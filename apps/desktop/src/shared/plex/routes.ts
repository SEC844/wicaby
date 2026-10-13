// The Plex route table (plex-spec §3.2 guard 1): every Emby route the renderer and main send to a plex server,
// with the PMS request it becomes. `build` is the pure translation (query.ts); an entry without one is answered
// by the adapter from state it holds (an item it fetched first, the image path cache, the decision; PX-06 to
// PX-09). Anything else is PLEX_UNSUPPORTED (with the UI fallback that hides it) or, at run time, a 404
// 'PLEX-UNMAPPED <method> <path>', never a wrong answer. tools/checks/plex-routes-check.mjs fails on an Emby
// path in the source that is in neither list. Pure.
import { deleteRequest, parseLiveId } from './livetv-map';
import { parseId } from './map';
import { itemKey, itemsRequest, latestRequest, metadataRequest, nextUpRequest, playedRequest, resumeRequest, PlexUnmapped, timelineRequest, transcodeRequest, userDataRequest, itemsUri, LIBRARY_ID, type PmsReq, type Query } from './query';

export interface Ctx {
  machineId: string;
}

type Params = Record<string, string>;
// null: the request is valid but the adapter answers it itself (a section's or a person's own item).
type Build = (p: Params, q: Query, body: Record<string, unknown> | undefined, ctx: Ctx) => PmsReq | null;

export interface Route {
  method: 'GET' | 'POST' | 'DELETE';
  // Emby path pattern; '{name}' matches one segment.
  path: string;
  op: string;
  // Served through wicaby-media (PlexClient.url), not api:request.
  media?: boolean;
  build?: Build;
}

const get = (path: string, query: Record<string, string> = {}, extra: Partial<PmsReq> = {}): PmsReq => ({ method: 'GET', path, query, ...extra });
const ids = (q: Query, key = 'Ids'): string[] => String(q[key] ?? '').split(',').filter(Boolean);

