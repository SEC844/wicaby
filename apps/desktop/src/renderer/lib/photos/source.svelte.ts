// Photos (spec PH-02, §3.1): the light "skeleton" of a photo library, album or favourites view, the whole timeline
// in pages of 1,000 (two in flight), each page re-sorted by takenAt. Kept in memory for the session, never on disk
// (no coordinates are asked for: the map is off).
// shortcut: no persisted skeleton; add a disk cache plus MinDateLastSaved deltas if a 50k library takes over 5 s on LAN.
import type { BaseItem } from '../../../shared/models';
import { apiFor } from '../api';
import { w } from '../bridge';
import { errorMessage, sessionFor, settings } from '../stores.svelte';
import { quarterTurn, toAsset, type PhotoAsset } from './asset';
import { memoryQuery, type Memory } from './memories';
import { byTakenDesc } from './timeline';

// orient: what the orientation rule needs once the thumbnail is decoded (quarter-turn assets only).
export type GridAsset = PhotoAsset & { orient?: { o: string; w: number; h: number } };

export class Skeleton {
  assets = $state.raw<GridAsset[]>([]);
  total = $state(0);
  // Years present (newest first), from /Years: the scrubber's ticks before every page is in.
  years = $state.raw<number[]>([]);
  done = $state(false);
  error = $state('');
  // Bumped when an asset changes in place (favourite).
  version = $state(0);
}

const PAGE = 1000;
const cache = new Map<string, Skeleton>();

// geo: keep the coordinates (only while the map is on, spec §6.1; memory only, never persisted or logged).
export function asset(item: BaseItem, geo = false): GridAsset {
  const a: GridAsset = toAsset(item, undefined, geo);
  if (quarterTurn(item.ImageOrientation) && item.Width && item.Height) a.orient = { o: item.ImageOrientation!, w: item.Width, h: item.Height };
  return a;
}

// favorites: the Favourites tab (Filters=IsFavorite).
export function skeleton(server: string | undefined, parentId: string, favorites = false): Skeleton {
  const geo = mapEnabled();
  return cachedSkeleton(`${server ?? ''}:${parentId}:${favorites ? 'fav' : 'all'}${geo ? ':geo' : ''}`, (s) => load(s, server, parentId, favorites, geo));
}

// The session cache every photo view shares (Immich's too, lib/photos/immich.svelte.ts), so a favourite changes
// every loaded view. A key holding ':fav' is a favourites view. A failed load starts over on the next visit.
export function cachedSkeleton(key: string, start: (s: Skeleton) => Promise<void>): Skeleton {
  let s = cache.get(key);
  if (!s || s.error) {
    s = new Skeleton();
    cache.set(key, s);
    void start(s);
  }
  return s;
}

