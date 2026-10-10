import { initializeWamHost } from '@webaudiomodules/sdk';
import type { PluginRef, PluginSlot } from '../PluginSlot';

// Minimal structural types for the parts of the WAM2 API we use.
interface WamNodeLike extends AudioNode {
  scheduleEvents(...events: { type: string; time?: number; data: unknown }[]): void;
  getState(): Promise<unknown>;
  setState(state: unknown): Promise<void>;
  destroy(): void;
}
interface WamInstanceLike {
  audioNode: WamNodeLike;
  descriptor?: { name?: string; isInstrument?: boolean; hasMidiInput?: boolean; hasAudioInput?: boolean };
  createGui(): Promise<HTMLElement>;
  destroyGui(el: HTMLElement): void;
}
interface WamModuleLike {
  createInstance(groupId: string, ctx: BaseAudioContext, initialState?: unknown): Promise<WamInstanceLike>;
  isWebAudioModuleConstructor?: boolean;
}

const hostGroups = new WeakMap<BaseAudioContext, Promise<string>>();

function hostGroupFor(ctx: BaseAudioContext): Promise<string> {
  let p = hostGroups.get(ctx);
  if (!p) {
    p = initializeWamHost(ctx).then(([groupId]) => groupId);
    hostGroups.set(ctx, p);
  }
  return p;
}

class WamSlot implements PluginSlot {
  readonly input: AudioNode | null;
  readonly output: AudioNode;
  readonly isInstrument: boolean;

  constructor(readonly ref: PluginRef, private wam: WamInstanceLike, instrumentHint: boolean) {
    const d = wam.descriptor ?? {};
    this.isInstrument = d.isInstrument ?? instrumentHint;
    this.input = wam.audioNode;
    this.output = wam.audioNode;
  }

  latencyMs() { return 0; }

  sendMidi(bytes: number[], time?: number) {
    this.wam.audioNode.scheduleEvents({
      type: 'wam-midi',
      time: time ?? this.wam.audioNode.context.currentTime,
      data: { bytes },
    });
  }

  hasGui() { return true; }
  createGui() { return this.wam.createGui(); }
  destroyGui(el: HTMLElement | null) { if (el) this.wam.destroyGui(el); }
  getState() { return this.wam.audioNode.getState(); }
  setState(s: unknown) { return this.wam.audioNode.setState(s); }

  dispose() {
    try { this.wam.audioNode.disconnect(); } catch { /* already disconnected */ }
    this.wam.audioNode.destroy();
  }
}

/** Load a WAM2 plugin from an ES module URL (must be CORS-enabled). */
export async function loadWam(ctx: BaseAudioContext, url: string, name: string, instrumentHint = false, state?: unknown): Promise<PluginSlot> {
  const groupId = await hostGroupFor(ctx);
  const mod = await import(/* @vite-ignore */ url);
  const WAM: WamModuleLike = mod.default;
  if (!WAM?.createInstance) throw new Error(`${url} is not a WebAudioModule`);
  const instance = await WAM.createInstance(groupId, ctx, state);
  const pluginName = instance.descriptor?.name || name;
  return new WamSlot({ kind: 'wam', id: url, name: pluginName }, instance, instrumentHint);
}
