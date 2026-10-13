// The "files dialect" (file-sources-spec §3.1): a file source answers the Emby-shaped calls the renderer and
// the playback service already make, through a route table over its backend. Unknown routes throw
// FILES-UNMAPPED (404), which the UI reads as "not here". Progress, played and hidden are local (§4.4): the
// session reports the playback service posts land in this source's progress store.
import { Readable } from 'node:stream';
import { TICKS_PER_MS, type FileProtocol, type Query } from '../../shared/contract';
import { baseName, decodeId, encodeId, joinRel, parentRel, ROOT_ID } from '../../shared/files/ids';
import { episodeLabel, extOf, isVideoName, parseName, type ParsedName } from '../../shared/files/names';
import { natCompare } from '../../shared/files/natsort';
import { MAX_NFO_BYTES, parseNfo, type NfoInfo } from '../../shared/files/nfo';
import { continueList, sameFile, type ProgressRecord } from '../../shared/files/progress';
import { episodeOrder, folderShape, seasonNumber, seasonOrder, type FolderShape } from '../../shared/files/shapes';
import { folderSidecars, videoSidecars, type SidecarSubtitle } from '../../shared/files/sidecars';
import type { BaseItem, ItemsResult, MediaStream } from '../../shared/models';
import { ApiClient, ApiError, buildQuery, type ClientIdentity } from '../connection/api-client';
import { logger } from '../core/log';
import { filesError, MAX_ENTRIES, mimeOf, type FileEntry, type FilesBackend } from './backend';
import type { LoopbackRelay } from './loopback';
import type { ProgressStore } from './progress';

const log = logger.scope('files');

const LISTING_TTL_MS = 60_000;
const MAX_POSTER_BYTES = 10 * 1024 * 1024;
const MAX_SUBTITLE_BYTES = 4 * 1024 * 1024;
const SUB_INDEX = 100;
const HIDDEN = new Set(['@eadir', '#recycle', '$recycle.bin', 'system volume information', 'lost+found', '#snapshot', '@recycle']);

export const isHiddenName = (name: string): boolean => name.startsWith('.') || name.startsWith('.Trash-') || HIDDEN.has(name.toLowerCase());