export const ROUTES: readonly Route[] = [
  // Browse (PX-06).
  { method: 'GET', path: '/Users/{user}/Views', op: 'views', build: () => get('/library/sections') },
  // The global search's Live TV half (channels and programmes) is the adapter's (PlexLiveTv.search).
  { method: 'GET', path: '/Users/{user}/Items', op: 'items', build: (_p, q) => (q.IncludeItemTypes === 'TvChannel,LiveTvProgram' ? null : itemsRequest(q)) },
  { method: 'GET', path: '/Users/{user}/Items/Resume', op: 'resume', build: (_p, q) => resumeRequest(q) },
  { method: 'GET', path: '/Users/{user}/Items/Latest', op: 'latest', build: (_p, q) => latestRequest(q) },
  // An id may be a section ('section-1': its view) or a person ('person-7': their page); the adapter answers those.
  { method: 'GET', path: '/Users/{user}/Items/{id}', op: 'item', build: (p) => (parseId(p.id)?.kind === 'item' ? metadataRequest(p.id) : null) },
  { method: 'GET', path: '/Users/{user}/Items/{id}/LocalTrailers', op: 'trailers', build: (p) => metadataRequest(p.id) },
  { method: 'GET', path: '/Users/{user}/Items/{id}/SpecialFeatures', op: 'extras', build: (p) => metadataRequest(p.id) },
  { method: 'GET', path: '/Items/{id}/Ancestors', op: 'ancestors', build: (p) => metadataRequest(p.id) },
  { method: 'GET', path: '/Items/{id}/Similar', op: 'similar', build: (p) => get(`/library/metadata/${itemKey(p.id)}/similar`) },
  { method: 'GET', path: '/Shows/NextUp', op: 'nextUp', build: (_p, q) => nextUpRequest(q) },
  // Plex has no "upcoming episodes": the row is empty, so it is hidden (plex-spec §8).
  { method: 'GET', path: '/Shows/Upcoming', op: 'empty' },
  { method: 'GET', path: '/Shows/{id}/Seasons', op: 'seasons', build: (p) => get(`/library/metadata/${itemKey(p.id)}/children`, { excludeAllLeaves: '1' }) },
  {
    method: 'GET',
    path: '/Shows/{id}/Episodes',
    op: 'episodes',
    build: (p, q) => (q.SeasonId ? get(`/library/metadata/${itemKey(String(q.SeasonId))}/children`) : get(`/library/metadata/${itemKey(p.id)}/allLeaves`)),
  },
  // Server-defined Home rows (caps.serverHubs, plex-spec §8): not an Emby route; renderer/lib/api.ts hubs() sends
  // it to plex servers only. ParentId = a section: that library's hubs.
  {
    method: 'GET',
    path: '/Hubs',
    op: 'hubs',
    build: (_p, q) => {
      const parent = String(q.ParentId ?? '');
      if (!parent) return get('/hubs/promoted');
      if (parseId(parent)?.kind !== 'section') throw new PlexUnmapped(`Hubs ParentId=${parent}`);
      return get(`/hubs/sections/${parseId(parent)!.key}`);
    },
  },
  { method: 'GET', path: '/Users/{user}', op: 'me' },
  { method: 'GET', path: '/System/Info/Public', op: 'identity', build: () => get('/identity') },
  // Music (music-spec): a music section's artists, genres and years.
  { method: 'GET', path: '/Artists', op: 'artists', build: (_p, q) => sectionDirectory(q, 'all', { type: '8' }) },
  { method: 'GET', path: '/Artists/AlbumArtists', op: 'artists', build: (_p, q) => sectionDirectory(q, 'all', { type: '8' }) },
  { method: 'GET', path: '/Genres', op: 'genres', build: (_p, q) => sectionDirectory(q, 'genre') },
  { method: 'GET', path: '/MusicGenres', op: 'genres', build: (_p, q) => sectionDirectory(q, 'genre') },
  { method: 'GET', path: '/Years', op: 'years', build: (_p, q) => sectionDirectory(q, 'year') },

  // User data writes. Favorites are the plex.tv watchlist (D-6): the adapter needs the item's plex:// guid.
  { method: 'POST', path: '/Users/{user}/FavoriteItems/{id}', op: 'favorite' },
  { method: 'DELETE', path: '/Users/{user}/FavoriteItems/{id}', op: 'unfavorite' },
  { method: 'POST', path: '/Users/{user}/PlayedItems/{id}', op: 'played', build: (p) => playedRequest(p.id, true) },
  { method: 'DELETE', path: '/Users/{user}/PlayedItems/{id}', op: 'unplayed', build: (p) => playedRequest(p.id, false) },
  { method: 'POST', path: '/Users/{user}/Items/{id}/UserData', op: 'userData', build: (p, _q, b) => userDataRequest(p.id, b) },
  {
    method: 'POST',
    path: '/Users/{user}/Items/{id}/HideFromResume',
    op: 'hideFromResume',
    build: (p, q) => {
      // Plex can hide, not unhide.
      if (q.Hide === false || q.Hide === 'false') throw new PlexUnmapped('HideFromResume Hide=false');
      return { method: 'PUT', path: '/actions/removeFromContinueWatching', query: { ratingKey: itemKey(p.id) } };
    },
  },
  // D-2: the one admin action, "Refresh metadata", for the server owner.
  // A section id (torrent-service refreshes the library a download landed in) refreshes that section.
  {
    method: 'POST',
    path: '/Items/{id}/Refresh',
    op: 'refreshItem',
    build: (p) => (parseId(p.id)?.kind === 'section' ? get(`/library/sections/${parseId(p.id)!.key}/refresh`) : { method: 'PUT', path: `/library/metadata/${itemKey(p.id)}/refresh`, query: {} }),
  },
  { method: 'POST', path: '/Library/Refresh', op: 'refreshLibrary', build: () => get('/library/sections/all/refresh') },

  // Playlists and collections (renderer/lib/playlists.ts).
  { method: 'GET', path: '/Playlists/{id}/Items', op: 'playlistItems', build: (p) => get(`/playlists/${itemKey(p.id)}/items`) },
  {
    method: 'POST',
    path: '/Playlists',
    op: 'createPlaylist',
    build: (_p, q, b, ctx) => {
      const name = String(q.Name ?? b?.Name ?? '');
      const list = ids(q).length ? ids(q) : ((b?.Ids as string[] | undefined) ?? []);
      const type = String(q.MediaType ?? b?.MediaType ?? 'Video') === 'Audio' ? 'audio' : 'video';
      if (!name || !list.length) throw new PlexUnmapped('POST /Playlists without Name or Ids');
      return { method: 'POST', path: '/playlists', query: { type, title: name, smart: '0', uri: itemsUri(ctx.machineId, list) } };
    },
  },
  { method: 'POST', path: '/Playlists/{id}/Items', op: 'playlistAdd', build: (p, q, _b, ctx) => ({ method: 'PUT', path: `/playlists/${itemKey(p.id)}/items`, query: { uri: itemsUri(ctx.machineId, ids(q)) } }) },
  {
    method: 'DELETE',
    path: '/Playlists/{id}/Items',
    op: 'playlistRemove',
    build: (p, q) => {
      const entries = ids(q, 'EntryIds');
      if (entries.length !== 1) throw new PlexUnmapped(`DELETE /Playlists/{id}/Items with ${entries.length} entries`);
      return { method: 'DELETE', path: `/playlists/${itemKey(p.id)}/items/${itemKey(entries[0])}`, query: {} };
    },
  },
  // Plex moves "after an entry": the adapter reads the list to find which one (PX-06).
  { method: 'POST', path: '/Playlists/{id}/Items/{entry}/Move/{index}', op: 'playlistMove' },
  // A collection needs its section and type: the adapter reads the first item (PX-06).
  { method: 'POST', path: '/Collections', op: 'createCollection' },
  { method: 'POST', path: '/Collections/{id}/Items', op: 'collectionAdd', build: (p, q, _b, ctx) => ({ method: 'PUT', path: `/library/collections/${itemKey(p.id)}/items`, query: { uri: itemsUri(ctx.machineId, ids(q)) } }) },
  {
    method: 'DELETE',
    path: '/Collections/{id}/Items',
    op: 'collectionRemove',
    build: (p, q) => {
      const list = ids(q);
      if (list.length !== 1) throw new PlexUnmapped(`DELETE /Collections/{id}/Items with ${list.length} items`);
      return { method: 'DELETE', path: `/library/collections/${itemKey(p.id)}/items/${itemKey(list[0])}`, query: {} };
    },
  },

  // Playback (PX-08, PX-09): the decision, markers and reports.
  { method: 'POST', path: '/Items/{id}/PlaybackInfo', op: 'playbackInfo' },
  { method: 'GET', path: '/MediaSegments/{id}', op: 'segments', build: (p) => metadataRequest(p.id) },
  { method: 'POST', path: '/Sessions/Playing', op: 'timeline', build: (_p, _q, b) => (liveItem(b) ? null : timelineRequest('', b)) },
  { method: 'POST', path: '/Sessions/Playing/Progress', op: 'timeline', build: (_p, _q, b) => (liveItem(b) ? null : timelineRequest('Progress', b)) },
  { method: 'POST', path: '/Sessions/Playing/Stopped', op: 'timeline', build: (_p, _q, b) => (liveItem(b) ? null : timelineRequest('Stopped', b)) },
  { method: 'POST', path: '/Sessions/Playing/Ping', op: 'ping', build: (_p, q) => transcodeRequest('ping', String(q.PlaySessionId ?? '')) },
  { method: 'DELETE', path: '/Videos/ActiveEncodings', op: 'stopTranscode', build: (_p, q) => transcodeRequest('stop', String(q.PlaySessionId ?? '')) },
  // Wicaby is not a controllable Plex player (caps.castReceiver false): nothing to register, and nothing is wrong.
  { method: 'POST', path: '/Sessions/Capabilities/Full', op: 'noop' },

  // Live TV and DVR (PX-11, livetv-map.ts; PlexLiveTv answers the 'live*' ops). Channels, programmes, timers and rules
  // come from the DVR, its EPG grid and the subscriptions; a channel's PlaybackInfo above tunes it.
  { method: 'GET', path: '/LiveTv/Info', op: 'liveInfo' },
  { method: 'GET', path: '/LiveTv/GuideInfo', op: 'liveGuideInfo' },
  { method: 'GET', path: '/LiveTv/Channels', op: 'liveChannels' },
  { method: 'GET', path: '/LiveTv/Programs', op: 'livePrograms' },
  { method: 'GET', path: '/LiveTv/Programs/Recommended', op: 'livePrograms' },
  { method: 'GET', path: '/LiveTv/Programs/{id}', op: 'liveProgram' },
  { method: 'GET', path: '/LiveTv/Timers', op: 'liveTimers' },
  { method: 'GET', path: '/LiveTv/Timers/Defaults', op: 'liveTimerDefaults' },
  { method: 'GET', path: '/LiveTv/Timers/{id}', op: 'liveTimer' },
  { method: 'POST', path: '/LiveTv/Timers', op: 'liveCreateTimer' },
  { method: 'POST', path: '/LiveTv/Timers/{id}', op: 'liveUpdateTimer' },
  { method: 'DELETE', path: '/LiveTv/Timers/{id}', op: 'liveCancelTimer' },
  { method: 'GET', path: '/LiveTv/SeriesTimers', op: 'liveSeriesTimers' },
  { method: 'GET', path: '/LiveTv/SeriesTimers/{id}', op: 'liveSeriesTimer' },
  { method: 'POST', path: '/LiveTv/SeriesTimers', op: 'liveCreateSeriesTimer' },
  { method: 'POST', path: '/LiveTv/SeriesTimers/{id}', op: 'liveUpdateSeriesTimer' },
  { method: 'DELETE', path: '/LiveTv/SeriesTimers/{id}', op: 'liveDeleteSeriesTimer', build: (p) => deleteRequest(subscriptionKey(p.id)) },
  { method: 'GET', path: '/LiveTv/Recordings', op: 'liveRecordings' },
  // Plex picks the recording folder itself: no folders to offer.
  { method: 'GET', path: '/LiveTv/Recordings/Folders', op: 'empty' },
  // Only the item's recorded versions, never the item (livetv-map.ts deleteRecordingRequests).
  { method: 'DELETE', path: '/LiveTv/Recordings/{id}', op: 'liveDeleteRecording' },
  // A tune's stream is a transcode session: closing it stops the transcode, which frees the tuner.
  { method: 'POST', path: '/LiveStreams/Close', op: 'liveClose', build: (_p, q) => transcodeRequest('stop', String(q.PlaySessionId ?? '')) },

  // Media through wicaby-media://api (PlexClient.url): paths resolved from the item the adapter has seen.
  { method: 'GET', path: '/Items/{id}/Images/{type}', op: 'image', media: true },
  { method: 'GET', path: '/Items/{id}/Images/{type}/{index}', op: 'image', media: true },
  { method: 'GET', path: '/Videos/{id}/stream', op: 'stream', media: true },
  { method: 'GET', path: '/Videos/{id}/stream.{ext}', op: 'stream', media: true },
  { method: 'GET', path: '/Audio/{id}/stream', op: 'stream', media: true },
  { method: 'GET', path: '/Videos/{id}/index.bif', op: 'bif', media: true },
  { method: 'GET', path: '/Videos/{id}/{source}/Subtitles/{index}/Stream', op: 'subtitle', media: true },
  { method: 'GET', path: '/Videos/{id}/{source}/Subtitles/{index}/Stream.{ext}', op: 'subtitle', media: true },
  // Downloads take the original part, only where the server allows it (allowSync, plex-spec §1.3).
  { method: 'GET', path: '/Items/{id}/Download', op: 'download', media: true },
];

