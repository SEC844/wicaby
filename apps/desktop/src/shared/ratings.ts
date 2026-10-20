// External ratings (IMDb, Rotten Tomatoes, Metacritic, Letterboxd, TMDb) from MDBList, keyed by the item's
// provider ids. Shared by main (desktop), the web TV bridge and tools/checks/ratings-check.mjs; Android has
// the same parser in core/ratings/Ratings.kt.

export const MDBLIST_API = 'https://api.mdblist.com';
// Where a user gets the free key (Settings → Library → Ratings).
export const MDBLIST_KEY_URL = 'https://mdblist.com/preferences/';
export const RATINGS_TTL_MS = 7 * 24 * 3600_000;
export const MDBLIST_KEY_RE = /^[A-Za-z0-9]{8,64}$/;

// Display order. popcorn: Rotten Tomatoes' audience score.
export const RATING_SOURCES = ['imdb', 'tomatoes', 'popcorn', 'metacritic', 'letterboxd', 'tmdb'] as const;
export type RatingSource = (typeof RATING_SOURCES)[number];

// value: IMDb 0-10, Letterboxd 0-5, every other source 0-100.
export interface ExternalRating {
  source: RatingSource;
  value: number;
}

// "imdb/movie/tt0111161" (or tmdb/show/1396): the MDBList route for a movie or series, imdb preferred; null
// for other types or without a usable id. ProviderIds keys differ in case between servers.
export function mdblistPath(item: { Type?: string; ProviderIds?: Record<string, string> }): string | null {
  const kind = item.Type === 'Movie' ? 'movie' : item.Type === 'Series' ? 'show' : null;
  if (!kind || !item.ProviderIds) return null;
  const id = (k: string) => Object.entries(item.ProviderIds ?? {}).find(([key]) => key.toLowerCase() === k)?.[1]?.trim();
  const imdb = id('imdb');
  if (imdb && /^tt\d{5,10}$/.test(imdb)) return `imdb/${kind}/${imdb}`;
  const tmdb = id('tmdb');
  return tmdb && /^\d{1,10}$/.test(tmdb) ? `tmdb/${kind}/${tmdb}` : null;
}

export const MDBLIST_PATH_RE = /^(imdb\/(movie|show)\/tt\d{5,10}|tmdb\/(movie|show)\/\d{1,10})$/;

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
};

// MDBList's answer → the known sources that have a value, in display order. Missing ratings come back as
// null, 0, "" or "N/A". TMDb's value is not always on 0-100: its normalized score is.
export function parseMdblist(json: unknown): ExternalRating[] {
  const list = json && typeof json === 'object' ? (json as { ratings?: unknown }).ratings : undefined;
  if (!Array.isArray(list)) return [];
  const out: ExternalRating[] = [];
  for (const source of RATING_SOURCES) {
    const r = list.find((x): x is Record<string, unknown> => !!x && typeof x === 'object' && (x as { source?: unknown }).source === source);
    const value = r ? num(source === 'tmdb' ? (r.score ?? r.value) : r.value) : null;
    const max = source === 'imdb' ? 10 : source === 'letterboxd' ? 5 : 100;
    if (value !== null && value <= max) out.push({ source, value });
  }
  return out;
}
