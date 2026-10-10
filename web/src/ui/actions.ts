import type { Engine } from '../engine/Engine';
import type { PluginRef } from '../plugins/PluginSlot';
import { loadPlugin } from '../plugins/loadPlugin';
import { toast } from './dom';

/**
 * Put a plugin on the selected track: instruments go in the instrument slot
 * (replacing any existing one), effects are appended to the insert chain.
 * Creates a suitable track if none is selected.
 */
export async function addPluginToSelected(engine: Engine, ref: PluginRef, isInstrument: boolean) {
  let track = engine.selected;
  if (!track) track = engine.addTrack(isInstrument ? 'instrument' : 'testloop');
  toast(`Loading ${ref.name}…`);
  try {
    const slot = await loadPlugin(engine.ctx, ref, undefined, isInstrument);
    if (slot.isInstrument) track.setInstrument(slot);
    else track.addInsert(slot);
    toast(`${slot.ref.name} → ${track.name}`);
    return slot;
  } catch (e) {
    console.error(e);
    toast(`Couldn't load ${ref.name}: ${(e as Error).message}`, 'error');
    return null;
  }
}