// A live channel's reports: the adapter answers them (PlexLiveTv.report), no library timeline.
const liveItem = (b: Record<string, unknown> | undefined): boolean => parseLiveId(String(b?.ItemId ?? '')) !== null;

// A series rule's id is its subscription key (livetv-map.ts).
function subscriptionKey(id: string): string {
  if (!/^\d{1,12}$/.test(id)) throw new PlexUnmapped(`subscription ${id}`);
  return id;
}

// A music section's directory (/Artists?ParentId=section-3): Plex lists by section.
function sectionDirectory(q: Query, what: 'all' | 'genre' | 'year', extra: Record<string, string> = {}): PmsReq {
  const parent = String(q.ParentId ?? q.parentId ?? '');
  const m = /^section-(\d+)$/.exec(parent);
  if (!m) throw new PlexUnmapped(`${what} without a section ParentId`);
  return get(`/library/sections/${m[1]}/${what}`, extra);
}

// Emby routes a plex server does not answer, each with what the UI does instead. The run-time answer is the
// same 404 PLEX-UNMAPPED; this list is what makes the coverage check pass, so every entry needs its fallback.
export const PLEX_UNSUPPORTED: readonly { path: string; fallback: string }[] = [
  { path: '/Users/{user}/Items/{id}/Intros', fallback: 'no cinema intros (Plex prerolls are a server setting)' },
  { path: '/Items/{id}/InstantMix', fallback: 'the Instant mix action shows its error toast' },
  { path: '/Items/{id}/RemoteSearch/Subtitles/{lang}', fallback: 'subtitle search shows its error (PX-17)' },
  { path: '/Items/{id}/File', fallback: 'caps.comics is false: no comics on Plex' },
  { path: '/Videos/{id}/Trickplay/{width}/tiles.m3u8', fallback: 'Plex trickplay is BIF (/Videos/{id}/index.bif)' },
  { path: '/Videos/{id}/Trickplay/{width}/{n}.jpg', fallback: 'Plex trickplay is BIF (/Videos/{id}/index.bif)' },
  { path: '/LiveTv/*', fallback: 'Emby-only Live TV calls (channel tags, recording options) answer 404: their UI stays hidden' },
  { path: '/LiveStreams/Open', fallback: 'a Plex tune never asks for opening (RequiresOpening false)' },
  { path: '/DisplayPreferences/*', fallback: 'Live TV preferences have no Plex store: guide favourites and groups are not editable there (a toast says so)' },
  { path: '/UserFavoriteItems/{id}', fallback: 'Plex has no channel favourites (PX-11): the toggle reverts with its error toast' },
  { path: '/Sessions', fallback: 'caps.sessionsRemote is false: no Plex rows in the Cast picker' },
  { path: '/Sessions/{id}/*', fallback: 'caps.sessionsRemote is false: no remote control of Plex sessions' },
  { path: '/Sessions/Logout', fallback: 'cast ephemeral tokens are Emby/Jellyfin only; Plex casts through the relay' },
  { path: '/QuickConnect/*', fallback: 'cast ephemeral tokens are Emby/Jellyfin only; Plex casts through the relay' },
  { path: '/Users/AuthenticateWithQuickConnect', fallback: 'cast ephemeral tokens are Emby/Jellyfin only' },
  { path: '/Users/Public', fallback: 'Plex sign-in is the plex.tv PIN and Home users (PX-04)' },
  { path: '/Users/AuthenticateByName', fallback: 'Plex sign-in is the plex.tv PIN and Home users (PX-04)' },
  { path: '/Users/{user}/Images/Primary', fallback: 'the avatar is the Home user thumb from plex.tv (PX-04); else initials' },
  { path: '/System/WakeOnLanInfo', fallback: 'Wake stays hidden: Plex sends no MAC (plex-spec §8)' },
  { path: '/System/Info', fallback: 'admin alerts are off (caps.admin)' },
  { path: '/ScheduledTasks', fallback: 'admin alerts are off (caps.admin)' },
  { path: '/Plugins', fallback: 'no server plugins: the Trakt plugin hint is skipped' },
];

