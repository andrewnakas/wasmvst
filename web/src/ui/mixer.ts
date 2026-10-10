import type { Engine } from '../engine/Engine';
import type { Track, TrackSource } from '../engine/Track';
import type { PluginSlot } from '../plugins/PluginSlot';
import { closePluginWindow, openPluginWindow } from './windows';
import { h, toast } from './dom';

interface MeterRef { el: HTMLElement; l: AnalyserNode; r: AnalyserNode; peakL: number; peakR: number }

const SOURCES: [TrackSource, string][] = [['instrument', 'MIDI → Instrument'], ['testloop', 'Test loop'], ['input', 'Audio input']];
const buf = new Float32Array(512);

function level(a: AnalyserNode) {
  a.getFloatTimeDomainData(buf);
  let m = 0;
  for (let i = 0; i < buf.length; i++) m = Math.max(m, Math.abs(buf[i]));
  return m;
}

function dbToPct(v: number) {
  const db = 20 * Math.log10(v + 1e-9);
  return Math.max(0, Math.min(100, ((db + 60) / 66) * 100));
}

function showGui(slot: PluginSlot) {
  openPluginWindow(slot, slot.ref.name).catch((e) => toast(`GUI failed: ${e.message}`, 'error'));
}

export function createMixer(engine: Engine): HTMLElement {
  const strips = h('div', { class: 'strips' });
  let meters: MeterRef[] = [];

  function slotRow(slot: PluginSlot, label: string, extra: HTMLElement[], onRemove: () => void, bypassed = false) {
    const latency = slot.latencyMs();
    return h('div', { class: `slot ${slot.ref.kind} ${bypassed ? 'bypassed' : ''}`, title: `${slot.ref.name}${latency ? ` · +${latency.toFixed(0)} ms` : ''}` },
      h('span', { class: 'slot-kind' }, label),
      h('button', { class: 'slot-name', onclick: () => slot.hasGui() && showGui(slot) }, slot.ref.name),
      ...extra,
      h('button', { class: 'icon', title: 'Remove', onclick: () => { closePluginWindow(slot); onRemove(); } }, '×'));
  }

  function strip(t: Track) {
    const sel = engine.selected === t;
    const meter = h('div', { class: 'meter' }, h('div', { class: 'bar l' }), h('div', { class: 'bar r' }));
    meters.push({ el: meter, l: t.meterL, r: t.meterR, peakL: 0, peakR: 0 });

    const source = h('select', {
      onchange: () => engine.setTrackSource(t, source.value as TrackSource).catch((e) => toast(e.message, 'error')),
    }, ...SOURCES.map(([v, l]) => new Option(l, v, false, t.source === v)));

    const inst = t.instrument
      ? slotRow(t.instrument, 'INST', [], () => t.setInstrument(null))
      : h('div', { class: 'slot empty' }, t.source === 'instrument' ? 'Drop an instrument from the browser' : '—');

    const inserts = t.inserts.map((ins, i) =>
      slotRow(ins.slot, ins.slot.isInstrument ? 'INST' : 'FX', [
        h('button', { class: `icon ${ins.bypass ? '' : 'on'}`, title: 'Bypass', onclick: () => t.setBypass(i, !ins.bypass) }, '⏻'),
        h('button', { class: 'icon', title: 'Move up', onclick: () => t.moveInsert(i, -1) }, '↑'),
      ], () => t.removeInsert(i), ins.bypass));

    const vol = h('input', {
      type: 'range', min: '0', max: '1.25', step: '0.01', value: String(t.volume), class: 'fader',
      oninput: () => { t.volume = Number(vol.value); volLabel.textContent = fmtDb(t.volume); },
    });
    const volLabel = h('span', { class: 'db' }, fmtDb(t.volume));
    const pan = h('input', {
      type: 'range', min: '-1', max: '1', step: '0.01', value: String(t.pan), class: 'pan',
      ondblclick: () => { pan.value = '0'; t.pan = 0; },
      oninput: () => { t.pan = Number(pan.value); },
    });
    const name = h('input', { class: 'track-name', value: t.name, onchange: () => { t.name = name.value; } });
    const latency = t.latencyMs();

    return h('div', { class: `strip ${sel ? 'selected' : ''}`, onpointerdown: (e: Event) => { if (!sel && !(e.target as HTMLElement).closest('button,input,select')) engine.select(t); } },
      h('div', { class: 'strip-head', onclick: () => engine.select(t) }, name),
      source,
      h('div', { class: 'chain' }, inst, ...inserts),
      latency > 1 ? h('div', { class: 'latency', title: 'Added by native plugins via the bridge' }, `+${latency.toFixed(0)} ms`) : null,
      h('div', { class: 'strip-bottom' },
        pan,
        h('div', { class: 'fader-row' }, vol, meter),
        volLabel,
        h('div', { class: 'buttons' },
          h('button', { class: `toggle mute ${t.mute ? 'on' : ''}`, onclick: () => { t.mute = !t.mute; engine.updateSolo(); render(); } }, 'M'),
          h('button', { class: `toggle solo ${t.solo ? 'on' : ''}`, onclick: () => { t.solo = !t.solo; engine.updateSolo(); render(); } }, 'S'),
          h('button', { class: 'toggle', title: 'Delete track', onclick: () => engine.removeTrack(t) }, '🗑'),
        )));
  }

  function masterStrip() {
    const meter = h('div', { class: 'meter' }, h('div', { class: 'bar l' }), h('div', { class: 'bar r' }));
    meters.push({ el: meter, l: engine.masterMeterL, r: engine.masterMeterR, peakL: 0, peakR: 0 });
    const vol = h('input', {
      type: 'range', min: '0', max: '1.25', step: '0.01', value: String(engine.master.gain.value), class: 'fader',
      oninput: () => engine.master.gain.setTargetAtTime(Number(vol.value), engine.ctx.currentTime, 0.01),
    });
    return h('div', { class: 'strip master' }, h('div', { class: 'strip-head' }, 'Master'),
      h('div', { class: 'chain' }), h('div', { class: 'strip-bottom' }, h('div', { class: 'fader-row' }, vol, meter)));
  }

  function render() {
    meters = [];
    strips.replaceChildren(
      ...engine.tracks.map(strip),
      h('div', { class: 'add-track' },
        h('button', { onclick: () => engine.addTrack('instrument') }, '+ MIDI track'),
        h('button', { onclick: () => engine.addTrack('testloop') }, '+ Audio track')),
      masterStrip(),
    );
  }

  const tick = () => {
    for (const m of meters) {
      m.peakL = Math.max(level(m.l), m.peakL * 0.9);
      m.peakR = Math.max(level(m.r), m.peakR * 0.9);
      (m.el.children[0] as HTMLElement).style.height = `${dbToPct(m.peakL)}%`;
      (m.el.children[1] as HTMLElement).style.height = `${dbToPct(m.peakR)}%`;
      m.el.classList.toggle('clip', m.peakL > 1 || m.peakR > 1);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  engine.addEventListener('change', render);
  render();
  return h('main', { class: 'mixer' }, strips);
}

function fmtDb(v: number) {
  return v < 0.001 ? '-∞ dB' : `${(20 * Math.log10(v)).toFixed(1)} dB`;
}
