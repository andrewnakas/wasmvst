import type { PluginRef, PluginSlot } from '../plugins/PluginSlot';

export type TrackSource = 'instrument' | 'testloop' | 'input';

export interface InsertEntry { slot: PluginSlot; bypass: boolean }

export interface TrackJSON {
  name: string;
  source: TrackSource;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  instrument: { ref: PluginRef; state: unknown } | null;
  inserts: { ref: PluginRef; state: unknown; bypass: boolean }[];
}

let nextTrackId = 1;

/**
 * One mixer channel: source → [instrument] → inserts… → fader → pan → meters → bus.
 * The whole chain is rebuilt on every structural change; that's cheap and avoids
 * stale connections between plugin nodes.
 */
export class Track extends EventTarget {
  readonly id = nextTrackId++;
  name: string;
  source: TrackSource;
  instrument: PluginSlot | null = null;
  inserts: InsertEntry[] = [];
  mute = false;
  solo = false;
  /** Audio from test loop / live input enters here. */
  readonly audioIn: GainNode;
  readonly fader: GainNode;
  readonly panner: StereoPannerNode;
  readonly meterL: AnalyserNode;
  readonly meterR: AnalyserNode;
  private readonly muteGain: GainNode;

  constructor(private ctx: AudioContext, bus: AudioNode, name: string, source: TrackSource) {
    super();
    this.name = name;
    this.source = source;
    this.audioIn = ctx.createGain();
    this.fader = ctx.createGain();
    this.panner = ctx.createStereoPanner();
    this.muteGain = ctx.createGain();
    this.meterL = ctx.createAnalyser();
    this.meterR = ctx.createAnalyser();
    this.meterL.fftSize = this.meterR.fftSize = 512;
    const split = ctx.createChannelSplitter(2);
    this.fader.connect(this.panner).connect(this.muteGain);
    this.muteGain.connect(bus);
    this.muteGain.connect(split);
    split.connect(this.meterL, 0);
    split.connect(this.meterR, 1);
    this.rewire();
  }

  get volume() { return this.fader.gain.value; }
  set volume(v: number) { this.fader.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01); }
  get pan() { return this.panner.pan.value; }
  set pan(v: number) { this.panner.pan.setTargetAtTime(v, this.ctx.currentTime, 0.01); }

  /** Called by the engine with the solo state of all tracks. */
  updateAudible(anySolo: boolean) {
    const audible = !this.mute && (!anySolo || this.solo);
    this.muteGain.gain.setTargetAtTime(audible ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  rewire() {
    this.audioIn.disconnect();
    this.instrument?.output.disconnect();
    for (const { slot } of this.inserts) slot.output.disconnect();

    let head: AudioNode | null = this.source === 'instrument' ? this.instrument?.output ?? null : this.audioIn;
    for (const ins of this.inserts) {
      if (ins.bypass) continue;
      if (head && ins.slot.input) head.connect(ins.slot.input);
      // An instrument dropped into the insert chain replaces the signal (like Live).
      if (ins.slot.input || ins.slot.isInstrument) head = ins.slot.output;
    }
    head?.connect(this.fader);
    this.dispatchEvent(new Event('change'));
  }

  setInstrument(slot: PluginSlot | null) {
    this.instrument?.dispose();
    this.instrument = slot;
    if (slot) this.source = 'instrument';
    this.rewire();
  }

  addInsert(slot: PluginSlot, index = this.inserts.length) {
    this.inserts.splice(index, 0, { slot, bypass: false });
    this.rewire();
  }

  removeInsert(i: number) {
    const [ins] = this.inserts.splice(i, 1);
    ins?.slot.dispose();
    this.rewire();
  }

  moveInsert(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= this.inserts.length) return;
    [this.inserts[i], this.inserts[j]] = [this.inserts[j], this.inserts[i]];
    this.rewire();
  }

  setBypass(i: number, bypass: boolean) {
    this.inserts[i].bypass = bypass;
    this.rewire();
  }

  setSource(src: TrackSource) {
    this.source = src;
    this.rewire();
  }

  /** Latency of the chain in ms (bridge plugins add network delay). */
  latencyMs() {
    let ms = this.source === 'instrument' ? this.instrument?.latencyMs() ?? 0 : 0;
    for (const i of this.inserts) if (!i.bypass) ms += i.slot.latencyMs();
    return ms;
  }

  /** Every slot that should receive this track's MIDI. */
  midiTargets(): PluginSlot[] {
    const t: PluginSlot[] = [];
    if (this.instrument) t.push(this.instrument);
    for (const i of this.inserts) if (i.slot.isInstrument) t.push(i.slot);
    return t;
  }

  async toJSON(): Promise<TrackJSON> {
    return {
      name: this.name,
      source: this.source,
      volume: this.volume,
      pan: this.pan,
      mute: this.mute,
      solo: this.solo,
      instrument: this.instrument ? { ref: this.instrument.ref, state: await this.instrument.getState().catch(() => null) } : null,
      inserts: await Promise.all(
        this.inserts.map(async (i) => ({ ref: i.slot.ref, state: await i.slot.getState().catch(() => null), bypass: i.bypass })),
      ),
    };
  }

  dispose() {
    this.instrument?.dispose();
    for (const i of this.inserts) i.slot.dispose();
    this.audioIn.disconnect();
    this.muteGain.disconnect();
  }
}
