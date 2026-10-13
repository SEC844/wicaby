// The Plex dialect at run time (plex-spec §3.3, PX-06): a PlexClient answers the Emby-shaped calls the renderer
// and main already make (api:request, wicaby-media://api) by translating them through the route table
// (shared/plex/routes.ts), calling the PMS and mapping its JSON (shared/plex/map.ts). No PMS shape crosses IPC. A
// route or query the table does not know answers 404 'PLEX-UNMAPPED …', never a wrong answer. The server token
// goes only as the X-Plex-Token header, to this server's address. Playback (PlaybackInfo, reports, markers,
// streams, BIF, subtitles; PX-08/PX-09) is plex-playback.ts.
import { net } from 'electron';
import type { Query } from '../../shared/contract';
import type { BaseItem, ItemsResult, SystemInfoPublic, UserDto } from '../../shared/models';
import { imagePaths, parseImageRoute, transcodePath } from '../../shared/plex/images';
import { parseId, personId, seasonsFlattened, toExtras, toHubs, toItem, toView } from '../../shared/plex/map';
import { answerMeta, itemKey, itemsUri, metadataRequest, PLEX_TYPE, PlexUnmapped, withGenreIds, type PmsReq } from '../../shared/plex/query';
import { matchRoute, translate } from '../../shared/plex/routes';
import type { PlexContainer, PlexMeta, PlexSection } from '../../shared/plex/types';
import { logger } from '../core/log';
import { ApiClient, ApiError, buildQuery, routed, type ClientIdentity } from './api-client';
import { plexHeaders } from './plex-account';
import { PlexPlayback } from './plex-playback';

const log = logger.scope('plex');

// The signed-in Home user's watchlist on plex.tv (D-6), held by the ConnectionManager: the user token stays there.
export interface PlexWatchlist {
  guids(): Promise<string[]>;
  set(guid: string, on: boolean): Promise<void>;
}

export interface PlexClientOptions {
  machineId: string;
  userName: string;
  // The server owner's own account (D-2: "Refresh metadata" is theirs).
  owner: boolean;
  watchlist?: PlexWatchlist;
  // The address is a remote or relay one (plex-spec §6.2: remote sessions start at the server's remote cap).
  remote?: boolean;
}

// PMS item types a section of each type holds (a fan-out with type= skips the others).
const SECTION_TYPES: Readonly<Record<string, number[]>> = { movie: [1, 18], show: [2, 3, 4, 18], artist: [8, 9, 10, 18], photo: [13, 14] };
const MAX_CACHE = 5000;
const SECTIONS_TTL_MS = 60_000;
const WATCHLIST_TTL_MS = 60_000;
// shortcut: one PMS request per watchlisted title and section, capped; use a bulk guid filter if PMS ever documents one.
const MAX_WATCHLIST = 50;

