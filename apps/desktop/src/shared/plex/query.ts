// Emby query → PMS request (plex-spec §4 "Query mapping", §6.5, §6.6). Each builder returns the request the
// adapter sends; the adapter executes it and maps the answer with map.ts. A query key the dialect does not
// know throws PlexUnmapped instead of being dropped: an ignored filter would be a wrong answer. Pure.
import { itemType, parseId, ticksToMs } from './map';
import type { PlexContainer, PlexMeta } from './types';

export interface PmsReq {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query: Record<string, string>;
  headers?: Record<string, string>;
  // 'sections': run once per library section (path has '{section}') and merge (Recursive with no ParentId).
  fanOut?: 'sections';
  // The answer is /hubs/search's Hub[]: flatten its Metadata.
  hubs?: boolean;
  // Genre names to turn into PMS genre ids (GET /library/sections/{id}/genre) before sending: withGenreIds().
  genres?: string[];
  // The answer is Metadata[0].OnDeck.Metadata (a show's next episode, includeOnDeck=1).
  onDeck?: true;
  // Favorites (D-6): only the items on the user's plex.tv watchlist; the adapter adds one guid= per entry.
  watchlist?: true;
  // Keep only the items of these Emby types: the PMS endpoint cannot filter by type. answerMeta() applies both.
  keep?: string[];
}

// Thrown for a route or query the dialect does not translate: the adapter answers 404 'PLEX-UNMAPPED …', which the
// UI already reads as "not supported here", and the log reads as a to-do list.
export class PlexUnmapped extends Error {
  status = 404;
  constructor(what: string) {
    super(`PLEX-UNMAPPED ${what}`);
    this.name = 'PlexUnmapped';
  }
}

export type Query = Record<string, string | number | boolean | undefined>;

export const LIBRARY_ID = 'com.plexapp.plugins.library';

// Emby item type → PMS numeric type.
export const PLEX_TYPE: Readonly<Record<string, number>> = { Movie: 1, Series: 2, Season: 3, Episode: 4, MusicArtist: 8, MusicAlbum: 9, Audio: 10, Photo: 13, PhotoAlbum: 14, BoxSet: 18 };

const SORT: Readonly<Record<string, string>> = {
  SortName: 'titleSort',
  Name: 'title',
  DateCreated: 'addedAt',
  DateLastContentAdded: 'addedAt',
  PremiereDate: 'originallyAvailableAt',
  ProductionYear: 'year',
  CommunityRating: 'audienceRating',
  CriticRating: 'rating',
  OfficialRating: 'contentRating',
  DatePlayed: 'lastViewedAt',
  Random: 'random',
  Runtime: 'duration',
  PlayCount: 'viewCount',
  IndexNumber: 'index',
  ParentIndexNumber: 'parentIndex',
  Album: 'album.titleSort',
  AlbumArtist: 'artist.titleSort',
};

// Keys that change nothing PMS needs to know: fields, image hints, user ids, Emby-only switches.
const IGNORED = new Set(
  [
    'Fields',
    'EnableImageTypes',
    'ImageTypeLimit',
    'EnableImages',
    'EnableUserData',
    'EnableTotalRecordCount',
    'UserId',
    'CollapseBoxSetItems',
    'GroupItemsIntoCollections',
    'IsFolder',
    'GroupItems',
    'ExcludeLocationTypes',
    'IsMissing',
    'IsVirtualUnaired',
    'HasQueryLimit',
    'EnableResumable',
    'EnableRewatching',
    'DisableFirstEpisode',
    'api_key',
  ].map((k) => k.toLowerCase()),
);

const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

// Query keys are case-insensitive on Emby: read them that way.
function reader(query: Query): { get: (k: string) => string; rest: (used: string[]) => string[] } {
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') lower.set(k.toLowerCase(), s(v));
  return {
    get: (k) => lower.get(k.toLowerCase()) ?? '',
    rest: (used) => [...lower.keys()].filter((k) => !IGNORED.has(k) && !used.some((u) => u.toLowerCase() === k)),
  };
}