const empty = (): ItemsResult => ({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
const iso = (ms: number): string | undefined => (ms > 0 ? new Date(ms).toISOString() : undefined);
const tagOf = (e: { size: number; mtime: number }): string => `${e.size.toString(36)}${Math.floor(e.mtime / 1000).toString(36)}`;

export interface FileSourceView {
  id: string;
  name: string;
  protocol: FileProtocol;
}

interface Listing {
  at: number;
  entries: FileEntry[];
  truncated: boolean;
}

// What the playback service plays for a file item.
export interface FilesPlayTarget {
  url: string;
  subtitles: { index: number; url: string; label: string; language?: string }[];
  title: string;
  // The file changed since its progress was saved (size or mtime): it starts at 0.
  changed: boolean;
  durationMs: number;
}

export class FilesClient extends ApiClient {
  private listings = new Map<string, Promise<Listing>>();
  // Size and mtime of files seen in a listing or opened, for progress reports.
  private seen = new Map<string, { size: number; mtime: number }>();
  // This source's relay play (one player at a time): started once its Playing report came, so a Stopped
  // report of the play it replaced (a version switch reports after the new load) does not end it.
  private play: { url: string; started: boolean } | null = null;

  constructor(
    public source: FileSourceView,
    readonly backend: FilesBackend,
    readonly progress: ProgressStore,
    identity: ClientIdentity,
    private readonly relay: LoopbackRelay,
  ) {
    super(`wicaby-files://${source.id}`, 'files', identity, undefined, 'local');
  }

  override get prefix(): string {
    return '';
  }

  override url(path: string, query?: Query): string {
    return `${this.address}${path}${buildQuery(query)}`;
  }

  override authHeaders(): Record<string, string> {
    return {};
  }

  override mediaAuthHeaders(): string[] {
    return [];
  }

  // Pull-to-refresh / Refresh: the next listing goes to the backend.
  refresh(): void {
    this.listings.clear();
  }

  override async request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    const q = query ?? {};
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;
    const is = (verb: string, re: RegExp) => method === verb && (m = re.exec(path)) !== null;
    if (is('GET', /^\/Users\/[^/]+\/Views$/)) return { Items: [this.rootItem()], TotalRecordCount: 1 } as T;
    if (is('GET', /^\/Users\/[^/]+\/Items\/Resume$/)) return (await this.resume(Number(q.Limit) || 24)) as T;
    if (is('GET', /^\/Users\/[^/]+\/Items\/Latest$/)) return [] as T;
    if (is('GET', /^\/Users\/[^/]+\/Items$/)) return (await this.items(q)) as T;
    if (is('GET', /^\/Users\/[^/]+\/Items\/([^/]+)$/)) return (await this.item(m![1])) as T;
    if (is('POST', /^\/Users\/[^/]+\/PlayedItems\/([^/]+)$/)) return (await this.setPlayed(m![1], true)) as T;
    if (is('DELETE', /^\/Users\/[^/]+\/PlayedItems\/([^/]+)$/)) return (await this.setPlayed(m![1], false)) as T;
    if (is('POST', /^\/Users\/[^/]+\/Items\/([^/]+)\/HideFromResume$/)) return this.hide(m![1], q.Hide !== false && q.Hide !== 'false') as T;
    if (is('GET', /^\/Shows\/(NextUp|Upcoming)$/)) return empty() as T;
    if (is('GET', /^\/Shows\/([^/]+)\/Seasons$/)) return (await this.seasons(m![1])) as T;
    if (is('GET', /^\/Shows\/([^/]+)\/Episodes$/)) return (await this.episodes(m![1], q.SeasonId)) as T;
    if (is('POST', /^\/Sessions\/Playing(\/Progress|\/Stopped)?$/)) return (await this.report(m![1] ?? '', b)) as T;
    if (is('POST', /^\/Sessions\/(Playing\/Ping|Capabilities\/Full)$/)) return undefined as T;
    throw new ApiError(`FILES-UNMAPPED ${method} ${path.split('?')[0]}`, 404);
  }

  // ---- Listing ----

  private listing(rel: string): Promise<Listing> {
    const hit = this.listings.get(rel);
    if (hit) return hit;
    const p = this.backend.list(rel).then((all) => {
      for (const e of all) if (!e.dir) this.seen.set(joinRel(rel, e.name), { size: e.size, mtime: e.mtime });
      return { at: Date.now(), entries: all, truncated: all.length >= MAX_ENTRIES };
    });
    this.listings.set(rel, p);
    p.catch(() => this.listings.delete(rel));
    setTimeout(() => this.listings.get(rel) === p && this.listings.delete(rel), LISTING_TTL_MS).unref?.();
    if (this.listings.size > 200) this.listings.delete(this.listings.keys().next().value!);
    return p;
  }

  private visible(e: FileEntry): boolean {
    return !isHiddenName(e.name) && (e.dir || isVideoName(e.name));
  }

  private rootItem(): BaseItem {
    return { Id: ROOT_ID, Name: this.source.name, Type: 'CollectionFolder', CollectionType: 'mixed', IsFolder: true, ServerId: this.source.id };
  }

  private async items(q: Query): Promise<ItemsResult> {
    // Search, filters and recursive queries need an index (folder mode has none).
    if (q.SearchTerm || q.Filters || q.Ids || q.PersonIds || q.ArtistIds || q.Genres || q.Recursive === true || q.Recursive === 'true' || q.IsFavorite) return empty();
    const rel = typeof q.ParentId === 'string' ? decodeId(q.ParentId) : null;
    if (rel === null) return empty();
    const listing = await this.listing(rel);
    const names = listing.entries.filter((e) => !e.dir).map((e) => e.name);
    const shown = listing.entries.filter((e) => this.visible(e));
    const sort = String(q.SortBy ?? 'SortName').split(',')[0];
    const desc = q.SortOrder === 'Descending' ? -1 : 1;
    const by =
      sort === 'DateCreated' || sort === 'DateModified'
        ? (a: FileEntry, b: FileEntry) => a.mtime - b.mtime
        : sort === 'Size'
          ? (a: FileEntry, b: FileEntry) => a.size - b.size
          : (a: FileEntry, b: FileEntry) => (a.dir ? seasonOrder(a.name, b.name) : episodeOrder(a.name, b.name)) || natCompare(a.name, b.name);
    shown.sort((a, b) => Number(b.dir) - Number(a.dir) || desc * by(a, b) || natCompare(a.name, b.name));
    const start = Math.max(0, Number(q.StartIndex) || 0);
    const limit = Math.max(0, Number(q.Limit) || shown.length);
    const page = shown.slice(start, start + limit);
    const items = (await Promise.all(page.map((e) => this.cardOf(rel, e, names)))).filter((x): x is BaseItem => x !== null);
    const out: ItemsResult & { Truncated?: boolean } = { Items: items, TotalRecordCount: shown.length, StartIndex: start };
    if (listing.truncated) out.Truncated = true;
    return out;
  }

  // The shape of a folder (§4.3) from its listing; a folder that cannot be listed is a plain folder.
  private async shapeOf(rel: string): Promise<{ shape: FolderShape; film?: FileEntry; names: string[] }> {
    if (seasonNumber(baseName(rel)) !== undefined) return { shape: 'Season', names: [] };
    const inside = await this.listing(rel).catch(() => null);
    const children = (inside?.entries ?? []).filter((c) => !isHiddenName(c.name));
    return { ...folderShape(baseName(rel), children), names: children.filter((c) => !c.dir).map((c) => c.name) };
  }

  // A card of a listing: a film folder is its film (the card opens it directly), a series or season folder
  // gets that type; the ids stay those of the paths.
  private async cardOf(parent: string, e: FileEntry, siblings: string[]): Promise<BaseItem | null> {
    const rel = joinRel(parent, e.name);
    if (!e.dir) return this.entryItem(rel, e, siblings);
    const shape = await this.shapeOf(rel);
    if (shape.shape === 'Movie' && shape.film) {
      const film = this.entryItem(joinRel(rel, shape.film.name), shape.film, shape.names);
      if (film) {
        const p = parseName(e.name);
        film.Type = 'Movie';
        film.Name = p.title || e.name;
        if (p.year) film.ProductionYear = p.year;
        return film;
      }
    }
    return this.entryItem(rel, e, siblings, shape.shape);
  }

  // A video named as an episode: the series is the season folder's parent, else its own folder.
  private episodeOf(item: BaseItem, rel: string, p: ParsedName): void {
    const parent = parentRel(rel);
    if (p.episode === undefined || !parent) return;
    const season = seasonNumber(baseName(parent));
    const series = season !== undefined ? parentRel(parent) : parent;
    item.Type = 'Episode';
    item.SeriesId = encodeId(series) ?? ROOT_ID;
    item.SeriesName = this.titleOf(series);
    if (season !== undefined) {
      item.SeasonId = encodeId(parent) ?? undefined;
      item.ParentIndexNumber ??= season;
    }
  }

  // A series folder named "Example Show (2019)" shows as "Example Show"; the root is the source.
  private titleOf(rel: string): string {
    return rel ? parseName(baseName(rel)).title || baseName(rel) : this.source.name;
  }

  // A listing entry as an item; null when its path is too long to have an id.
  private entryItem(rel: string, e: FileEntry, siblings: string[], shape?: FolderShape): BaseItem | null {
    const id = encodeId(rel);
    if (!id) return null;
    const parentId = encodeId(parentRel(rel)) ?? ROOT_ID;
    if (e.dir) {
      const season = seasonNumber(e.name);
      return {
        Id: id,
        Name: e.name,
        Type: season !== undefined ? 'Season' : shape === 'Series' ? 'Series' : 'Folder',
        IsFolder: true,
        ...(season !== undefined ? { IndexNumber: season, SeriesId: parentId, SeriesName: this.titleOf(parentRel(rel)) } : {}),
        ParentId: parentId,
        ServerId: this.source.id,
        DateCreated: iso(e.mtime),
        // Optimistic: the image route looks for poster/folder/cover when asked, else 404 (the card's placeholder).
        ImageTags: { Primary: `f${tagOf(e)}` },
      };
    }
    const parsed = parseName(e.name);
    const label = episodeLabel(parsed);
    const side = videoSidecars(e.name, siblings);
    const rec = this.progress.get(rel);
    const item: BaseItem = {
      Id: id,
      Name: label ? `${label}${parsed.title ? ` · ${parsed.title}` : ''}` : rec?.title || parsed.title || e.name,
      Type: 'Video',
      MediaType: 'Video',
      IsFolder: false,
      ParentId: parentId,
      ServerId: this.source.id,
      Container: extOf(e.name),
      DateCreated: iso(e.mtime),
      ...(parsed.year ? { ProductionYear: parsed.year } : {}),
      ...(parsed.episode !== undefined ? { IndexNumber: parsed.episode } : {}),
      ...(parsed.season !== undefined ? { ParentIndexNumber: parsed.season } : {}),
      ...(side.poster ? { ImageTags: { Primary: `v${tagOf(e)}` } } : {}),
      ...(side.backdrop ? { BackdropImageTags: [`b${tagOf(e)}`] } : {}),
    };
    this.episodeOf(item, rel, parsed);
    this.applyUserData(item, rec, e);
    return item;
  }

  private applyUserData(item: BaseItem, rec: ProgressRecord | undefined, file: { size: number; mtime: number } | null): void {
    const fresh = rec && (!file || sameFile(rec, file.size, file.mtime));
    if (fresh && rec.durationMs > 0) item.RunTimeTicks = Math.round(rec.durationMs * TICKS_PER_MS);
    item.UserData = fresh
      ? {
          Played: rec.played,
          PlaybackPositionTicks: Math.round(rec.positionMs * TICKS_PER_MS),
          PlayedPercentage: rec.durationMs > 0 ? (rec.positionMs / rec.durationMs) * 100 : undefined,
          LastPlayedDate: iso(rec.lastPlayedAt),
          PlayCount: rec.played ? 1 : 0,
          IsFavorite: false,
        }
      : { Played: false, PlaybackPositionTicks: 0, IsFavorite: false };
  }

  // ---- One item ----

  private relOf(id: string): string {
    const rel = decodeId(id);
    if (rel === null) throw filesError('invalid');
    return rel;
  }

  private async nfo(rel: string): Promise<NfoInfo | null> {
    try {
      return parseNfo((await this.backend.read(rel, MAX_NFO_BYTES)).toString('utf8'));
    } catch {
      return null;
    }
  }

  async item(id: string): Promise<BaseItem> {
    const rel = this.relOf(id);
    if (!rel) return this.rootItem();
    const st = await this.backend.stat(rel);
    const parent = parentRel(rel);
    if (st.dir) {
      const inside = await this.listing(rel).catch(() => null);
      const side = folderSidecars((inside?.entries ?? []).filter((e) => !e.dir).map((e) => e.name));
      const shape = folderShape(baseName(rel), (inside?.entries ?? []).filter((c) => !isHiddenName(c.name))).shape;
      const item = this.entryItem(rel, { ...st, name: baseName(rel) }, [], shape)!;
      if (!side.poster) delete item.ImageTags;
      const info = side.nfo ? await this.nfo(joinRel(rel, side.nfo)) : null;
      if (info?.title) item.Name = info.title;
      if (info?.plot) item.Overview = info.plot;
      if (info?.year) item.ProductionYear = info.year;
      if (info?.genres.length) item.Genres = info.genres;
      item.ChildCount = inside?.entries.filter((e) => this.visible(e)).length;
      return item;
    }
    this.seen.set(rel, { size: st.size, mtime: st.mtime });
    const around = (await this.listing(parent)).entries.filter((e) => !isHiddenName(e.name));
    const siblings = around.filter((e) => !e.dir).map((e) => e.name);
    const name = baseName(rel);
    const item = this.entryItem(rel, { ...st, name }, siblings);
    if (!item) throw filesError('invalid');
    if (parent && folderShape(baseName(parent), around).film?.name === name) item.Type = 'Movie';
    const side = videoSidecars(name, siblings);
    const info = side.nfo ? await this.nfo(joinRel(parent, side.nfo)) : null;
    if (info) {
      if (info.title && info.kind !== 'tvshow') item.Name = info.kind === 'episode' && info.episode !== undefined ? `${episodeLabel({ title: '', season: info.season, episode: info.episode })} · ${info.title}` : info.title;
      if (info.plot) item.Overview = info.plot;
      if (info.year) item.ProductionYear = info.year;
      if (info.genres.length) item.Genres = info.genres;
      if (Object.keys(info.providerIds).length) item.ProviderIds = info.providerIds;
      if (!item.RunTimeTicks && info.runtimeMin) item.RunTimeTicks = info.runtimeMin * 60_000 * TICKS_PER_MS;
    }
    const streams: MediaStream[] = side.subtitles.map((s, i) => this.subtitleStream(s, i));
    item.MediaSources = [
      {
        Id: item.Id,
        Name: name,
        Protocol: this.source.protocol === 'webdav' ? 'Http' : 'File',
        Container: extOf(name),
        Size: st.size,
        RunTimeTicks: item.RunTimeTicks,
        SupportsDirectPlay: true,
        SupportsDirectStream: false,
        SupportsTranscoding: false,
        MediaStreams: streams,
      },
    ];
    item.MediaStreams = streams;
    return item;
  }

  private subtitleStream(s: SidecarSubtitle, i: number): MediaStream {
    const flags = [s.forced ? 'Forced' : '', s.hearingImpaired ? 'SDH' : ''].filter(Boolean);
    return {
      Index: SUB_INDEX + i,
      Type: 'Subtitle',
      Codec: s.codec,
      Language: s.language,
      IsForced: s.forced,
      IsExternal: true,
      IsTextSubtitleStream: s.codec !== 'sub',
      DeliveryMethod: 'External',
      DisplayTitle: [s.language?.toUpperCase() ?? s.codec.toUpperCase(), ...flags].join(' · '),
    };
  }

  // ---- Local user data ----

  private async fileOf(rel: string): Promise<{ size: number; mtimeMs: number }> {
    let known = this.seen.get(rel);
    if (!known) {
      known = await this.backend.stat(rel);
      this.seen.set(rel, known);
    }
    return { size: known.size, mtimeMs: known.mtime };
  }

  private async setPlayed(id: string, played: boolean): Promise<{ Played: boolean }> {
    const rel = this.relOf(id);
    const file = await this.fileOf(rel);
    this.progress.patch(
      rel,
      (r) => {
        r.played = played;
        r.positionMs = 0;
        r.lastPlayedAt = Date.now();
      },
      file,
    );
    return { Played: played };
  }

  private hide(id: string, hidden: boolean): undefined {
    this.progress.patch(this.relOf(id), (r) => {
      r.hidden = hidden;
    });
    return undefined;
  }

  // Sessions/Playing (start), /Progress and /Stopped: the position and duration the player reported.
  private async report(kind: string, b: Record<string, unknown>): Promise<undefined> {
    const rel = decodeId(b.ItemId);
    if (this.play && !kind) this.play.started = true;
    if (this.play?.started && kind === '/Stopped') this.endPlay();
    if (rel === null || !kind) return undefined;
    const file = await this.fileOf(rel).catch(() => null);
    if (!file) return undefined;
    const pos = Number(b.PositionTicks ?? 0) / TICKS_PER_MS;
    const dur = Number(b.RunTimeTicks ?? 0) / TICKS_PER_MS;
    this.progress.report(rel, file, Number.isFinite(pos) ? pos : 0, Number.isFinite(dur) ? dur : 0);
    return undefined;
  }

  // Tags read at first play (D5).
  cacheTitle(id: string, title: string | undefined): void {
    const rel = decodeId(id);
    const clean = title?.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
    const seen = rel !== null ? this.seen.get(rel) : undefined;
    // Read right after the file loaded, before any report: the record starts here when there is none.
    if (rel !== null && clean) this.progress.patch(rel, (r) => void (r.title = clean), seen && { size: seen.size, mtimeMs: seen.mtime });
  }

  // Continue: records with a position, then "next in folder" after the files played last.
  private async resume(limit: number): Promise<ItemsResult> {
    const doc = this.progress.doc;
    const items: BaseItem[] = [];
    for (const rel of continueList(doc, limit)) {
      const id = encodeId(rel);
      if (!id) continue;
      const rec = doc.records[rel];
      const p = parseName(baseName(rel));
      const label = episodeLabel(p);
      const item: BaseItem = {
        Id: id,
        Name: rec.title || (label ? `${label}${p.title ? ` · ${p.title}` : ''}` : p.title || baseName(rel)),
        Type: 'Video',
        MediaType: 'Video',
        ParentId: encodeId(parentRel(rel)) ?? ROOT_ID,
        ServerId: this.source.id,
        Container: extOf(rel),
      };
      this.episodeOf(item, rel, p);
      // Not re-checked here: the file is stat-ed when it is opened.
      this.applyUserData(item, rec, null);
      items.push(item);
    }
    const played = Object.entries(doc.records)
      .filter(([, r]) => r.played && r.positionMs === 0)
      .sort((a, b) => b[1].lastPlayedAt - a[1].lastPlayedAt)
      .slice(0, 5);
    for (const [rel, rec] of played) {
      if (items.length >= limit) break;
      const parent = parentRel(rel);
      const listing = await this.listing(parent).catch(() => null);
      if (!listing) continue;
      const videos = listing.entries.filter((e) => !e.dir && this.visible(e)).sort((a, b) => natCompare(a.name, b.name));
      const next = videos[videos.findIndex((e) => e.name === baseName(rel)) + 1];
      const nextRel = next ? joinRel(parent, next.name) : null;
      if (!next || !nextRel || this.progress.get(nextRel)?.played || items.some((x) => decodeId(x.Id) === nextRel)) continue;
      const item = this.entryItem(nextRel, next, listing.entries.filter((e) => !e.dir).map((e) => e.name));
      if (item) {
        item.UserData = { ...item.UserData, LastPlayedDate: iso(rec.lastPlayedAt) };
        items.push(item);
      }
    }
    return { Items: items.slice(0, limit), TotalRecordCount: Math.min(items.length, limit), StartIndex: 0 };
  }

  // ---- Series and season folders (§4.3): the routes the item page and the play button use ----

  private async seasons(seriesId: string): Promise<ItemsResult> {
    const rel = this.relOf(seriesId);
    const dirs = (await this.listing(rel)).entries.filter((e) => e.dir && !isHiddenName(e.name) && seasonNumber(e.name) !== undefined);
    dirs.sort((a, b) => seasonOrder(a.name, b.name) || natCompare(a.name, b.name));
    const items = dirs.map((e) => this.entryItem(joinRel(rel, e.name), e, [])).filter((x): x is BaseItem => x !== null);
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  // The videos of one season folder, or of the series folder and all its seasons, in episode order.
  private async episodes(seriesId: string, seasonId: unknown): Promise<ItemsResult> {
    const rel = this.relOf(seriesId);
    const season = typeof seasonId === 'string' ? decodeId(seasonId) : null;
    const folders = season && parentRel(season) === rel ? [season] : [rel, ...(await this.seasons(seriesId)).Items.map((x) => decodeId(x.Id)!)];
    const items: BaseItem[] = [];
    for (const dir of folders) {
      const listing = await this.listing(dir).catch(() => null);
      if (!listing) continue;
      const names = listing.entries.filter((e) => !e.dir).map((e) => e.name);
      const videos = listing.entries.filter((e) => !e.dir && this.visible(e)).sort((a, b) => episodeOrder(a.name, b.name) || natCompare(a.name, b.name));
      for (const e of videos) {
        const item = this.entryItem(joinRel(dir, e.name), e, names);
        if (item) items.push(item);
      }
    }
    return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
  }

  // ---- Media (wicaby-media://api/<sourceId>/…) ----

  // Images, the file itself (HTML player) and sidecar subtitles. rel: the API path.
  async media(apiPath: string, method: string, range: string | undefined): Promise<Response> {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges' };
    const m = /^\/Items\/([^/]+)\/(Images\/(Primary|Backdrop|Thumb)(?:\/0)?|File|Subtitles\/(\d{1,3}))$/.exec(apiPath);
    if (!m) return new Response('Not found', { status: 404, headers: cors });
    const rel = decodeId(m[1]);
    if (rel === null) return new Response('Bad request', { status: 400, headers: cors });
    try {
      if (m[3]) {
        const target = await this.imageOf(rel, m[3]);
        if (!target) return new Response('Not found', { status: 404, headers: cors });
        const data = await this.backend.read(target, MAX_POSTER_BYTES);
        return new Response(new Uint8Array(data), { headers: { 'Content-Type': mimeOf(target), 'Cache-Control': 'private, max-age=86400', ...cors } });
      }
      let target = rel;
      if (m[4] !== undefined) {
        const sub = (await this.sidecarsOf(rel)).subtitles[Number(m[4]) - SUB_INDEX];
        if (!sub) return new Response('Not found', { status: 404, headers: cors });
        target = joinRel(parentRel(rel), sub.name);
        const data = await this.backend.read(target, MAX_SUBTITLE_BYTES);
        return new Response(new Uint8Array(data), { headers: { 'Content-Type': mimeOf(target), ...cors } });
      }
      const r = await this.backend.open(target, range, method === 'HEAD');
      return new Response(r.body ? (Readable.toWeb(r.body) as ReadableStream) : null, { status: r.status, headers: { ...r.headers, ...cors } });
    } catch (err) {
      const status = err instanceof ApiError && err.status >= 400 && err.status < 500 ? err.status : 502;
      return new Response(null, { status, headers: cors });
    }
  }

  private async sidecarsOf(rel: string) {
    const siblings = (await this.listing(parentRel(rel))).entries.filter((e) => !e.dir).map((e) => e.name);
    return videoSidecars(baseName(rel), siblings);
  }

  private async imageOf(rel: string, type: string): Promise<string | null> {
    const st = await this.backend.stat(rel);
    if (st.dir) {
      const side = folderSidecars((await this.listing(rel)).entries.filter((e) => !e.dir).map((e) => e.name));
      const name = type === 'Backdrop' ? side.backdrop : side.poster;
      return name ? joinRel(rel, name) : null;
    }
    const side = await this.sidecarsOf(rel);
    const name = type === 'Backdrop' ? side.backdrop : side.poster;
    return name ? joinRel(parentRel(rel), name) : null;
  }

  // ---- Playback (playback-service.ts files branch) ----

  // The relay token of the last play stops working (file-sources-spec §5.1: one token per play).
  endPlay(): void {
    if (this.play) this.relay.release(this.play.url);
    this.play = null;
  }

  async playTarget(id: string, player: 'mpv' | 'html', mediaUrl: (path: string) => string): Promise<FilesPlayTarget> {
    const rel = this.relOf(id);
    const st = await this.backend.stat(rel);
    if (st.dir) throw filesError('notFound');
    this.seen.set(rel, { size: st.size, mtime: st.mtime });
    const rec = this.progress.get(rel);
    const changed = Boolean(rec && rec.positionMs > 0 && !sameFile(rec, st.size, st.mtime));
    if (changed) {
      log.info(`files: ${this.source.id.slice(0, 6)} item changed since its progress was saved, starting over`);
      this.progress.drop(rel);
    }
    const side = await this.sidecarsOf(rel);
    const subRels = side.subtitles.map((s) => joinRel(parentRel(rel), s.name));
    const label = (s: SidecarSubtitle) => [s.language?.toUpperCase() ?? s.codec.toUpperCase(), s.forced ? 'Forced' : '', s.hearingImpaired ? 'SDH' : ''].filter(Boolean).join(' · ');
    let url: string;
    let subUrls: string[];
    if (player === 'html') {
      url = mediaUrl(`/Items/${id}/File`);
      subUrls = side.subtitles.map((_, i) => mediaUrl(`/Items/${id}/Subtitles/${SUB_INDEX + i}`));
    } else if (this.backend.localPath) {
      url = await this.backend.localPath(rel);
      subUrls = await Promise.all(subRels.map((r) => this.backend.localPath!(r)));
    } else {
      this.endPlay();
      [url, ...subUrls] = await this.relay.register(this.backend, [rel, ...subRels]);
      this.play = { url, started: false };
    }
    return {
      url,
      subtitles: side.subtitles.map((s, i) => ({ index: SUB_INDEX + i, url: subUrls[i], label: label(s), language: s.language })),
      title: (!changed && rec?.title) || parseName(baseName(rel)).title || baseName(rel),
      changed,
      durationMs: !changed && rec ? rec.durationMs : 0,
    };
  }
}

