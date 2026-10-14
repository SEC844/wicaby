// Live TV store, one per (server, user) (spec §4.1, §5.4, §6.3–§6.6, §7, §21.2 F8/F9, §21.4).
//
// - Channels: paged in (500 per page, 2 pages in flight), rendered from IndexedDB first and
//   revalidated when older than 10 min or on LibraryChanged; "offline" when only the cache is left.
// - Lenses, sort, favourites first, favourite order, hidden channels, client groups, recents and
//   badges come from the synced DisplayPreferences document (prefs.ts); the lens pipeline is the
//   pure shared/livetv/lens.ts. Favourite toggles are optimistic, serialized, rolled back on failure
//   and refused while favourites or prefs failed to load.
// - Programmes: the tile loader of guide-cache.ts (memory LRU + IndexedDB + planner queue).
// - Caps and probes: V15 (onNow source), V16 (IsHD), newFlag, category probes 1 and 2, channel tags,
//   tuner count, record permission (403 downgrade), clock skew from the Date header.
// - VisibilityGate (F8): every Live TV timer (clock, anchor, rails, overlay catch-up) runs only while
//   Live TV is shown in a visible, focused window; visible again → one catch-up run.
// - Cross-window: BroadcastChannel('wicaby-livetv') carries slab, channels, timers and favourite
//   changes between the main and OSD windows.
// - Dev counters on window.__wicabyLive (§16.3).
import { channelCategorySet, channelTags, channelsPage, guideInfo, info, onNow, programsTile, setFavorite } from '../../../shared/livetv/dialect';
import type { Req } from '../../../shared/livetv/dialect';
import type { SortMode } from '../../../shared/livetv/channel-order';
import { anchorInit, anchorReduce, dayChips } from '../../../shared/livetv/anchor';
import type { AnchorEvent, AnchorState } from '../../../shared/livetv/anchor';
import { applyLens, availableLenses, categoryRows, categoryRowsProbe, categorySourceFromGenres, categorySourceFromTiles, pushRecent, reconcileFavorites, sameLens } from '../../../shared/livetv/lens';
import type { ClientGroup, LensPrefs } from '../../../shared/livetv/lens';
import { defaultCaps, hdProbe, normalizeChannel, onNowProbe, parseServerDate } from '../../../shared/livetv/model';
import type { Category, ChannelRow, LensRef, LiveCaps, ProgramLite, ServerKind } from '../../../shared/livetv/model';
import { canEditFavorites, defaultPrefs } from '../../../shared/livetv/prefs';
import type { Badge, LivePrefs } from '../../../shared/livetv/prefs';
import { TUNING, idleSet, slabEnd, slabOf, slabStart } from '../../../shared/livetv/tiles';
import type { TileRequest } from '../../../shared/livetv/tiles';
import { w } from '../bridge';
import { t } from '../i18n.svelte';
import { sessionFor, toast } from '../stores.svelte';
import { DEADLINE_CHANNELS_MS, DEADLINE_TILE_MS, LiveApi, LiveApiError, requestCounters, retryable } from './api';
import { DvrStore } from './dvr.svelte';
import { CHANNEL_CHANNEL, GuideDb, TileLoader } from './guide-cache';
import type { Viewport } from './guide-cache';
import { PrefsSyncer } from './prefs';

export const CHANNELS_MAX_AGE_MS = 10 * 60_000; // stale-while-revalidate on each open
export const CATEGORY_SET_TTL_MS = 30 * 60_000;
export const CLOCK_TICK_MS = 30_000;
export const PROBE_TILES = 3; // V16 and category probe 2 look at the first 3 tiles
const TUNE = TUNING.desktop;

type Dto = Record<string, unknown>;
type Items = { Items?: Dto[]; TotalRecordCount?: number };
export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface ServiceState {
  name: string;
  ok: boolean;
  message: string;
}

// ---------------------------------------------------------------------------------------------------
// VisibilityGate (F8)
// ---------------------------------------------------------------------------------------------------

// 'visible': the window is shown. 'open': Live TV is shown (route or a source such as the OSD
// overlay), in a visible and focused window.
export type GateLevel = 'visible' | 'open';

interface GateTask {
  ms: number;
  fn: () => void;
  level: GateLevel;
  lastRun: number;
  timer: ReturnType<typeof setInterval> | null;
}

class VisibilityGate {
  visible = $state(typeof document === 'undefined' || document.visibilityState === 'visible');
  focused = $state(typeof document === 'undefined' || document.hasFocus());
  private sources = $state<Record<string, boolean>>({});
  open = $derived(this.visible && this.focused && Object.values(this.sources).some(Boolean));
  private tasks = new Set<GateTask>();
  private listeners = new Set<(open: boolean, level: GateLevel) => void>();
  private was = { visible: false, open: false };