function compile(pattern: string): RegExp {
  const src = pattern
    .split(/(\{\w+\}|\*)/)
    .map((part) => (part === '*' ? '.+' : /^\{\w+\}$/.test(part) ? `(?<${part.slice(1, -1)}>[^/]+?)` : part.replace(/[.+?^$()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${src}$`);
}
const COMPILED = ROUTES.map((r) => ({ r, re: compile(r.path) }));
export const UNSUPPORTED_RE = PLEX_UNSUPPORTED.map((u) => ({ ...u, re: compile(u.path) }));

const holesOf = (pattern: string): number => (pattern.match(/\{|\*/g) ?? []).length;

// The route for a request, or null. The most literal pattern wins, unsupported ones included: '/Users/{user}/Items/Resume'
// over '/Users/{user}/Items/{id}', and the unsupported '/Users/Public' over '/Users/{user}' (null).
export function matchRoute(method: string, path: string): { route: Route; params: Params } | null {
  const clean = path.split('?')[0];
  let best: { route: Route; params: Params; holes: number } | null = null;
  for (const { r, re } of COMPILED) {
    if (r.method !== method.toUpperCase()) continue;
    const m = re.exec(clean);
    if (!m) continue;
    const holes = holesOf(r.path);
    if (!best || holes < best.holes) best = { route: r, params: { ...(m.groups ?? {}) }, holes };
  }
  if (best && UNSUPPORTED_RE.some((u) => u.re.test(clean) && holesOf(u.path) < best!.holes)) return null;
  return best && { route: best.route, params: best.params };
}

// The translated request, or a PlexUnmapped throw. `adapter: true` means the route exists and the adapter
// answers it itself (see Route.build).
export function translate(method: string, path: string, query: Query = {}, body?: Record<string, unknown>, ctx: Ctx = { machineId: '' }): { op: string; params: Params; req?: PmsReq; adapter?: true } {
  const hit = matchRoute(method, path);
  if (!hit || hit.route.media) throw new PlexUnmapped(`${method.toUpperCase()} ${path.split('?')[0]}`);
  const { route, params } = hit;
  const req = route.build?.(params, query, body, ctx);
  return req ? { op: route.op, params, req } : { op: route.op, params, adapter: true };
}

export { LIBRARY_ID, PlexUnmapped };
