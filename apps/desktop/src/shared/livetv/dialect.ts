// Live TV request builders per server (spec §5): one pure function per operation returns the
// method, path, query and body; the platform HTTP layer only executes it. An operation a server
// does not have returns null. No runtime import, so a check can import this file on its own.
// Pure and erasable TypeScript only; C/livetv/Dialect.kt mirrors it (vectors: dialect.json).
import type { Category, ServerKind } from './model';

export interface Req {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

const HOUR = 3_600_000;
const enc = encodeURIComponent;
export const iso = (t: number): string => new Date(t).toISOString();

function req(method: Req['method'], path: string, query: Record<string, string | number | boolean | undefined> = {}, body?: unknown): Req {
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined) q[k] = String(v);
  return body === undefined ? { method, path, query: q } : { method, path, query: q, body };
}

const CATEGORY_PARAM: Readonly<Record<Exclude<Category, 'new'>, string>> = { movies: 'IsMovie', sports: 'IsSports', news: 'IsNews', kids: 'IsKids', series: 'IsSeries' };

// The query flag for a category, or null ("Inédits" is Emby-only: IsNewOrPremiere).
function categoryFlag(kind: ServerKind, cat: Category | undefined): Record<string, string> | null {
  if (!cat) return {};
  if (cat === 'new') return kind === 'emby' ? { IsNewOrPremiere: 'true' } : null;
  return { [CATEGORY_PARAM[cat]]: 'true' };
}

// ---- Reads (§5.1) ----

export const info = (_kind: ServerKind): Req => req('GET', '/LiveTv/Info');
export const guideInfo = (_kind: ServerKind): Req => req('GET', '/LiveTv/GuideInfo');

export function channelsPage(kind: ServerKind, a: { userId: string; startIndex: number; limit: number }): Req {
  return req('GET', '/LiveTv/Channels', {
    UserId: a.userId,
    StartIndex: a.startIndex,
    Limit: a.limit,
    EnableTotalRecordCount: a.startIndex === 0,
    EnableImageTypes: 'Primary',
    ImageTypeLimit: 1,
    EnableUserData: true,
    AddCurrentProgram: false,
    Fields: kind === 'emby' ? 'Tags' : undefined,
  });
}

export function channelCategorySet(kind: ServerKind, a: { userId: string; category: Category }): Req | null {
  const flag = categoryFlag(kind, a.category);
  if (!flag) return null;
  return req('GET', '/LiveTv/Channels', { UserId: a.userId, ...flag, EnableImages: false, EnableUserData: false, Limit: 5000 });
}

export function channelTags(kind: ServerKind, a: { userId: string }): Req | null {
  return kind === 'emby' ? req('GET', '/LiveTv/ChannelTags', { UserId: a.userId }) : null;
}

// Never MinStartDate: it loses the programme airing at the slab start.
export function programsTile(_kind: ServerKind, a: { userId: string; channelIds: readonly string[]; from: number; to: number; genres?: boolean }): Req {
  return req('GET', '/LiveTv/Programs', {
    UserId: a.userId,
    ChannelIds: a.channelIds.join(','),
    MinEndDate: iso(a.from),
    MaxStartDate: iso(a.to),
    SortBy: 'StartDate',
    EnableImages: false,
    EnableUserData: false,
    EnableTotalRecordCount: false,
    Fields: a.genres ? 'Genres' : undefined,
  });
}

export function programNowNext(_kind: ServerKind, a: { userId: string; channelId: string; now: number }): Req {
  return req('GET', '/LiveTv/Programs', { UserId: a.userId, ChannelIds: a.channelId, MinEndDate: iso(a.now), MaxStartDate: iso(a.now + 8 * HOUR), SortBy: 'StartDate', Limit: 4, EnableImages: false });
}

export function programDetail(kind: ServerKind, a: { userId: string; id: string }): Req {
  return req('GET', `/LiveTv/Programs/${enc(a.id)}`, kind === 'emby' ? { UserId: a.userId } : { userId: a.userId });
}