  constructor() {
    if (typeof window === 'undefined') return;
    const update = (): void => {
      this.visible = document.visibilityState === 'visible';
      this.focused = document.hasFocus();
      this.apply();
    };
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    const route = (): void => this.setSource('route', /^#\/(?:livetv|iptv)(?:[/?]|$)/.test(location.hash));
    window.addEventListener('hashchange', route);
    route();
    this.was = { visible: this.visible, open: this.open };
  }

  // A Live TV surface is shown or hidden (the route does this itself; the OSD's live overlay, D-5).
  setSource(name: string, active: boolean): void {
    if (Boolean(this.sources[name]) === active) return;
    this.sources = { ...this.sources, [name]: active };
    this.apply();
  }

  is(level: GateLevel): boolean {
    return level === 'visible' ? this.visible : this.open;
  }

  // Runs fn every ms while the level holds; when it holds again after a pause, one catch-up run if due.
  every(ms: number, fn: () => void, level: GateLevel = 'open'): () => void {
    const task: GateTask = { ms, fn, level, lastRun: Date.now(), timer: null };
    this.tasks.add(task);
    if (this.is(level)) this.start(task);
    return () => {
      if (task.timer) clearInterval(task.timer);
      this.tasks.delete(task);
    };
  }

  onChange(cb: (open: boolean, level: GateLevel) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private start(task: GateTask): void {
    if (task.timer) return;
    task.timer = setInterval(() => {
      task.lastRun = Date.now();
      task.fn();
    }, task.ms);
  }

  private apply(): void {
    // $derived is read synchronously here, outside any effect: fine for a plain read.
    const now = { visible: this.visible, open: this.open };
    for (const task of this.tasks) {
      const on = this.is(task.level);
      if (on && !task.timer) {
        if (Date.now() - task.lastRun >= task.ms) {
          task.lastRun = Date.now();
          task.fn();
        }
        this.start(task);
      } else if (!on && task.timer) {
        clearInterval(task.timer);
        task.timer = null;
      }
    }
    if (now.visible !== this.was.visible) for (const cb of this.listeners) cb(now.visible, 'visible');
    if (now.open !== this.was.open) for (const cb of this.listeners) cb(now.open, 'open');
    this.was = now;
  }
}

export const liveGate = new VisibilityGate();

// ---------------------------------------------------------------------------------------------------
// Shared layers: IndexedDB, BroadcastChannel, dev counters
// ---------------------------------------------------------------------------------------------------

let sharedDb: GuideDb | null = null;
function guideDb(): GuideDb {
  if (!sharedDb) {
    sharedDb = new GuideDb();
    sharedDb.onWritten = (scope, keys) => post({ type: 'slab', scope, keys });
    const db = sharedDb;
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    (ric ?? ((cb: () => void) => setTimeout(cb, 3000)))(() => void db.purge(Date.now()), { timeout: 10_000 });
  }
  return sharedDb;
}

type Broadcast =
  | { type: 'slab'; scope: string; keys: string[] }
  | { type: 'channels'; scope: string }
  | { type: 'timers'; serverId: string }
  | { type: 'favorite'; scope: string; id: string; favorite: boolean };

let bc: BroadcastChannel | null = null;
function channel(): BroadcastChannel | null {
  if (bc || typeof BroadcastChannel === 'undefined') return bc;
  try {
    bc = new BroadcastChannel(CHANNEL_CHANNEL);
    bc.onmessage = (e: MessageEvent<Broadcast>) => onBroadcast(e.data);
  } catch {
    bc = null;
  }
  return bc;
}

function post(msg: Broadcast): void {
  try {
    channel()?.postMessage(msg);
  } catch {
    // another window is optional
  }
}

function onBroadcast(m: Broadcast): void {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'timers') {
    for (const s of stores.values()) if (s.serverId === m.serverId) s.dvr.refreshSoon();
    return;
  }
  const s = stores.get(m.scope);
  if (!s) return;
  if (m.type === 'slab') s.loader.invalidate(m.keys);
  else if (m.type === 'channels') void s.reloadChannelsFromDb();
  else if (m.type === 'favorite') s.applyFavorite(m.id, m.favorite);
}

// ---------------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------------

const mruKey = (scope: string): string => `wicaby.livetv.mru.${scope}`;
const plainId = (s: unknown): string => (typeof s === 'string' ? s.replace(/-/g, '').toLowerCase() : '');

function readMru(scope: string): string[] | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(mruKey(scope)) ?? 'null');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20) : null;
  } catch {
    return null;
  }
}

function writeMru(scope: string, ids: readonly string[]): void {
  try {
    localStorage.setItem(mruKey(scope), JSON.stringify(ids));
  } catch {
    // device copy only
  }
}

export class LiveTvStore {
  readonly serverId: string;
  readonly userId: string;
  readonly kind: ServerKind;
  readonly scope: string;
  readonly api: LiveApi;
  readonly loader: TileLoader;
  readonly prefsSync: PrefsSyncer;
  readonly dvr: DvrStore;