// A rescanned photo source: its views load again on their next visit.
export function forgetViews(server: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${server}:`)) cache.delete(k);
}

export const mapEnabled = () => settings.value?.photos?.map.enabled === true;

async function load(s: Skeleton, server: string | undefined, parentId: string, favorites: boolean, geo: boolean): Promise<void> {
  const api = apiFor(server);
  const query = (start: number) => ({
    ParentId: parentId,
    Recursive: true,
    IncludeItemTypes: 'Photo,Video',
    SortBy: 'DateCreated,SortName',
    SortOrder: 'Descending',
    Filters: favorites ? 'IsFavorite' : undefined,
    StartIndex: start,
    Limit: PAGE,
  });
  const page = (items: BaseItem[]) => items.map((x) => asset(x, geo)).sort(byTakenDesc);
  const sid = sessionFor(server)?.server.id;
  void w.api
    .get<{ Items: { ProductionYear?: number; Name?: string }[] }>('/Years', { ParentId: parentId, Recursive: true, IncludeItemTypes: 'Photo,Video', SortBy: 'SortName', SortOrder: 'Descending', UserId: sessionFor(server)?.user?.id }, sid)
    .then((r) => (s.years = (r.Items ?? []).map((y) => y.ProductionYear ?? Number(y.Name)).filter((y) => y > 1800).sort((a, b) => b - a)))
    .catch(() => undefined);
  try {
    const first = await api.photoItems(query(0));
    s.total = first.TotalRecordCount;
    s.assets = page(first.Items);
    const count = Math.ceil(s.total / PAGE);
    const ready: (GridAsset[] | undefined)[] = [];
    let next = 1;
    let shown = 1;
    // Two pages in flight; they join the timeline in order.
    const worker = async () => {
      while (next < count) {
        const i = next++;
        ready[i] = page((await api.photoItems(query(i * PAGE))).Items);
        while (ready[shown]) {
          s.assets = s.assets.concat(ready[shown]!);
          ready[shown++] = undefined;
        }
      }
    };
    await Promise.all([worker(), worker()]);
    s.total = s.assets.length;
    s.done = true;
  } catch (err) {
    s.error = errorMessage(err);
  }
}

// The heart in the viewer and `f` on a tile: the server first, then every loaded view of that asset. The favourites
// views reload on their next visit.
export async function setFavorite(a: PhotoAsset, value: boolean): Promise<void> {
  if (a.serverId.startsWith('immich:')) await w.photos.immich.request(a.serverId.slice(7), 'PUT', '/assets', undefined, { ids: [a.id], isFavorite: value });
  else await apiFor(a.serverId || undefined).setFavorite(a.id, value);
  for (const [key, s] of cache) {
    if (key.includes(':fav')) cache.delete(key);
    let hit = false;
    for (const x of s.assets) if (x.id === a.id && x.serverId === a.serverId) (x.favorite = value), (hit = true);
    if (hit) s.version++;
  }
  a.favorite = value;
}

// A photo opened outside a photo library (a card in search, favourites or a home row): the viewer alone.
export const lonePhoto = $state<{ assets: GridAsset[] | null }>({ assets: null });

// "On this day" (spec F7, PH-08) on one server: its photos taken on today's month and day in earlier years, grouped by
// year, the nearest first. Kept until the date changes. today: "YYYY-MM-DD", local.
export type MemoryGroup = Memory & { assets: GridAsset[] };
const memoryCache = new Map<string, Promise<MemoryGroup[]>>();

export function memoriesOf(server: string, today: string): Promise<MemoryGroup[]> {
  const uid = sessionFor(server)?.user?.id;
  const key = `${server}/${uid}/${today}`;
  let p = memoryCache.get(key);
  if (!p) {
    for (const k of memoryCache.keys()) if (k.startsWith(`${server}/`)) memoryCache.delete(k);
    const api = apiFor(server);
    // 90: the range spans three days (memoryQuery's ±1 day). shortcut: a busy eve can still crowd the day out, page if it does.
    const range = (min: string, max: string) => api.photoItems({ Recursive: true, IncludeItemTypes: 'Photo', MinPremiereDate: min, MaxPremiereDate: max, SortBy: 'PremiereDate', SortOrder: 'Ascending', Limit: 90 }).then((r) => r.Items.map((x) => asset(x)));
    const years = () =>
      w.api
        .get<{ Items: { ProductionYear?: number; Name?: string }[] }>('/Years', { Recursive: true, IncludeItemTypes: 'Photo', SortBy: 'SortName', SortOrder: 'Descending', UserId: uid }, server)
        .then((r) => (r.Items ?? []).map((y) => y.ProductionYear ?? Number(y.Name)).filter((y) => y > 1800));
    p = memoryQuery(years, range, (a) => a.takenAt, today).then(({ items, memories }) => memories.map((m) => ({ ...m, assets: m.indexes.map((i) => items[i]) })));
    // A failure is not kept: the next visit asks again.
    p.catch(() => memoryCache.delete(key));
    memoryCache.set(key, p);
  }
  return p;
}
