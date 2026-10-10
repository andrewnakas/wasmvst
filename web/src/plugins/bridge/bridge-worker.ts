// Dedicated Worker: moves fixed-size blocks between the SAB rings and the bridge's
// per-instance audio WebSocket so the audio thread never touches the network.
import { Ring, TICK, type RingSabs } from './rings';
import { MIDI_EVENT_BYTES, REQ_HEADER_BYTES, RES_HEADER_BYTES } from './protocol';

interface InitMsg { type: 'init'; url: string; block: number; toBridge: RingSabs; fromBridge: RingSabs }
type Msg = InitMsg | { type: 'midi'; bytes: number[] } | { type: 'close' };

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

let toBridge: Ring;
let fromBridge: Ring;
let block = 256;
let ws: WebSocket | null = null;
let seq = 0;
let closed = false;
let midiQueue: number[][] = [];
const sentAt = new Map<number, number>();
let rttAvg = 0;
let scratch: Float32Array[] = [];

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === 'init') {
    toBridge = new Ring(m.toBridge);
    fromBridge = new Ring(m.fromBridge);
    block = m.block;
    scratch = [new Float32Array(block), new Float32Array(block)];
    connect(m.url);
    pump();
  } else if (m.type === 'midi') {
    midiQueue.push(m.bytes);
  } else if (m.type === 'close') {
    closed = true;
    ws?.close();
  }
};

function connect(url: string) {
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => post({ type: 'status', connected: true });
  ws.onclose = () => {
    post({ type: 'status', connected: false });
    ws = null;
    sentAt.clear();
    if (!closed) setTimeout(() => connect(url), 1000);
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') return;
    receive(e.data as ArrayBuffer);
  };
}

function send() {
  toBridge.read(scratch, block);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    // Hold MIDI until the socket opens (notes sent right after loading), but don't grow forever.
    if (midiQueue.length > 1024) midiQueue = midiQueue.slice(-1024);
    return;
  }
  const midi = midiQueue.slice(0, 1024);
  midiQueue = midiQueue.slice(midi.length);
  const buf = new ArrayBuffer(REQ_HEADER_BYTES + midi.length * MIDI_EVENT_BYTES + 2 * block * 4);
  const dv = new DataView(buf);
  const s = seq++ >>> 0;
  dv.setUint32(0, s, true);
  dv.setUint16(4, 2, true);
  dv.setUint16(6, block, true);
  dv.setUint16(8, midi.length, true);
  let o = REQ_HEADER_BYTES;
  for (const ev of midi) {
    dv.setUint32(o, 0, true);
    for (let i = 0; i < 3; i++) dv.setUint8(o + 4 + i, ev[i] ?? 0);
    dv.setUint8(o + 7, Math.min(ev.length, 3));
    o += MIDI_EVENT_BYTES;
  }
  const audio = new Float32Array(buf, o, 2 * block);
  audio.set(scratch[0], 0);
  audio.set(scratch[1], block);
  sentAt.set(s, performance.now());
  ws.send(buf);
}

function receive(buf: ArrayBuffer) {
  const dv = new DataView(buf);
  const s = dv.getUint32(0, true);
  const chans = dv.getUint16(4, true);
  const frames = dv.getUint16(6, true);
  const latencySamples = dv.getUint32(8, true);
  const audio = new Float32Array(buf, RES_HEADER_BYTES, chans * frames);
  const planes = [];
  for (let c = 0; c < chans; c++) planes.push(audio.subarray(c * frames, (c + 1) * frames));
  fromBridge.write(planes, frames);
  const t = sentAt.get(s);
  if (t !== undefined) {
    sentAt.delete(s);
    rttAvg = rttAvg ? rttAvg * 0.95 + (performance.now() - t) * 0.05 : performance.now() - t;
  }
  if (s % 200 === 0) post({ type: 'stats', rttMs: rttAvg, pluginLatencySamples: latencySamples });
}

function pump() {
  if (closed) return;
  while (toBridge.available() >= block) send();
  const tick = Atomics.load(toBridge.ctrl, TICK);
  const waitAsync = (Atomics as unknown as { waitAsync?: (a: Int32Array, i: number, v: number, t: number) => { async: boolean; value: Promise<unknown> | string } }).waitAsync;
  if (waitAsync) {
    const r = waitAsync(toBridge.ctrl, TICK, tick, 100);
    if (r.async) (r.value as Promise<unknown>).then(pump);
    else queueMicrotask(pump);
  } else {
    setTimeout(pump, 1);
  }
}
