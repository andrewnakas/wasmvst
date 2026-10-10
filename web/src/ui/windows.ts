import { h } from './dom';
import type { PluginSlot } from '../plugins/PluginSlot';

const open = new Map<PluginSlot, { win: HTMLElement; gui: HTMLElement | null }>();
let z = 100;

/** Shows a plugin GUI in a draggable floating window (or asks the bridge to open a native one). */
export async function openPluginWindow(slot: PluginSlot, title: string) {
  const existing = open.get(slot);
  if (existing) {
    existing.win.style.zIndex = String(++z);
    return;
  }
  const gui = await slot.createGui();
  if (!gui) return; // native editor window opened by the bridge
  const close = h('button', { class: 'win-close', title: 'Close', onclick: () => closePluginWindow(slot) }, '×');
  const bar = h('div', { class: 'win-bar' }, h('span', {}, title), close);
  const body = h('div', { class: 'win-body' }, gui);
  const n = open.size;
  const win = h('div', { class: 'plugin-window', style: `left:${260 + n * 30}px;top:${80 + n * 30}px;z-index:${++z}` }, bar, body);
  win.onpointerdown = () => (win.style.zIndex = String(++z));
  bar.onpointerdown = (e) => {
    if (e.target === close) return;
    const sx = e.clientX - win.offsetLeft;
    const sy = e.clientY - win.offsetTop;
    bar.setPointerCapture(e.pointerId);
    bar.onpointermove = (m) => {
      win.style.left = `${Math.max(0, m.clientX - sx)}px`;
      win.style.top = `${Math.max(0, m.clientY - sy)}px`;
    };
    bar.onpointerup = () => (bar.onpointermove = null);
  };
  document.body.append(win);
  open.set(slot, { win, gui });
}

export function closePluginWindow(slot: PluginSlot) {
  const o = open.get(slot);
  if (!o) {
    if (slot.ref.kind === 'bridge') slot.destroyGui(null);
    return;
  }
  slot.destroyGui(o.gui);
  o.win.remove();
  open.delete(slot);
}
