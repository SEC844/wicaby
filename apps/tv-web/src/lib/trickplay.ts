// The thumbnail over the scrub bar (Android core Trickplay.kt): Jellyfin's tile sheets or Emby's BIF. Null when the
// item has none (no extraction, an old server, a refused file): no preview, no error.
// Tiles draw as a CSS background of the sheet image (no fetch, so no CORS needed); a BIF is one file of JPEG frames,
// fetched once (capped) and cut into blob URLs on first use.
import { bifFrameAt, parseBif, type Bif } from '$shared/bif';
import type { BaseItem, TrickplayInfo } from '$shared/models';
import type { Api } from './api';

export interface Thumb {
  src: string;
  // A tile on a sheet: its offset and the sheet's size, in the source's pixels; a BIF frame is the whole image.
  tile?: { x: number; y: number; sheetWidth: number; sheetHeight: number };
  width: number;
  height: number;
}

export interface Preview {
  at(ms: number): Thumb | null;
  release(): void;
}

const BIF_CAP = 64 * 1024 * 1024;

// {mediaSourceId: {width: info}} (10.9+) or flat {width: info}: the smallest width of at least 320, else the largest.
function pickTiles(trickplay: BaseItem['Trickplay'], sourceId: string): TrickplayInfo | null {
  if (!trickplay) return null;
  const keys = Object.keys(trickplay);
  const flat = keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
  const widths = (flat ? trickplay : (trickplay[sourceId] ?? trickplay[keys[0]])) as Record<string, TrickplayInfo> | undefined;
  if (!widths) return null;
  const infos = Object.keys(widths)
    .map((k) => widths[k])
    .filter((i) => i && i.Width > 0 && i.Height > 0 && i.TileWidth > 0 && i.TileHeight > 0 && i.ThumbnailCount > 0 && i.Interval > 0);
  const big = infos.filter((i) => i.Width >= 320).sort((a, b) => a.Width - b.Width);
  return big[0] ?? infos.sort((a, b) => b.Width - a.Width)[0] ?? null;
}

function tiles(api: Api, item: BaseItem, sourceId: string, info: TrickplayInfo): Preview {
  const per = info.TileWidth * info.TileHeight;
  const sheets = Math.ceil(info.ThumbnailCount / per);
  const url = (n: number) => api.mediaUrl(`/Videos/${item.Id}/Trickplay/${info.Width}/${n}.jpg?MediaSourceId=${encodeURIComponent(sourceId)}`) ?? '';
  const warmed = new Set<number>();
  let lastMs = -1;
  // The browser keeps a sheet once loaded; the next one in the direction of motion loads ahead.
  const warm = (n: number) => {
    if (n < 0 || n >= sheets || warmed.has(n)) return;
    warmed.add(n);
    new Image().src = url(n);
  };
  return {
    at(ms) {
      const i = Math.min(info.ThumbnailCount - 1, Math.max(0, Math.floor(ms / info.Interval)));
      const sheet = Math.floor(i / per);
      const local = i % per;
      warm(sheet);
      warm(sheet + (ms >= lastMs ? 1 : -1));
      lastMs = ms;
      return {
        src: url(sheet),
        tile: { x: (local % info.TileWidth) * info.Width, y: Math.floor(local / info.TileWidth) * info.Height, sheetWidth: info.TileWidth * info.Width, sheetHeight: info.TileHeight * info.Height },
        width: info.Width,
        height: info.Height,
      };
    },
    release() {},
  };
}

async function bif(api: Api, item: BaseItem): Promise<Preview | null> {
  const url = api.mediaUrl(`/Videos/${item.Id}/index.bif?Width=320`);
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok || Number(res.headers.get('content-length') ?? 0) > BIF_CAP) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > BIF_CAP) return null;
  const data = new Uint8Array(buf);
  let parsed: Bif;
  try {
    parsed = parseBif(data);
  } catch {
    return null;
  }
  if (!parsed.frames.length) return null;
  const frames = new Map<number, string>();
  // BIF frames are 320 px wide; most libraries are 16:9.
  return {
    at(ms) {
      const i = bifFrameAt(parsed, ms);
      if (i < 0) return null;
      let src = frames.get(i);
      if (!src) {
        const f = parsed.frames[i];
        src = URL.createObjectURL(new Blob([data.subarray(f.offset, f.offset + f.size)], { type: 'image/jpeg' }));
        frames.set(i, src);
      }
      return { src, width: 320, height: 180 };
    },
    release() {
      frames.forEach((u) => URL.revokeObjectURL(u));
      frames.clear();
    },
  };
}

export async function loadPreview(api: Api, item: BaseItem, sourceId: string | undefined): Promise<Preview | null> {
  try {
    if (api.isEmby) return await bif(api, item);
    const info = pickTiles(item.Trickplay, sourceId ?? item.Id);
    return info ? tiles(api, item, sourceId ?? item.Id, info) : null;
  } catch {
    return null;
  }
}
