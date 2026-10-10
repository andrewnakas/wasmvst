type Attrs = Record<string, unknown> & { class?: string; style?: string };

/** Tiny hyperscript helper: h('div', {class:'x', onclick}, child, ...) */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') (el as any)[k] = v;
    else if (k in el) (el as any)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== false && c !== undefined) el.append(c);
  return el;
}

let toastHost: HTMLElement | null = null;
export function toast(msg: string, kind: 'info' | 'error' = 'info') {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts' }));
  const t = h('div', { class: `toast ${kind}` }, msg);
  toastHost.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}
