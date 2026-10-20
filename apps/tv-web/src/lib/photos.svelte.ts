// Photo libraries (Android core photos/PhotoSource.kt, desktop renderer/lib/photos): the timeline of a library, an
// album or the favourites, paged 1,000 at a time and re-sorted by the date taken (the server pages by DateCreated);
// the albums; the image URLs. The asset shape, dates and orientation rules are the desktop's ($desktop/photos/asset,
// pinned by the shared photo fixtures). A timeline stays loaded for the session, so the viewer and Back find it again.
import type { BaseItem, ItemsResult } from '$shared/models';
import { quarterTurn, toAsset, type PhotoAsset } from '$desktop/photos/asset';
import { localDay, memoryQuery } from '$desktop/photos/memories';
import { byTakenDesc } from '$desktop/photos/timeline';
import type { Api } from './api';

export interface Photo {
  asset: PhotoAsset;
  item: BaseItem;
}

const PAGE = 1000;
// The viewer's longest side: 1280 px on a low-end TV, 1920 px otherwise (spec §4.4 memory budget).
export const VIEWER_PX = 1920;

export class Timeline {
  photos = $state.raw<Photo[]>([]);
  // -1 until the first page answers.
  total = $state(-1);
  failed = $state(false);
  complete = false;
  private loading: Promise<void> | null = null;

  constructor(private readonly fetch: (start: number, limit: number) => Promise<ItemsResult>) {}

  load(): Promise<void> {
    if (this.complete) return Promise.resolve();
    return (this.loading ??= this.run().finally(() => (this.loading = null)));
  }

  private async run(): Promise<void> {
    try {
      const out: Photo[] = [];
      for (;;) {
        const r = await this.fetch(out.length, PAGE);
        const page = r.Items.map((item) => ({ asset: toAsset(item), item }));
        page.sort((a, b) => byTakenDesc(a.asset, b.asset));
        out.push(...page);
        // Each page lands in place (sorted within itself, like Android): the screen fills while a large library pages.
        this.photos = out.slice().sort((a, b) => byTakenDesc(a.asset, b.asset));
        this.total = r.TotalRecordCount;
        if (!r.Items.length || out.length >= r.TotalRecordCount) break;
      }
      this.failed = false;
      this.complete = true;
    } catch {
      this.failed = !this.photos.length;
    }
  }

  // The favourite flag as the viewer last set it.
  setFavorite(id: string, on: boolean): void {
    this.photos = this.photos.map((p) => (p.asset.id === id ? { ...p, asset: { ...p.asset, favorite: on } } : p));
  }
}

const timelines = new Map<string, Timeline>();

// /Items with what a timeline needs: the size for the layout, one Primary image, the favourite flag.
function photoItems(api: Api, query: Record<string, unknown>): Promise<ItemsResult> {
  return api.items({ Fields: `${api.listFields},Width,Height`, EnableImageTypes: 'Primary', ImageTypeLimit: 1, EnableUserData: true, ...query });
}

// Every photo and clip under [parentId] (a library or an album), or its favourites; one per key for the session.
export function timeline(api: Api, parentId: string, favorites = false): Timeline {
  const key = `${api.address}|${api.userId}|${parentId}|${favorites}`;
  let tl = timelines.get(key);
  if (!tl) {
    tl = new Timeline((start, limit) =>
      photoItems(api, {
        ParentId: parentId,
        Recursive: true,
        IncludeItemTypes: 'Photo,Video',
        SortBy: 'DateCreated,SortName',
        SortOrder: 'Descending',
        Filters: favorites ? 'IsFavorite' : undefined,
        StartIndex: start,
        Limit: limit,
      }),
    );
    timelines.set(key, tl);
  }
  return tl;
}

export function timelineKey(tl: Timeline): string | undefined {
  for (const [k, v] of timelines) if (v === tl) return k;
  return undefined;
}

export function timelineByKey(key: string): Timeline | undefined {
  return timelines.get(key);
}

export async function photoAlbums(api: Api, libraryId: string): Promise<BaseItem[]> {
  return (await photoItems(api, { ParentId: libraryId, IncludeItemTypes: 'PhotoAlbum', Recursive: false, SortBy: 'SortName', SortOrder: 'Ascending' })).Items;
}

