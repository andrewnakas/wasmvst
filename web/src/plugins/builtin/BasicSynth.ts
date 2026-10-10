import type { PluginRef, PluginSlot } from '../PluginSlot';

interface Voice { osc: OscillatorNode; osc2: OscillatorNode; env: GainNode }

/**
 * Always-available polyphonic subtractive synth so the DAW makes sound
 * without any network plugin. Plain WebAudio nodes, no worklet.
 */
export class BasicSynth implements PluginSlot {
  readonly ref: PluginRef = { kind: 'builtin', id: 'basic-synth', name: 'Basic Synth' };
  readonly isInstrument = true;
  readonly input = null;
  readonly output: GainNode;
  private filter: BiquadFilterNode;
  private voices = new Map<number, Voice>();
  private params = { wave: 'sawtooth' as OscillatorType, cutoff: 2400, resonance: 4, attack: 0.005, release: 0.25, detune: 7 };

  constructor(private ctx: BaseAudioContext) {
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.output = ctx.createGain();
    this.output.gain.value = 0.25;
    this.filter.connect(this.output);
    this.applyParams();
  }

  private applyParams() {
    this.filter.frequency.value = this.params.cutoff;
    this.filter.Q.value = this.params.resonance;
  }

  latencyMs() { return 0; }

  sendMidi(bytes: number[], time = this.ctx.currentTime) {
    const [status, note, vel] = bytes;
    const cmd = status & 0xf0;
    if (cmd === 0x90 && vel > 0) this.noteOn(note, vel, time);
    else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) this.noteOff(note, time);
    else if (cmd === 0xb0 && note === 123) for (const n of [...this.voices.keys()]) this.noteOff(n, time);
  }

  private noteOn(note: number, vel: number, t: number) {
    this.noteOff(note, t);
    const freq = 440 * 2 ** ((note - 69) / 12);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel / 127, t + this.params.attack);
    const osc = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    for (const o of [osc, osc2]) {
      o.type = this.params.wave;
      o.frequency.value = freq;
      o.connect(env);
      o.start(t);
    }
    osc2.detune.value = this.params.detune;
    env.connect(this.filter);
    this.voices.set(note, { osc, osc2, env });
  }

  private noteOff(note: number, t: number) {
    const v = this.voices.get(note);
    if (!v) return;
    this.voices.delete(note);
    v.env.gain.cancelScheduledValues(t);
    v.env.gain.setValueAtTime(v.env.gain.value, t);
    v.env.gain.linearRampToValueAtTime(0, t + this.params.release);
    v.osc.stop(t + this.params.release + 0.01);
    v.osc2.stop(t + this.params.release + 0.01);
    v.osc.onended = () => v.env.disconnect();
  }

  hasGui() { return true; }

  async createGui() {
    const el = document.createElement('div');
    el.className = 'builtin-gui';
    const row = (label: string, input: HTMLElement) => {
      const l = document.createElement('label');
      l.textContent = label;
      l.append(input);
      el.append(l);
    };
    const wave = document.createElement('select');
    for (const w of ['sawtooth', 'square', 'triangle', 'sine']) wave.add(new Option(w, w, false, w === this.params.wave));
    wave.onchange = () => { this.params.wave = wave.value as OscillatorType; };
    row('Wave', wave);
    const slider = (key: 'cutoff' | 'resonance' | 'attack' | 'release' | 'detune', min: number, max: number, step: number) => {
      const s = document.createElement('input');
      Object.assign(s, { type: 'range', min, max, step, value: String(this.params[key]) });
      s.oninput = () => { this.params[key] = Number(s.value); this.applyParams(); };
      row(key[0].toUpperCase() + key.slice(1), s);
    };
    slider('cutoff', 80, 12000, 1);
    slider('resonance', 0.1, 20, 0.1);
    slider('attack', 0.001, 1, 0.001);
    slider('release', 0.01, 3, 0.01);
    slider('detune', 0, 50, 1);
    return el;
  }

  destroyGui() {}

  async getState() { return { ...this.params }; }
  async setState(s: unknown) { Object.assign(this.params, s); this.applyParams(); }

  dispose() {
    for (const n of [...this.voices.keys()]) this.noteOff(n, this.ctx.currentTime);
    this.output.disconnect();
  }
}