// "En ce moment" rails. source 'window' is the V15 fallback when Emby ignores IsAiring.
export function onNow(kind: ServerKind, a: { userId: string; now: number; category?: Category; source?: 'recommended' | 'window' }): Req | null {
  const flag = categoryFlag(kind, a.category);
  if (!flag) return null;
  const images = { EnableImageTypes: 'Primary,Thumb', ImageTypeLimit: 1, Fields: 'Genres' };
  if (a.source === 'window') return req('GET', '/LiveTv/Programs', { UserId: a.userId, MinEndDate: iso(a.now), MaxStartDate: iso(a.now), SortBy: 'StartDate', Limit: 24, ...images, ...flag });
  return req('GET', '/LiveTv/Programs/Recommended', { UserId: a.userId, IsAiring: true, Limit: 24, ...images, ...flag });
}

export function onLater(kind: ServerKind, a: { userId: string; now: number; category: Category }): Req | null {
  const flag = categoryFlag(kind, a.category);
  if (!flag) return null;
  return req('GET', '/LiveTv/Programs', { UserId: a.userId, ...flag, MinStartDate: iso(a.now), MaxStartDate: iso(a.now + 48 * HOUR), SortBy: 'StartDate', Limit: 24 });
}

export function searchPrograms(kind: ServerKind, a: { userId: string; query: string; now: number; guideEnd: number }): Req {
  if (kind === 'jellyfin') return req('GET', '/Items', { UserId: a.userId, IncludeItemTypes: 'LiveTvProgram', Recursive: true, SearchTerm: a.query, Limit: 30, Fields: 'ChannelInfo' });
  return req('GET', '/LiveTv/Programs', { UserId: a.userId, SearchTerm: a.query, MinEndDate: iso(a.now - HOUR), MaxStartDate: iso(a.guideEnd), SortBy: 'StartDate', Limit: 30, EnableImages: false });
}

// Other airings of a programme, now − 1 h to now + 48 h. Emby: SearchTerm (the caller keeps exact
// folded name matches). Jellyfin: by series ids, else null (memory search).
export function otherAirings(kind: ServerKind, a: { userId: string; name: string; now: number; seriesTimerId?: string; librarySeriesId?: string }): Req | null {
  const win = { MinEndDate: iso(a.now - HOUR), MaxStartDate: iso(a.now + 48 * HOUR), SortBy: 'StartDate', Limit: 50, EnableImages: false };
  if (kind === 'emby') return req('GET', '/LiveTv/Programs', { UserId: a.userId, SearchTerm: a.name, ...win });
  if (a.librarySeriesId) return req('GET', '/LiveTv/Programs', { UserId: a.userId, LibrarySeriesId: a.librarySeriesId, ...win });
  if (a.seriesTimerId) return req('GET', '/LiveTv/Programs', { UserId: a.userId, SeriesTimerId: a.seriesTimerId, ...win });
  return null;
}

export const timers = (_kind: ServerKind): Req => req('GET', '/LiveTv/Timers');
export const timersOfRule = (_kind: ServerKind, a: { id: string }): Req => req('GET', '/LiveTv/Timers', { SeriesTimerId: a.id });
export const seriesTimers = (_kind: ServerKind): Req => req('GET', '/LiveTv/SeriesTimers');
export const seriesTimer = (_kind: ServerKind, a: { id: string }): Req => req('GET', `/LiveTv/SeriesTimers/${enc(a.id)}`);
export const timerDefaults = (_kind: ServerKind, a: { programId: string }): Req => req('GET', '/LiveTv/Timers/Defaults', { ProgramId: a.programId });

export function recordingOptions(kind: ServerKind, a: { userId: string }): Req {
  return kind === 'emby' ? req('GET', '/LiveTv/AvailableRecordingOptions') : req('GET', '/LiveTv/Recordings/Folders', { userId: a.userId });
}

