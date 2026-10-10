import type { Engine } from './engine/Engine';

/** Web MIDI input → engine. Returns the names of connected inputs. */
export async function initWebMidi(engine: Engine, onChange: (names: string[]) => void) {
  if (!navigator.requestMIDIAccess) return;
  try {
    const access = await navigator.requestMIDIAccess();
    const bind = () => {
      const names: string[] = [];
      access.inputs.forEach((input) => {
        names.push(input.name ?? 'MIDI input');
        input.onmidimessage = (e) => {
          if (!e.data) return;
          const bytes = Array.from(e.data);
          if (bytes[0] >= 0xf0) return; // ignore clock/sysex
          engine.midiIn(bytes);
          window.dispatchEvent(new CustomEvent('wasmvst-midi', { detail: bytes }));
        };
      });
      onChange(names);
    };
    access.onstatechange = bind;
    bind();
  } catch (e) {
    console.warn('Web MIDI unavailable', e);
  }
}