  // ---- Reactive state ----
  channels = $state.raw<ChannelRow[]>([]);
  channelsState = $state<LoadState>('idle');
  channelsError = $state('');
  channelsUpdatedAt = $state(0);
  offline = $state(false); // a refresh failed: the cached list is shown ("Guide hors ligne · mis à jour {when}")
  total = $state(0);
  caps = $state<LiveCaps>(defaultCaps('emby'));
  prefs = $state.raw<LivePrefs>(defaultPrefs());
  prefsState = $state<'pending' | 'ok' | 'failed'>('pending');
  mru = $state.raw<string[]>([]);
  category = $state<Category | null>(null);
  categorySet = $state.raw<ReadonlySet<string> | null>(null);
  guideEnd = $state<number | null>(null);
  enabled = $state(true); // /LiveTv/Info IsEnabled
  services = $state.raw<ServiceState[]>([]);
  version = $state(0); // programme data; read it to react to tile arrivals
  clock = $state(Date.now()); // server time, ticked by the gate
  anchor = $state.raw<AnchorState>(anchorInit(Date.now()));
  reminded = $state.raw<ReadonlySet<string>>(new Set()); // programme ids with a local reminder (the guide's bell)
  recenterSeq = $state(0); // the guide re-centres on now when this changes
  tzEpoch = $state(0); // the time zone changed: rebuild days and dayparts

  lens = $derived<LensRef>(this.prefs.lens);
  sort = $derived<SortMode>(this.prefs.sort);
  favFirst = $derived(this.prefs.favFirst);
  badges = $derived<Badge[]>(this.prefs.badges);
  lensPrefs = $derived<LensPrefs>({ favOrder: this.prefs.fav, hidden: this.prefs.hidden, groups: this.prefs.groups, recents: this.mru });
  // The one pipeline (§6.5): hidden out → lens → sort, then the category rows when the server honours them.
  lensRows = $derived(applyLens({ rows: this.channels, lens: this.lens, prefs: this.lensPrefs, sort: this.sort, favFirst: this.favFirst }));
  // Genre-sourced categories: the server has no category flags, so its channel filter returns nothing (S7 flagless).
  rows = $derived(categoryRows(this.lensRows, this.category, this.categorySet, this.caps.categorySource === 'genres' ? false : this.caps.categoryFilterOnChannels));
  rowIds = $derived(this.rows.map((r) => r.id));
  lenses = $derived(availableLenses(this.channels, this.prefs.groups, this.caps.kind === 'emby'));
  favorites = $derived.by(() => {
    const hidden = new Set(this.prefs.hidden);
    return reconcileFavorites(this.channels.filter((r) => !hidden.has(r.id)), this.prefs.fav);
  });
  days = $derived(dayChips(this.clock, this.guideEnd));
  favoritesEditable = $derived(this.prefsState === 'ok' && this.channelsState === 'ready' && !this.offline);

  // ---- Plain bookkeeping ----
  firstPaintMs: number | null = null;
  private openedAt = 0;
  private restored = false;
  private channelsLoading: Promise<void> | null = null;
  private prefsLoad: Promise<boolean> = Promise.resolve(false);
  prefsSeeded = false; // prefs from this device's last read are shown while the server answers
  private favChain: Promise<unknown> = Promise.resolve();
  private probeTiles = 0;
  private probeRaw: Dto[] = [];
  private probePrograms: ProgramLite[] = [];
  private genreProbe: Promise<void> | null = null;
  private categorySets = new Map<Category, { at: number; ids: Set<string> }>();
  private staticLoaded = false;
  private versionQueued = false;
  private nowDemand = new Set<string>();
  private nowDemandQueued = false;
  private nowFrac: (() => number | null) | null = null;
  private tz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : '';
  private offs: (() => void)[] = [];
  private refreshHooks = new Set<() => void>();

  constructor(serverId: string, userId: string, kind: ServerKind) {
    this.serverId = serverId;
    this.userId = userId;
    this.kind = kind;
    this.scope = `${serverId}:${userId}`;
    this.caps = defaultCaps(kind);
    this.api = new LiveApi(serverId, kind, userId);
    this.api.onSkew = (ms) => {
      this.caps.clockSkewMs = ms;
      this.clock = this.now();
      void this.saveChannelsRecord();
    };
    const db = guideDb();
    this.loader = new TileLoader({
      serverId,
      userId,
      kind,
      tuning: TUNE,
      db,
      fetcher: (req, genres) => this.fetchTile(req, genres),
      now: () => this.now(),
      caps: () => this.caps,
      retryable,
      isTimeout: (err) => err instanceof LiveApiError && err.kind === 'timeout',
      onChange: () => this.bump(),
      onRaw: (req, raw, programs) => this.probeTile(req, raw, programs),
      idleIds: () => idleSet(this.favorites.map((r) => r.id), this.rowIds, TUNE),
    });
    this.prefsSync = new PrefsSyncer(kind, userId, (req) => this.api.run(req, { deadlineMs: 20_000 }).then((r) => r.data));
    this.prefsSync.onChange = () => {
      this.prefs = this.prefsSync.prefs;
      this.prefsState = this.prefsSync.loadState;
      // Keep the device copy for the next cold start (debounced with the prefs write itself).
      if (this.prefsState === 'ok') this.queuePrefsSave();
    };
    this.prefsSync.onWriteFailed = () => toast('error', t('livetv.manage.syncFailed'));
    this.dvr = new DvrStore(this.api);
    const mru = readMru(this.scope);
    if (mru) {
      this.mru = mru;
      this.prefsSync.setLocal({ recents: mru });
    }
    this.offs.push(
      liveGate.every(CLOCK_TICK_MS, () => this.tick(), 'visible'),
      liveGate.every(CLOCK_TICK_MS, () => this.anchorTick(), 'open'),
      liveGate.onChange((on, level) => {
        if (level === 'visible') this.anchorEvent({ type: on ? 'visible' : 'hidden', at: this.now() });
        // Back on Live TV: catch up the overlay and the visible slabs once.
        if (level === 'open' && on) {
          void this.dvr.open();
          this.loader.schedulePlan();
        }
      }),
    );
  }

