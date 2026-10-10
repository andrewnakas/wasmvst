const cache = new Map<string, AudioBuffer>();

/** One bar of synthesized drums + bass at the given tempo, so effects have something to chew on. */
export function makeTestLoop(ctx: BaseAudioContext, bpm: number): AudioBuffer {
  const key = `${ctx.sampleRate}:${bpm}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const sr = ctx.sampleRate;
  const beat = 60 / bpm;
  const len = Math.round(beat * 4 * sr);
  const buf = ctx.createBuffer(2, len, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const add = (start: number, dur: number, fn: (t: number) => number, panL = 1, panR = 1) => {
    const s0 = Math.round(start * sr);
    const n = Math.min(Math.round(dur * sr), len - s0);
    for (let i = 0; i < n; i++) {
      const v = fn(i / sr);
      L[s0 + i] += v * panL;
      R[s0 + i] += v * panR;
    }
  };
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let b = 0; b < 4; b++) {
    // kick
    add(b * beat, 0.35, (t) => Math.sin(2 * Math.PI * (50 * t + 90 * (1 - Math.exp(-t * 30)) / 30)) * Math.exp(-t * 9) * 0.9);
    // snare on 2 and 4
    if (b % 2 === 1) add(b * beat, 0.2, (t) => (noise() * 0.6 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * Math.exp(-t * 18) * 0.5);
    // hats on 8ths
    for (let h = 0; h < 2; h++) add(b * beat + (h * beat) / 2, 0.05, () => noise() * 0.15, 0.6, 1);
  }
  // bass line
  const notes = [36, 36, 39, 41];
  notes.forEach((n, b) => {
    const f = 440 * 2 ** ((n - 69) / 12);
    add(b * beat + beat / 2, beat / 2 * 0.9, (t) => {
      const ph = (f * t) % 1;
      return (ph * 2 - 1) * 0.25 * Math.min(1, t * 200) * Math.exp(-t * 3);
    });
  });
  cache.set(key, buf);
  return buf;
}
