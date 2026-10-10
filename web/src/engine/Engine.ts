import { Track, type TrackJSON, type TrackSource } from './Track';
import { loadPlugin } from '../plugins/loadPlugin';
import { makeTestLoop } from './testLoop';

export interface ProjectJSON { version: 1; bpm: number; tracks: TrackJSON[] }

/** AudioContext owner, master bus, track list and transport. */
export class Engine extends EventTarget {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly masterMeterL: AnalyserNode;
  readonly masterMeterR: AnalyserNode;
  tracks: Track[] = [];
  selected: Track | null = null;
  bpm = 120;
  metronome = false;
  playing = false;
  private startedAt = 0;
  private loopSources: AudioBufferSourceNode[] = [];
  private clickTimer = 0;
  private nextClickBeat = 0;
  private liveInput: MediaStreamAudioSourceNode | null = null;

  constructor() {
    super();
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    const split = this.ctx.createChannelSplitter(2);
    this.masterMeterL = this.ctx.createAnalyser();
    this.masterMeterR = this.ctx.createAnalyser();
    this.master.connect(this.ctx.destination);
    this.master.connect(split);
    split.connect(this.masterMeterL, 0);
    split.connect(this.masterMeterR, 1);
  }

  private changed() { this.dispatchEvent(new Event('change')); }

  addTrack(source: TrackSource = 'instrument', name?: string): Track {
    const t = new Track(this.ctx, this.master, name ?? `${this.tracks.length + 1} ${source === 'instrument' ? 'MIDI' : 'Audio'}`, source);
    this.tracks.push(t);
    t.addEventListener('change', () => this.changed());
    this.selected = t;
    this.updateSolo();
    if (source === 'input') this.attachLiveInput(t);
    if (source === 'testloop' && this.playing) this.startLoop(t, this.ctx.currentTime + 0.05);
    this.changed();
    return t;
  }

  removeTrack(t: Track) {
    t.dispose();
    this.tracks = this.tracks.filter((x) => x !== t);
    if (this.selected === t) this.selected = this.tracks.at(-1) ?? null;
    this.updateSolo();
    this.changed();
  }

  select(t: Track) {
    this.selected = t;
    this.changed();
  }

  async setTrackSource(t: Track, src: TrackSource) {
    t.setSource(src);
    if (src === 'input') await this.attachLiveInput(t);
    if (src === 'testloop' && this.playing) this.restartTransport();
  }

  updateSolo() {
    const anySolo = this.tracks.some((t) => t.solo);
    for (const t of this.tracks) t.updateAudible(anySolo);
  }

  private async attachLiveInput(t: Track) {
    if (!this.liveInput) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.liveInput = this.ctx.createMediaStreamSource(stream);
    }
    this.liveInput.connect(t.audioIn);
  }

  // ---- transport ----

  get beatsPerSecond() { return this.bpm / 60; }

  /** Current position in beats. */
  positionBeats() {
    return this.playing ? (this.ctx.currentTime - this.startedAt) * this.beatsPerSecond : 0;
  }

  play() {
    if (this.playing) return;
    this.ctx.resume();
    this.playing = true;
    this.startedAt = this.ctx.currentTime + 0.05;
    for (const t of this.tracks) if (t.source === 'testloop') this.startLoop(t, this.startedAt);
    this.nextClickBeat = 0;
    this.clickTimer = window.setInterval(() => this.scheduleClicks(), 25);
    this.changed();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    for (const s of this.loopSources) s.stop();
    this.loopSources = [];
    clearInterval(this.clickTimer);
    for (const t of this.tracks) for (const p of t.midiTargets()) p.sendMidi([0xb0, 123, 0]);
    this.changed();
  }

  setBpm(bpm: number) {
    this.bpm = Math.min(999, Math.max(20, bpm));
    if (this.playing) this.restartTransport();
    this.changed();
  }

  private restartTransport() {
    this.stop();
    this.play();
  }

  private startLoop(t: Track, when: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = makeTestLoop(this.ctx, this.bpm);
    src.loop = true;
    src.connect(t.audioIn);
    // Join an already-running transport on the right beat.
    const offset = Math.max(0, (when - this.startedAt)) % src.buffer.duration;
    src.start(when, offset);
    this.loopSources.push(src);
  }

  private scheduleClicks() {
    const lookahead = this.ctx.currentTime + 0.1;
    for (;;) {
      const t = this.startedAt + this.nextClickBeat / this.beatsPerSecond;
      if (t > lookahead) break;
      if (this.metronome) {
        const osc = this.ctx.createOscillator();
        const env = this.ctx.createGain();
        osc.frequency.value = this.nextClickBeat % 4 === 0 ? 1600 : 1000;
        env.gain.setValueAtTime(0.3, t);
        env.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
        osc.connect(env).connect(this.master);
        osc.start(t);
        osc.stop(t + 0.06);
      }
      this.nextClickBeat++;
    }
  }

  // ---- MIDI ----

  /** Routes live MIDI to the selected track's instrument(s). */
  midiIn(bytes: number[]) {
    const t = this.selected;
    if (!t) return;
    for (const p of t.midiTargets()) p.sendMidi(bytes);
  }

  // ---- project ----

  async toJSON(): Promise<ProjectJSON> {
    return { version: 1, bpm: this.bpm, tracks: await Promise.all(this.tracks.map((t) => t.toJSON())) };
  }

  /** Rebuild from JSON; plugins that fail to load are reported, not fatal. */
  async load(p: ProjectJSON): Promise<string[]> {
    this.stop();
    for (const t of [...this.tracks]) this.removeTrack(t);
    this.bpm = p.bpm;
    const errors: string[] = [];
    for (const tj of p.tracks) {
      const t = this.addTrack(tj.source, tj.name);
      t.volume = tj.volume;
      t.pan = tj.pan;
      t.mute = tj.mute;
      t.solo = tj.solo;
      if (tj.instrument) {
        try {
          t.setInstrument(await loadPlugin(this.ctx, tj.instrument.ref, tj.instrument.state ?? undefined, true));
          t.setSource(tj.source);
        } catch (e) {
          errors.push(`${tj.instrument.ref.name}: ${(e as Error).message}`);
        }
      }
      for (const ij of tj.inserts) {
        try {
          t.addInsert(await loadPlugin(this.ctx, ij.ref, ij.state ?? undefined));
          if (ij.bypass) t.setBypass(t.inserts.length - 1, true);
        } catch (e) {
          errors.push(`${ij.ref.name}: ${(e as Error).message}`);
        }
      }
    }
    this.updateSolo();
    this.changed();
    return errors;
  }
}
