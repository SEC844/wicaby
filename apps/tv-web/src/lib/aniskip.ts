// AniSkip (api.aniskip.com: community opening, ending and recap times keyed by MyAnimeList id) for anime episodes
// the server has no intro or credits markers for, as core AniSkip.kt with the desktop's pure shared/aniskip.ts.
// A third party: off by default (Settings > Playback). Sends only the ids, the episode number and its length.
import { aniskipMarkers, aniskipTarget, aniskipUrl } from '$shared/aniskip';
import type { BaseItem } from '$shared/models';
import type { Api } from './api';
import type { Segments, SkipRange } from './segments';

// In memory for the run: one answer per (MAL id, episode), one MAL id per AniList id.
const cache = new Map<string, Segments | null>();
const malOfAnilist = new Map<number, number | null>();

// AniSkip answers "not found" with a 404 and a JSON body.
async function fetchJson(url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok && res.status !== 404) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

async function malOf(anilist: number): Promise<number | null> {
  if (malOfAnilist.has(anilist)) return malOfAnilist.get(anilist)!;
  const r = (await fetchJson('https://graphql.anilist.co', { query: 'query($id:Int){Media(id:$id,type:ANIME){idMal}}', variables: { id: anilist } })) as {
    data?: { Media?: { idMal?: number | null } };
  };
  const mal = r?.data?.Media?.idMal ?? null;
  malOfAnilist.set(anilist, mal);
  return mal;
}

// Intro, credits and recap of an anime episode whose season or series has a MyAnimeList or AniList id.
export async function aniskipSegments(api: Api, item: BaseItem): Promise<Segments | null> {
  const lengthMs = (item.RunTimeTicks ?? 0) / 10_000;
  if (item.Type !== 'Episode' || !item.SeasonId || !item.SeriesId || lengthMs <= 0) return null;
  const [season, series] = await Promise.all([api.item(item.SeasonId), api.item(item.SeriesId)]);
  const target = aniskipTarget(item, season.ProviderIds, series.ProviderIds);
  if (!target) return null;
  const mal = target.mal ?? (target.anilist ? await malOf(target.anilist) : null);
  if (!mal) return null;
  const key = `${mal}:${target.episode}`;
  if (cache.has(key)) return cache.get(key)!;
  const m = aniskipMarkers(await fetchJson(aniskipUrl(mal, target.episode, lengthMs)));
  const ranges: SkipRange[] = [];
  if (m?.introStartMs !== undefined && m.introEndMs !== undefined) ranges.push({ kind: 'Intro', startMs: m.introStartMs, endMs: m.introEndMs });
  for (const s of m?.segments ?? []) if (s.type === 'recap') ranges.push({ kind: 'Recap', startMs: s.startMs, endMs: s.endMs });
  const out = m ? { credits: m.creditsStartMs, ranges: ranges.sort((a, b) => a.startMs - b.startMs) } : null;
  cache.set(key, out);
  return out;
}

// The server's recap, preview and commercial ranges win over AniSkip's.
export function mergeAniskip(server: Segments, a: Segments): Segments {
  return { credits: a.credits, ranges: [...server.ranges, ...a.ranges.filter((r) => !server.ranges.some((x) => x.kind === r.kind))].sort((x, y) => x.startMs - y.startMs) };
}
