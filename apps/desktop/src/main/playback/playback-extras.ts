// What the playback service loads after the first frame (loadExtras): Emby's intro skip mode and
// trick-play thumbnails, as BIF (Emby) or tiles (Jellyfin), and the AniSkip and community fallbacks for markers.
import { app, net } from 'electron';
import { aniskipMarkers, aniskipTarget, aniskipUrl } from '../../shared/aniskip';
import { communityMarkers, communityTarget, introDbTimes, introDbUrl, mergeMarkers, theIntroDbTimes, theIntroDbUrl } from '../../shared/community-segments';
import type { MediaMarkers, SkipMode, Trickplay } from '../../shared/contract';
import type { BaseItem, MediaSource } from '../../shared/models';
import { buildQuery, type ApiClient } from '../connection/api-client';
import { logger } from '../core/log';
import { userItem } from '../connection/user-routes';
import { mediaApiUrl } from './playback-model';

const log = logger.scope('playback');

export const EMBY_SKIP_MODE: Record<string, SkipMode> = { ShowButton: 'ask', AutoSkip: 'auto', None: 'off' };

// Jellyfin tile playlist: #EXT-X-TILES:RESOLUTION=320x180,LAYOUT=10x10,DURATION=10.000 then one sheet URI per tile.
function parseTilesM3u8(text: string): { width: number; height: number; tileWidth: number; tileHeight: number; intervalMs: number; sheets: number } | null {
  const m = /#EXT-X-TILES:.*?RESOLUTION=(\d+)x(\d+).*?LAYOUT=(\d+)x(\d+).*?DURATION=([\d.]+)/.exec(text);
  if (!m) return null;
  const sheets = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).length;
  return { width: +m[1], height: +m[2], tileWidth: +m[3], tileHeight: +m[4], intervalMs: Math.round(+m[5] * 1000), sheets };
}

export async function jellyfinTrickplay(api: ApiClient, item: BaseItem, source: MediaSource | undefined, serverId: string | undefined): Promise<Trickplay | null> {
  const q = buildQuery({ MediaSourceId: source?.Id });
  const widths = Object.values((source?.Id && item.Trickplay?.[source.Id]) || Object.values(item.Trickplay ?? {})[0] || {});
  const info = widths.sort((a, b) => Math.abs(a.Width - 320) - Math.abs(b.Width - 320))[0];
  if (info) {
    return {
      kind: 'tiles',
      url: mediaApiUrl(`/Videos/${item.Id}/Trickplay/${info.Width}/{n}.jpg${q}`, serverId),
      width: info.Width,
      height: info.Height,
      tileWidth: info.TileWidth,
      tileHeight: info.TileHeight,
      intervalMs: info.Interval,
      count: info.ThumbnailCount,
    };
  }
  const text = await api.get<unknown>(`/Videos/${item.Id}/Trickplay/320/tiles.m3u8`, { MediaSourceId: source?.Id });
  const t = typeof text === 'string' ? parseTilesM3u8(text) : null;
  if (!t || t.sheets === 0) return null;
  const { sheets, ...rest } = t;
  return { kind: 'tiles', url: mediaApiUrl(`/Videos/${item.Id}/Trickplay/${t.width}/{n}.jpg${q}`, serverId), ...rest, count: sheets * t.tileWidth * t.tileHeight };
}

// In memory for the run: one AniSkip answer per (MAL id, episode), one MAL id per AniList id.
const aniskipCache = new Map<string, MediaMarkers | null>();
const malOfAnilist = new Map<number, number | null>();

// Per host, the time a 429 lets it be asked again.
const retryAt = new Map<string, number>();

