// The Navidrome (OpenSubsonic) dialect at run time (music-feishin-navidrome spec §4.B, the Plex adapter pattern): a
// SubsonicClient answers the Emby/Jellyfin-shaped music calls the renderer and main already make (api:request,
// wicaby-media://api, PlaybackInfo, the session reports) by calling the Subsonic API and mapping its records
// (shared/subsonic/map.ts). A route it does not know answers 404 'NAVIDROME-UNMAPPED …', never a wrong answer; the
// routes of a video server (resume, next up) answer empty lists, so merged views never count it as failing.
// Auth: token + salt (t = md5(password + s), a fresh s on every request), never p=. The credentials go only in the
// query of a request to this server's own address: the renderer and wicaby-media URLs never carry them, and mpv's
// direct-play URL is signed for this machine only (as an IPTV stream URL). Logs redact u/t/s/p (core/log.ts).
import { createHash, randomBytes } from 'node:crypto';
import { net } from 'electron';
import type { Query } from '../../shared/contract';
import type { BaseItem, ItemsResult } from '../../shared/models';
import { albumItem, albumListArgs, artistItem, decodeId, folderView, genreItem, lyricsToJellyfin, playlistItem, plainText, scrobbleDue, songItem } from '../../shared/subsonic/map';
import { logger } from '../core/log';
import { t } from '../i18n';
import { ApiClient, ApiError, redirectPolicy, routed, type ClientIdentity } from './api-client';

const log = logger.scope('navidrome');

type Rec = Record<string, unknown>;
type Params = Record<string, string | number | boolean | undefined | (string | number)[]>;

export const SUBSONIC_API_VERSION = '1.16.1';
const ARTISTS_TTL_MS = 60_000;
// The page a "fetch everything" loop asks for (getAlbumList2 caps size at 500).
const ALL_PAGE = 500;

// Subsonic error codes → HTTP statuses the app already understands.
const STATUS: Record<number, number> = { 10: 400, 20: 400, 30: 400, 40: 401, 41: 401, 42: 401, 43: 400, 44: 401, 50: 403, 60: 403, 70: 404 };

export class SubsonicError extends ApiError {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message, STATUS[code] ?? 500);
  }
}

// t = md5(password + salt) with a fresh crypto-random salt (OpenSubsonic token auth). The vector from the docs
// (sesame, c19b2d → 26719a1196d2a940705a59634eb18eab) is in fixtures/subsonic/vectors.json.
export function subsonicAuth(user: string, password: string, salt = randomBytes(8).toString('hex')): Record<string, string> {
  return { u: user, t: createHash('md5').update(password + salt, 'utf8').digest('hex'), s: salt, v: SUBSONIC_API_VERSION, c: 'Wicaby', f: 'json' };
}

function search(params: Params): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    for (const one of Array.isArray(v) ? v : [v]) out.append(k, String(one));
  }
  return out.toString();
}

// Query names in one case (Emby sends ParentId, Jellyfin parentId): first letter upper.
function norm(query: Query | undefined, body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === '') return;
    out[k[0].toUpperCase() + k.slice(1)] = Array.isArray(v) ? v.join(',') : String(v);
  };
  if (body && typeof body === 'object' && !Array.isArray(body)) for (const [k, v] of Object.entries(body)) put(k, v);
  for (const [k, v] of Object.entries(query ?? {})) put(k, v);
  return out;
}

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v && typeof v === 'object' ? [v as T] : []);
const result = (Items: BaseItem[], TotalRecordCount = Items.length, StartIndex = 0): ItemsResult => ({ Items, TotalRecordCount, StartIndex });
const page = (all: BaseItem[], q: Record<string, string>): ItemsResult => {
  const start = Number(q.StartIndex) || 0;
  const limit = Number(q.Limit) || all.length;
  return result(all.slice(start, start + limit), all.length, start);
};

export class SubsonicClient extends ApiClient {
  // getArtists by music folder ('' all).
  private artistsCache = new Map<string, { at: number; list: Promise<Rec[]> }>();
  private extensions: Promise<Set<string>> | null = null;
  // Plays already counted (submission=true), by PlaySessionId: one scrobble per play.
  private counted = new Set<string>();