// A photo's picture at [px] on its longest side. Emby turns the pixels on request (AutoOrient); Jellyfin never does,
// the client turns them (asset.rotation).
export function photoUrl(api: Api, a: PhotoAsset, px: number): string | undefined {
  if (!a.thumbTag) return undefined;
  const size = a.aspect >= 1 ? { maxWidth: px } : { maxHeight: px };
  return api.url(`/Items/${a.id}/Images/Primary`, { tag: a.thumbTag, ...size, quality: 90, AutoOrient: api.isEmby ? true : undefined });
}

// "12 octobre 2019" or "Octobre 2019": the wall-clock fields of takenAt, no zone conversion.
export function photoDate(takenAt: string, locale: string, month = false): string {
  const d = new Date(Number(takenAt.slice(0, 4)), Number(takenAt.slice(5, 7)) - 1, Number(takenAt.slice(8, 10)) || 1);
  const s = d.toLocaleDateString(locale, month ? { month: 'long', year: 'numeric' } : { day: 'numeric', month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- "Ce jour-là" (spec F7, PH-08; Android core photos/Memories.kt homeMemories) ---

export interface MemoryGroup {
  yearsAgo: number;
  photos: Photo[];
}

const memoryCache = new Map<string, Promise<MemoryGroup[]>>();

// Today's month and day in earlier years, across every photo library: /Years once, then one premiere-date range per
// year (the 10 nearest, three in flight), kept by the desktop's memories() so the Feb 29 rule holds. Once per server,
// user and day.
// parentId: an album or library only (the screensaver's Memories source).
export function homeMemories(api: Api, parentId?: string): Promise<MemoryGroup[]> {
  const today = localDay();
  const key = `${api.address}|${api.userId}|${today}|${parentId ?? ''}`;
  let p = memoryCache.get(key);
  if (!p) {
    p = memoryQuery<BaseItem>(
      async () =>
        (
          await api.get<ItemsResult>('/Years', { UserId: api.userId, ParentId: parentId, Recursive: true, IncludeItemTypes: 'Photo', SortBy: 'SortName', SortOrder: 'Descending' })
        ).Items.map((y) => y.ProductionYear ?? Number(y.Name)).filter((y) => y > 0),
      async (min, max) =>
        (
          await photoItems(api, {
            ParentId: parentId, Recursive: true, IncludeItemTypes: 'Photo', MinPremiereDate: min, MaxPremiereDate: max, SortBy: 'PremiereDate', SortOrder: 'Ascending', Limit: 90,
          })
        ).Items.filter((i) => i.ImageTags?.Primary),
      (item) => toAsset(item).takenAt,
      today,
    ).then(({ items, memories }) => memories.map((m) => ({ yearsAgo: m.yearsAgo, photos: m.indexes.map((i) => ({ asset: toAsset(items[i]), item: items[i] })) })));
    p.catch(() => memoryCache.delete(key));
    memoryCache.set(key, p);
  }
  return p;
}

// The cover: a photo the server shows upright (a quarter-turned one needs the decoded-size test first).
export const memoryCover = (photos: Photo[]): Photo => photos.find((p) => quarterTurn(p.item.ImageOrientation) === 0) ?? photos[0];

// A year's photos as a loaded timeline, for the viewer (its route reads timelines by key).
export function memoryTimeline(group: MemoryGroup): string {
  const key = `memories|${group.yearsAgo}`;
  const tl = new Timeline(() => Promise.resolve({ Items: [], TotalRecordCount: 0 }));
  tl.photos = group.photos;
  tl.total = group.photos.length;
  tl.complete = true;
  timelines.set(key, tl);
  return key;
}

// The screensaver's photo sources (photos spec PH-07, core randomPhotos and memoryPhotos): 60 random stills under an
// album or library (every library without one), or today's photos in earlier years, else random stills, so the
// screensaver never goes black.
export async function randomPhotos(api: Api, parentId?: string, limit = 60): Promise<Photo[]> {
  const r = await photoItems(api, { ParentId: parentId, Recursive: true, IncludeItemTypes: 'Photo', SortBy: 'Random', Limit: limit });
  return r.Items.filter((i) => i.ImageTags?.Primary).map((item) => ({ asset: toAsset(item), item }));
}

export async function memoryPhotos(api: Api, parentId?: string, limit = 60): Promise<Photo[]> {
  const found = (await homeMemories(api, parentId).catch(() => [])).flatMap((g) => g.photos).slice(0, limit);
  return found.length ? found : randomPhotos(api, parentId, limit);
}
