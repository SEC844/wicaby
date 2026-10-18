// Immich photo sources (photos spec §3.2, PH-12) on the renderer side: the sources main knows, and each library's
// views (timeline, favourites, an album, a person), albums, people, memories and map markers. Every call goes
// through main (w.photos.immich.request), which holds the key; the timeline's shape is read by immich-timeline.ts
// alone. Nothing here is persisted: the views live in the shared session cache (source.svelte.ts).
import type { ImmichSource } from '../../../shared/contract';
import type { BaseItem } from '../../../shared/models';
import { w } from '../bridge';
import { t } from '../i18n.svelte';
import { errorMessage } from '../stores.svelte';
import { loadTimeline, searchToAsset, type ImmichCall, type ImmichFilter } from './immich-timeline';
import { cachedSkeleton, mapEnabled, type MemoryGroup, type Skeleton } from './source.svelte';

export const immich = $state<{ sources: ImmichSource[] }>({ sources: [] });

let watching = false;
// Called by the sidebar once: the list now, then every change main reports.
export function watchImmichSources(): void {
  if (watching) return;
  watching = true;
  void w.photos.immich
    .sources()
    .then((l) => {
      immich.sources = l;
    })
    .catch(() => undefined);
  w.photos.immich.onSources((l) => {
    immich.sources = l;
  });
}

const call =
  (source: string): ImmichCall =>
  (method, path, query, body) =>
    w.photos.immich.request(source, method, path, query, body);

// A failed Immich call as the caption to show: a missing permission is named (spec §3.2), a refused key says so.
export function immichError(err: unknown, scope: string): string {
  const m = errorMessage(err);
  if (/immich:403\b/.test(m)) return t('photos.sources.scopeMissing', { scope });
  if (/immich:401\b/.test(m)) return t('photos.sources.keyRefused');
  return /^immich:\d+$/.test(m) ? t('photos.sources.failed', { status: m.slice(7) }) : m;
}

export function immichSkeleton(source: string, filter: ImmichFilter): Skeleton {
  const geo = mapEnabled();
  const key = `immich:${source}:${filter.albumId ?? ''}:${filter.personId ?? ''}:${filter.favorites ? 'fav' : 'all'}${geo ? ':geo' : ''}`;
  return cachedSkeleton(key, async (s) => {
    try {
      const { assets } = await loadTimeline(call(source), `immich:${source}`, filter, geo, {
        onStart: (total, years) => ((s.total = total), (s.years = years)),
        onPage: (assets) => (s.assets = assets),
      });
      s.assets = assets;
      s.total = assets.length;
      if (!s.years.length) s.years = [...new Set(assets.map((a) => Number(a.takenAt.slice(0, 4))))];
      s.done = true;
    } catch (err) {
      s.error = immichError(err, 'asset.read');
    }
  });
}

// Albums as the Albums tab's cards. ImageTags.Primary holds the cover's asset id (immichUrl builds its thumbnail).
export type ImmichAlbum = BaseItem & { IsShared: boolean };
export async function immichAlbums(source: string): Promise<ImmichAlbum[]> {
  const list = await call(source)<{ id: string; albumName: string; albumThumbnailAssetId?: string | null; assetCount?: number; isShared?: boolean; shared?: boolean }[]>('GET', '/albums');
  return list
    .map((a) => ({
      Id: a.id,
      Name: a.albumName,
      Type: 'PhotoAlbum',
      ServerId: `immich:${source}`,
      ChildCount: a.assetCount,
      ImageTags: a.albumThumbnailAssetId ? { Primary: a.albumThumbnailAssetId } : undefined,
      // v3 says isShared, v2 shared.
      IsShared: a.isShared ?? a.shared ?? false,
    }))
    .sort((a, b) => a.Name.localeCompare(b.Name));
}

export interface ImmichPerson {
  id: string;
  name: string;
}

// Named, visible people only (no naming or merging from Wicaby, spec F5).
export async function immichPeople(source: string): Promise<ImmichPerson[]> {
  const r = await call(source)<{ people?: { id: string; name?: string; isHidden?: boolean }[] }>('GET', '/people', { withHidden: false });
  return (r.people ?? []).filter((p) => !p.isHidden && p.name).map((p) => ({ id: p.id, name: p.name! }));
}

// Immich's own "on this day" memories, as the Home row's groups (nearest year first).
export async function immichMemories(source: string, today: string): Promise<MemoryGroup[]> {
  const list = await call(source)<{ type?: string; data?: { year?: number }; assets?: Parameters<typeof searchToAsset>[0][] }[]>('GET', '/memories', { for: today });
  const year = Number(today.slice(0, 4));
  return list
    .filter((m) => m.type === 'on_this_day' && Number(m.data?.year) < year && m.assets?.length)
    .map((m) => ({ yearsAgo: year - Number(m.data!.year), indexes: [], assets: m.assets!.map((a) => searchToAsset(a, `immich:${source}`)) }))
    .sort((a, b) => a.yearsAgo - b.yearsAgo);
}

// Map markers (only asked for while the map is on, spec §6.1): asset id -> position. Memory only, never logged.
export async function immichMarkers(source: string): Promise<Map<string, { lat: number; lon: number }>> {
  const list = await call(source)<{ id: string; lat?: number; lon?: number }[]>('GET', '/map/markers', { isArchived: false });
  return new Map(list.filter((m) => typeof m.lat === 'number' && typeof m.lon === 'number').map((m) => [m.id, { lat: m.lat!, lon: m.lon! }]));
}

// The viewer's info panel: the asset's EXIF in the BaseItem fields exif.ts reads. Aperture is an f-number here.
export async function immichDetail(source: string, id: string): Promise<BaseItem> {
  const a = await call(source)<{ originalFileName?: string; exifInfo?: Record<string, unknown> | null }>('GET', `/assets/${id}`);
  const e = a.exifInfo ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const exposure = typeof e.exposureTime === 'string' ? /^(\d+)\/(\d+)$/.exec(e.exposureTime) : null;
  return {
    Id: id,
    Name: a.originalFileName ?? '',
    Type: 'Photo',
    CameraMake: typeof e.make === 'string' ? e.make : undefined,
    CameraModel: typeof e.model === 'string' ? e.model : undefined,
    ExposureTime: exposure ? Number(exposure[1]) / Number(exposure[2]) : num(Number(e.exposureTime)),
    Aperture: num(e.fNumber),
    FocalLength: num(e.focalLength),
    IsoSpeedRating: num(e.iso),
    Width: num(e.exifImageWidth),
    Height: num(e.exifImageHeight),
    Latitude: num(e.latitude),
    Longitude: num(e.longitude),
  } as BaseItem;
}