  // token: the user's password (token+salt needs it), from the vault; userId: the user name.
  constructor(address: string, identity: ClientIdentity, token?: string, userId?: string) {
    super(address, 'navidrome', identity, token, userId);
  }

  override get prefix(): string {
    return '';
  }

  // No header auth in Subsonic: requests are signed in their query (sign).
  override authHeaders(): Record<string, string> {
    return {};
  }

  override mediaAuthHeaders(): string[] {
    return [];
  }

  // A URL to this server with fresh credentials appended. Only ever for this server's own origin.
  sign(url: string): string {
    if (!this.token || !this.userId) return url;
    return `${url}${url.includes('?') ? '&' : '?'}${search(subsonicAuth(this.userId, this.token))}`;
  }

  // mpv's direct-play (and download) URL: the Subsonic media URL, signed, for this machine's player only.
  override url(path: string, query?: Query): string {
    const media = this.mediaPath(`${path}${query ? `?${search(query as Params)}` : ''}`);
    return media ? this.sign(routed(`${this.address}${media}`)) : super.url(path, query);
  }

  // An Emby media path → its unsigned Subsonic path (wicaby-media://api signs it after resolveServerUrl). null: 404.
  mediaPath(relWithQuery: string): string | null {
    const [path, qs = ''] = relWithQuery.split('?', 2);
    const q = norm(Object.fromEntries(new URLSearchParams(qs)), undefined);
    const img = /^\/Items\/([^/]+)\/Images\/Primary(?:\/\d+)?$/i.exec(path);
    if (img) {
      // ImageTags.Primary is the coverArt id; without a tag, the item's own id (Navidrome takes ids of any kind).
      const id = q.Tag ?? decodeId(decodeURIComponent(img[1]))?.raw;
      const size = Math.max(Number(q.MaxWidth ?? q.Width ?? 0), Number(q.MaxHeight ?? q.Height ?? 0)) || 600;
      return id ? `/rest/getCoverArt?${search({ id, size })}` : null;
    }
    const media = /^\/(?:Audio|Items)\/([^/]+)\/(stream(?:\.\w+)?|universal|Download)$/i.exec(path);
    const track = media && decodeId(decodeURIComponent(media[1]));
    if (!media || track?.kind !== 'tr') return null;
    return media[2] === 'Download' ? `/rest/download?${search({ id: track.raw })}` : `/rest/stream?${search({ id: track.raw, format: 'raw' })}`;
  }

