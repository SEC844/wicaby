// The demo server (GitHub Pages and "Try the demo"): an Emby that lives in the page. It answers from
// demo/catalog.json, which scripts/demo-data.mjs builds from tools/mock-server's demo dataset (the Blender open
// movies, CC BY: demo/ATTRIBUTION.md). Every film plays the same generated test clip. Watched state and favourites
// stay in this browser (localStorage). Nothing leaves the page.
import type { Query } from '../../desktop/src/shared/contract';
import type { BaseItem } from '../../desktop/src/shared/models';

// The demo server's address: typing it in the address field (Pages build) adds the demo too.
export const DEMO_ADDRESS = 'demo';
export const DEMO_BASE = './demo';
// Set by the Pages build (WEBTV_DEMO=1): only then does the page carry demo/.
export const demoAvailable = import.meta.env.VITE_WICABY_DEMO === '1';

interface Catalog {
  server: { Id: string; ServerName: string; Version: string; ProductName: string };
  user: { Id: string; Name: string };
  views: BaseItem[];
  items: Record<string, BaseItem & { _view?: string }>;
  children: Record<string, string[]>;
}
interface UserData {
  PlaybackPositionTicks: number;
  PlayCount: number;
  IsFavorite: boolean;
  Played: boolean;
  LastPlayedDate?: string;
}

const CLIP_TICKS = 30 * 10_000_000;
const STORE = 'wicaby.demo.userdata';
let catalog: Promise<Catalog> | null = null;
let userData: Record<string, UserData> = {};

// Tests (tools/checks/webtv-check.mjs) hand the catalogue over directly.
export function loadDemo(c?: Catalog): Promise<Catalog> {
  if (catalog && !c) return catalog;
  catalog = c
    ? Promise.resolve(c)
    : fetch(`${DEMO_BASE}/catalog.json`).then((r) => {
        if (!r.ok) throw new Error(`demo catalogue: HTTP ${r.status}`);
        return r.json() as Promise<Catalog>;
      });
  // A failed load is tried again on the next request.
  catalog.catch(() => (catalog = null));
  try {
    userData = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, UserData>;
  } catch {
    userData = {};
  }
  return catalog;
}

function ud(id: string): UserData {
  return (userData[id] ??= { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false });
}
function save(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(userData));
  } catch {
    // Private mode: the demo forgets on reload.
  }
}

export const DEMO_ID = 'wicabydemo0000000000000000000001';
const SERVER_ID = DEMO_ID;
function view(c: Catalog, it: BaseItem & { _view?: string }): BaseItem {
  const { _view, ...rest } = it;
  void _view;
  const out = { ...rest, ServerId: SERVER_ID, CanDelete: false, UserData: { ...ud(it.Id) } } as BaseItem;
  if (it.Type === 'Series' || it.Type === 'Season') {
    const eps = Object.values(c.items).filter((e) => e.Type === 'Episode' && (e.SeriesId === it.Id || e.SeasonId === it.Id));
    const unplayed = eps.filter((e) => !ud(e.Id).Played).length;
    out.UserData = { ...out.UserData!, UnplayedItemCount: unplayed, Played: eps.length > 0 && unplayed === 0 } as BaseItem['UserData'];
    out.ChildCount = it.Type === 'Series' ? 1 : eps.length;
  }
  return out;
}

const SORT: Record<string, (i: BaseItem) => string | number> = {
  SortName: (i) => ((i as { SortName?: string }).SortName ?? i.Name ?? '').toLowerCase(),
  Name: (i) => (i.Name ?? '').toLowerCase(),
  DateCreated: (i) => i.DateCreated ?? '',
  PremiereDate: (i) => i.PremiereDate ?? String(i.ProductionYear ?? ''),
  ProductionYear: (i) => i.ProductionYear ?? 0,
  CommunityRating: (i) => i.CommunityRating ?? 0,
  DatePlayed: (i) => ud(i.Id).LastPlayedDate ?? '',
  IndexNumber: (i) => i.IndexNumber ?? 0,
  ParentIndexNumber: (i) => i.ParentIndexNumber ?? 0,
};

function sorted(list: BaseItem[], sortBy?: string, order?: string): BaseItem[] {
  const keys = (sortBy ?? '').split(',').filter((k) => SORT[k]);
  if (!keys.length) return list;
  const dir = /desc/i.test(order ?? '') ? -1 : 1;
  return [...list].sort((a, b) => {
    for (const k of keys) {
      const x = SORT[k](a);
      const y = SORT[k](b);
      if (x < y) return -dir;
      if (x > y) return dir;
    }
    return 0;
  });
}