  // Server time: the client clock plus the measured skew (§21.4).
  now(): number {
    return Date.now() + this.caps.clockSkewMs;
  }

  private bump(): void {
    if (this.versionQueued) return;
    this.versionQueued = true;
    queueMicrotask(() => {
      this.versionQueued = false;
      this.version++;
    });
  }

  // ---- Open ----

  // Live TV is shown: resolves once a channel list is available (cache or network).
  async open(): Promise<void> {
    this.openedAt = performance.now();
    if (!this.restored) {
      this.restored = true;
      await this.reloadChannelsFromDb();
    }
    this.prefsLoad = this.prefsSync.load();
    void this.dvr.open();
    void w.reminders.list().then((l) => (this.reminded = new Set(l.filter((r) => r.serverId === this.serverId).map((r) => r.programId))), () => undefined);
    if (!this.staticLoaded) {
      this.staticLoaded = true;
      void this.loadStatic();
    }
    if (!this.channels.length || this.channelsState === 'error') await this.loadChannels();
    else if (Date.now() - this.channelsUpdatedAt > CHANNELS_MAX_AGE_MS) void this.loadChannels();
  }

  setReminded(programId: string, on: boolean): void {
    const next = new Set(this.reminded);
    if (on) next.add(programId);
    else next.delete(programId);
    this.reminded = next;
  }

  private prefsSaveQueued = false;
  private queuePrefsSave(): void {
    if (this.prefsSaveQueued) return;
    this.prefsSaveQueued = true;
    setTimeout(() => {
      this.prefsSaveQueued = false;
      void this.saveChannelsRecord();
    }, 2_500);
  }

  // The DisplayPreferences read of the current open (true when it loaded).
  prefsReady(): Promise<boolean> {
    return this.prefsLoad;
  }

  // Called by the UI (or the facade) when the first programmes are on screen.
  markPainted(): void {
    if (this.firstPaintMs === null && this.openedAt) this.firstPaintMs = Math.round(performance.now() - this.openedAt);
  }

  async reloadChannelsFromDb(): Promise<void> {
    const rec = await guideDb().getChannels<ChannelRow, LiveCaps, LivePrefs>(this.serverId, this.userId);
    if (!rec || !Array.isArray(rec.rows)) return;
    if (rec.fetchedAt <= this.channelsUpdatedAt) return;
    this.channels = rec.rows;
    this.total = rec.rows.length;
    this.channelsUpdatedAt = rec.fetchedAt;
    if (this.channelsState !== 'loading') this.channelsState = 'ready';
    if (rec.caps && typeof rec.caps === 'object') this.caps = { ...defaultCaps(this.kind), ...rec.caps, kind: this.kind, canRecord: true };
    if (typeof rec.staleBefore === 'number') this.loader.staleBefore = Math.max(this.loader.staleBefore, rec.staleBefore);
    if (typeof rec.guideEnd === 'number') this.guideEnd = rec.guideEnd;
    if (rec.prefs && typeof rec.prefs === 'object') {
      this.prefsSync.seed(rec.prefs);
      this.prefsSeeded = true;
    }
  }

  private saveChannelsRecord(): Promise<void> {
    if (!this.channels.length) return Promise.resolve();
    return guideDb().putChannels({
      s: this.serverId,
      u: this.userId,
      rows: $state.snapshot(this.channels) as ChannelRow[],
      fetchedAt: this.channelsUpdatedAt,
      caps: $state.snapshot(this.caps) as LiveCaps,
      staleBefore: this.loader.staleBefore,
      guideEnd: this.guideEnd ?? undefined,
      prefs: this.prefsState === 'ok' ? this.prefsSync.prefs : undefined,
    });
  }

