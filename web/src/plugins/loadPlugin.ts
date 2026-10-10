import type { PluginRef, PluginSlot } from './PluginSlot';
import { BasicSynth } from './builtin/BasicSynth';
import { loadWam } from './wam/WamHost';
import { loadBridgePlugin } from './bridge/BridgeSlot';

export const BUILTINS: { id: string; name: string; isInstrument: boolean; description: string }[] = [
  { id: 'basic-synth', name: 'Basic Synth', isInstrument: true, description: 'Two-oscillator polyphonic synth with a resonant filter' },
];

export async function loadPlugin(ctx: AudioContext, ref: PluginRef, state?: unknown, instrumentHint = false): Promise<PluginSlot> {
  let slot: PluginSlot;
  switch (ref.kind) {
    case 'builtin':
      if (ref.id !== 'basic-synth') throw new Error(`unknown builtin ${ref.id}`);
      slot = new BasicSynth(ctx);
      if (state !== undefined) await slot.setState(state);
      return slot;
    case 'wam':
      return loadWam(ctx, ref.id, ref.name, instrumentHint, state);
    case 'bridge':
      return loadBridgePlugin(ctx, ref.id, state);
  }
}