const page = (list: BaseItem[], q: Query) => {
  const start = Number(q.StartIndex ?? 0) || 0;
  const limit = Number(q.Limit ?? 0) || list.length;
  return { Items: list.slice(start, start + limit), TotalRecordCount: list.length, StartIndex: start };
};
const types = (v: unknown) => String(v ?? '').split(',').filter(Boolean);

function items(c: Catalog, q: Query): BaseItem[] {
  let list = Object.values(c.items);
  const parent = q.ParentId ? String(q.ParentId) : '';
  if (q.Ids) {
    const ids = types(q.Ids);
    list = ids.map((id) => c.items[id]).filter(Boolean);
  } else if (parent && c.children[parent]) list = c.children[parent].map((id) => c.items[id]).filter(Boolean);
  else if (parent && c.items[parent]?.Type === 'Series') list = list.filter((i) => i.Type === 'Season' && i.SeriesId === parent);
  else if (parent && c.items[parent]?.Type === 'Season') list = list.filter((i) => i.Type === 'Episode' && i.SeasonId === parent);
  else if (parent) list = list.filter((i) => i._view === parent && (q.Recursive ? true : ['Movie', 'Series', 'BoxSet'].includes(i.Type)));
  else if (!q.Recursive && !q.SearchTerm && !q.IncludeItemTypes) list = list.filter((i) => ['Movie', 'Series', 'BoxSet'].includes(i.Type));
  const include = types(q.IncludeItemTypes);
  const exclude = types(q.ExcludeItemTypes);
  if (include.length) list = list.filter((i) => include.includes(i.Type));
  if (exclude.length) list = list.filter((i) => !exclude.includes(i.Type));
  const filters = types(q.Filters);
  if (filters.includes('IsFavorite') || q.IsFavorite === true || q.IsFavorite === 'true') list = list.filter((i) => ud(i.Id).IsFavorite);
  if (filters.includes('IsResumable')) list = list.filter((i) => ud(i.Id).PlaybackPositionTicks > 0);
  if (filters.includes('IsPlayed') || q.IsPlayed === 'true' || q.IsPlayed === true) list = list.filter((i) => ud(i.Id).Played);
  if (filters.includes('IsUnplayed') || q.IsPlayed === 'false' || q.IsPlayed === false) list = list.filter((i) => !ud(i.Id).Played);
  if (q.Genres) {
    const g = String(q.Genres).split('|');
    list = list.filter((i) => i.Genres?.some((x) => g.includes(x)));
  }
  const term = String(q.SearchTerm ?? q.NameStartsWith ?? '').toLowerCase();
  if (term) list = list.filter((i) => (i.Name ?? '').toLowerCase().includes(term) && i.Type !== 'Season');
  return sorted(list, q.SortBy ? String(q.SortBy) : undefined, q.SortOrder ? String(q.SortOrder) : undefined);
}

function nextUp(c: Catalog): BaseItem[] {
  const out: BaseItem[] = [];
  for (const s of Object.values(c.items).filter((i) => i.Type === 'Series')) {
    const eps = sorted(
      Object.values(c.items).filter((e) => e.Type === 'Episode' && e.SeriesId === s.Id),
      'ParentIndexNumber,IndexNumber',
    );
    const last = eps.map((e) => ud(e.Id).Played).lastIndexOf(true);
    const next = eps[last + 1];
    if (last >= 0 && next && !ud(next.Id).PlaybackPositionTicks) out.push(next);
  }
  return out;
}

function report(body: { ItemId?: string; PositionTicks?: number } | undefined, stopped: boolean): void {
  const id = body?.ItemId;
  if (!id) return;
  const d = ud(id);
  const pos = body?.PositionTicks ?? 0;
  d.LastPlayedDate = new Date().toISOString();
  // The clip is 30 s: past 90 % of it counts as watched, like a server's default.
  if (stopped && pos >= CLIP_TICKS * 0.9) {
    d.Played = true;
    d.PlayCount++;
    d.PlaybackPositionTicks = 0;
  } else if (pos > 0) d.PlaybackPositionTicks = pos;
  save();
}

function playbackInfo(c: Catalog, id: string) {
  const it = c.items[id];
  if (!it) throw Object.assign(new Error('Not found'), { status: 404 });
  return {
    PlaySessionId: `demo-${Date.now()}`,
    MediaSources: [
      {
        Id: id,
        Name: it.Name,
        Protocol: 'Http',
        Container: 'mp4',
        RunTimeTicks: CLIP_TICKS,
        SupportsDirectPlay: true,
        SupportsDirectStream: true,
        SupportsTranscoding: false,
        MediaStreams: [{ Index: 0, Type: 'Video', Codec: 'h264', Width: 960, Height: 540, IsDefault: true, DisplayTitle: '540p H.264' }],
      },
    ],
  };
}