const list = (v: string): string[] => v.split(/[,|]/).map((x) => x.trim()).filter(Boolean);
// The ratingKey (or person id) behind an Emby-side id; anything else is unmapped, never guessed.
function keyOf(id: string, what: string, kind: 'item' | 'person' = 'item'): string {
  const p = parseId(id);
  if (!p || p.kind !== kind) throw new PlexUnmapped(`${what}=${id}`);
  return p.key;
}
export const itemKey = (id: string): string => keyOf(id, 'Id');

function paging(get: (k: string) => string): Record<string, string> | undefined {
  const start = Math.max(0, Math.floor(Number(get('StartIndex')) || 0));
  const limit = Math.floor(Number(get('Limit')) || 0);
  if (!start && !limit) return undefined;
  const h: Record<string, string> = { 'X-Plex-Container-Start': String(start) };
  if (limit > 0) h['X-Plex-Container-Size'] = String(limit);
  return h;
}

function sortOf(sortBy: string, order: string): string | undefined {
  const desc = /^desc/i.test(list(order)[0] ?? '');
  const keys = list(sortBy).map((k) => SORT[k]).filter((k): k is string => !!k);
  if (!keys.length) return undefined;
  return keys.map((k) => (k === 'random' ? k : `${k}:${desc ? 'desc' : 'asc'}`)).join(',');
}

// Emby types no PMS library lists: asking for them alongside others changes no answer (a Plex 'clip' is an extra,
// never a library item).
const NONE_ON_PLEX = new Set(['Book', 'Video']);