  // Pages of 500, 2 in flight, 20 s each; a page retries once on a connection error or 5xx.
  loadChannels(): Promise<void> {
    if (this.channelsLoading) return this.channelsLoading;
    if (!this.channels.length) this.channelsState = 'loading';
    const page = TUNE.channelPage;
    const getPage = async (startIndex: number): Promise<Items> => {
      const req = channelsPage(this.kind, { userId: this.userId, startIndex, limit: page });
      try {
        return (await this.api.run<Items>(req, { deadlineMs: DEADLINE_CHANNELS_MS })).data ?? {};
      } catch (err) {
        if (!retryable(err)) throw err;
        await new Promise((r) => setTimeout(r, 2_000));
        return (await this.api.run<Items>(req, { deadlineMs: DEADLINE_CHANNELS_MS })).data ?? {};
      }
    };
    this.channelsLoading = (async () => {
      try {
        const first = await getPage(0);
        const pages: Dto[][] = [first.Items ?? []];
        const total = typeof first.TotalRecordCount === 'number' ? first.TotalRecordCount : null;
        if (total !== null) {
          const starts: number[] = [];
          for (let s = page; s < total; s += page) starts.push(s);
          let next = 0;
          const worker = async (): Promise<void> => {
            while (next < starts.length) {
              const i = next++;
              pages[i + 1] = (await getPage(starts[i])).Items ?? [];
            }
          };
          await Promise.all(Array.from({ length: Math.min(TUNE.channelPagesInFlight, starts.length) }, worker));
        } else {
          // No total: page until a short page.
          for (let s = page; (pages[pages.length - 1]?.length ?? 0) >= page; s += page) pages.push((await getPage(s)).Items ?? []);
        }
        const rows: ChannelRow[] = [];
        pages.flat().forEach((dto, i) => {
          const r = normalizeChannel(dto, this.serverId, i);
          if (r) rows.push(r);
        });
        this.channels = rows;
        this.total = total ?? rows.length;
        this.channelsUpdatedAt = Date.now();
        this.channelsState = 'ready';
        this.channelsError = '';
        this.offline = false;
        // Category sets were computed against the old lineup.
        this.categorySets.clear();
        await this.saveChannelsRecord();
        post({ type: 'channels', scope: this.scope });
      } catch (err) {
        this.channelsError = err instanceof Error ? err.message : String(err);
        if (this.channels.length) this.offline = true;
        else this.channelsState = 'error';
      } finally {
        this.channelsLoading = null;
      }
    })();
    return this.channelsLoading;
  }

  // Once per session: Info (enabled, services, tuners), GuideInfo (range), Emby channel tags.
  private async loadStatic(): Promise<void> {
    const [i, g, tags] = await Promise.allSettled([
      this.api.run<Dto>(info(this.kind)),
      this.api.run<Dto>(guideInfo(this.kind)),
      this.kind === 'emby' && !this.caps.channelTags ? this.api.run<unknown>(channelTags(this.kind, { userId: this.userId }) as Req) : Promise.reject(new Error('skip')),
    ]);
    if (i.status === 'fulfilled') {
      const d = i.value.data ?? {};
      this.enabled = d.IsEnabled !== false;
      const list = Array.isArray(d.Services) ? (d.Services as Dto[]) : [];
      this.services = list.map((s) => ({ name: typeof s.Name === 'string' ? s.Name : '', ok: s.Status === undefined || s.Status === 'Ok', message: typeof s.StatusMessage === 'string' ? s.StatusMessage : '' }));
      const tuners = list.reduce((n, s) => n + (Array.isArray(s.Tuners) ? s.Tuners.length : 0), 0);
      this.caps.tunerCount = tuners || undefined;
    }
    if (g.status === 'fulfilled') {
      const end = parseServerDate(g.value.data?.EndDate);
      if (Number.isFinite(end)) this.guideEnd = end;
    }
    if (tags.status === 'fulfilled') this.caps.channelTags = true;
    void this.saveChannelsRecord();
  }

  // ---- Clock, anchor, time zone (LT-06 logic, §21.4) ----

