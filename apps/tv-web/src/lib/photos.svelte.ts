// Photo libraries (Android core photos/PhotoSource.kt, desktop renderer/lib/photos): the timeline of a library, an
// album or the favourites, paged 1,000 at a time and re-sorted by the date taken (the server pages by DateCreated);
// the albums; the image URLs. The asset shape, dates and orientation rules are the desktop's ($desktop/photos/asset,
// pinned by the shared photo fixtures). A timeline stays loaded for the session, so the viewer and Back find it again.
import type { BaseItem, ItemsResult } from '$shared/models';
import { toAsset, type PhotoAsset } from '$desktop/photos/asset';
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
