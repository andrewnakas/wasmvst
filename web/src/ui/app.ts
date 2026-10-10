import { Engine, type ProjectJSON } from '../engine/Engine';
import { bridge } from '../plugins/bridge/BridgeClient';
import { initWebMidi } from '../midi';
import { createBrowser } from './browser';
import { createMixer } from './mixer';
import { createKeyboard } from './keyboard';
import { h, toast } from './dom';

const STORAGE_KEY = 'wasmvst.project';

export function createApp(root: HTMLElement) {
  const engine = new Engine();
  (window as any).wasmvst = { engine, bridge };

  // ---- transport ----
  const playBtn = h('button', { class: 'transport-btn', title: 'Play (Space)', onclick: () => (engine.playing ? engine.stop() : engine.play()) }, '▶');
  const bpm = h('input', { type: 'number', class: 'bpm', min: '20', max: '999', value: String(engine.bpm), onchange: () => engine.setBpm(Number(bpm.value)) });
  const metro = h('button', { class: 'toggle', title: 'Metronome', onclick: () => { engine.metronome = !engine.metronome; metro.classList.toggle('on', engine.metronome); } }, '◔');
  const pos = h('span', { class: 'position' }, '1.1.1');
  const bridgePill = h('span', { class: 'pill' });
  const midiPill = h('span', { class: 'pill', title: 'Web MIDI inputs' }, 'No MIDI');
  const cpu = h('span', { class: 'pill', title: 'Audio output latency' });

  const updateTransport = () => {
    playBtn.textContent = engine.playing ? '■' : '▶';
    playBtn.classList.toggle('on', engine.playing);
    bpm.value = String(engine.bpm);
  };
  engine.addEventListener('change', updateTransport);

  const tickPos = () => {
    const b = engine.positionBeats();
    pos.textContent = `${Math.floor(b / 4) + 1}.${(Math.floor(b) % 4) + 1}.${Math.floor((b % 1) * 4) + 1}`;
    requestAnimationFrame(tickPos);
  };
  requestAnimationFrame(tickPos);

  const updateBridge = () => {
    bridgePill.className = `pill ${bridge.status}`;
    bridgePill.textContent = bridge.status === 'connected' ? `Bridge ✓ ${bridge.plugins.length} plugins` : 'Bridge offline';
  };
  bridge.addEventListener('status', updateBridge);
  bridge.addEventListener('plugins', updateBridge);
  updateBridge();

  // ---- project ----
  const save = async () => {
    const json = await engine.toJSON();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(json));
    toast('Project saved in this browser');
  };
  const exportFile = async () => {
    const blob = new Blob([JSON.stringify(await engine.toJSON(), null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'project.wasmvst.json' });
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const loadJSON = async (p: ProjectJSON) => {
    const errors = await engine.load(p);
    if (errors.length) toast(`Some plugins failed to load:\n${errors.join('\n')}`, 'error');
    else toast('Project loaded');
  };
  const importInput = h('input', {
    type: 'file', accept: '.json', style: 'display:none',
    onchange: async () => {
      const f = importInput.files?.[0];
      if (f) await loadJSON(JSON.parse(await f.text()));
      importInput.value = '';
    },
  });

  const header = h('header', { class: 'topbar' },
    h('span', { class: 'logo' }, 'wasmvst'),
    h('div', { class: 'transport' }, playBtn, bpm, h('span', { class: 'unit' }, 'BPM'), metro, pos),
    h('div', { class: 'spacer' }),
    cpu, midiPill, bridgePill,
    h('button', { onclick: save }, 'Save'),
    h('button', { onclick: () => { const s = localStorage.getItem(STORAGE_KEY); if (s) loadJSON(JSON.parse(s)); else toast('Nothing saved yet'); } }, 'Open'),
    h('button', { onclick: exportFile }, 'Export'),
    h('button', { onclick: () => importInput.click() }, 'Import'),
    importInput,
  );

  root.append(header, h('div', { class: 'workspace' }, createBrowser(engine), createMixer(engine)), createKeyboard(engine));

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !(e.target as HTMLElement).closest('input,select,textarea,button')) {
      e.preventDefault();
      engine.playing ? engine.stop() : engine.play();
    }
  });

  // AudioContext needs a user gesture; one overlay click starts everything.
  const overlay = h('div', { class: 'start-overlay' },
    h('div', { class: 'start-card' },
      h('h1', {}, 'wasmvst'),
      h('p', {}, 'A browser DAW that hosts WebAudio Modules, plus your native VST3/AU plugins through the local bridge.'),
      h('button', { class: 'primary' }, 'Start audio'),
      crossOriginIsolated ? null : h('p', { class: 'hint error' }, 'Not cross-origin isolated yet: native plugins need a reload.')));
  overlay.onclick = async () => {
    await engine.ctx.resume();
    overlay.remove();
    cpu.textContent = `${engine.ctx.sampleRate / 1000} kHz · ${((engine.ctx.baseLatency + (engine.ctx.outputLatency || 0)) * 1000).toFixed(0)} ms`;
    if (!engine.tracks.length) engine.addTrack('instrument');
    initWebMidi(engine, (names) => { midiPill.textContent = names.length ? `MIDI: ${names.join(', ')}` : 'No MIDI'; });
  };
  document.body.append(overlay);

  bridge.connect();
}
