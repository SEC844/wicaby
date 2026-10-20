// AniSkip (api.aniskip.com, community opening/ending times keyed by MyAnimeList id) for anime episodes the
// server has no intro or credits markers for. Pure and erasable TypeScript: tools/checks/aniskip-check.mjs runs
// it, and Android's player/AniSkip.kt follows the same rules (both read tools/checks/fixtures/aniskip.json).
import type { MediaMarkers } from './contract';

export interface AniSkipTarget {
  mal?: number;
  anilist?: number;
  episode: number;
}

type Ids = Record<string, string> | undefined;

// ProviderIds spellings of the anime plugins (Emby/Jellyfin MyAnimeList, AniList); keys compared case-insensitively.
function idOf(ids: Ids, names: string[]): number | undefined {
  const v = Object.entries(ids ?? {}).find(([k]) => names.includes(k.toLowerCase()))?.[1];
  return v && /^\d{1,9}$/.test(v) ? Number(v) : undefined;
}

function target(ids: Ids, episode: number): AniSkipTarget | null {
  const mal = idOf(ids, ['myanimelist', 'mal']);
  const anilist = idOf(ids, ['anilist']);
  return mal || anilist ? { mal, anilist, episode } : null;
}

// MAL numbers episodes per entry, and each season of an anime is its own entry: a season with its own id uses it,
// the series id only in season 1. Anything else (specials, a later season with only a series id) would risk
// another season's times, so it is skipped.
export function aniskipTarget(episode: { IndexNumber?: number; ParentIndexNumber?: number }, seasonIds: Ids, seriesIds: Ids): AniSkipTarget | null {
  const ep = episode.IndexNumber;
  if (!ep || ep < 1 || !episode.ParentIndexNumber) return null;
  return target(seasonIds, ep) ?? (episode.ParentIndexNumber === 1 ? target(seriesIds, ep) : null);
}

export function aniskipUrl(mal: number, episode: number, lengthMs: number): string {
  const types = ['op', 'ed', 'mixed-op', 'mixed-ed', 'recap'].map((t) => `types[]=${t}`).join('&');
  return `https://api.aniskip.com/v2/skip-times/${mal}/${episode}?${types}&episodeLength=${Math.round(lengthMs / 1000)}`;
}

interface Result {
  interval?: { startTime?: number; endTime?: number };
  skipType?: string;
}

// The earliest opening as the intro, the earliest ending's start as the credits, a recap as a segment. Null when none.
export function aniskipMarkers(body: unknown): MediaMarkers | null {
  const results = (body as { found?: boolean; results?: Result[] } | null)?.found ? ((body as { results?: Result[] }).results ?? []) : [];
  const spans = results
    .map((r) => ({ type: r.skipType ?? '', start: Math.round((r.interval?.startTime ?? -1) * 1000), end: Math.round((r.interval?.endTime ?? -1) * 1000) }))
    .filter((s) => s.start >= 0 && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const op = spans.find((s) => s.type === 'op' || s.type === 'mixed-op');
  // A credits marker at 0 would mark the item watched as it starts (markers.ts).
  const ed = spans.find((s) => (s.type === 'ed' || s.type === 'mixed-ed') && s.start > 0);
  const recap = spans.find((s) => s.type === 'recap');
  if (!op && !ed && !recap) return null;
  const m: MediaMarkers = { introStartMs: op?.start, introEndMs: op?.end, creditsStartMs: ed?.start };
  return recap ? { ...m, segments: [{ type: 'recap', startMs: recap.start, endMs: recap.end }] } : m;
}
