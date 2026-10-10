// AudioWorkletGlobalScope: copies the node's input into the "to bridge" ring and
// plays processed audio from the "from bridge" ring once enough is buffered.
import { Ring, type RingSabs } from './rings';

declare const registerProcessor: (name: string, ctor: unknown) => void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const QUANTUM = 128;

class BridgeProcessor extends AudioWorkletProcessor {
  private toBridge: Ring;
  private fromBridge: Ring;
  private prebuffer: number;
  private primed = false;
  private underruns = 0;
  private frames = 0;
  private alive = true;

  constructor(options: { processorOptions: { toBridge: RingSabs; fromBridge: RingSabs; prebuffer: number } }) {
    super();
    const o = options.processorOptions;
    this.toBridge = new Ring(o.toBridge);
    this.fromBridge = new Ring(o.fromBridge);
    this.prebuffer = o.prebuffer;
    this.port.onmessage = (e) => {
      if (e.data?.type === 'prebuffer') this.prebuffer = e.data.frames;
      if (e.data?.type === 'dispose') this.alive = false;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    // Unconnected input still has to advance the stream, so send silence.
    this.toBridge.write(input && input.length ? input : [new Float32Array(QUANTUM)], QUANTUM);

    const out = outputs[0];
    const avail = this.fromBridge.available();
    if (!this.primed && avail >= this.prebuffer) this.primed = true;
    if (this.primed && avail >= QUANTUM) {
      this.fromBridge.read(out, QUANTUM);
    } else {
      for (const ch of out) ch.fill(0);
      if (this.primed) {
        this.primed = false;
        this.underruns++;
      }
    }
    // Too much queued (e.g. after a stall): drop the excess so latency doesn't creep.
    const excess = this.fromBridge.available() - this.prebuffer * 2 - QUANTUM;
    if (excess > 0) this.fromBridge.skip(excess);

    this.frames += QUANTUM;
    if (this.frames >= sampleRate) {
      this.frames = 0;
      this.port.postMessage({ type: 'stats', underruns: this.underruns, buffered: this.fromBridge.available() });
    }
    return this.alive;
  }
}

declare const sampleRate: number;
registerProcessor('wasmvst-bridge', BridgeProcessor);
