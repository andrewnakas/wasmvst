import type { PluginRef, PluginSlot } from '../PluginSlot';
import { bridge } from './BridgeClient';
import { createRing } from './rings';
import type { CreatedInstance } from './protocol';
import workletUrl from './bridge-worklet.ts?worker&url';
import BridgeWorker from './bridge-worker.ts?worker';

/** Frames per network round trip. Smaller = lower latency, more packets. */
const BLOCK = 256;
/** Frames the worklet waits for before it starts playing (absorbs network jitter). */
const PREBUFFER = 512;

const workletLoaded = new WeakMap<BaseAudioContext, Promise<void>>();

function ensureWorklet(ctx: BaseAudioContext) {
  let p = workletLoaded.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(workletUrl);
    workletLoaded.set(ctx, p);
  }
  return p;
}

/** A real VST3/AU plugin running inside the native bridge, streamed in and out of the page. */
class BridgeSlot implements PluginSlot {
  readonly input: AudioNode | null;
  readonly output: AudioNode;
  readonly isInstrument: boolean;
  private rttMs = 0;
  private pluginLatencySamples: number;
  underruns = 0;
  connected = false;

  constructor(
    readonly ref: PluginRef,
    private ctx: BaseAudioContext,
    private inst: CreatedInstance,
    private node: AudioWorkletNode,
    private worker: Worker,
  ) {
    this.isInstrument = inst.isInstrument;
    this.input = inst.isInstrument ? null : node;
    this.output = node;
    this.pluginLatencySamples = inst.latencySamples;
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'stats') {
        this.rttMs = m.rttMs;
        this.pluginLatencySamples = m.pluginLatencySamples;
      } else if (m.type === 'status') {
        this.connected = m.connected;
      }
    };
    node.port.onmessage = (e) => {
      if (e.data.type === 'stats') this.underruns = e.data.underruns;
    };
  }

  /** Total delay the bridge adds: block accumulation + prebuffer + network + the plugin's own latency. */
  latencyMs() {
    const sr = this.ctx.sampleRate;
    return ((BLOCK + PREBUFFER + this.pluginLatencySamples) / sr) * 1000 + this.rttMs;
  }

  sendMidi(bytes: number[]) {
    this.worker.postMessage({ type: 'midi', bytes });
  }

  hasGui() { return this.inst.hasEditor; }

  async createGui() {
    await bridge.request('openEditor', { instanceId: this.inst.instanceId });
    return null; // the plugin's own window opens on the desktop
  }

  destroyGui() {
    bridge.request('closeEditor', { instanceId: this.inst.instanceId }).catch(() => {});
  }

  async getState() {
    const r = await bridge.request<{ state: string }>('getState', { instanceId: this.inst.instanceId });
    return r.state;
  }

  async setState(state: unknown) {
    if (typeof state === 'string') await bridge.request('setState', { instanceId: this.inst.instanceId, state });
  }

  dispose() {
    this.node.port.postMessage({ type: 'dispose' });
    this.node.disconnect();
    this.worker.postMessage({ type: 'close' });
    setTimeout(() => this.worker.terminate(), 500);
    bridge.request('destroy', { instanceId: this.inst.instanceId }).catch(() => {});
  }
}

export async function loadBridgePlugin(ctx: BaseAudioContext, pluginId: string, state?: unknown): Promise<PluginSlot> {
  if (!crossOriginIsolated) throw new Error('Page is not cross-origin isolated; reload so the service worker can enable SharedArrayBuffer.');
  await ensureWorklet(ctx);
  const inst = await bridge.create(pluginId, ctx.sampleRate, BLOCK);
  const toBridge = createRing();
  const fromBridge = createRing();
  const node = new AudioWorkletNode(ctx, 'wasmvst-bridge', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    processorOptions: { toBridge, fromBridge, prebuffer: PREBUFFER },
  });
  const worker = new BridgeWorker();
  worker.postMessage({ type: 'init', url: `${bridge.url}/audio/${inst.instanceId}`, block: BLOCK, toBridge, fromBridge });
  const slot = new BridgeSlot({ kind: 'bridge', id: pluginId, name: inst.name }, ctx, inst, node, worker);
  if (state !== undefined) await slot.setState(state);
  return slot;
}