  private tick(): void {
    this.clock = this.now();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz !== this.tz) {
      this.tz = tz;
      this.tzEpoch++;
    }
  }

  // The guide registers where the now line sits in its lane (0…1), or null when unknown.
  setNowFraction(fn: (() => number | null) | null): void {
    this.nowFrac = fn;
  }

  private anchorTick(): void {
    const frac = this.nowFrac?.();
    if (frac === null || frac === undefined) return;
    this.anchorEvent({ type: 'tick', at: this.now(), nowFrac: frac });
  }

  anchorEvent(ev: AnchorEvent): boolean {
    const r = anchorReduce(this.anchor, ev);
    this.anchor = r.state;
    if (r.recenter) this.recenterSeq++;
    return r.recenter;
  }

  // ---- Programmes (guide, mini-guide, banner, now list) ----

  setViewport(v: Omit<Viewport, 'rows'> & { rows?: readonly string[] }): void {
    this.loader.setViewport({ ...v, rows: v.rows ?? this.rowIds });
  }

  // Reactive reads: they depend on `version`.
  programs(channelId: string, from: number, to: number): ProgramLite[] | undefined {
    void this.version;
    return this.loader.programs(channelId, from, to);
  }

  programsIn(channelId: string, from: number, to: number): ProgramLite[] {
    void this.version;
    return this.loader.window(channelId, from, to);
  }

  nowNext(channelId: string, at = this.clock): [ProgramLite | null, ProgramLite | null] {
    void this.version;
    return this.loader.nowNext(channelId, at);
  }

  rowFailed(channelId: string, from: number, to: number): boolean {
    void this.version;
    return this.loader.rowFailed(channelId, from, to);
  }

  rowLoading(channelId: string, from: number, to: number): boolean {
    void this.version;
    return this.loader.rowLoading(channelId, from, to);
  }

  retryRow(channelId: string): void {
    this.loader.retryRow(channelId);
  }

  ensure(ids: readonly string[], from: number, to: number, priority: 0 | 1 | 2 | 3 = 0, revalidated = false): Promise<void> {
    return this.loader.ensure(ids, from, to, priority, revalidated);
  }

  // A reader needs the airing programme of a channel (now list, legacy tiles): load the now slab,
  // batched with the other demands of the same tick. Never writes reactive state synchronously.
  demandNow(channelId: string): void {
    const k = slabOf(this.now());
    if (this.loader.cache.has(channelId, k) || this.nowDemand.has(channelId)) return;
    this.nowDemand.add(channelId);
    if (this.nowDemandQueued) return;
    this.nowDemandQueued = true;
    queueMicrotask(() => {
      this.nowDemandQueued = false;
      const ids = [...this.nowDemand];
      this.nowDemand.clear();
      const s = slabOf(this.now());
      void this.loader.ensure(ids, slabStart(s), slabEnd(s), 1);
    });
  }

  private fetchTile(req: TileRequest, genres: boolean): Promise<Dto[]> {
    return this.api.run<Items>(programsTile(this.kind, { userId: this.userId, channelIds: req.channelIds, from: req.from, to: req.to, genres }), { deadlineMs: DEADLINE_TILE_MS }).then((r) => r.data?.Items ?? []);
  }

  // V16 and category probe 2, on the first 3 tiles.
  private probeTile(_req: TileRequest, raw: readonly Dto[], programs: readonly ProgramLite[]): void {
    if (this.probeTiles >= PROBE_TILES) return;
    this.probeTiles++;
    if (this.caps.hdFlag === 'unknown') this.probeRaw.push(...raw);
    if (this.caps.categorySource === 'unknown') this.probePrograms.push(...programs);
    if (this.probeTiles < PROBE_TILES) return;
    let changed = false;
    if (this.caps.hdFlag === 'unknown' && this.probeRaw.length) {
      this.caps.hdFlag = hdProbe(this.probeRaw);
      changed = true;
    }
    this.probeRaw = [];
    if (this.caps.categorySource === 'unknown' && this.probePrograms.length) {
      const verdict = categorySourceFromTiles(this.probePrograms, this.channels.length);
      if (verdict === 'flags') {
        this.caps.categorySource = 'flags';
        changed = true;
      } else void this.probeGenres();
    }
    this.probePrograms = [];
    if (changed) void this.saveChannelsRecord();
  }

  // Probe 2: no category flag in the first tiles → one onNow page with Fields=Genres decides.
  private probeGenres(): Promise<void> {
    if (this.genreProbe) return this.genreProbe;
    this.genreProbe = this.onNowRaw()
      .then((items) => {
        const lists = items.map((it) => (Array.isArray(it.Genres) ? it.Genres.filter((g): g is string => typeof g === 'string') : []));
        this.caps.categorySource = categorySourceFromGenres(lists);
        void this.saveChannelsRecord();
        // Tiles fetched without genres are no longer fresh: the visible ones refetch with Fields=Genres.
        if (this.caps.categorySource === 'genres') this.loader.schedulePlan();
      })
      .catch(() => undefined)
      .finally(() => {
        this.genreProbe = null;
      });
    return this.genreProbe;
  }

  // ---- En direct rails (V15 probe) ----

  private async onNowRaw(category?: Category): Promise<Dto[]> {
    const now = this.now();
    const run = async (source: 'recommended' | 'window'): Promise<Dto[]> => {
      const req = onNow(this.kind, { userId: this.userId, now, category, source });
      if (!req) return [];
      return (await this.api.run<Items>(req)).data?.Items ?? [];
    };
    let items = await run(this.caps.onNowSource);
    if (this.caps.onNowSource === 'recommended' && onNowProbe(items, now) === 'window') {
      this.caps.onNowSource = 'window';
      void this.saveChannelsRecord();
      items = await run('window');
    }
    return items;
  }

  // Programmes airing now (rails), as server DTOs carrying their server id.
  async onNow(category?: Category): Promise<Dto[]> {
    const now = this.now();
    const items = (await this.onNowRaw(category)).filter((it) => parseServerDate(it.StartDate) <= now && parseServerDate(it.EndDate) > now);
    for (const it of items) it.ServerId = this.serverId;
    return items;
  }

  // ---- Lenses, sort, categories ----

  setLens(lens: LensRef): void {
    if (sameLens(lens, this.lens)) return;
    this.prefsSync.set({ lens });
  }

  setSort(sort: SortMode): void {
    if (sort !== this.sort) this.prefsSync.set({ sort });
  }

  setFavFirst(on: boolean): void {
    if (on !== this.favFirst) this.prefsSync.set({ favFirst: on });
  }

  setBadges(badges: Badge[]): void {
    this.prefsSync.set({ badges });
  }

  // One category at a time; rows are intersected only when the server honours the flag (probe 1).
  async setCategory(cat: Category | null): Promise<void> {
    this.category = cat;
    this.categorySet = null;
    if (!cat || this.caps.categoryFilterOnChannels === false) return;
    const cached = this.categorySets.get(cat);
    if (cached && Date.now() - cached.at < CATEGORY_SET_TTL_MS) {
      this.categorySet = cached.ids;
      return;
    }
    const req = channelCategorySet(this.kind, { userId: this.userId, category: cat });
    if (!req) return; // "Inédits" on Jellyfin: dim only
    try {
      const r = await this.api.run<Items>(req, { deadlineMs: DEADLINE_CHANNELS_MS });
      const ids = new Set((r.data?.Items ?? []).map((it) => it.Id).filter((id): id is string => typeof id === 'string'));
      if (this.caps.categoryFilterOnChannels === 'unknown') {
        this.caps.categoryFilterOnChannels = categoryRowsProbe(ids.size, this.channels.length);
        void this.saveChannelsRecord();
      }
      this.categorySets.set(cat, { at: Date.now(), ids });
      if (this.category === cat && this.caps.categoryFilterOnChannels === true) this.categorySet = ids;
    } catch {
      // dim only
    }
  }

  // ---- Recents (MRU of 20; the device copy wins until the next sync) ----

  pushRecent(channelId: string): void {
    this.mru = pushRecent(this.mru, channelId);
    writeMru(this.scope, this.mru);
    this.prefsSync.set({ recents: this.mru });
  }

  // ---- Favourites (membership = IsFavorite, order = lt.fav) ----

  applyFavorite(id: string, favorite: boolean): void {
    if (!this.channels.some((r) => r.id === id && r.favorite !== favorite)) return;
    this.channels = this.channels.map((r) => (r.id === id ? { ...r, favorite } : r));
  }

  // Optimistic, serialized, rolled back with a toast on failure; refused while favourites or prefs
  // failed to load. Resolves to the new state (unchanged when refused or rolled back).
  toggleFavorite(id: string): Promise<boolean> {
    const row = this.channels.find((r) => r.id === id);
    if (!row) return Promise.resolve(false);
    if (!canEditFavorites(this.prefsSync.state, this.channelsState === 'ready' && !this.offline)) {
      toast('error', t('livetv.toasts.favoritesUnavailable'));
      return Promise.resolve(row.favorite);
    }
    const next = !row.favorite;
    const oldFav = this.prefs.fav;
    const oldAt = oldFav.indexOf(id);
    this.applyFavorite(id, next);
    this.prefsSync.set({ fav: next ? [...oldFav.filter((x) => x !== id), id] : oldFav.filter((x) => x !== id) });
    const result = this.favChain.then(() =>
      this.api.run(setFavorite(this.kind, { userId: this.userId, id, favorite: next })).then(
        () => {
          post({ type: 'favorite', scope: this.scope, id, favorite: next });
          toast('success', t(next ? 'livetv.toasts.favoriteAdded' : 'livetv.toasts.favoriteRemoved', { channel: row.name }));
          return next;
        },
        () => {
          this.applyFavorite(id, !next);
          // Undo only this toggle: later toggles queued behind it keep their changes.
          const fav = this.prefs.fav.filter((x) => x !== id);
          if (!next) fav.splice(oldAt < 0 ? fav.length : Math.min(oldAt, fav.length), 0, id);
          this.prefsSync.set({ fav });
          toast('error', t('livetv.manage.syncFailed'));
          return !next;
        },
      ),
    );
    this.favChain = result;
    return result;
  }

  // "Réorganiser les favoris": that order is the zap order in the Favoris lens.
  reorderFavorites(order: readonly string[]): boolean {
    if (!this.favoritesEditable) {
      toast('error', t('livetv.toasts.favoritesUnavailable'));
      return false;
    }
    this.prefsSync.set({ fav: [...order] });
    return true;
  }

  // ---- Hidden channels and client groups (Gérer les chaînes) ----

  setHidden(id: string, hidden: boolean): void {
    const cur = this.prefs.hidden;
    if (cur.includes(id) === hidden) return;
    this.prefsSync.set({ hidden: hidden ? [...cur, id] : cur.filter((x) => x !== id) });
  }

  createGroup(name: string, ids: readonly string[] = []): string {
    const id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.prefsSync.set({ groups: [...this.prefs.groups, { id, name, ids: [...new Set(ids)] }] });
    return id;
  }

  updateGroup(id: string, patch: Partial<Omit<ClientGroup, 'id'>>): void {
    this.prefsSync.set({ groups: this.prefs.groups.map((g) => (g.id === id ? { ...g, ...patch, ids: patch.ids ? [...new Set(patch.ids)] : g.ids } : g)) });
  }

  deleteGroup(id: string): void {
    this.prefsSync.set({ groups: this.prefs.groups.filter((g) => g.id !== id) });
    if (this.lens.kind === 'group' && this.lens.id === id) this.setLens({ kind: 'all' });
  }

  // ---- Server events (§7.2) ----

  onServerEvent(type: string, data: unknown): void {
    const d = (data && typeof data === 'object' ? data : {}) as Dto;
    switch (type) {
      case 'TimerCreated':
      case 'TimerCancelled':
      case 'SeriesTimerCreated':
      case 'SeriesTimerCancelled':
      case 'RecordingStarted':
      case 'RecordingEnded':
        // Overlay only: no programme refetch.
        this.dvr.refreshSoon();
        break;
      case 'UserDataChanged': {
        if (d.UserId !== undefined && plainId(d.UserId) !== plainId(this.userId)) break;
        const list = Array.isArray(d.UserDataList) ? (d.UserDataList as Dto[]) : [];
        for (const u of list) if (typeof u.ItemId === 'string' && typeof u.IsFavorite === 'boolean') this.applyFavorite(u.ItemId, u.IsFavorite);
        break;
      }
      case 'LibraryChanged':
        void this.loadChannels();
        break;
      case 'ScheduledTaskEnded':
        if (typeof d.Key === 'string' && /refreshguide/i.test(d.Key)) {
          this.loader.markAllStale(this.now());
          void this.saveChannelsRecord();
          for (const fn of this.refreshHooks) fn();
        }
        break;
    }
  }

  // A guide refresh happened (every slab is stale now); readers outside the viewport planner re-read.
  onGuideRefresh(fn: () => void): () => void {
    this.refreshHooks.add(fn);
    return () => this.refreshHooks.delete(fn);
  }

  // ---- Dev counters ----

  counters(): Record<string, unknown> {
    return {
      scope: this.scope,
      channels: this.channels.length,
      channelsState: this.channelsState,
      offline: this.offline,
      rows: this.rows.length,
      firstPaintMs: this.firstPaintMs,
      tiles: { ...this.loader.counters, memoryUnits: this.loader.cache.unitCount, memoryPrograms: this.loader.cache.programCount },
      prefs: { ...this.prefsSync.counters, load: this.prefsSync.loadState },
      overlay: { refetches: this.dvr.refetches, timers: this.dvr.timers.length, loaded: this.dvr.overlay !== null },
      caps: $state.snapshot(this.caps),
    };
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    this.loader.dispose();
    this.prefsSync.dispose();
    this.dvr.dispose();
  }
}

