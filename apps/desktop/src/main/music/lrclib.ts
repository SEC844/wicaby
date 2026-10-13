// Online lyrics from lrclib.net (music-spec MU-13): off by default (Settings > Audio), asked only when the server has
// none, from main so the renderer's CSP stays closed. It sends the artist, title, album and duration to a third party
// (docs/features.md). Answers, "not found" included, are cached per track id for 30 days; a failure is not cached.
import type { LrclibTrack } from '../../shared/contract';
import { parseLrc, type Lyrics } from '../../shared/music';

export const LRCLIB = 'https://lrclib.net';
export const LRCLIB_TTL_MS = 30 * 24 * 3600_000;
const MAX_TEXT = 200_000;

// Dev builds and checks point it at the loopback mock (LRCLIB_BASE, tools/mock-server /mock/lrclib); a packaged build
// ignores it, as anything that is not loopback.
export function lrclibBase(env: string | undefined, packaged: boolean): string {
  const v = env?.replace(/\/+$/, '');
  return !packaged && v && /^http:\/\/(127\.0\.0\.1|localhost):\d+(\/[\w/-]*)?$/.test(v) ? v : LRCLIB;
}

export type LrclibCache = Record<string, { at: number; lyrics: Lyrics | null }>;

export interface LrclibOptions {
  base: string;
  userAgent: string;
  // Read at each call: the setting can change while the app runs.
  enabled: () => boolean;
  // A JsonStore in the app; a plain object in tools/checks/lrclib-check.mjs.
  cache: { readonly value: LrclibCache; update(fn: (c: LrclibCache) => LrclibCache | void): void };
  fetch?: typeof fetch;
  now?: () => number;
}

// LRCLIB's /api/get answer: synced lyrics first, plain ones otherwise; instrumental or empty = none.
export function fromLrclib(b: unknown): Lyrics | null {
  const o = (b ?? {}) as { instrumental?: unknown; syncedLyrics?: unknown; plainLyrics?: unknown };
  if (o.instrumental === true) return null;
  for (const text of [o.syncedLyrics, o.plainLyrics]) {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) continue;
    const l = parseLrc(text);
    if (l.lines.length) return l;
  }
  return null;
}

export async function lrclibLyrics(track: LrclibTrack, o: LrclibOptions): Promise<Lyrics | null> {
  if (!o.enabled()) return null;
  const now = (o.now ?? Date.now)();
  const hit = o.cache.value[track.id];
  if (hit && now - hit.at < LRCLIB_TTL_MS) return hit.lyrics;
  const q = new URLSearchParams({ artist_name: track.artist, track_name: track.title, album_name: track.album, duration: String(Math.round(track.durationMs / 1000)) });
  let lyrics: Lyrics | null = null;
  try {
    const res = await (o.fetch ?? fetch)(`${o.base}/api/get?${q}`, { headers: { 'User-Agent': o.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) lyrics = fromLrclib(await res.json());
    // Anything but "not found" may work next time: not cached.
    else if (res.status !== 404) return null;
  } catch {
    return null;
  }
  o.cache.update((c) => {
    for (const [id, e] of Object.entries(c)) if (now - e.at >= LRCLIB_TTL_MS) delete c[id];
    c[track.id] = { at: now, lyrics };
  });
  return lyrics;
}