function typesOf(v: string): number[] {
  const out: number[] = [];
  const asked = list(v).filter((t) => !NONE_ON_PLEX.has(t));
  if (!asked.length) throw new PlexUnmapped(`IncludeItemTypes=${v}`);
  for (const t of asked) {
    const n = PLEX_TYPE[t];
    if (n === undefined) throw new PlexUnmapped(`IncludeItemTypes=${t}`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

const req = (method: PmsReq['method'], path: string, query: Record<string, string> = {}, extra: Partial<PmsReq> = {}): PmsReq => ({ method, path, query, ...extra });

// The Emby type names asked for, in the form answerMeta() keeps (Book and the like dropped by typesOf).
const keepOf = (types: number[]): string[] => Object.keys(PLEX_TYPE).filter((t) => types.includes(PLEX_TYPE[t]));

// GET /Users/{u}/Items (and Jellyfin's /Items): the library browser, search, a person's films, a collection.
export function itemsRequest(query: Query): PmsReq {
  const { get, rest } = reader(query);
  const used = ['ParentId', 'IncludeItemTypes', 'SortBy', 'SortOrder', 'Filters', 'Genres', 'PersonIds', 'Ids', 'StartIndex', 'Limit', 'NameStartsWith', 'Recursive', 'SearchTerm', 'Years', 'ArtistIds', 'AlbumArtistIds', 'IsPlayed', 'IsFavorite'];
  const unknown = rest(used);
  if (unknown.length) throw new PlexUnmapped(`/Items ${unknown.join(',')}`);
  if (get('SearchTerm')) return searchRequest(get, rest);
  // The playlists row and picker: PMS keeps playlists outside the sections.
  if (get('IncludeItemTypes') === 'Playlist' && !get('ParentId') && !get('Ids')) {
    const headers = paging(get);
    return req('GET', '/playlists', {}, headers ? { headers } : {});
  }
  const favorites = list(get('Filters')).includes('IsFavorite') || get('IsFavorite') === 'true';
  const out = itemsBrowse(get);
  return favorites ? { ...out, watchlist: true } : out;
}

function itemsBrowse(get: (k: string) => string): PmsReq {
  const headers = paging(get);
  const types = get('IncludeItemTypes') ? typesOf(get('IncludeItemTypes')) : [];
  // Several types, or a path that ignores `type` (children, Ids): PMS cannot filter, the adapter does.
  const keep: Partial<PmsReq> = types.length ? { keep: keepOf(types) } : {};
  const ids = get('Ids');
  if (ids) return req('GET', `/library/metadata/${list(ids).map((i) => keyOf(i, 'Ids')).join(',')}`, {}, { ...(headers ? { headers } : {}), ...keep });
  const q: Record<string, string> = {};
  if (types.length === 1) q.type = String(types[0]);
  const sort = sortOf(get('SortBy'), get('SortOrder'));
  if (sort) q.sort = sort;
  for (const f of list(get('Filters'))) {
    if (f === 'IsUnplayed') q.unwatched = '1';
    else if (f === 'IsPlayed') q['viewCount>>'] = '0';
    else if (f === 'IsResumable') q.inProgress = '1';
    else if (f !== 'IsFolder' && f !== 'IsNotFolder' && f !== 'IsFavorite') throw new PlexUnmapped(`Filters=${f}`);
  }
  if (get('IsPlayed') === 'true') q['viewCount>>'] = '0';
  if (get('IsPlayed') === 'false') q.unwatched = '1';
  const people = list(get('PersonIds')).map((p) => keyOf(p, 'PersonIds', 'person'));
  if (people.length) q.actor = people.join(',');
  const years = list(get('Years'));
  if (years.length) q.year = years.join(',');
  const genres = list(get('Genres'));
  const extra: Partial<PmsReq> = { ...(headers ? { headers } : {}), ...keep };
  if (genres.length) extra.genres = genres;
  const parent = get('ParentId');
  const artist = get('ArtistIds') || get('AlbumArtistIds');
  if (artist) {
    // An artist's albums are its children, its tracks its leaves.
    const key = keyOf(list(artist)[0], 'ArtistIds');
    return req('GET', `/library/metadata/${key}/${types.includes(10) ? 'allLeaves' : 'children'}`, sortOnly(q), extra);
  }
  if (!parent) {
    if (get('Recursive') !== 'true') throw new PlexUnmapped('/Items without ParentId');
    return req('GET', '/library/sections/{section}/all', q, { ...extra, fanOut: 'sections' });
  }
  const p = parseId(parent);
  if (!p || p.kind === 'person') throw new PlexUnmapped(`ParentId=${parent}`);
  if (p.kind === 'section') {
    const first = get('NameStartsWith');
    if (first) return req('GET', `/library/sections/${p.key}/firstCharacter/${encodeURIComponent(first.charAt(0).toUpperCase())}`, q, extra);
    return req('GET', `/library/sections/${p.key}/all`, q, extra);
  }
  // A show, season, album or collection: its children (Recursive: its leaves, e.g. every episode of a show).
  return req('GET', `/library/metadata/${p.key}/${get('Recursive') === 'true' && types.some((t) => t === 4 || t === 10) ? 'allLeaves' : 'children'}`, sortOnly(q), extra);
}

// SearchTerm -> /hubs/search, which takes a term, a section and a per-hub limit, nothing else: any other filter is
// unmapped. Types are kept by the adapter (answerMeta).
function searchRequest(get: (k: string) => string, rest: (used: string[]) => string[]): PmsReq {
  const other = rest(['SearchTerm', 'IncludeItemTypes', 'Limit', 'Recursive', 'ParentId', 'StartIndex']);
  if (other.length) throw new PlexUnmapped(`/Items SearchTerm with ${other.join(',')}`);
  if (Number(get('StartIndex')) > 0) throw new PlexUnmapped('/Items SearchTerm with StartIndex');
  const q: Record<string, string> = { query: get('SearchTerm'), limit: String(Math.floor(Number(get('Limit')) || 20)) };
  const parent = get('ParentId');
  if (parent) {
    const p = parseId(parent);
    if (p?.kind !== 'section') throw new PlexUnmapped(`SearchTerm ParentId=${parent}`);
    q.sectionId = p.key;
  }
  const types = get('IncludeItemTypes') ? typesOf(get('IncludeItemTypes')) : [];
  return req('GET', '/hubs/search', q, types.length ? { hubs: true, keep: keepOf(types) } : { hubs: true });
}

// Children endpoints take only a sort (and the user filters): drop the type the path already implies.
function sortOnly(q: Record<string, string>): Record<string, string> {
  const { type: _type, ...rest } = q;
  return rest;
}

// Genre names → PMS ids, once the adapter has read the section's genre directory.
export function withGenreIds(r: PmsReq, directory: { key?: string | number; id?: string | number; title?: string }[]): PmsReq {
  if (!r.genres?.length) return r;
  const ids = r.genres.map((name) => {
    const hit = directory.find((d) => (d.title ?? '').toLowerCase() === name.toLowerCase());
    if (!hit) throw new PlexUnmapped(`Genres=${name}`);
    return String(hit.id ?? hit.key);
  });
  const { genres: _g, ...rest } = r;
  return { ...rest, query: { ...r.query, genre: ids.join(',') } };
}

// GET /Users/{u}/Items/Latest: per section when ParentId is one.
export function latestRequest(query: Query): PmsReq {
  const { get, rest } = reader(query);
  const unknown = rest(['ParentId', 'IncludeItemTypes', 'Limit']);
  if (unknown.length) throw new PlexUnmapped(`/Items/Latest ${unknown.join(',')}`);
  const parent = get('ParentId') ? parseId(get('ParentId')) : null;
  if (get('ParentId') && parent?.kind !== 'section') throw new PlexUnmapped(`Latest ParentId=${get('ParentId')}`);
  const q: Record<string, string> = {};
  const types = get('IncludeItemTypes') ? typesOf(get('IncludeItemTypes')) : [];
  if (types.length === 1) q.type = String(types[0]);
  const limit = Math.floor(Number(get('Limit')) || 16);
  const extra: Partial<PmsReq> = types.length > 1 ? { keep: keepOf(types) } : {};
  return req('GET', parent ? `/library/sections/${parent.key}/recentlyAdded` : '/library/recentlyAdded', q, { headers: { 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': String(limit) }, ...extra });
}

// Emby MediaTypes -> the Emby item types that carry it.
const MEDIA_TYPES: Readonly<Record<string, string[]>> = { Video: ['Movie', 'Episode', 'Video', 'Trailer'], Audio: ['Audio'], Photo: ['Photo'] };

// GET /Users/{u}/Items/Resume: Continue Watching for the whole server (no ParentId: PMS has no per-section form).
export function resumeRequest(query: Query): PmsReq {
  const { get, rest } = reader(query);
  const unknown = rest(['Limit', 'StartIndex', 'MediaTypes', 'IncludeItemTypes']);
  if (unknown.length) throw new PlexUnmapped(`/Items/Resume ${unknown.join(',')}`);
  const extra: Partial<PmsReq> = {};
  const headers = paging(get);
  if (headers) extra.headers = headers;
  const media = list(get('MediaTypes'));
  // shortcut: kept after PMS paged, so a page can come back short; page by type in PMS if a row looks thin.
  if (media.length)
    extra.keep = media.flatMap((m) => {
      if (!MEDIA_TYPES[m]) throw new PlexUnmapped(`MediaTypes=${m}`);
      return MEDIA_TYPES[m];
    });
  // Both given: Emby keeps the items that match both.
  if (get('IncludeItemTypes')) {
    const types = keepOf(typesOf(get('IncludeItemTypes')));
    extra.keep = extra.keep ? types.filter((t) => extra.keep!.includes(t)) : types;
  }
  return req('GET', '/hubs/continueWatching/items', {}, extra);
}

// GET /Shows/NextUp: one show's next episode (SeriesId: the show's OnDeck), else the server's On Deck, episodes only.
export function nextUpRequest(query: Query): PmsReq {
  const { get, rest } = reader(query);
  const unknown = rest(['SeriesId', 'Limit', 'StartIndex']);
  if (unknown.length) throw new PlexUnmapped(`/Shows/NextUp ${unknown.join(',')}`);
  const series = get('SeriesId');
  if (series) return req('GET', `/library/metadata/${keyOf(series, 'SeriesId')}`, { includeOnDeck: '1' }, { onDeck: true, keep: ['Episode'] });
  const headers = paging(get);
  // shortcut: movies are dropped after PMS paged, so a page can come back short; fine for a home row.
  return req('GET', '/library/onDeck', {}, { ...(headers ? { headers } : {}), keep: ['Episode'] });
}

// The PMS items that answer `r`: a show's OnDeck unwrapped, search hubs flattened, then only the types kept.
export function answerMeta(r: PmsReq, c: PlexContainer | undefined): PlexMeta[] {
  const all = r.onDeck ? (c?.Metadata?.[0]?.OnDeck?.Metadata ?? []) : r.hubs ? (c?.Hub ?? []).flatMap((h) => h.Metadata ?? []) : (c?.Metadata ?? []);
  return r.keep ? all.filter((m) => r.keep!.includes(itemType(m) ?? '')) : all;
}

// The metadata request every item page, PlaybackInfo, MediaSegments and BIF lookup starts from.
export function metadataRequest(id: string): PmsReq {
  const key = keyOf(id, 'Id');
  return req('GET', `/library/metadata/${key}`, { includeMarkers: '1', includeChapters: '1', includeExtras: '1', includeOnDeck: '1', checkFiles: '1' });
}

// Watched state (plex-spec §2): scrobble / unscrobble, offline progress (§6.6).
export function playedRequest(id: string, played: boolean): PmsReq {
  return req('GET', played ? '/:/scrobble' : '/:/unscrobble', { key: keyOf(id, 'Id'), identifier: LIBRARY_ID });
}

// POST /Users/{u}/Items/{id}/UserData {PlaybackPositionTicks, Played}: offline progress sync.
export function userDataRequest(id: string, body: { PlaybackPositionTicks?: number; Played?: boolean } | undefined): PmsReq {
  if (body?.Played) return playedRequest(id, true);
  if (body?.PlaybackPositionTicks === undefined) throw new PlexUnmapped('UserData without a position');
  return req('GET', '/:/progress', { key: keyOf(id, 'Id'), identifier: LIBRARY_ID, time: String(ticksToMs(body.PlaybackPositionTicks)), state: 'stopped' });
}

// Session reports → /:/timeline (§6.5). The play session id rides in X-Plex-Session-Identifier.
export function timelineRequest(event: '' | 'Progress' | 'Stopped', body: Record<string, unknown> | undefined): PmsReq {
  const b = body ?? {};
  const id = s(b.ItemId);
  const key = keyOf(id, 'ItemId');
  const state = event === 'Stopped' ? 'stopped' : b.IsPaused === true ? 'paused' : 'playing';
  const q: Record<string, string> = { ratingKey: key, key: `/library/metadata/${key}`, state, time: String(ticksToMs(b.PositionTicks as number)) };
  const duration = ticksToMs(b.RunTimeTicks as number);
  if (duration) q.duration = String(duration);
  const headers: Record<string, string> = {};
  if (b.PlaySessionId) headers['X-Plex-Session-Identifier'] = s(b.PlaySessionId);
  return req('GET', '/:/timeline', q, { headers });
}

// Keep-alive and stop of a transcode (§6.1.6).
export function transcodeRequest(what: 'ping' | 'stop', session: string): PmsReq {
  if (!session) throw new PlexUnmapped(`transcode ${what} without a session`);
  return req('GET', `/video/:/transcode/universal/${what}`, { session });
}

// 'server://{machine}/com.plexapp.plugins.library/library/metadata/{ids}': how PMS names items to add.
export function itemsUri(machineId: string, ids: string[]): string {
  return `server://${machineId}/${LIBRARY_ID}/library/metadata/${ids.map((i) => keyOf(i, 'Ids')).join(',')}`;
}
