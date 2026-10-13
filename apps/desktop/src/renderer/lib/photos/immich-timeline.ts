// Immich timeline adapter (photos spec §3.2, PH-12): the ONLY file that reads Immich's timeline. Its two endpoints,
// GET /api/timeline/buckets and /api/timeline/bucket (columnar), are marked Internal and may change outside a major
// release, so their shape is parsed here and nowhere else. A bucket that no longer parses switches the whole load to
// the Stable POST /api/search/metadata (page by page, newest first). Written by hand from the published API
// reference: no Immich code (spec §0). Kotlin twin: core photos/ImmichTimeline.kt. Pure and dependency-free:
// tools/checks/immich-check.mjs runs it against mock-immich.
import type { PhotoAsset } from "./asset";

export type ImmichCall = <T>(method: "GET" | "POST", path: string, query?: Record<string, string | number | boolean | undefined>, body?: unknown) => Promise<T>;

export interface ImmichFilter {
  favorites?: boolean;
  albumId?: string;
  personId?: string;
}

const PAGE = 1000;
const p2 = (n: number, w = 2) => String(n).padStart(w, "0");

// A shape the adapter does not know: the load falls back to search/metadata.
export class TimelineShapeError extends Error {}

// fileCreatedAt (UTC) moved by the asset's own offset: the wall-clock time it was taken, "YYYY-MM-DDTHH:MM:SS".
export function wallClock(fileCreatedAt: string, offsetHours: number | null | undefined): string | null {
  const ms = Date.parse(fileCreatedAt);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + (Number.isFinite(offsetHours) ? Number(offsetHours) : 0) * 3_600_000);
  return `${p2(d.getUTCFullYear(), 4)}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

// "H:MM:SS.ffffff" in milliseconds; undefined for none or zero.
export function durationMs(s: unknown): number | undefined {
  const m = typeof s === "string" ? /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(s) : null;
  if (!m) return undefined;
  const ms = ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + Math.round(Number(`0.${m[4] ?? "0"}`) * 1000);
  return ms > 0 ? ms : undefined;
}

// One bucket's parallel columns as assets. Throws TimelineShapeError when a column Wicaby needs is missing or of
// another length. visibility: rows of another visibility are dropped (the server filters already).
export function columnsToAssets(cols: unknown, serverId: string, geo: boolean, visibility?: string): PhotoAsset[] {
  const c = cols as Record<string, unknown[] | undefined> | null;
  const ids = c?.id;
  if (!c || !Array.isArray(ids)) throw new TimelineShapeError("id");
  const need = ["ratio", "isImage", "isFavorite", "fileCreatedAt", "localOffsetHours"];
  for (const k of need) if (!Array.isArray(c[k]) || c[k]!.length !== ids.length) throw new TimelineShapeError(k);
  const col = (k: string, i: number) => (Array.isArray(c[k]) ? c[k]![i] : undefined);
  const out: PhotoAsset[] = [];
  ids.forEach((id, i) => {
    if (typeof id !== "string") throw new TimelineShapeError("id");
    if (col("isTrashed", i) === true || (visibility && col("visibility", i) && col("visibility", i) !== visibility)) return;
    const taken = wallClock(String(col("fileCreatedAt", i)), Number(col("localOffsetHours", i)));
    if (!taken) throw new TimelineShapeError("fileCreatedAt");
    const ratio = Number(col("ratio", i));
    const a: PhotoAsset = {
      id,
      serverId,
      kind: col("isImage", i) === false ? "video" : "photo",
      takenAt: taken,
      aspect: ratio > 0 ? ratio : 1.5,
      rotate: 0,
      favorite: col("isFavorite", i) === true,
    };
    const d = durationMs(col("duration", i));
    if (d && a.kind === "video") a.durationMs = d;
    const lat = col("latitude", i);
    const lon = col("longitude", i);
    if (geo && typeof lat === "number" && typeof lon === "number") (a.lat = lat), (a.lon = lon);
    out.push(a);
  });
  return out;
}

interface SearchAsset {
  id: string;
  type?: string;
  localDateTime?: string;
  fileCreatedAt?: string;
  isFavorite?: boolean;
  duration?: string;
  exifInfo?: { exifImageWidth?: number | null; exifImageHeight?: number | null; orientation?: string | null; latitude?: number | null; longitude?: number | null } | null;
}

// A Stable AssetResponseDto (search/metadata, memories) as an asset. localDateTime carries the wall clock with a "Z".
export function searchToAsset(x: SearchAsset, serverId: string, geo = false): PhotoAsset {
  const e = x.exifInfo ?? {};
  const w = Number(e.exifImageWidth);
  const h = Number(e.exifImageHeight);
  // EXIF orientations 5 to 8 are quarter turns: Immich's thumbnails are upright, so the shown shape is swapped.
  const turned = ["5", "6", "7", "8"].includes(String(e.orientation ?? ""));
  const a: PhotoAsset = {
    id: x.id,
    serverId,
    kind: x.type === "VIDEO" ? "video" : "photo",
    takenAt: (x.localDateTime ?? "").slice(0, 19) || wallClock(x.fileCreatedAt ?? "", 0) || "0001-01-01T00:00:00",
    aspect: w > 0 && h > 0 ? (turned ? h / w : w / h) : 1.5,
    rotate: 0,
    favorite: x.isFavorite === true,
  };
  const d = durationMs(x.duration);
  if (d && a.kind === "video") a.durationMs = d;
  if (geo && typeof e.latitude === "number" && typeof e.longitude === "number") (a.lat = e.latitude), (a.lon = e.longitude);
  return a;
}

const isAuth = (err: unknown) => /immich:40[13]\b/.test(err instanceof Error ? err.message : String(err));

export interface TimelineLoad {
  // Months present, newest first, and the asset count, once known (the scrubber's ticks before every page is in).
  onStart?: (total: number, years: number[]) => void;
  // Every asset so far, newest month first.
  onPage?: (assets: PhotoAsset[]) => void;
}

// The whole timeline of a source (or of an album, a person, the favourites). Resolves with every asset and whether
// the Stable fallback served it. A 401/403 is not a shape problem: it propagates.
export async function loadTimeline(call: ImmichCall, serverId: string, filter: ImmichFilter, geo: boolean, cb: TimelineLoad = {}): Promise<{ assets: PhotoAsset[]; fallback: boolean }> {
  // Album pages show what the album holds; everywhere else archived assets stay out (spec §3.2: sent explicitly).
  const visibility = filter.albumId ? undefined : "timeline";
  const query = { visibility, isFavorite: filter.favorites ? true : undefined, albumId: filter.albumId, personId: filter.personId };
  try {
    const raw = await call<unknown>("GET", "/timeline/buckets", query);
    if (!Array.isArray(raw)) throw new TimelineShapeError("buckets");
    const buckets = raw.map((b: { timeBucket?: unknown; count?: unknown }) => {
      if (typeof b?.timeBucket !== "string" || !/^\d{4}-\d{2}/.test(b.timeBucket)) throw new TimelineShapeError("timeBucket");
      return { key: b.timeBucket, count: Number(b.count) || 0 };
    });
    buckets.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
    cb.onStart?.(
      buckets.reduce((s, b) => s + b.count, 0),
      [...new Set(buckets.map((b) => Number(b.key.slice(0, 4))))],
    );
    // Two months in flight; they join in order.
    const ready: PhotoAsset[][] = [];
    let assets: PhotoAsset[] = [];
    let next = 0;
    let shown = 0;
    const byTaken = (a: PhotoAsset, b: PhotoAsset) => (a.takenAt < b.takenAt ? 1 : a.takenAt > b.takenAt ? -1 : 0);
    const worker = async () => {
      while (next < buckets.length) {
        const i = next++;
        ready[i] = columnsToAssets(await call<unknown>("GET", "/timeline/bucket", { ...query, timeBucket: buckets[i].key }), serverId, geo, visibility).sort(byTaken);
        while (ready[shown]) {
          assets = assets.concat(ready[shown]);
          ready[shown++] = undefined as unknown as PhotoAsset[];
          cb.onPage?.(assets);
        }
      }
    };
    await Promise.all([worker(), worker()]);
    return { assets, fallback: false };
  } catch (err) {
    if (isAuth(err)) throw err;
    // shortcut: any other failure of the Internal endpoints (shape, 404, 5xx) tries the Stable search once.
    return { assets: await searchAll(call, serverId, filter, visibility, geo, cb), fallback: true };
  }
}

type SearchPage = { assets?: { items?: SearchAsset[]; nextPage?: string | null; total?: number } };

async function searchAll(call: ImmichCall, serverId: string, filter: ImmichFilter, visibility: string | undefined, geo: boolean, cb: TimelineLoad): Promise<PhotoAsset[]> {
  let assets: PhotoAsset[] = [];
  for (let page: string | null = "1"; page; ) {
    const body: Record<string, unknown> = {
      page: Number(page),
      size: PAGE,
      order: "desc",
      visibility,
      withExif: true,
      isFavorite: filter.favorites ? true : undefined,
      albumIds: filter.albumId ? [filter.albumId] : undefined,
      personIds: filter.personId ? [filter.personId] : undefined,
    };
    const r: SearchPage = await call<SearchPage>("POST", "/search/metadata", undefined, body);
    const items: SearchAsset[] | undefined = r?.assets?.items;
    if (!Array.isArray(items)) throw new TimelineShapeError("search");
    if (page === "1") cb.onStart?.(Number(r.assets!.total) || items.length, []);
    assets = assets.concat(items.map((x) => searchToAsset(x, serverId, geo)));
    cb.onPage?.(assets);
    page = items.length ? (r.assets!.nextPage ?? null) : null;
  }
  return assets;
}