// The stream of every demo item: one generated test pattern (apps/webtv/demo/demo.mp4), no sound.
export const demoVideoUrl = (): string => `${DEMO_BASE}/video.mp4`;

export async function demoRequest<T>(method: string, path: string, query: Query = {}, body?: unknown): Promise<T> {
  const c = await loadDemo();
  const p = path.replace(/^\/emby/i, '');
  const user = { Id: c.user.Id, Name: c.user.Name, HasPassword: false, HasConfiguredPassword: false, ServerId: SERVER_ID, Policy: { IsAdministrator: false }, Configuration: {} };
  const one = (id: string) => (c.items[id] ? view(c, c.items[id]) : c.views.find((v) => v.Id === id) ? { ...c.views.find((v) => v.Id === id)!, ServerId: SERVER_ID } : null);
  let m: RegExpExecArray | null;
  const res = ((): unknown => {
    if (p === '/System/Info/Public' || p === '/System/Info') return { ...c.server, Id: SERVER_ID };
    if (p === '/Users/Public') return [user];
    if (p === '/Users/AuthenticateByName') return { AccessToken: 'demo', User: user, ServerId: SERVER_ID, SessionInfo: {} };
    if (p === `/Users/${c.user.Id}`) return user;
    if (p === `/Users/${c.user.Id}/Views` || p === '/UserViews') return { Items: c.views.map((v) => ({ ...v, ServerId: SERVER_ID })), TotalRecordCount: c.views.length };
    if (p === `/Users/${c.user.Id}/Items/Resume`) return page(sorted(items(c, { Recursive: true, IncludeItemTypes: 'Movie,Episode', Filters: 'IsResumable' }), 'DatePlayed', 'Descending').map((i) => view(c, i)), query);
    if (p === `/Users/${c.user.Id}/Items/Latest`)
      return items(c, { ParentId: query.ParentId, SortBy: 'DateCreated', SortOrder: 'Descending' })
        .slice(0, Number(query.Limit ?? 16))
        .map((i) => view(c, i));
    if (p === `/Users/${c.user.Id}/Items` || p === '/Items') return page(items(c, query).map((i) => view(c, i)), query);
    if (p === '/Shows/NextUp') return page(nextUp(c).map((i) => view(c, i)), query);
    if (p === '/Shows/Upcoming') return { Items: [], TotalRecordCount: 0 };
    if ((m = /^\/Shows\/([^/]+)\/Seasons$/.exec(p))) return page(items(c, { ParentId: m[1], SortBy: 'IndexNumber' }).map((i) => view(c, i)), query);
    if ((m = /^\/Shows\/([^/]+)\/Episodes$/.exec(p)))
      return page(
        sorted(
          Object.values(c.items).filter((e) => e.Type === 'Episode' && e.SeriesId === m![1] && (!query.SeasonId || e.SeasonId === query.SeasonId)),
          'ParentIndexNumber,IndexNumber',
        ).map((i) => view(c, i)),
        query,
      );
    if ((m = /^\/Items\/([^/]+)\/Similar$/.exec(p))) {
      const it = c.items[m[1]];
      const list = Object.values(c.items).filter((i) => i.Id !== it?.Id && i.Type === it?.Type && i.Genres?.some((g) => it?.Genres?.includes(g)));
      return page(list.map((i) => view(c, i)), query);
    }
    if ((m = /^\/Items\/([^/]+)\/PlaybackInfo$/.exec(p))) return playbackInfo(c, m[1]);
    if ((m = new RegExp(`^/Users/${c.user.Id}/Items/([^/]+)$`).exec(p))) {
      const it = one(m[1]);
      if (!it) throw Object.assign(new Error('Not found'), { status: 404 });
      return it;
    }
    if ((m = new RegExp(`^/Users/${c.user.Id}/(Favorite|Played)Items/([^/]+)$`).exec(p))) {
      const d = ud(m[2]);
      const on = method === 'POST';
      if (m[1] === 'Favorite') d.IsFavorite = on;
      else {
        d.Played = on;
        d.PlaybackPositionTicks = 0;
      }
      save();
      return { ...d };
    }
    if (p === '/Sessions/Playing' || p === '/Sessions/Playing/Progress') return report(body as never, false);
    if (p === '/Sessions/Playing/Stopped') return report(body as never, true);
    if (/\/(LocalTrailers|SpecialFeatures|ThemeMedia|Intros)$/.test(p)) return [];
    if (p === '/LiveTv/Info') return { IsEnabled: false, Services: [], EnabledUsers: [] };
    if (method !== 'GET') return undefined;
    return { Items: [], TotalRecordCount: 0 };
  })();
  // A copy, like a response off the wire: pages may mutate what they get.
  return (res === undefined ? undefined : JSON.parse(JSON.stringify(res))) as T;
}
