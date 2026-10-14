// Pure rules of the Feishin-inspired library UI (music-feishin-navidrome spec §4.C): the album's release type
// (C4), the next or previous album in the queue (C9), the multi-select of track rows (C3) and the full-screen
// player's quality badge (C6). tools/checks/music-ui-check.mjs runs them; core/music/MusicUi.kt is the Kotlin twin
// of releaseType, against the same fixtures/music/ui-vectors.json.

export type ReleaseType = 'album' | 'ep' | 'single' | 'compilation';

const VARIOUS = /^(various( artists)?|va|v\.a\.|artistes? divers|divers)$/i;
const HALF_HOUR_MS = 30 * 60_000;

// shortcut: Emby and Jellyfin send no release type, so it is guessed from the track count and length (the usual store
// rule: up to 3 tracks a single, up to 6 an EP, both under 30 min). Upgrade to OpenSubsonic releaseTypes with Navidrome.
export function releaseType(trackCount: number, durationMs: number, albumArtist?: string): ReleaseType {
  if (VARIOUS.test(albumArtist?.trim() ?? '')) return 'compilation';
  if (trackCount < 1 || durationMs >= HALF_HOUR_MS) return 'album';
  return trackCount <= 3 ? 'single' : trackCount <= 6 ? 'ep' : 'album';
}

// The queue index of the next album's first track (dir 1) or the previous album's first track (dir -1), from each
// queue entry's album id (undefined: a track alone). null when there is none.
export function albumJump(albums: readonly (string | undefined | null)[], index: number, dir: 1 | -1): number | null {
  const key = (i: number) => albums[i] ?? `#${i}`;
  const startOf = (i: number) => {
    while (i > 0 && key(i - 1) === key(i)) i--;
    return i;
  };
  if (index < 0 || index >= albums.length) return null;
  if (dir === 1) {
    for (let j = index + 1; j < albums.length; j++) if (key(j) !== key(index)) return j;
    return null;
  }
  const here = startOf(index);
  return here === 0 ? null : startOf(here - 1);
}

// The selection after a Ctrl-click (toggle [id]) or a Shift-click (the rows from [anchor] to [id]), in list order.
export function selectIds(selected: readonly string[], order: readonly string[], id: string, anchor: string | null, range: boolean): string[] {
  const set = new Set(selected);
  const a = anchor ? order.indexOf(anchor) : -1;
  const b = order.indexOf(id);
  if (range && a >= 0 && b >= 0) {
    set.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(order[i]);
  } else if (set.has(id)) set.delete(id);
  else set.add(id);
  return order.filter((x) => set.has(x));
}

// "FLAC · 16/44,1 kHz · 1 411 kbps": the codec, bit depth (when the server sends one) and sample rate, then the
// bitrate. num formats a number in the UI language.
export function audioBadge(s: { Codec?: string; BitDepth?: number; SampleRate?: number; BitRate?: number } | undefined, num: (n: number) => string = String): string {
  if (!s?.Codec) return '';
  const codec = s.Codec.toUpperCase();
  const out = [codec];
  const khz = s.SampleRate ? num(Math.round(s.SampleRate / 100) / 10) : '';
  if (s.BitDepth && khz) out.push(`${s.BitDepth}/${khz} kHz`);
  else if (khz) out.push(`${khz} kHz`);
  if (s.BitRate) out.push(`${num(Math.round(s.BitRate / 1000))} kbps`);
  return out.join(' · ');
}
