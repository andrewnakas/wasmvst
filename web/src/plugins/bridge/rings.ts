/**
 * Single-producer / single-consumer stereo float ring buffer on SharedArrayBuffers,
 * used between the bridge AudioWorklet and its Worker. Indices are free-running
 * Int32 frame counters; capacity is a power of two so `& mask` works after wraparound.
 */
export const RING_CHANNELS = 2;
export const RING_CAPACITY = 16384;
const MASK = RING_CAPACITY - 1;

export const W = 0; // write counter
export const R = 1; // read counter
export const TICK = 2; // bumped + notified by the producer on every write

export interface RingSabs { ctrl: SharedArrayBuffer; data: SharedArrayBuffer }

export function createRing(): RingSabs {
  return {
    ctrl: new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT),
    data: new SharedArrayBuffer(RING_CHANNELS * RING_CAPACITY * Float32Array.BYTES_PER_ELEMENT),
  };
}

export class Ring {
  readonly ctrl: Int32Array;
  readonly data: Float32Array;
  constructor(sabs: RingSabs) {
    this.ctrl = new Int32Array(sabs.ctrl);
    this.data = new Float32Array(sabs.data);
  }

  available(): number {
    return (Atomics.load(this.ctrl, W) - Atomics.load(this.ctrl, R)) | 0;
  }

  space(): number {
    return RING_CAPACITY - this.available();
  }

  /** chans: one array per channel, each at least `frames` long; missing channels repeat channel 0. */
  write(chans: ArrayLike<number>[], frames: number, offset = 0): boolean {
    if (this.space() < frames) return false;
    const w = Atomics.load(this.ctrl, W);
    for (let c = 0; c < RING_CHANNELS; c++) {
      const src = chans[c] ?? chans[0];
      const base = c * RING_CAPACITY;
      for (let i = 0; i < frames; i++) this.data[base + ((w + i) & MASK)] = src ? src[offset + i] : 0;
    }
    Atomics.store(this.ctrl, W, (w + frames) | 0);
    Atomics.add(this.ctrl, TICK, 1);
    Atomics.notify(this.ctrl, TICK);
    return true;
  }

  /** Reads `frames` into dst arrays (planar); returns false if not enough data. */
  read(dst: Float32Array[], frames: number, offset = 0): boolean {
    if (this.available() < frames) return false;
    const r = Atomics.load(this.ctrl, R);
    for (let c = 0; c < dst.length; c++) {
      const base = Math.min(c, RING_CHANNELS - 1) * RING_CAPACITY;
      const out = dst[c];
      for (let i = 0; i < frames; i++) out[offset + i] = this.data[base + ((r + i) & MASK)];
    }
    Atomics.store(this.ctrl, R, (r + frames) | 0);
    return true;
  }

  skip(frames: number) {
    Atomics.store(this.ctrl, R, (Atomics.load(this.ctrl, R) + Math.min(frames, this.available())) | 0);
  }
}
