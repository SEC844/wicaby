// External ratings (IMDb, Rotten Tomatoes, Metacritic, Letterboxd, TMDb) from MDBList, as core Ratings.kt with the
// desktop's shared/ratings.ts: off until the user sets their MDBList key; then each movie or series page sends its
// IMDb or TMDb id to mdblist.com. Answers ("not found" too) are kept per route for 7 days on the TV; a failure is
// not kept. The key stays in the TV's storage (a TV has no keychain).
import { MDBLIST_API, MDBLIST_KEY_RE, mdblistPath, parseMdblist, RATINGS_TTL_MS, type ExternalRating } from '$shared/ratings';
import type { BaseItem } from '$shared/models';
import { k, locale, t } from './i18n.svelte';
import { load, save } from './storage';

const KEY = 'ratings_key';
const CACHE = 'ratings_cache';
// A TV browses far fewer titles in a week.
const CAP = 300;

export const ratings = $state({ configured: !!load<string>(KEY, '') });

// "" turns ratings off; false when [key] does not look like an MDBList key.
export function setRatingsKey(key: string): boolean {
  const k = key.trim();
  if (k && !MDBLIST_KEY_RE.test(k)) return false;
  save(KEY, k);
  save(CACHE, {});
  ratings.configured = !!k;
  return true;
}

export async function externalRatings(item: BaseItem): Promise<ExternalRating[]> {
  const key = load<string>(KEY, '');
  const path = mdblistPath(item);
  if (!key || !path) return [];
  const cache = load<Record<string, { at: number; ratings: ExternalRating[] }>>(CACHE, {});
  const hit = cache[path];
  if (hit && Date.now() - hit.at < RATINGS_TTL_MS) return hit.ratings;
  const res = await fetch(`${MDBLIST_API}/${path}?apikey=${encodeURIComponent(key)}`, { headers: { Accept: 'application/json' } });
  // An unknown title is kept like an answer; a bad key or the rate limit is not.
  if (!res.ok && res.status !== 404) throw new Error(`MDBList HTTP ${res.status}`);
  const found = res.ok ? parseMdblist(await res.json()) : [];
  const now = Date.now();
  const kept = Object.entries(cache).filter(([p, e]) => p !== path && now - e.at < RATINGS_TTL_MS).slice(-(CAP - 1));
  save(CACHE, Object.fromEntries([...kept, [path, { at: now, ratings: found }]]));
  return found;
}

const LABEL: Record<string, string> = {
  imdb: k('rating_imdb'),
  tomatoes: k('rating_tomatoes'),
  popcorn: k('rating_popcorn'),
  metacritic: k('rating_metacritic'),
  letterboxd: k('rating_letterboxd'),
  tmdb: k('rating_tmdb'),
};

// "IMDb 7,8", "RT 91 %"… in the UI's language.
export function ratingLabel(r: ExternalRating): string {
  return t(LABEL[r.source] ?? 'rating_tmdb', r.value.toLocaleString(locale.current, { maximumFractionDigits: 1 }));
}
