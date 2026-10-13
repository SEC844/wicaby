// What the playback service loads after the first frame (loadExtras): Emby's intro skip mode and
// trick-play thumbnails, as BIF (Emby) or tiles (Jellyfin).
import type { SkipMode, Trickplay } from '../../shared/contract';
import type { BaseItem, MediaSource } from '../../shared/models';
import { buildQuery, type ApiClient } from '../connection/api-client';
import { mediaApiUrl } from './playback-model';

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
