import type { Engine } from '../engine/Engine';
import { BUILTINS } from '../plugins/loadPlugin';
import { fetchWamCatalog, type WamCatalogEntry } from '../plugins/wam/catalog';
import { bridge } from '../plugins/bridge/BridgeClient';
import { BRIDGE_PORT } from '../plugins/bridge/protocol';
import { addPluginToSelected } from './actions';
import { h, toast } from './dom';

const RELEASES_URL = 'https://github.com/andrewnakas/wasmvst/releases/latest';

type Tab = 'builtin' | 'wam' | 'native';

export function createBrowser(engine: Engine): HTMLElement {
  let tab: Tab = 'wam';
  let filter = '';
  let wamList: WamCatalogEntry[] | null = null;
  let wamError = '';

  const list = h('div', { class: 'browser-list' });
  const search = h('input', {
    type: 'search',
    placeholder: 'Search plugins…',
    oninput: () => { filter = search.value.toLowerCase(); render(); },
  });
  const tabs = h('div', { class: 'tabs' });
  const matches = (...s: string[]) => !filter || s.some((x) => x.toLowerCase().includes(filter));

  const item = (name: string, sub: string, instrument: boolean, onAdd: () => void) =>
    h('button', { class: 'browser-item', title: 'Add to selected track', onclick: onAdd },
      h('span', { class: `badge ${instrument ? 'inst' : 'fx'}` }, instrument ? 'INST' : 'FX'),
      h('span', { class: 'item-name' }, name),
      h('span', { class: 'item-sub' }, sub));

  function renderTabs() {
    tabs.replaceChildren(
      ...([['builtin', 'Built-in'], ['wam', 'Web (WAM)'], ['native', 'VST3 / AU']] as [Tab, string][]).map(([t, label]) =>
        h('button', { class: `tab ${tab === t ? 'active' : ''}`, onclick: () => { tab = t; render(); } }, label,
          t === 'native' ? h('span', { class: `dot ${bridge.status}` }) : null)),
    );
  }

  function renderBuiltin() {
    for (const b of BUILTINS) if (matches(b.name)) {
      list.append(item(b.name, b.description, b.isInstrument, () =>
        addPluginToSelected(engine, { kind: 'builtin', id: b.id, name: b.name }, b.isInstrument)));
    }
  }

  function renderWam() {
    if (!wamList && !wamError) {
      list.append(h('div', { class: 'hint' }, 'Loading WAM community catalog…'));
      fetchWamCatalog().then((l) => { wamList = l; render(); }, (e) => { wamError = e.message; render(); });
      return;
    }
    if (wamError) list.append(h('div', { class: 'hint error' }, `Catalog unavailable: ${wamError}`));
    for (const p of wamList ?? []) if (matches(p.name, p.vendor, ...p.category)) {
      list.append(item(p.name, `${p.vendor} · ${p.category.slice(1).join(', ') || p.category[0]}`, p.isInstrument, () =>
        addPluginToSelected(engine, { kind: 'wam', id: p.url, name: p.name }, p.isInstrument)));
    }
    const url = h('input', { type: 'url', placeholder: 'https://…/index.js (WAM2 module URL)' });
    const asInst = h('input', { type: 'checkbox' });
    list.append(h('form', {
      class: 'wam-url',
      onsubmit: (e: Event) => {
        e.preventDefault();
        if (!url.value) return;
        addPluginToSelected(engine, { kind: 'wam', id: url.value, name: url.value.split('/').slice(-2, -1)[0] || 'WAM' }, asInst.checked);
      },
    }, h('div', { class: 'label' }, 'Load WAM2 from URL'), url, h('label', {}, asInst, ' instrument'), h('button', { type: 'submit' }, 'Load')));
  }

  function renderNative() {
    if (bridge.status !== 'connected') {
      list.append(h('div', { class: 'bridge-help' },
        h('h3', {}, 'Native plugins need the wasmvst bridge'),
        h('p', {}, 'Browsers can\'t run native VST3/AU binaries. The bridge is a small app that runs on your computer, hosts your real plugins, and streams audio to this page.'),
        h('ol', {},
          h('li', {}, h('a', { href: RELEASES_URL, target: '_blank', rel: 'noopener' }, 'Download wasmvst-bridge'), ' (macOS)'),
          h('li', {}, 'Unzip it, then right-click wasmvst-bridge.app → Open (the first time only)'),
          h('li', {}, 'Allow this page to access your local network if Chrome asks'),
        ),
        h('p', { class: 'hint' }, bridge.status === 'connecting' ? `Looking for the bridge on 127.0.0.1:${BRIDGE_PORT}…` : 'Not connected; retrying…'),
      ));
      return;
    }
    const rescan = h('button', {
      onclick: async () => {
        rescan.disabled = true;
        rescan.textContent = 'Scanning…';
        try { await bridge.rescan(); toast(`Found ${bridge.plugins.length} plugins`); }
        catch (e) { toast(`Scan failed: ${(e as Error).message}`, 'error'); }
        render();
      },
    }, 'Rescan plugins');
    list.append(h('div', { class: 'bridge-bar' }, h('span', {}, `Bridge ${bridge.info.version ?? ''} · ${bridge.plugins.length} plugins`), rescan));
    const sorted = [...bridge.plugins].sort((a, b) => Number(b.isInstrument) - Number(a.isInstrument) || a.name.localeCompare(b.name));
    for (const p of sorted) if (matches(p.name, p.vendor, p.format, p.category)) {
      list.append(item(p.name, `${p.vendor} · ${p.format === 'AudioUnit' ? 'AU' : p.format}`, p.isInstrument, () =>
        addPluginToSelected(engine, { kind: 'bridge', id: p.id, name: p.name }, p.isInstrument)));
    }
    if (!bridge.plugins.length) list.append(h('div', { class: 'hint' }, 'No plugins found yet. Click Rescan.'));
  }

  function render() {
    renderTabs();
    list.replaceChildren();
    if (tab === 'builtin') renderBuiltin();
    else if (tab === 'wam') renderWam();
    else renderNative();
  }

  bridge.addEventListener('status', render);
  bridge.addEventListener('plugins', render);
  bridge.addEventListener('scanProgress', (e) => {
    const d = (e as CustomEvent).detail;
    if (tab === 'native') list.querySelector('.bridge-bar span')!.textContent = `Scanning ${d.name ?? ''} (${Math.round((d.progress ?? 0) * 100)}%)`;
  });
  render();

  return h('aside', { class: 'browser' }, h('div', { class: 'panel-title' }, 'Browser'), tabs, search, list);
}
