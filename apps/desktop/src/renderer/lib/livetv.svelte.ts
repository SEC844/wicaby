// Live TV facade (spec §18 D-3). The data layer lives in lib/livetv/ (store, guide cache, prefs,
// DVR overlay, dialect executor); this module keeps the names the rest of the app imports
// (`live`, `playChannel`, `programSheet`, `timersVersion`, the Program/Channel shapes and the time
// helpers) so Home, ProgramSheet, ChannelTile, search and the current guide keep working on it.
//
// - live.channels() without a limit reads the store (paged, cached in IndexedDB, synced lens
//   prefs); each channel's CurrentProgram is read from the guide cache, reactively.
// - live.programs() is served by the tile cache: a timer change no longer reloads programmes, it
//   only refetches the timer overlay (GET /LiveTv/Timers); marks are getters over that overlay, so
//   they re-render on `timersVersion` while the grid keeps its programmes. The grid re-reads only on
//   `guideVersion` (a guide refresh, after its windows revalidated).
// - Timer writes go through the DVR store (optimistic overlay patch, then the authoritative refetch).
import type { BaseItem, ItemsResult } from '../../shared/models';
import { PF } from '../../shared/livetv/model';
import type { ChannelRow, ProgramLite, TimerLite } from '../../shared/livetv/model';
import { applyLens } from '../../shared/livetv/lens';
import { cachedGet, invalidateApiCache, LIST_FIELDS } from './api';
import { w } from './bridge';
import { fmt } from './i18n.svelte';
import { errorMessage, iptvSessions, liveTv, sessionFor, toast } from './stores.svelte';
import { broadcastTimers, liveGate, storeFor } from './livetv/store.svelte';
import type { LiveTvStore } from './livetv/store.svelte';

export { liveGate, storeFor } from './livetv/store.svelte';
export type { LiveTvStore } from './livetv/store.svelte';

export interface Program extends BaseItem {
  ChannelId?: string;
  ChannelName?: string;
  StartDate?: string;
  EndDate?: string;
  EpisodeTitle?: string;
  IsSeries?: boolean;
  IsMovie?: boolean;
  IsLive?: boolean;
  IsNew?: boolean;
  IsPremiere?: boolean;
  TimerId?: string;
  SeriesTimerId?: string;
}

export interface Channel extends BaseItem {
  ChannelNumber?: string;
  Number?: string;
  CurrentProgram?: Program;
}

export interface Timer {
  Id: string;
  Name?: string;
  ChannelId?: string;
  ChannelName?: string;
  ProgramId?: string;
  StartDate: string;
  EndDate: string;
  Status?: string;
  SeriesTimerId?: string;
}

export interface SeriesTimer {
  Id: string;
  Name?: string;
  ChannelName?: string;
  RecordAnyChannel?: boolean;
  RecordNewOnly?: boolean;
}

// Live TV is per server. The page shows one at a time (a picker appears when several have it);
// calls default to that one, and items carry their own ServerId otherwise.
export const liveServer = $state<{ id: string | undefined }>({ id: undefined });
export function currentLiveServer(): string | undefined {
  return liveServer.id && liveTv.servers.includes(liveServer.id) ? liveServer.id : liveTv.servers[0];
}

// IPTV sources (the IPTV page): the same store and pages, one source at a time.
export const iptvSource = $state<{ id: string | undefined }>({ id: undefined });
export function currentIptvSource(): string | undefined {
  const ids = iptvSessions().map((s) => s.server.id);
  return iptvSource.id && ids.includes(iptvSource.id) ? iptvSource.id : ids[0];
}

function uid(serverId?: string): string {
  return sessionFor(serverId)?.user?.id ?? '';
}

const IMAGES = { EnableImageTypes: 'Primary,Thumb,Backdrop', ImageTypeLimit: 1 };

// Bumped whenever the timer overlay changes, so marks re-render. A timer change never reloads
// programmes (zero /LiveTv/Programs requests).
export const timersVersion = $state({ value: 0 });

// Bumped after a guide refresh revalidated the grid's windows: the grid re-reads them from the cache.
export const guideVersion = $state({ value: 0 });

// The windows the current grid asked for, per store: a guide refresh revalidates them.
const windows = new Map<LiveTvStore, { ids: Set<string>; from: number; to: number }>();

function store(serverId: string | undefined): LiveTvStore {
  const s = storeFor(serverId);
  if (!s) throw new Error('Live TV: no signed-in user on this server');
  if (!s.dvr.onChange) {
    s.dvr.onChange = () => timersVersion.value++;
    s.onGuideRefresh(() => {
      const w = windows.get(s);
      if (w) void s.ensure([...w.ids], w.from, w.to, 1, true).then(() => guideVersion.value++);
    });
  }
  return s;
}

