/** Everything a track needs from a loaded plugin, regardless of where it runs. */
export type PluginKind = 'builtin' | 'wam' | 'bridge';

/** Serializable reference used to re-create a plugin when loading a project. */
export interface PluginRef {
  kind: PluginKind;
  /** builtin id, WAM module URL, or bridge plugin identifier string */
  id: string;
  name: string;
}

export interface PluginSlot {
  readonly ref: PluginRef;
  readonly isInstrument: boolean;
  /** Audio goes in here (null for pure instruments). */
  readonly input: AudioNode | null;
  readonly output: AudioNode;
  /** Extra latency this slot adds, in milliseconds (bridge round-trip). */
  latencyMs(): number;
  /** Raw MIDI bytes; time is AudioContext time (defaults to now). */
  sendMidi(bytes: number[], time?: number): void;
  hasGui(): boolean;
  /** Returns an element to show in the host window, or null if the GUI opens elsewhere (native window). */
  createGui(): Promise<HTMLElement | null>;
  destroyGui(el: HTMLElement | null): void;
  getState(): Promise<unknown>;
  setState(state: unknown): Promise<void>;
  dispose(): void;
}
