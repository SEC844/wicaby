// Fields read from a Kodi-style NFO (file-sources-spec §4.2). Regex-based on purpose, like cast/dlna.ts:
// no DTD, no entity expansion beyond the five XML ones and numeric references. Pure; vectors in
// tools/checks/fixtures/files/nfo.json. The caller caps the input at MAX_NFO_BYTES.

export const MAX_NFO_BYTES = 256 * 1024;

export interface NfoInfo {
  kind: 'movie' | 'episode' | 'tvshow' | 'url';
  title?: string;
  year?: number;
  plot?: string;
  season?: number;
  episode?: number;
  runtimeMin?: number;
  genres: string[];
  providerIds: Record<string, string>;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h: string) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d{1,7});/g, (m, d: string) => safeChar(Number(d), m))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function safeChar(cp: number, fallback: string): string {
  return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : fallback;
}

// Text of every <tag ...>text</tag> directly in body (no nested tag of that name expected).
function all(body: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  return [...body.matchAll(re)].map((m) => decode(m[1])).filter(Boolean);
}

const first = (body: string, tag: string): string | undefined => all(body, tag)[0];

function int(v: string | undefined): number | undefined {
  const n = v !== undefined && /^\d{1,6}$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

// Null when it is neither an NFO document nor a bare IMDb/TMDB link.
export function parseNfo(text: string): NfoInfo | null {
  const root = /<(movie|episodedetails|tvshow)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/i.exec(text);
  if (!root) {
    const imdb = /\b(tt\d{7,9})\b/.exec(text)?.[1];
    const tmdb = /themoviedb\.org\/(?:movie|tv)\/(\d{1,9})/.exec(text)?.[1];
    if (!imdb && !tmdb) return null;
    return { kind: 'url', genres: [], providerIds: { ...(imdb ? { Imdb: imdb } : {}), ...(tmdb ? { Tmdb: tmdb } : {}) } };
  }
  const kind = root[1].toLowerCase() === 'movie' ? 'movie' : root[1].toLowerCase() === 'tvshow' ? 'tvshow' : 'episode';
  const body = root[2];
  const out: NfoInfo = { kind, genres: all(body, 'genre').slice(0, 20), providerIds: {} };
  const title = first(body, 'title');
  if (title) out.title = title;
  const year = int(first(body, 'year')) ?? int(/^(\d{4})-/.exec(first(body, 'premiered') ?? first(body, 'aired') ?? '')?.[1]);
  if (year && year >= 1870 && year <= 2200) out.year = year;
  const plot = first(body, 'plot') ?? first(body, 'outline');
  if (plot) out.plot = plot;
  const season = int(first(body, 'season'));
  const episode = int(first(body, 'episode'));
  if (season !== undefined) out.season = season;
  if (episode !== undefined) out.episode = episode;
  const runtime = int(first(body, 'runtime'));
  if (runtime) out.runtimeMin = runtime;
  // <uniqueid type="imdb">tt…</uniqueid>, then the older <imdbid>, <tmdbid>, <id>.
  for (const m of body.matchAll(/<uniqueid\s[^>]*type\s*=\s*["']([a-z]+)["'][^>]*>([^<]{1,64})<\/uniqueid>/gi)) {
    const type = m[1].toLowerCase();
    const name = type === 'imdb' ? 'Imdb' : type === 'tmdb' ? 'Tmdb' : type === 'tvdb' ? 'Tvdb' : null;
    if (name && !out.providerIds[name]) out.providerIds[name] = decode(m[2]);
  }
  const imdb = first(body, 'imdbid') ?? first(body, 'imdb_id') ?? (/^tt\d{7,9}$/.test(first(body, 'id') ?? '') ? first(body, 'id') : undefined);
  if (imdb && !out.providerIds.Imdb) out.providerIds.Imdb = imdb;
  const tmdb = first(body, 'tmdbid');
  if (tmdb && !out.providerIds.Tmdb) out.providerIds.Tmdb = tmdb;
  for (const [k, v] of Object.entries(out.providerIds)) if (!/^[A-Za-z0-9_-]{1,32}$/.test(v)) delete out.providerIds[k];
  return out;
}