function track(s: LiveTvStore, ids: readonly string[], from: number, to: number): void {
  const w = windows.get(s);
  if (!w) windows.set(s, { ids: new Set(ids), from, to });
  else {
    for (const id of ids) w.ids.add(id);
    w.from = Math.min(w.from, from);
    w.to = Math.max(w.to, to);
  }
}

// ---- Legacy shapes over the store's rows ----

const iso = (t: number): string => new Date(t).toISOString();

// The overlay wins once loaded; the payload ids are used only before it (§6.7).
function marks(p: ProgramLite, overlay: ReadonlyMap<string, TimerLite> | null): { timerId?: string; seriesTimerId?: string } {
  if (!overlay) return { timerId: p.timerId, seriesTimerId: p.seriesTimerId };
  const tm = overlay.get(p.id);
  return { timerId: tm?.id, seriesTimerId: tm?.seriesTimerId ?? p.seriesTimerId };
}

export function legacyProgram(p: ProgramLite, s: LiveTvStore): Program {
  const out: Program = {
    Id: p.id,
    Name: p.title,
    Type: 'Program',
    ServerId: s.serverId,
    ChannelId: p.channelId,
    StartDate: iso(p.start),
    EndDate: iso(p.end),
    IsSeries: (p.flags & PF.Series) !== 0,
    IsMovie: (p.flags & PF.Movie) !== 0,
    IsLive: (p.flags & PF.Live) !== 0,
    IsNew: (p.flags & PF.New) !== 0,
    IsPremiere: (p.flags & PF.Premiere) !== 0,
  };
  if (p.episodeTitle) out.EpisodeTitle = p.episodeTitle;
  if (p.rating) out.OfficialRating = p.rating;
  if (p.seriesId) out.SeriesId = p.seriesId;
  if (p.imageTag) out.ImageTags = { Primary: p.imageTag };
  // Read on access (reactive to timersVersion): a timer change re-renders marks, nothing reloads.
  const mark = () => {
    void timersVersion.value;
    return marks(p, s.dvr.overlay);
  };
  Object.defineProperties(out, {
    TimerId: { enumerable: true, configurable: true, get: () => mark().timerId },
    SeriesTimerId: { enumerable: true, configurable: true, get: () => mark().seriesTimerId },
  });
  return out;
}

export function legacyChannel(r: ChannelRow, s: LiveTvStore): Channel {
  const c: Channel = { Id: r.id, Name: r.name, Type: 'TvChannel', ServerId: r.serverId, ChannelNumber: r.number, Number: r.number };
  if (r.logoTag) c.ImageTags = { Primary: r.logoTag };
  (c as Channel & { UserData?: { IsFavorite: boolean } }).UserData = { IsFavorite: r.favorite };
  // Read from the guide cache on access: reactive to tile arrivals, and asks for the now slab.
  Object.defineProperty(c, 'CurrentProgram', {
    enumerable: true,
    configurable: true,
    get(): Program | undefined {
      void timersVersion.value;
      const [cur] = s.nowNext(r.id, s.clock);
      if (!cur) {
        s.demandNow(r.id);
        return undefined;
      }
      return legacyProgram(cur, s);
    },
  });
  return c;
}

