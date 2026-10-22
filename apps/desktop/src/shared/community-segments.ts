// Community skip times from TheIntroDB (api.theintrodb.org) and IntroDB (api.introdb.app), for titles the server has
// no markers for. Pure and erasable TypeScript (tools/checks/community-segments-check.mjs runs it, the TV web app
// reuses it): request URLs, response parsing with sanity drops, and the per-kind merge of every marker source.
import type { MediaMarkers, SkipSegment } from './contract';

type Ids = Record<string, string> | undefined;

export interface CommunityTarget {
  tmdb?: string;
  tvdb?: string;
  imdb?: string;
  season?: number;
  episode?: number;
}

const idOf = (ids: Ids, name: string) => Object.entries(ids ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
const num = (v?: string) => (v && /^\d{1,10}$/.test(v) ? v : undefined);

// A movie by its own ids; an episode by its series' ids with its season and episode numbers. Null without an id.
export function communityTarget(item: { Type?: string; ParentIndexNumber?: number; IndexNumber?: number }, ids: Ids): CommunityTarget | null {
  const imdbRaw = idOf(ids, 'imdb');
  const t: CommunityTarget = { tmdb: num(idOf(ids, 'tmdb')), tvdb: num(idOf(ids, 'tvdb')), imdb: imdbRaw && /^tt\d{5,10}$/.test(imdbRaw) ? imdbRaw : undefined };
  if (!t.tmdb && !t.tvdb && !t.imdb) return null;
  if (item.Type === 'Movie') return t;
  if (item.Type !== 'Episode' || item.ParentIndexNumber === undefined || item.ParentIndexNumber < 0 || !item.IndexNumber || item.IndexNumber < 1) return null;
  return { ...t, season: item.ParentIndexNumber, episode: item.IndexNumber };
}

const episodeQuery = (t: CommunityTarget) => (t.season === undefined ? '' : `&season=${t.season}&episode=${t.episode}`);

// One id, TVDB first (TheIntroDB's own identity), then TMDB, then IMDb (as the Android apps).
export function theIntroDbUrl(t: CommunityTarget): string {
  const id = t.tvdb ? `tvdb_id=${t.tvdb}` : t.tmdb ? `tmdb_id=${t.tmdb}` : `imdb_id=${t.imdb}`;
  return `https://api.theintrodb.org/v4/media?${id}${episodeQuery(t)}`;
}

// IntroDB only knows IMDb ids.
export function introDbUrl(t: CommunityTarget): string | null {
  if (!t.imdb) return null;
  return `https://api.introdb.app/segments?imdb_id=${t.imdb}${t.season === undefined ? '&is_movie=true' : episodeQuery(t)}`;
}

export type CommunityKind = 'intro' | 'recap' | 'credits' | 'preview';
export type CommunityTimes = Partial<Record<CommunityKind, { startMs: number; endMs: number }>>;

// Drop what cannot be right: an empty or reversed span, a negative start, an end past the runtime (+5 s).
function sane(startMs: unknown, endMs: unknown, runtimeMs: number): { startMs: number; endMs: number } | undefined {
  if (typeof startMs !== 'number' || typeof endMs !== 'number' || !isFinite(startMs) || !isFinite(endMs)) return undefined;
  if (startMs < 0 || endMs <= startMs || (runtimeMs > 0 && endMs > runtimeMs + 5000)) return undefined;
  return { startMs: Math.round(startMs), endMs: Math.round(endMs) };
}

interface TidbSpan {
  start_ms?: number | null;
  end_ms?: number | null;
}

// TheIntroDB GET /v4/media. Only the grouped shape has times (the "versions" and "episodes" shapes have none). Each
// kind is a list; a null start means the start of the media (intro, recap only), a null end its end (credits,
// preview only); a null anywhere else drops the span.
export function theIntroDbTimes(body: unknown, runtimeMs: number): CommunityTimes {
  const out: CommunityTimes = {};
  if (!body || typeof body !== 'object') return out;
  for (const kind of ['intro', 'recap', 'credits', 'preview'] as const) {
    const list = (body as Record<string, unknown>)[kind];
    if (!Array.isArray(list)) continue;
    const spans = (list as TidbSpan[])
      .map((s) => {
        const head = kind === 'intro' || kind === 'recap';
        const start = s?.start_ms == null && head ? 0 : s?.start_ms;
        const end = s?.end_ms == null && !head && runtimeMs > 0 ? runtimeMs : s?.end_ms;
        return sane(start, end, runtimeMs);
      })
      .filter((s): s is { startMs: number; endMs: number } => !!s)
      .sort((a, b) => a.startMs - b.startMs);
    if (spans[0]) out[kind] = spans[0];
  }
  return out;
}

interface IdbSpan {
  start_ms?: number;
  end_ms?: number;
  start_sec?: number;
  end_sec?: number;
}

// IntroDB GET /segments: intro, recap and outro (the end credits) as null or one span; post_credits is not skipped.
export function introDbTimes(body: unknown, runtimeMs: number): CommunityTimes {
  const out: CommunityTimes = {};
  if (!body || typeof body !== 'object') return out;
  for (const [key, kind] of [['intro', 'intro'], ['recap', 'recap'], ['outro', 'credits']] as const) {
    const s = (body as Record<string, IdbSpan | null | undefined>)[key];
    if (!s || typeof s !== 'object') continue;
    const span = sane(s.start_ms ?? (s.start_sec ?? NaN) * 1000, s.end_ms ?? (s.end_sec ?? NaN) * 1000, runtimeMs);
    if (span) out[kind] = span;
  }
  return out;
}

// The player's markers: a credits start at 0 would mark the item watched as it starts (markers.ts). Null when empty.
export function communityMarkers(t: CommunityTimes): MediaMarkers | null {
  const segments: SkipSegment[] = [];
  if (t.recap) segments.push({ type: 'recap', ...t.recap });
  if (t.preview) segments.push({ type: 'preview', ...t.preview });
  const credits = t.credits && t.credits.startMs > 0 ? t.credits.startMs : undefined;
  if (!t.intro && credits === undefined && !segments.length) return null;
  const m: MediaMarkers = { introStartMs: t.intro?.startMs, introEndMs: t.intro?.endMs, creditsStartMs: credits };
  return segments.length ? { ...m, segments: segments.sort((a, b) => a.startMs - b.startMs) } : m;
}

// Per kind, the first source that has it wins: pass them as server, TheIntroDB, IntroDB, AniSkip. Null when empty.
export function mergeMarkers(...sources: (MediaMarkers | null | undefined)[]): MediaMarkers | null {
  const list = sources.filter((m): m is MediaMarkers => !!m);
  const intro = list.find((m) => m.introStartMs !== undefined && m.introEndMs !== undefined);
  const creditsStartMs = list.find((m) => m.creditsStartMs !== undefined)?.creditsStartMs;
  const segments: SkipSegment[] = [];
  for (const type of ['recap', 'preview', 'commercial'] as const) {
    const from = list.find((m) => m.segments?.some((s) => s.type === type));
    if (from) segments.push(...from.segments!.filter((s) => s.type === type));
  }
  if (!intro && creditsStartMs === undefined && !segments.length) return null;
  const m: MediaMarkers = { introStartMs: intro?.introStartMs, introEndMs: intro?.introEndMs, creditsStartMs };
  return segments.length ? { ...m, segments: segments.sort((a, b) => a.startMs - b.startMs) } : m;
}

// What the server already covers, so a title with every kind marked asks nobody.
export function missingKinds(m: MediaMarkers | null | undefined): boolean {
  const has = (type: string) => !!m?.segments?.some((s) => s.type === type);
  return m?.introEndMs === undefined || m?.creditsStartMs === undefined || !has('recap') || !has('preview');
}