export function recordings(_kind: ServerKind, a: { userId: string; startIndex?: number; limit?: number; inProgress?: boolean }): Req {
  return req('GET', '/LiveTv/Recordings', {
    UserId: a.userId,
    Fields: 'Overview,PrimaryImageAspectRatio,DateCreated',
    EnableImageTypes: 'Primary,Thumb',
    ImageTypeLimit: 1,
    StartIndex: a.startIndex ?? 0,
    Limit: a.limit ?? 500,
    IsInProgress: a.inProgress ? true : undefined,
  });
}

// Never client=emby.
export function displayPrefs(kind: ServerKind, a: { userId: string }): Req {
  return req('GET', '/DisplayPreferences/wicaby-livetv', kind === 'emby' ? { UserId: a.userId, Client: 'wicaby' } : { userId: a.userId, client: 'wicaby' });
}

// ---- Writes (§5.2) ----

export function setFavorite(kind: ServerKind, a: { userId: string; id: string; favorite: boolean }): Req {
  const method = a.favorite ? 'POST' : 'DELETE';
  return kind === 'emby' ? req(method, `/Users/${enc(a.userId)}/FavoriteItems/${enc(a.id)}`) : req(method, `/UserFavoriteItems/${enc(a.id)}`, { userId: a.userId });
}

export const createTimer = (_kind: ServerKind, a: { body: unknown }): Req => req('POST', '/LiveTv/Timers', {}, a.body);
export const updateTimer = (_kind: ServerKind, a: { id: string; body: unknown }): Req => req('POST', `/LiveTv/Timers/${enc(a.id)}`, {}, a.body);
export const cancelTimer = (_kind: ServerKind, a: { id: string }): Req => req('DELETE', `/LiveTv/Timers/${enc(a.id)}`);
export const createSeriesTimer = (_kind: ServerKind, a: { body: unknown }): Req => req('POST', '/LiveTv/SeriesTimers', {}, a.body);
export const updateSeriesTimer = (_kind: ServerKind, a: { id: string; body: unknown }): Req => req('POST', `/LiveTv/SeriesTimers/${enc(a.id)}`, {}, a.body);
export const deleteSeriesTimer = (_kind: ServerKind, a: { id: string }): Req => req('DELETE', `/LiveTv/SeriesTimers/${enc(a.id)}`);
export const deleteRecording = (_kind: ServerKind, a: { id: string }): Req => req('DELETE', `/LiveTv/Recordings/${enc(a.id)}`);
// Jellyfin fallback after a 404/405 on deleteRecording.
export const deleteItem = (_kind: ServerKind, a: { id: string }): Req => req('DELETE', `/Items/${enc(a.id)}`);

// The body must carry Id and Client (Emby reads the client from the DTO); see prefs.ts prefsBody.
export function saveDisplayPrefs(kind: ServerKind, a: { userId: string; body: Record<string, unknown> }): Req {
  const body = { ...a.body, Id: 'wicaby-livetv', Client: 'wicaby' };
  return req('POST', '/DisplayPreferences/wicaby-livetv', kind === 'emby' ? { UserId: a.userId, Client: 'wicaby' } : { userId: a.userId, client: 'wicaby' }, body);
}

// ---- Streams (§5.3) ----

export interface TuneArgs {
  userId: string;
  channelId: string;
  maxBitrate: number; // always sent (a posted profile otherwise caps at 8 Mbps)
  rung: 0 | 1 | 2; // 0 everything, 1 server remux, 2 full transcode
  deviceProfile?: unknown;
  autoOpen?: boolean; // false for probes, pre-fetch and the banner
}

export function tune(_kind: ServerKind, a: TuneArgs): Req {
  const body: Record<string, unknown> = {
    DeviceProfile: a.deviceProfile ?? {},
    EnableDirectPlay: a.rung === 0,
    EnableDirectStream: true,
    EnableTranscoding: true,
  };
  if (a.rung === 2) {
    body.AllowVideoStreamCopy = false;
    body.AllowAudioStreamCopy = false;
  }
  return req('POST', `/Items/${enc(a.channelId)}/PlaybackInfo`, { UserId: a.userId, IsPlayback: true, AutoOpenLiveStream: a.autoOpen !== false, MaxStreamingBitrate: a.maxBitrate, StartTimeTicks: 0 }, body);
}

