// Music equalizer (music-spec MU-11): 10 octave-wide peaking bands and a preamp. Desktop: mpv's `af` (eqAf below);
// Android: core/player/AudioFx.kt, with the same frequencies and presets (keep both tables in step).
export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const EQ_MAX_DB = 12;

export const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  vocal: [-2, -2, -1, 0, 2, 4, 4, 2, 0, -1],
  treble: [0, 0, 0, 0, 0, 0, 2, 4, 5, 6],
} as const satisfies Record<string, readonly number[]>;
export type EqPreset = keyof typeof EQ_PRESETS;

export interface EqSettings {
  bands: number[];
  preampDb: number;
}

// The preset these bands are, or 'custom'.
export function presetOf(bands: readonly number[]): EqPreset | 'custom' {
  const hit = (Object.keys(EQ_PRESETS) as EqPreset[]).find((p) => EQ_PRESETS[p].every((g, i) => g === bands[i]));
  return hit ?? 'custom';
}

// Out-of-range or malformed input becomes flat; gains are kept to half a dB.
export function sanitizeEq(v: unknown): EqSettings {
  const o = (v ?? {}) as Partial<EqSettings>;
  const db = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(Math.min(EQ_MAX_DB, Math.max(-EQ_MAX_DB, n)) * 2) / 2 : 0);
  const bands = Array.isArray(o.bands) && o.bands.length === EQ_FREQS.length ? o.bands.map(db) : [...EQ_PRESETS.flat];
  return { bands, preampDb: db(o.preampDb) };
}

// mpv's `af` value: '' when flat (no filter at all, so the bit-perfect path stays untouched). The preamp goes first;
// with preventClipping the loudest boost is taken off it, so a +6 dB bass never clips a full-scale master.
export function eqAf(eq: EqSettings, preventClipping = true): string {
  const headroom = preventClipping ? Math.max(0, ...eq.bands) : 0;
  const volume = eq.preampDb - headroom;
  const bands = eq.bands.flatMap((g, i) => (g ? [`equalizer=f=${EQ_FREQS[i]}:t=o:w=1:g=${g}`] : []));
  if (!bands.length && !eq.preampDb) return '';
  return [...(volume ? [`volume=volume=${volume}dB`] : []), ...bands].join(',');
}