  override async request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    try {
      return (await this.answer(method.toUpperCase(), path, norm(query, body))) as T;
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 404 && err.message.startsWith('NAVIDROME-UNMAPPED')) log.warn(err.message);
        // Error 50 on a playlist edit: someone else's playlist (Navidrome lets only the owner change it).
        if (err instanceof SubsonicError && err.code === 50 && /Playlists/.test(path)) throw new ApiError(t('errors.navidrome.notOwner'), 403);
        throw err;
      }
      throw new ApiError(err instanceof Error ? err.message : String(err), 0);
    }
  }

  // ---- Subsonic ----

  // One API call: the subsonic-response body, or a SubsonicError. Never follows a redirect (the URL carries the token).
  async call(name: string, params: Params = {}, timeoutMs = 20_000): Promise<Rec> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await net.fetch(this.sign(routed(`${this.address}/rest/${name}?${search(params)}`)), { headers: { Accept: 'application/json' }, signal: controller.signal, redirect: redirectPolicy(this.token) });
      if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
      const body = ((await res.json()) as { 'subsonic-response'?: Rec })['subsonic-response'];
      if (!body) throw new ApiError('Not a Subsonic answer', 502);
      if (body.status !== 'ok') {
        const e = (body.error ?? {}) as { code?: number; message?: string };
        throw new SubsonicError(e.code ?? 0, e.message ?? 'Subsonic error');
      }
      return body;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (controller.signal.aborted) throw new ApiError('timeout', 0);
      throw new ApiError(err instanceof Error ? err.message : String(err), 0);
    } finally {
      clearTimeout(timer);
    }
  }

  private ext(): Promise<Set<string>> {
    this.extensions ??= this.call('getOpenSubsonicExtensions')
      .then((r) => new Set(list<Rec>(r.openSubsonicExtensions).map((e) => String(e.name))))
      .catch(() => new Set<string>());
    return this.extensions;
  }

  private artists(folder = ''): Promise<Rec[]> {
    const hit = this.artistsCache.get(folder);
    if (hit && Date.now() - hit.at < ARTISTS_TTL_MS) return hit.list;
    const l = this.call('getArtists', { musicFolderId: folder || undefined }).then((r) => list<Rec>((r.artists as Rec | undefined)?.index).flatMap((i) => list<Rec>(i.artist)));
    this.artistsCache.set(folder, { at: Date.now(), list: l });
    l.catch(() => this.artistsCache.delete(folder));
    return l;
  }

  private async album(raw: string): Promise<Rec> {
    return ((await this.call('getAlbum', { id: raw })).album ?? {}) as Rec;
  }

  private async playlist(raw: string): Promise<Rec> {
    return ((await this.call('getPlaylist', { id: raw })).playlist ?? {}) as Rec;
  }

  // Every page of a list call (getAlbumList2 and the like), up to `max` records.
  private async all(fetch: (size: number, offset: number) => Promise<Rec[]>, max = 5000): Promise<Rec[]> {
    const out: Rec[] = [];
    for (let offset = 0; offset < max; offset += ALL_PAGE) {
      const got = await fetch(ALL_PAGE, offset);
      out.push(...got);
      if (got.length < ALL_PAGE) break;
    }
    return out;
  }

  private albumList = (args: Record<string, string>, folder?: string) => (size: number, offset: number) =>
    this.call('getAlbumList2', { ...args, size, offset, musicFolderId: folder }).then((r) => list<Rec>((r.albumList2 as Rec | undefined)?.album));

  // ---- The Emby routes ----

  private async answer(method: string, rawPath: string, q: Record<string, string>): Promise<unknown> {
    const path = rawPath
      .replace(/^\/Users\/[^/]+(?=\/(?:Views|Items|FavoriteItems|PlayedItems)(?:\/|$))/, '')
      .replace(/^\/UserViews$/, '/Views')
      .replace(/^\/User(Favorite|Played)Items\//, '/$1Items/')
      .replace(/^\/UserItems\/Resume$/, '/Items/Resume');
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    // The route's shape: the segment after Items, Playlists… (or Move) is an id, unless a literal route name.
    const key = `${method} /${parts.map((p, i) => (i > 0 && /^(Items|Playlists|FavoriteItems|PlayedItems|Audio|Move)$/.test(parts[i - 1]) && !/^(Resume|Latest)$/.test(p) ? '{id}' : p)).join('/')}`;
    const id = parts[1];
    // The stored sign-in's check (connection-manager resume): the password still works.
    if (method === 'GET' && parts.length === 2 && parts[0] === 'Users') {
      await this.call('ping');
      return { Id: this.userId, Name: this.userId };
    }

    switch (key) {
      case 'GET /Views':
        return result(list<Rec>(((await this.call('getMusicFolders')).musicFolders as Rec | undefined)?.musicFolder).map(folderView));
      case 'GET /Items/Resume':
      case 'GET /Shows/NextUp':
      case 'GET /Shows/Upcoming':
      case 'GET /Items/{id}/Similar':
      case 'GET /Years':
        // shortcut: no year list (the decade filter still works by range); derive it from getAlbumList2 byYear if asked.
        return result([]);
      case 'GET /Items/{id}/SpecialFeatures':
      case 'GET /Items/{id}/LocalTrailers':
        return [];
      case 'GET /Items/Latest': {
        const folder = decodeId(q.ParentId ?? '');
        return list<Rec>(((await this.call('getAlbumList2', { type: 'newest', size: Number(q.Limit) || 24, musicFolderId: folder?.kind === 'mf' ? folder.raw : undefined })).albumList2 as Rec | undefined)?.album).map(albumItem);
      }
      case 'GET /Items':
        return this.items(q);
      case 'GET /Items/{id}':
        return this.item(id);
      case 'GET /Items/{id}/InstantMix':
        return result(await this.instantMix(id, Number(q.Limit) || 100));
      case 'GET /Artists':
      case 'GET /Artists/AlbumArtists': {
        const folder = decodeId(q.ParentId ?? '');
        return page(this.nameFiltered((await this.artists(folder?.kind === 'mf' ? folder.raw : '')).map(artistItem), q), q);
      }
      case 'GET /Genres':
      case 'GET /MusicGenres':
        return result(list<Rec>(((await this.call('getGenres')).genres as Rec | undefined)?.genre).map(genreItem).sort((a, b) => a.Name.localeCompare(b.Name)));
      case 'GET /Audio/{id}/Lyrics': // the adapter answers it, never isEmby
        return this.lyrics(id);
      case 'GET /Playlists/{id}/Items':
        return this.entries(id);
      case 'POST /Playlists':
        return this.createPlaylist(q);
      case 'POST /Playlists/{id}/Items':
        return this.addToPlaylist(id, q.Ids ?? '');
      case 'DELETE /Playlists/{id}/Items':
        return this.removeFromPlaylist(id, q.EntryIds ?? '');
      case 'POST /Playlists/{id}/Items/{id}/Move/{id}':
        return this.moveInPlaylist(id, parts[3], Number(parts[5]));
      case 'POST /FavoriteItems/{id}':
      case 'DELETE /FavoriteItems/{id}':
        return this.setStar(id, method === 'POST');
      case 'POST /PlayedItems/{id}':
        return this.scrobble(id, true).then(() => ({ Played: true }));
      case 'DELETE /PlayedItems/{id}':
        // Subsonic cannot unplay: the play count stays.
        return { Played: false };
      case 'GET /Items/{id}/PlaybackInfo':
      case 'POST /Items/{id}/PlaybackInfo': {
        const item = await this.item(id);
        return { MediaSources: item.MediaSources ?? [], PlaySessionId: randomBytes(16).toString('hex') };
      }
      case 'POST /Sessions/Playing':
        return this.scrobble(q.ItemId ?? '', false).then(() => undefined);
      case 'POST /Sessions/Playing/Stopped':
        return this.stopped(q);
      case 'POST /Sessions/Playing/Progress':
      case 'POST /Sessions/Playing/Ping':
      case 'POST /Sessions/Capabilities/Full':
      case 'POST /Sessions/Capabilities':
        return undefined;
    }
    throw new ApiError(`NAVIDROME-UNMAPPED ${method} ${rawPath}`, 404);
  }

  // NameStartsWith / NameLessThan / NameStartsWithOrGreater (the Android TV A-Z rail), on the name, case-insensitive.
  private nameFiltered(items: BaseItem[], q: Record<string, string>): BaseItem[] {
    const low = (s?: string) => (s ?? '').toLowerCase();
    return items.filter((x) => {
      const n = low(x.Name);
      return (!q.NameStartsWith || n.startsWith(low(q.NameStartsWith))) && (!q.NameLessThan || n < low(q.NameLessThan)) && (!q.NameStartsWithOrGreater || n >= low(q.NameStartsWithOrGreater));
    });
  }

  async item(id: string): Promise<BaseItem> {
    const d = decodeId(id);
    switch (d?.kind) {
      case 'tr':
        return songItem(((await this.call('getSong', { id: d.raw })).song ?? {}) as Rec);
      case 'al':
        return albumItem(await this.album(d.raw));
      case 'ar': {
        const [a, info] = await Promise.all([this.call('getArtist', { id: d.raw }), this.call('getArtistInfo2', { id: d.raw }).catch(() => ({}) as Rec)]);
        const bio = plainText((info.artistInfo2 as Rec | undefined)?.biography as string | undefined);
        return { ...artistItem((a.artist ?? {}) as Rec), ...(bio ? { Overview: bio } : {}) };
      }
      case 'pl':
        return playlistItem(await this.playlist(d.raw));
      case 'mf': {
        const f = list<Rec>(((await this.call('getMusicFolders')).musicFolders as Rec | undefined)?.musicFolder).find((x) => String(x.id) === d.raw);
        if (f) return folderView(f);
        break;
      }
      case 'ge':
        return genreItem({ value: d.raw });
    }
    throw new ApiError('Not found', 404);
  }

  private async items(q: Record<string, string>): Promise<ItemsResult> {
    const types = (q.IncludeItemTypes ?? '').split(',').filter(Boolean);
    const wants = (t: string) => !types.length || types.includes(t);
    const parent = decodeId(q.ParentId ?? '');
    const folder = parent?.kind === 'mf' ? parent.raw : undefined;
    const limit = Number(q.Limit) || 100;
    const start = Number(q.StartIndex) || 0;

    if (q.Ids) {
      const got = await Promise.all(q.Ids.split(',').map((x) => this.item(x).catch(() => null)));
      return result(got.filter((x): x is BaseItem => x !== null));
    }
    if (q.SearchTerm) {
      const r = ((await this.call('search3', { query: q.SearchTerm, artistCount: wants('MusicArtist') ? limit : 0, albumCount: wants('MusicAlbum') ? limit : 0, songCount: wants('Audio') ? limit : 0, musicFolderId: folder })).searchResult3 ?? {}) as Rec;
      return result([...list<Rec>(r.artist).map(artistItem), ...list<Rec>(r.album).map(albumItem), ...list<Rec>(r.song).map((s) => songItem(s))].slice(0, limit));
    }
    if (parent?.kind === 'pl') return this.entries(q.ParentId!);
    if (types.length === 1 && types[0] === 'Playlist') return page(list<Rec>(((await this.call('getPlaylists')).playlists as Rec | undefined)?.playlist).map(playlistItem), q);
    if (types.length && !types.some((t) => ['MusicAlbum', 'Audio', 'MusicArtist'].includes(t))) return result([]);

    const albumIds = parent?.kind === 'al' ? [parent.raw] : (q.AlbumIds?.split(',').map((x) => decodeId(x)?.raw).filter((x): x is string => Boolean(x)) ?? []);
    if (albumIds.length) {
      const albums = await Promise.all(albumIds.map((a) => this.album(a)));
      return page(albums.flatMap((a) => list<Rec>(a.song).map((s) => songItem(s))), q);
    }
    const artistRef = parent?.kind === 'ar' ? parent.raw : decodeId((q.AlbumArtistIds ?? q.ArtistIds ?? '').split(',')[0])?.raw;
    if (artistRef || q.ContributingArtistIds) {
      // shortcut: Subsonic lists an artist's own albums only; "appears on" (ContributingArtistIds) answers none.
      if (!artistRef) return result([]);
      const albums = list<Rec>(((await this.call('getArtist', { id: artistRef })).artist as Rec | undefined)?.album);
      if (wants('MusicAlbum') && !types.includes('Audio')) return page(albums.map(albumItem), q);
      const full = await Promise.all(albums.map((a) => this.album(String(a.id))));
      return page(full.flatMap((a) => list<Rec>(a.song).map((s) => songItem(s))), q);
    }
    const favorites = /IsFavorite/.test(q.Filters ?? '') || q.IsFavorite === 'true';
    if (favorites) {
      const r = ((await this.call('getStarred2', { musicFolderId: folder })).starred2 ?? {}) as Rec;
      const out = types.includes('Audio') ? list<Rec>(r.song).map((s) => songItem(s)) : types.includes('MusicArtist') ? list<Rec>(r.artist).map(artistItem) : types.includes('MusicAlbum') ? list<Rec>(r.album).map(albumItem) : [...list<Rec>(r.artist).map(artistItem), ...list<Rec>(r.album).map(albumItem), ...list<Rec>(r.song).map((s) => songItem(s))];
      return page(out, q);
    }
    if (types[0] === 'MusicArtist') return page((await this.artists(folder)).map(artistItem), q);
    if (types.includes('Audio')) {
      const genre = q.Genres?.split('|')[0] ?? (parent?.kind === 'ge' ? parent.raw : decodeId((q.GenreIds ?? '').split(',')[0])?.raw);
      const songs = genre
        ? list<Rec>(((await this.call('getSongsByGenre', { genre, count: limit, offset: start, musicFolderId: folder })).songsByGenre as Rec | undefined)?.song)
        : list<Rec>((((await this.call('search3', { query: '', artistCount: 0, albumCount: 0, songCount: limit, songOffset: start, musicFolderId: folder })).searchResult3 ?? {}) as Rec).song);
      // shortcut: Subsonic gives no song total; one more page is promised while pages come back full (the list grows as it scrolls).
      return result(songs.map((s) => songItem(s)), start + songs.length + (songs.length === limit ? limit : 0), start);
    }
    // Albums (also a folder's or a genre's).
    const args = albumListArgs(parent?.kind === 'ge' ? { ...q, Genres: parent.raw } : q);
    if (args.type === 'alphabeticalByName' || args.type === 'alphabeticalByArtist' || args.type === 'newest' || args.type === 'random') {
      const albums = await this.albumList(args, folder)(limit, start);
      // The total: every album artist's album count (Navidrome's getArtists lists album artists).
      const total = (await this.artists(folder)).reduce((n, a) => n + (Number(a.albumCount) || 0), 0);
      return result(albums.map(albumItem), Math.max(total, start + albums.length), start);
    }
    // Filtered or by play counts: the whole list, paged here (exact totals).
    return page((await this.all(this.albumList(args, folder))).map(albumItem), q);
  }

  private async entries(playlistId: string): Promise<ItemsResult> {
    const d = decodeId(playlistId);
    if (d?.kind !== 'pl') throw new ApiError('Not found', 404);
    return result(list<Rec>((await this.playlist(d.raw)).entry).map((s, i) => songItem(s, i)));
  }

  // Album, artist and playlist ids stand for their tracks (Emby takes them in a playlist add).
  private async songIds(ids: string): Promise<string[]> {
    const out: string[] = [];
    for (const x of ids.split(',').filter(Boolean)) {
      const d = decodeId(x);
      if (d?.kind === 'tr') out.push(d.raw);
      else if (d?.kind === 'al') out.push(...list<Rec>((await this.album(d.raw)).song).map((s) => String(s.id)));
      else if (d?.kind === 'pl') out.push(...list<Rec>((await this.playlist(d.raw)).entry).map((s) => String(s.id)));
      else if (d?.kind === 'ar') {
        const albums = list<Rec>(((await this.call('getArtist', { id: d.raw })).artist as Rec | undefined)?.album);
        for (const a of albums) out.push(...list<Rec>((await this.album(String(a.id))).song).map((s) => String(s.id)));
      } else throw new ApiError(`Not a track: ${x}`, 400);
    }
    return out;
  }

  private async createPlaylist(q: Record<string, string>): Promise<{ Id?: string }> {
    const songId = await this.songIds(q.Ids ?? '');
    const r = await this.call('createPlaylist', { name: q.Name ?? '', songId });
    const id = (r.playlist as Rec | undefined)?.id;
    return { Id: id !== undefined ? playlistItem({ id }).Id : undefined };
  }

  private async addToPlaylist(playlistId: string, ids: string): Promise<void> {
    const d = decodeId(playlistId);
    if (d?.kind !== 'pl') throw new ApiError('Not found', 404);
    await this.call('updatePlaylist', { playlistId: d.raw, songIdToAdd: await this.songIds(ids) });
  }

  // Entry ids are pe_<index>; removed from the end first so the indexes stay valid whatever the server does.
  private async removeFromPlaylist(playlistId: string, entryIds: string): Promise<void> {
    const d = decodeId(playlistId);
    if (d?.kind !== 'pl') throw new ApiError('Not found', 404);
    const idx = entryIds.split(',').map((e) => decodeId(e)).filter((e) => e?.kind === 'pe').map((e) => Number(e!.raw)).filter(Number.isInteger).sort((a, b) => b - a);
    if (idx.length) await this.call('updatePlaylist', { playlistId: d.raw, songIndexToRemove: idx });
  }

  // Subsonic has no move: the playlist is rewritten in the new order (createPlaylist with playlistId).
  private async moveInPlaylist(playlistId: string, entryId: string, newIndex: number): Promise<void> {
    const d = decodeId(playlistId);
    const from = Number(decodeId(entryId)?.raw);
    if (d?.kind !== 'pl' || !Number.isInteger(from)) throw new ApiError('Not found', 404);
    const songs = list<Rec>((await this.playlist(d.raw)).entry).map((s) => String(s.id));
    if (from < 0 || from >= songs.length) throw new ApiError('Not found', 404);
    const [moved] = songs.splice(from, 1);
    songs.splice(Math.max(0, Math.min(newIndex, songs.length)), 0, moved);
    await this.call('createPlaylist', { playlistId: d.raw, songId: songs });
  }

  private async setStar(id: string, on: boolean): Promise<{ IsFavorite: boolean }> {
    const d = decodeId(id);
    const param = d?.kind === 'tr' ? 'id' : d?.kind === 'al' ? 'albumId' : d?.kind === 'ar' ? 'artistId' : null;
    if (!d || !param) throw new ApiError('Not found', 404);
    await this.call(on ? 'star' : 'unstar', { [param]: d.raw });
    return { IsFavorite: on };
  }

  private async scrobble(itemId: string, submission: boolean): Promise<void> {
    const d = decodeId(itemId);
    if (d?.kind !== 'tr') return;
    await this.call('scrobble', { id: d.raw, submission, ...(submission ? { time: Date.now() } : {}) });
  }

  // A play ended: it counts once it reached half the track or 4 minutes, once per PlaySessionId.
  private async stopped(q: Record<string, string>): Promise<undefined> {
    const d = decodeId(q.ItemId ?? '');
    if (d?.kind !== 'tr') return undefined;
    const play = q.PlaySessionId || `${q.ItemId}:${Date.now()}`;
    if (this.counted.has(play)) return undefined;
    let runTime = Number(q.RunTimeTicks) || undefined;
    if (!runTime) runTime = (await this.item(q.ItemId!).catch(() => null))?.RunTimeTicks;
    if (!scrobbleDue(Number(q.PositionTicks) || 0, runTime)) return undefined;
    this.counted.add(play);
    if (this.counted.size > 500) this.counted.delete(this.counted.values().next().value!);
    await this.scrobble(q.ItemId!, true);
    return undefined;
  }

  private async instantMix(id: string, limit: number): Promise<BaseItem[]> {
    const d = decodeId(id);
    const songs = (r: Rec, key: string) => list<Rec>((r[key] as Rec | undefined)?.song);
    let out: Rec[] = [];
    if (d?.kind === 'tr' || d?.kind === 'al') out = songs(await this.call('getSimilarSongs', { id: d.raw, count: limit }).catch(() => ({})), 'similarSongs');
    else if (d?.kind === 'ar') {
      out = songs(await this.call('getSimilarSongs2', { id: d.raw, count: limit }).catch(() => ({})), 'similarSongs2');
      if (!out.length) {
        const name = String(((await this.call('getArtist', { id: d.raw })).artist as Rec | undefined)?.name ?? '');
        out = songs(await this.call('getTopSongs', { artist: name, count: limit }), 'topSongs');
      }
    } else if (d?.kind === 'pl') out = list<Rec>((await this.playlist(d.raw)).entry);
    // No similar songs (no Last.fm agent on the server): random songs of the seed's genre, its own tracks first.
    if (!out.length) {
      const seed = d?.kind === 'ge' ? null : await this.item(id).catch(() => null);
      const genre = d?.kind === 'ge' ? d.raw : seed?.Genres?.[0];
      const own = d?.kind === 'al' ? list<Rec>((await this.album(d.raw)).song) : d?.kind === 'tr' ? [((await this.call('getSong', { id: d.raw })).song ?? {}) as Rec] : [];
      const random = songs(await this.call('getRandomSongs', { size: limit, genre }), 'randomSongs');
      out = [...own, ...random.filter((s) => !own.some((o) => o.id === s.id))];
    }
    return out.slice(0, limit).map((s) => songItem(s));
  }

  private async lyrics(id: string): Promise<unknown> {
    const d = decodeId(id);
    if (d?.kind !== 'tr') throw new ApiError('Not found', 404);
    let mapped: ReturnType<typeof lyricsToJellyfin> = null;
    const extension = 'songLyrics'; // a variable: i18n-check reads has('…') as a catalogue key
    if ((await this.ext()).has(extension)) mapped = lyricsToJellyfin(list<Rec>(((await this.call('getLyricsBySongId', { id: d.raw })).lyricsList as Rec | undefined)?.structuredLyrics));
    else {
      const song = ((await this.call('getSong', { id: d.raw })).song ?? {}) as Rec;
      const r = await this.call('getLyrics', { artist: String(song.artist ?? ''), title: String(song.title ?? '') });
      mapped = lyricsToJellyfin(undefined, (r.lyrics as Rec | undefined)?.value as string | undefined);
    }
    if (!mapped) throw new ApiError('Not found', 404);
    return mapped;
  }
}