// Only when RequiresOpening && !LiveStreamId. Ids go in the query and in the body on both servers.
export function open(_kind: ServerKind, a: { userId: string; itemId: string; playSessionId: string; maxBitrate: number; openToken: string; deviceProfile?: unknown }): Req {
  return req(
    'POST',
    '/LiveStreams/Open',
    { UserId: a.userId, ItemId: a.itemId, PlaySessionId: a.playSessionId, MaxStreamingBitrate: a.maxBitrate, OpenToken: a.openToken },
    { OpenToken: a.openToken, DeviceProfile: a.deviceProfile ?? {}, UserId: a.userId, ItemId: a.itemId, PlaySessionId: a.playSessionId, MaxStreamingBitrate: a.maxBitrate },
  );
}

// Query string only (a body gives 400).
export const close = (_kind: ServerKind, a: { liveStreamId: string; playSessionId: string }): Req => req('POST', '/LiveStreams/Close', { LiveStreamId: a.liveStreamId, PlaySessionId: a.playSessionId });

export const killEncodes = (_kind: ServerKind, a: { deviceId: string; playSessionId: string }): Req => req('DELETE', '/Videos/ActiveEncodings', { DeviceId: a.deviceId, PlaySessionId: a.playSessionId });

export function staticStream(_kind: ServerKind, a: { itemId: string; container: string; mediaSourceId: string; liveStreamId?: string; deviceId: string; playSessionId: string }): Req {
  return req('GET', `/Videos/${enc(a.itemId)}/stream.${a.container}`, { Static: true, MediaSourceId: a.mediaSourceId, LiveStreamId: a.liveStreamId, DeviceId: a.deviceId, PlaySessionId: a.playSessionId });
}

export interface ReportArgs {
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  liveStreamId?: string;
  playMethod: 'DirectPlay' | 'DirectStream' | 'Transcode';
  isPaused?: boolean;
}

function report(path: string, a: ReportArgs): Req {
  const body: Record<string, unknown> = { ItemId: a.itemId, MediaSourceId: a.mediaSourceId, PlaySessionId: a.playSessionId, PlayMethod: a.playMethod, IsPaused: a.isPaused === true };
  if (a.liveStreamId) body.LiveStreamId = a.liveStreamId;
  return req('POST', path, {}, body);
}

export const reportPlaying = (_kind: ServerKind, a: ReportArgs): Req => report('/Sessions/Playing', a);
export const reportProgress = (_kind: ServerKind, a: ReportArgs): Req => report('/Sessions/Playing/Progress', a);
export const reportStopped = (_kind: ServerKind, a: ReportArgs): Req => report('/Sessions/Playing/Stopped', a);

// Every builder by name (the golden vectors and the headless mock check call them through this).
export const OPS: Readonly<Record<string, (kind: ServerKind, args: any) => Req | null>> = {
  info,
  guideInfo,
  channelsPage,
  channelCategorySet,
  channelTags,
  programsTile,
  programNowNext,
  programDetail,
  onNow,
  onLater,
  searchPrograms,
  otherAirings,
  timers,
  timersOfRule,
  seriesTimers,
  seriesTimer,
  timerDefaults,
  recordingOptions,
  recordings,
  displayPrefs,
  setFavorite,
  createTimer,
  updateTimer,
  cancelTimer,
  createSeriesTimer,
  updateSeriesTimer,
  deleteSeriesTimer,
  deleteRecording,
  deleteItem,
  saveDisplayPrefs,
  tune,
  open,
  close,
  killEncodes,
  staticStream,
  reportPlaying,
  reportProgress,
  reportStopped,
};

// path + query as a URL tail (keys in insertion order, values encoded).
export function toUrl(r: Req): string {
  const q = Object.entries(r.query)
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join('&');
  return q ? `${r.path}?${q}` : r.path;
}