const empty = (): ItemsResult => ({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
const get = (path: string, query: Record<string, string> = {}): PmsReq => ({ method: 'GET', path, query });

interface Seen {
  type: string;
  title?: string;
  guid?: string;
  section?: string;
}

export class PlexClient extends ApiClient {
  // '{id}/{ImageType}' → PMS image path, from every item mapped (images.ts imagePaths).
  private images = new Map<string, string>();
  private seen = new Map<string, Seen>();
  private sectionList: { at: number; list: Promise<PlexSection[]> } | null = null;
  private watched: { at: number; guids: Promise<Set<string>> } | null = null;

  constructor(
    address: string,
    private readonly ident: ClientIdentity,
    token: string | undefined,
    userId: string | undefined,
    readonly plex: PlexClientOptions,
  ) {
    super(address, 'plex', ident, token, userId);
  }

  override get prefix(): string {
    return '';
  }

  override authHeaders(): Record<string, string> {
    return plexHeaders(this.ident, this.token);
  }

  // Two headers, the client id too (PMS wants it on parts, HLS segments and sidecar subtitles, which mpv fetches itself).
  override mediaAuthHeaders(): string[] {
    return this.token ? [`X-Plex-Token: ${this.token}`, `X-Plex-Client-Identifier: ${this.ident.deviceId}`] : [];
  }

  // Playback (PX-08, PX-09): PlaybackInfo, the reports, markers and the media paths of a play (plex-playback.ts).
  private play?: PlexPlayback;
  get playback(): PlexPlayback {
    return (this.play ??= new PlexPlayback((r) => this.pms(r), this.ident.deviceId, Boolean(this.plex.remote)));
  }

  // mpv's direct play URL (/Videos/{id}/stream…) is the part itself, known from the PlaybackInfo just answered.
  override url(path: string, query?: Query): string {
    const hit = matchRoute('GET', path);
    const pms = hit?.route.media && hit.route.op !== 'image' ? this.playback.mediaPath(hit.route.op, hit.params, Object.fromEntries(Object.entries(query ?? {}).map(([k, v]) => [k, String(v)]))) : null;
    return pms ? routed(`${this.address}${pms}`) : super.url(path, query);
  }

  override async request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    try {
      return (await this.answer(method.toUpperCase(), path, query ?? {}, body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined)) as T;
    } catch (err) {
      if (err instanceof PlexUnmapped) {
        log.warn(err.message);
        throw new ApiError(err.message, 404);
      }
      throw err;
    }
  }

  // ---- PMS ----

  private async pms(r: PmsReq, timeoutMs = 20_000): Promise<PlexContainer | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await net.fetch(routed(`${this.address}${r.path}${buildQuery(r.query)}`), {
        method: r.method,
        headers: { ...this.authHeaders(), ...r.headers },
        signal: controller.signal,
        redirect: 'error',
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ApiError(text.slice(0, 300) || `HTTP ${res.status}`, res.status);
      }
      const text = await res.text();
      if (!text || !(res.headers.get('content-type') ?? '').includes('json')) return undefined;
      return (JSON.parse(text) as { MediaContainer?: PlexContainer }).MediaContainer;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (controller.signal.aborted) throw new ApiError('timeout', 0);
      throw new ApiError(err instanceof Error ? err.message : String(err), 0);
    } finally {
      clearTimeout(timer);
    }
  }

  private sections(): Promise<PlexSection[]> {
    if (this.sectionList && Date.now() - this.sectionList.at < SECTIONS_TTL_MS) return this.sectionList.list;
    const list = this.pms(get('/library/sections')).then((c) => (c?.Directory ?? []).filter((s) => !s.hidden));
    this.sectionList = { at: Date.now(), list };
    list.catch(() => (this.sectionList = null));
    return list;
  }

  // A request that may need a section fan-out, genre ids, or the playlist path.
  private async exec(r: PmsReq): Promise<PlexContainer> {
    if (r.watchlist) return this.watchlisted(r);
    if (r.fanOut !== 'sections') return (await this.one(r)) ?? {};
    const type = Number(r.query.type);
    const secs = (await this.sections()).filter((s) => (type ? SECTION_TYPES[s.type]?.includes(type) : s.type !== 'photo'));
    const parts = await Promise.all(
      secs.map((s) =>
        this.one({ ...r, fanOut: undefined, path: r.path.replace('{section}', encodeURIComponent(s.key)) }).catch((err) => {
          // A genre this section does not have: nothing from it.
          if (err instanceof PlexUnmapped) return undefined;
          throw err;
        }),
      ),
    );
    const metas = sortMerged(parts.flatMap((p) => p?.Metadata ?? []), r.query.sort);
    const size = Number(r.headers?.['X-Plex-Container-Size']) || metas.length;
    return { Metadata: metas.slice(0, size), totalSize: parts.reduce((n, p) => n + (p?.totalSize ?? p?.Metadata?.length ?? 0), 0) };
  }

  private async one(r: PmsReq): Promise<PlexContainer | undefined> {
    let q = r;
    if (q.genres?.length) {
      const sec = /^\/library\/sections\/(\d+)\//.exec(q.path)?.[1];
      if (!sec) throw new PlexUnmapped('Genres outside a section');
      const dir = (await this.pms(get(`/library/sections/${sec}/genre`)))?.Directory ?? [];
      q = withGenreIds(q, dir as { key?: string; id?: string; title?: string }[]);
    }
    // A playlist's entries live under /playlists, not /library/metadata.
    const m = /^\/library\/metadata\/(\d+)\/(?:children|allLeaves)$/.exec(q.path);
    if (m && this.seen.get(m[1])?.type === 'playlist') q = { ...q, path: `/playlists/${m[1]}/items`, query: {} };
    return this.pms(q);
  }

  // ---- Mapping (and what the adapter remembers of each item) ----

  private remember(key: string, value: string): void {
    this.images.set(key, value);
    if (this.images.size > MAX_CACHE) this.images.delete(this.images.keys().next().value!);
  }

  private note(meta: PlexMeta): void {
    for (const [k, v] of Object.entries(imagePaths(meta))) this.remember(k, v);
    this.seen.set(String(meta.ratingKey), { type: meta.type, title: meta.title, guid: meta.guid, section: meta.librarySectionID === undefined ? undefined : String(meta.librarySectionID) });
    for (const p of [...(meta.Role ?? []), ...(meta.Director ?? []), ...(meta.Writer ?? [])]) if (p.id !== undefined && p.tag) this.seen.set(personId(p.id), { type: 'person', title: p.tag });
    if (this.seen.size > MAX_CACHE) this.seen.delete(this.seen.keys().next().value!);
  }

  private async watchGuids(): Promise<Set<string>> {
    const wl = this.plex.watchlist;
    if (!wl) return new Set();
    if (!this.watched || Date.now() - this.watched.at > WATCHLIST_TTL_MS) {
      const guids = wl.guids().then(
        (g) => new Set(g),
        (err) => {
          log.warn('watchlist unavailable', err);
          this.watched = null;
          return new Set<string>();
        },
      );
      this.watched = { at: Date.now(), guids };
    }
    return this.watched.guids;
  }

  private async items(metas: PlexMeta[]): Promise<BaseItem[]> {
    const favs = await this.watchGuids();
    const out: BaseItem[] = [];
    for (const m of metas) {
      this.note(m);
      const it = toItem(m);
      if (!it) continue;
      if (it.UserData && m.guid && favs.has(m.guid)) it.UserData.IsFavorite = true;
      out.push(it);
    }
    return out;
  }

  private async list(r: PmsReq, query: Query): Promise<ItemsResult> {
    const c = await this.exec(r);
    const Items = await this.items(answerMeta(r, c));
    const start = Number(query.StartIndex) || 0;
    const total = !r.keep && typeof c.totalSize === 'number' ? c.totalSize : start + Items.length;
    return { Items, TotalRecordCount: total, StartIndex: start };
  }

  private async metaOf(id: string): Promise<PlexMeta> {
    const meta = (await this.pms(metadataRequest(id)))?.Metadata?.[0];
    if (!meta) throw new ApiError('Not found', 404);
    this.note(meta);
    return meta;
  }

  // Favorites (D-6): the watchlisted titles this server holds, found by guid in each section.
  private async watchlisted(r: PmsReq): Promise<PlexContainer> {
    const guids = [...(await this.watchGuids())].slice(0, MAX_WATCHLIST);
    const base: PmsReq = { ...r, watchlist: undefined, headers: undefined };
    const parts = await Promise.all(guids.map((guid) => this.exec({ ...base, query: { ...r.query, guid } }).catch(() => undefined)));
    const seen = new Set<string>();
    const metas = parts.flatMap((p) => p?.Metadata ?? []).filter((m) => !seen.has(m.ratingKey) && seen.add(m.ratingKey));
    const start = Number(r.headers?.['X-Plex-Container-Start']) || 0;
    const size = Number(r.headers?.['X-Plex-Container-Size']) || metas.length;
    return { Metadata: metas.slice(start, start + size), totalSize: metas.length, offset: start };
  }

  // ---- Answers ----

  private async answer(method: string, path: string, query: Query, body: Record<string, unknown> | undefined): Promise<unknown> {
    const { op, params, req } = translate(method, path, query as Record<string, string | number | boolean | undefined>, body, { machineId: this.plex.machineId });
    switch (op) {
      case 'me': {
        // A call that needs the token: a 401 here is what tells the session it is gone (a PIN changed, a share revoked).
        await this.pms(get('/'));
        const user: UserDto = { Id: this.userId ?? '', Name: this.plex.userName, Policy: { IsAdministrator: this.plex.owner } };
        return user;
      }
      case 'identity': {
        const c = (await this.pms(req!)) as (PlexContainer & { version?: string }) | undefined;
        const info: SystemInfoPublic = { Id: c?.machineIdentifier ?? this.plex.machineId, ServerName: '', Version: c?.version ?? '', ProductName: 'Plex Media Server' };
        return info;
      }
      case 'views': {
        const secs = await this.sections();
        for (const s of secs) if (s.thumb) this.remember(`section-${s.key}/Primary`, s.thumb);
        return { Items: secs.map(toView), TotalRecordCount: secs.length, StartIndex: 0 };
      }
      case 'hubs': {
        const c = await this.pms(req!);
        for (const h of c?.Hub ?? []) for (const m of h.Metadata ?? []) this.note(m);
        return toHubs(c);
      }
      case 'item':
        return req ? (await this.items([await this.metaOf(params.id)]))[0] : this.pseudoItem(params.id);
      case 'trailers':
      case 'extras': {
        const extras = toExtras(await this.metaOf(params.id), op === 'trailers');
        return extras;
      }
      case 'ancestors':
        return this.ancestors(await this.metaOf(params.id));
      case 'seasons':
        if (seasonsFlattened(await this.metaOf(params.id))) return empty();
        return this.list(req!, query);
      case 'items':
      case 'resume':
      case 'nextUp':
      case 'similar':
      case 'episodes':
      case 'playlistItems':
      case 'artists':
        return this.list(req!, query);
      case 'latest':
        return (await this.list(req!, query)).Items;
      case 'genres':
      case 'years': {
        const dir = ((await this.pms(req!))?.Directory ?? []) as { key?: string; title?: string }[];
        const Items = dir.map((d) => (op === 'years' ? { Id: String(d.key ?? d.title), Name: String(d.title), Type: 'Year', ProductionYear: Number(d.title) || undefined } : { Id: `genre-${d.key}`, Name: String(d.title), Type: 'Genre' }));
        return { Items, TotalRecordCount: Items.length, StartIndex: 0 };
      }
      case 'segments':
        return this.playback.segments(params.id);
      case 'playbackInfo':
        return this.playback.playbackInfo(params.id, query, body);
      case 'timeline':
        return this.playback.timeline(/\/Stopped$/i.test(path) ? 'Stopped' : /\/Progress$/i.test(path) ? 'Progress' : '', body);
      case 'empty':
        return empty();
      case 'noop':
        return undefined;
      case 'favorite':
      case 'unfavorite':
        return this.setFavorite(params.id, op === 'favorite');
      case 'createPlaylist': {
        const c = await this.pms(req!);
        return { Id: c?.Metadata?.[0]?.ratingKey };
      }
      case 'createCollection':
        return this.createCollection(query);
      case 'playlistMove':
        return this.movePlaylistEntry(params.id, params.entry, Number(params.index));
      default:
        // Writes the table translated (played, refresh, playlist and collection edits, reports): done, nothing to map.
        if (req && method !== 'GET') {
          await this.pms(req);
          return undefined;
        }
        throw new PlexUnmapped(`${method} ${path.split('?')[0]}`);
    }
  }

  // A section (its view) or a person (their page), which PMS does not serve as items.
  private async pseudoItem(id: string): Promise<BaseItem> {
    const p = parseId(id);
    if (p?.kind === 'section') {
      const s = (await this.sections()).find((x) => x.key === p.key);
      if (!s) throw new ApiError('Not found', 404);
      return toView(s);
    }
    if (p?.kind === 'person') {
      const tag = this.images.get(`${id}/Primary`);
      return { Id: id, Name: this.seen.get(id)?.title ?? '', Type: 'Person', ...(tag ? { ImageTags: { Primary: tag.split('/').pop() ?? '' } } : {}) };
    }
    throw new PlexUnmapped(`item ${id}`);
  }

  private async ancestors(meta: PlexMeta): Promise<BaseItem[]> {
    const out: BaseItem[] = [];
    if (meta.parentRatingKey) out.push({ Id: String(meta.parentRatingKey), Name: meta.parentTitle ?? '', Type: meta.type === 'episode' ? 'Season' : meta.type === 'track' ? 'MusicAlbum' : 'Series' });
    if (meta.grandparentRatingKey) out.push({ Id: String(meta.grandparentRatingKey), Name: meta.grandparentTitle ?? '', Type: meta.type === 'track' ? 'MusicArtist' : 'Series' });
    const s = (await this.sections()).find((x) => String(x.key) === String(meta.librarySectionID));
    if (s) out.push(toView(s));
    return out;
  }

  private async setFavorite(id: string, on: boolean): Promise<unknown> {
    const wl = this.plex.watchlist;
    if (!wl) throw new PlexUnmapped('FavoriteItems without a plex.tv account');
    const guid = this.seen.get(itemKey(id))?.guid ?? (await this.metaOf(id)).guid;
    if (!guid?.startsWith('plex://')) throw new PlexUnmapped(`FavoriteItems ${id}: no plex:// guid (legacy agent)`);
    await wl.set(guid, on);
    this.watched = null;
    return { IsFavorite: on };
  }

  // Emby creates a collection from items; PMS needs the section and the item type, read from the first one.
  private async createCollection(query: Query): Promise<{ Id?: string }> {
    const name = String(query.Name ?? '');
    const ids = String(query.Ids ?? '').split(',').filter(Boolean);
    if (!name || !ids.length) throw new PlexUnmapped('POST /Collections without Name or Ids');
    const first = await this.metaOf(ids[0]);
    const type = PLEX_TYPE[toItem(first)?.Type ?? ''];
    if (!type || first.librarySectionID === undefined) throw new PlexUnmapped(`POST /Collections of a ${first.type}`);
    const c = await this.pms({ method: 'POST', path: '/library/collections', query: { type: String(type), title: name, smart: '0', sectionId: String(first.librarySectionID), uri: itemsUri(this.plex.machineId, ids) } });
    return { Id: c?.Metadata?.[0]?.ratingKey };
  }

  // Emby moves an entry to an index; PMS moves it after another entry.
  private async movePlaylistEntry(playlistId: string, entry: string, index: number): Promise<void> {
    const c = await this.pms(get(`/playlists/${itemKey(playlistId)}/items`));
    const others = (c?.Metadata ?? []).map((m) => String(m.playlistItemID)).filter((x) => x !== entry);
    const after = index > 0 ? others[Math.min(index, others.length) - 1] : undefined;
    await this.pms({ method: 'PUT', path: `/playlists/${itemKey(playlistId)}/items/${itemKey(entry)}/move`, query: after ? { after } : {} });
  }

  // ---- Media (wicaby-media://api) ----

  // The PMS path for an Emby media path: images through /photo/:/transcode; a PMS path the adapter emitted passes.
  // null: not here (404).
  async mediaPath(relWithQuery: string): Promise<string | null> {
    const [path, search = ''] = relWithQuery.split('?', 2);
    if (/^\/(?:library|photo\/:|video\/:)\//.test(path)) return relWithQuery;
    // A play's part, BIF or sidecar subtitle (plex-playback.ts).
    const hit = matchRoute('GET', path);
    if (hit?.route.media && hit.route.op !== 'image') return this.playback.mediaPathAsync(hit.route.op, hit.params, Object.fromEntries(new URLSearchParams(search)));
    const img = parseImageRoute(path);
    if (!img) return null;
    const key = (type: string) => this.images.get(`${img.id}/${type}`);
    if (!key(img.type) && parseId(img.id)?.kind === 'item') await this.metaOf(img.id).catch(() => undefined);
    // Emby's Thumb (a landscape still) is Plex's art.
    const pmsPath = key(img.type) ?? (img.type === 'Thumb' ? key('Backdrop') : undefined);
    return pmsPath ? transcodePath(pmsPath, img.type, Object.fromEntries(new URLSearchParams(search))) : null;
  }
}

// Sections answered apart: merged in the order PMS used inside each one (the first sort key).
function sortMerged(metas: PlexMeta[], sort: string | undefined): PlexMeta[] {
  const [key, dir] = (sort ?? '').split(',')[0].split(':');
  if (!key || key === 'random') return metas;
  const val = (m: PlexMeta): string | number => {
    const v = (m as unknown as Record<string, unknown>)[key === 'titleSort' ? 'titleSort' : key] ?? (key === 'titleSort' ? m.title : undefined);
    return typeof v === 'number' ? v : String(v ?? '').toLowerCase();
  };
  const sign = dir === 'desc' ? -1 : 1;
  return [...metas].sort((a, b) => (val(a) < val(b) ? -sign : val(a) > val(b) ? sign : 0));
}
