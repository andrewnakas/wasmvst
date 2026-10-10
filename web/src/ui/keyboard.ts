import type { Engine } from '../engine/Engine';
import { h } from './dom';

// Live-style computer keyboard mapping: A W S E D F T G Y H U J K O L P ; ', Z/X octave, C/V velocity.
const KEYS = 'awsedftgyhujkolp;\'';
const BLACK = new Set([1, 3, 6, 8, 10]);

export function createKeyboard(engine: Engine): HTMLElement {
  let octave = 4;
  let velocity = 100;
  const held = new Map<string, number>();
  const keys: HTMLElement[] = [];
  const info = h('span', { class: 'kb-info' });
  const piano = h('div', { class: 'piano' });
  const FIRST = 36;
  const COUNT = 61;

  const updateInfo = () => (info.textContent = `Octave C${octave - 1} · Vel ${velocity} · Z/X octave, C/V velocity`);

  const light = (note: number, on: boolean) => keys[note - FIRST]?.classList.toggle('down', on);
  const noteOn = (n: number) => { engine.midiIn([0x90, n, velocity]); light(n, true); };
  const noteOff = (n: number) => { engine.midiIn([0x80, n, 0]); light(n, false); };

  for (let n = FIRST; n < FIRST + COUNT; n++) {
    const k = h('div', { class: `key ${BLACK.has(n % 12) ? 'black' : 'white'}` });
    k.onpointerdown = (e) => {
      k.setPointerCapture(e.pointerId);
      noteOn(n);
      const up = () => { noteOff(n); k.onpointerup = k.onpointercancel = null; };
      k.onpointerup = k.onpointercancel = up;
    };
    keys.push(k);
    piano.append(k);
  }

  window.addEventListener('wasmvst-midi', (e) => {
    const [s, n, v] = (e as CustomEvent<number[]>).detail;
    if ((s & 0xf0) === 0x90) light(n, v > 0);
    if ((s & 0xf0) === 0x80) light(n, false);
  });

  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    return t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range' || t.tagName === 'TEXTAREA' || t.isContentEditable || e.metaKey || e.ctrlKey;
  };

  window.addEventListener('keydown', (e) => {
    if (typing(e) || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'z') { octave = Math.max(0, octave - 1); updateInfo(); return; }
    if (k === 'x') { octave = Math.min(8, octave + 1); updateInfo(); return; }
    if (k === 'c') { velocity = Math.max(1, velocity - 20); updateInfo(); return; }
    if (k === 'v') { velocity = Math.min(127, velocity + 20); updateInfo(); return; }
    const i = KEYS.indexOf(k);
    if (i < 0 || held.has(k)) return;
    const note = 12 * octave + i;
    held.set(k, note);
    noteOn(note);
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    const note = held.get(k);
    if (note === undefined) return;
    held.delete(k);
    noteOff(note);
  });
  window.addEventListener('blur', () => { for (const n of held.values()) noteOff(n); held.clear(); });

  updateInfo();
  return h('footer', { class: 'keyboard' }, info, piano);
}