// AniSkip answers "not found" with a 404 and a JSON body; a 404 without one is null.
async function thirdParty(url: string, init: RequestInit = {}): Promise<unknown> {
  const host = new URL(url).host;
  if ((retryAt.get(host) ?? 0) > Date.now()) throw new Error(`${host} 429`);
  const r = await net.fetch(url, { signal: AbortSignal.timeout(8000), ...init });
  if (r.status === 429) retryAt.set(host, Date.now() + (Number(r.headers.get('retry-after')) || 60) * 1000);
  if (!r.ok && r.status !== 404) throw new Error(`${host} ${r.status}`);
  return r.ok ? r.json() : r.json().catch(() => null);
}

async function malOf(anilist: number): Promise<number | null> {
  if (!malOfAnilist.has(anilist)) {
    const body = { query: 'query($id:Int){Media(id:$id,type:ANIME){idMal}}', variables: { id: anilist } };
    const r = (await thirdParty('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })) as {
      data?: { Media?: { idMal?: number | null } };
    };
    malOfAnilist.set(anilist, r?.data?.Media?.idMal || null);
  }
  return malOfAnilist.get(anilist) ?? null;
}

// Settings > Playback > AniSkip: intro, credits and recap of an anime episode (its season or series has a
// MyAnimeList or AniList id) from api.aniskip.com. Sends only the MAL id, episode number and length.
export async function aniskipFallback(api: ApiClient, userId: string, item: BaseItem, durationMs: number): Promise<MediaMarkers | null> {
  if (item.Type !== 'Episode' || !item.SeasonId || !item.SeriesId || durationMs <= 0) return null;
  const [season, series] = await Promise.all([userItem<BaseItem>(api, userId, item.SeasonId), userItem<BaseItem>(api, userId, item.SeriesId)]);
  const t = aniskipTarget(item, season?.ProviderIds, series?.ProviderIds);
  const mal = t && (t.mal ?? (t.anilist ? await malOf(t.anilist) : null));
  if (!t || !mal) return null;
  const key = `${mal}:${t.episode}`;
  if (!aniskipCache.has(key)) aniskipCache.set(key, aniskipMarkers(await thirdParty(aniskipUrl(mal, t.episode, durationMs))));
  return aniskipCache.get(key) ?? null;
}

// In memory for the run: one answer body per title / episode and service ("no data" included), parsed per play as
// the sanity drops depend on the runtime.
const communityBodies = new Map<string, unknown>();

async function community(url: string): Promise<unknown> {
  if (!communityBodies.has(url)) {
    const headers = { Accept: 'application/json', 'User-Agent': `Wicaby/${app.getVersion()} (+https://github.com/WicaebethTheo/wicaby-releases)` };
    communityBodies.set(url, await thirdParty(url, { headers, redirect: 'error', signal: AbortSignal.timeout(5000) }));
  }
  return communityBodies.get(url);
}

// Settings > Playback > Community timestamps: intro, recap, credits and preview of a movie or episode from TheIntroDB,
// then IntroDB (TheIntroDB wins per kind). Sends the title's TMDB, TVDB or IMDb id and the episode numbers.
export async function communityFallback(api: ApiClient, userId: string, item: BaseItem, durationMs: number): Promise<MediaMarkers | null> {
  if ((item.Type !== 'Movie' && !(item.Type === 'Episode' && item.SeriesId)) || durationMs <= 0) return null;
  const owner = item.Type === 'Episode' ? item.SeriesId! : item.Id;
  const ids = item.Type === 'Movie' && item.ProviderIds ? item.ProviderIds : (await userItem<BaseItem>(api, userId, owner))?.ProviderIds;
  const t = communityTarget(item, ids);
  if (!t) return null;
  const quiet = (p: Promise<MediaMarkers | null>) => p.catch((err) => (log.debug(`community segments: ${String(err)}`), null));
  const idb = introDbUrl(t);
  const [a, b] = await Promise.all([
    quiet(community(theIntroDbUrl(t)).then((body) => communityMarkers(theIntroDbTimes(body, durationMs)))),
    idb ? quiet(community(idb).then((body) => communityMarkers(introDbTimes(body, durationMs)))) : null,
  ]);
  return mergeMarkers(a, b);
}