// ---------------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------------

const stores = new Map<string, LiveTvStore>();

// The store of a server's signed-in user; null when the server has no signed-in user.
export function storeFor(serverId: string | undefined): LiveTvStore | null {
  const s = sessionFor(serverId);
  const uid = s?.user?.id;
  // A file source has no Live TV (server-caps.ts liveTv: false). An IPTV source speaks the Emby dialect (main/iptv).
  const sk = s?.server.kind;
  if (!s || !uid || !sk || sk === 'files') return null;
  const kind = sk === 'iptv' ? 'emby' : sk;
  const scope = `${s.server.id}:${uid}`;
  let store = stores.get(scope);
  if (!store) {
    // The store outlives whichever component asks first: under its own root, or its $derived fields
    // would be owned by that component's effect and go stale once it unmounts.
    $effect.root(() => {
      store = new LiveTvStore(s.server.id, uid, kind);
      // No recording on IPTV (V1): the record actions stay hidden from the start.
      if (sk === 'iptv') store.dvr.canRecord = false;
    });
    stores.set(scope, store!);
    wire();
  }
  return store!;
}

let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  channel();
  w.events.onServerEvent((ev) => {
    for (const s of stores.values()) if (!ev.serverId || s.serverId === ev.serverId) s.onServerEvent(ev.type, ev.data);
  });
  // User switch, sign-out or server removed: that user's cache goes (memory, IndexedDB, MRU). Only
  // on a positive signal: while the app starts, a session is briefly absent or connecting, and the
  // cache must survive, so a missing session counts only once the server is gone from the saved list.
  w.session.onChange(async (state) => {
    let saved: Promise<Set<string> | null> | null = null;
    for (const [scope, s] of [...stores]) {
      const sess = state.sessions.find((x) => x.server.id === s.serverId);
      const signedOut = sess?.status === 'server-selected' && !sess.server.hasToken;
      const otherUser = sess?.status === 'signed-in' && sess.user?.id !== s.userId;
      saved ??= sess ? null : w.servers.list().then((l) => new Set(l.map((x) => x.id)), () => null);
      const removed = !sess && (await saved)?.has(s.serverId) === false;
      if (!signedOut && !otherUser && !removed) continue;
      if (stores.get(scope) !== s) continue; // an earlier change already dropped it
      s.dispose();
      stores.delete(scope);
      void guideDb().deleteScope(s.serverId, s.userId);
      try {
        localStorage.removeItem(mruKey(scope));
      } catch {
        // nothing stored
      }
    }
  });
  if (import.meta.env.DEV) {
    const target = window as unknown as { __wicabyLive?: Record<string, unknown> };
    const live = (target.__wicabyLive ??= {});
    Object.defineProperties(live, {
      requests: { get: () => ({ ...requestCounters, byPath: { ...requestCounters.byPath } }), enumerable: true, configurable: true },
      db: { get: () => ({ ...guideDb().counters, enabled: guideDb().enabled }), enumerable: true, configurable: true },
      stores: { get: () => [...stores.values()].map((s) => s.counters()), enumerable: true, configurable: true },
      firstPaintMs: { get: () => [...stores.values()].map((s) => s.firstPaintMs).find((x) => x !== null) ?? null, enumerable: true, configurable: true },
      gate: { get: () => ({ visible: liveGate.visible, focused: liveGate.focused, open: liveGate.open }), enumerable: true, configurable: true },
      // Scenario scripts drive the store directly (CDP Runtime.evaluate).
      storeFor: { value: storeFor, enumerable: false, configurable: true },
    });
  }
}

// Every channel's dvr store for a server (the facade's writes).
export function dvrFor(serverId: string | undefined): DvrStore | null {
  return storeFor(serverId)?.dvr ?? null;
}

// Tell other windows to refetch the overlay after a write made here.
export function broadcastTimers(serverId: string): void {
  post({ type: 'timers', serverId });
}