export const live = {
  // With a limit (Home's "En direct" row): the server's channels with their current programme, as
  // before. Without (the Live TV page): the store's full lineup, all channels, synced sort.
  async channels(limit?: number, serverId = currentLiveServer()): Promise<ItemsResult & { Items: Channel[] }> {
    if (limit === undefined) {
      const s = store(serverId);
      await s.open();
      if (s.channelsState === 'error' && !s.channels.length) throw new Error(s.channelsError);
      // Hidden channels and the sort come from the prefs: this device's last copy when there is one,
      // else the server's answer (which usually lands with the channels; never wait long for it).
      if (!s.prefsSeeded) await Promise.race([s.prefsReady(), new Promise((r) => setTimeout(r, 1500))]);
      const rows = applyLens({ rows: s.channels, lens: { kind: 'all' }, prefs: s.lensPrefs, sort: s.sort, favFirst: s.favFirst });
      const items = rows.map((r) => legacyChannel(r, s));
      return { Items: items, TotalRecordCount: items.length } as ItemsResult & { Items: Channel[] };
    }
    const r = await cachedGet<ItemsResult & { Items: Channel[] }>(
      '/LiveTv/Channels',
      { UserId: uid(serverId), AddCurrentProgram: true, EnableFavoriteSorting: true, Limit: limit, Fields: 'PrimaryImageAspectRatio', ...IMAGES },
      serverId,
    );
    // Nested programs need their server for images and the program sheet.
    for (const c of r.Items) if (c.CurrentProgram) c.CurrentProgram.ServerId = c.ServerId;
    return r;
  },

  // One window of the guide for a batch of channels, from the tile cache (≤ 50 channels × 12 h per
  // request, IndexedDB first). Marks come from the timer overlay.
  async programs(channelIds: string[], from: Date, to: Date, serverId = currentLiveServer()): Promise<ItemsResult & { Items: Program[] }> {
    const s = store(serverId);
    const a = from.getTime();
    const b = to.getTime();
    track(s, channelIds, a, b);
    await s.ensure(channelIds, a, b, 0);
    // The caller renders these in this task; the next frame is the one that paints them.
    requestAnimationFrame(() => s.markPainted());
    const items: Program[] = [];
    for (const id of channelIds) for (const p of s.programsIn(id, a, b)) items.push(legacyProgram(p, s));
    return { Items: items, TotalRecordCount: items.length } as ItemsResult & { Items: Program[] };
  },

  program: (id: string, serverId = currentLiveServer()) =>
    w.api.get<Program>(`/LiveTv/Programs/${id}`, { UserId: uid(serverId) }, serverId).then((p) => ({ ...p, ServerId: serverId })),

  recordings: (serverId = currentLiveServer()) =>
    cachedGet<ItemsResult>('/LiveTv/Recordings', { UserId: uid(serverId), Fields: LIST_FIELDS, ...IMAGES }, serverId),

  timers: (serverId = currentLiveServer()) => w.api.get<{ Items: Timer[] }>('/LiveTv/Timers', undefined, serverId),

  seriesTimers: (serverId = currentLiveServer()) => w.api.get<{ Items: SeriesTimer[] }>('/LiveTv/SeriesTimers', { SortBy: 'SortName' }, serverId),

  // The server's defaults become the new timer as they are (plus the synced padding when set).
  async record(programId: string, series: boolean, serverId = currentLiveServer()): Promise<void> {
    const s = store(serverId);
    await s.dvr.record(programId, series, s.prefs.dvrPadding);
    written(s.serverId);
  },

  async cancelTimer(id: string, serverId = currentLiveServer()): Promise<void> {
    const s = store(serverId);
    await s.dvr.cancelTimer(id);
    written(s.serverId);
  },

  async cancelSeriesTimer(id: string, serverId = currentLiveServer()): Promise<void> {
    const s = store(serverId);
    await s.dvr.cancelSeriesTimer(id);
    written(s.serverId);
  },
};


// After a timer write: the recordings list may change, and the other window refetches its overlay.
function written(serverId: string): void {
  invalidateApiCache();
  broadcastTimers(serverId);
}

export async function playChannel(channelId: string | undefined, serverId?: string): Promise<void> {
  if (!channelId) return;
  try {
    await w.playback.play({ itemIds: [channelId], serverId });
    storeFor(serverId ?? currentLiveServer())?.pushRecent(channelId);
  } catch (err) {
    toast('error', errorMessage(err));
  }
}

// Wall clock for "now" lines and progress bars, on the Live TV visibility gate (window visible);
// a tick when the window shows again catches up at once.
export const now = $state({ value: Date.now() });
liveGate.every(30_000, () => (now.value = Date.now()), 'visible');

export const programSheet = $state<{ program: Program | null; channel: Channel | null }>({ program: null, channel: null });

export function openProgram(program: Program | null | undefined, channel?: Channel | null): void {
  programSheet.program = program ?? null;
  programSheet.channel = channel ?? null;
  if (!program && channel) programSheet.program = { Id: '', Name: channel.Name, Type: 'Program', ChannelId: channel.Id, ServerId: channel.ServerId };
}

export const ms = (iso?: string) => (iso ? Date.parse(iso) : NaN);

export function hm(iso?: string | number): string {
  if (iso === undefined) return '';
  return fmt.time(iso);
}

export function span(p: { StartDate?: string; EndDate?: string }): string {
  return p.StartDate && p.EndDate ? `${hm(p.StartDate)} – ${hm(p.EndDate)}` : '';
}

export function airing(p: { StartDate?: string; EndDate?: string } | null | undefined, at = now.value): number {
  const s = ms(p?.StartDate);
  const e = ms(p?.EndDate);
  if (!(e > s) || at < s) return 0;
  return Math.min(1, (at - s) / (e - s));
}

export function channelNumber(c: Channel): string {
  return c.ChannelNumber ?? c.Number ?? '';
}

