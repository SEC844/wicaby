// Live TV programme cache and tile loader (spec §6.3, §7.1, §7.2, §16.3, §21.2 F9).
//
// - GuideCache: the memory layer. Programmes are stored per (channel, slab) unit, with a merged,
//   start-sorted list per channel for the binary-search row lookup. LRU over whole units, capped by
//   the platform tuning (desktop 40,000 programmes); the units around the viewport are never evicted.
// - GuideDb: the IndexedDB layer `wicaby-livetv` (stores `channels` and `slabs`), shared by the main
//   and OSD windows (same app:// origin, same session). Writes are batched in idle time, at most 200
//   rows per transaction; any failure (quota, private profile) turns it off: memory only, never fatal.
// - TileLoader: the planner queue. Viewport → planTiles (P0 visible … P3 idle) → IndexedDB first →
//   network tiles with per-pair de-duplication, the platform concurrency, dropping of queued tiles
//   that left the window, one retry after 2 s on a connection error or 5xx (never on a timeout),
//   a row-level "Réessayer" state after that, and a generation counter for server or user changes.
//
// Plain erasable TypeScript, no Svelte and no bridge import: the store injects the network fetcher,
// so a Node harness can drive it against the mock.
import { normalizeProgram } from '../../../shared/livetv/model';
import type { LiveCaps, PlatformTuning, ProgramLite, ServerKind } from '../../../shared/livetv/model';
import { cleanPrograms, coverageKey, dropStale, firstEndingAfter, ingestTile, planTiles, planWindow, programAt, programsInWindow, slabEnd, slabOf, slabRange, slabStart } from '../../../shared/livetv/tiles';
import type { PlanInput, TileRequest } from '../../../shared/livetv/tiles';

export const FRESH_AIRING_MS = 20 * 60_000; // the slab airing now revalidates after 20 min
export const FRESH_OTHER_MS = 6 * 3_600_000; // other slabs after 6 h
export const PURGE_ENDED_MS = 6 * 3_600_000; // startup purge: slabs that ended more than 6 h ago
export const RETRY_DELAY_MS = 2_000;
export const IDB_NAME = 'wicaby-livetv';
export const IDB_VERSION = 1;
export const IDB_BATCH = 200;
export const IDB_MAX_PROGRAMS = 200_000; // §2.2 desktop: 200,000 programmes (≈ 60 MB)
export const CHANNEL_CHANNEL = 'wicaby-livetv'; // BroadcastChannel name

// ---------------------------------------------------------------------------------------------------
// Memory layer
// ---------------------------------------------------------------------------------------------------

export interface Unit {
  channelId: string;
  slab: number;
  programs: ProgramLite[]; // programmes intersecting the slab, clean
  fetchedAt: number;
  genres: boolean; // fetched with Fields=Genres (category bits from genres)
  lastUsed: number;
}

export interface Freshness {
  now: number;
  staleBefore: number; // a guide refresh marks everything fetched before it stale
  needGenres: boolean;
}

export function unitFresh(u: Unit, f: Freshness): boolean {
  if (u.fetchedAt < f.staleBefore) return false;
  if (f.needGenres && !u.genres) return false;
  const airing = slabStart(u.slab) <= f.now && f.now < slabEnd(u.slab);
  return f.now - u.fetchedAt < (airing ? FRESH_AIRING_MS : FRESH_OTHER_MS);
}

// Programmes of one channel's list that intersect a slab.
function slice(list: readonly ProgramLite[], slab: number): ProgramLite[] {
  return programsInWindow(list, slabStart(slab), slabEnd(slab));
}

export class GuideCache {
  private units = new Map<string, Unit>();
  private slabsOf = new Map<string, Set<number>>();
  private merged = new Map<string, ProgramLite[]>();
  programCount = 0;

  get unitCount(): number {
    return this.units.size;
  }

  unit(channelId: string, slab: number): Unit | undefined {
    return this.units.get(coverageKey(channelId, slab));
  }

  has(channelId: string, slab: number): boolean {
    return this.units.has(coverageKey(channelId, slab));
  }

  put(u: Unit): void {
    const key = coverageKey(u.channelId, u.slab);
    const prev = this.units.get(key);
    if (prev) this.programCount -= prev.programs.length;
    this.units.set(key, u);
    this.programCount += u.programs.length;
    let s = this.slabsOf.get(u.channelId);
    if (!s) this.slabsOf.set(u.channelId, (s = new Set()));
    s.add(u.slab);
    this.merged.delete(u.channelId);
  }

  // A fetched channel list (clean, for the requested slabs) split into units.
  putChannel(channelId: string, slabs: readonly number[], list: readonly ProgramLite[], fetchedAt: number, genres: boolean): Unit[] {
    const out: Unit[] = [];
    for (const k of slabs) {
      const u: Unit = { channelId, slab: k, programs: slice(list, k), fetchedAt, genres, lastUsed: fetchedAt };
      this.put(u);
      out.push(u);
    }
    return out;
  }

  delete(channelId: string, slab: number): boolean {
    const key = coverageKey(channelId, slab);
    const u = this.units.get(key);
    if (!u) return false;
    this.units.delete(key);
    this.programCount -= u.programs.length;
    this.slabsOf.get(channelId)?.delete(slab);
    this.merged.delete(channelId);
    return true;
  }

  clear(): void {
    this.units.clear();
    this.slabsOf.clear();
    this.merged.clear();
    this.programCount = 0;
  }

  // The channel's programmes, start-sorted and non-overlapping (binary-search ready).
  programs(channelId: string): ProgramLite[] {
    let list = this.merged.get(channelId);
    if (list) return list;
    const slabs = this.slabsOf.get(channelId);
    if (!slabs || !slabs.size) return [];
    const all: ProgramLite[] = [];
    for (const k of [...slabs].sort((a, b) => a - b)) all.push(...(this.units.get(coverageKey(channelId, k)) as Unit).programs);
    list = cleanPrograms(all);
    this.merged.set(channelId, list);
    return list;
  }

  // Every slab of [from, to) is loaded for the channel (stale data counts).
  covers(channelId: string, from: number, to: number): boolean {
    const slabs = this.slabsOf.get(channelId);
    if (!slabs) return false;
    for (const k of slabRange(from, to)) if (!slabs.has(k)) return false;
    return true;
  }

  touch(channelId: string, slab: number, at: number): void {
    const u = this.units.get(coverageKey(channelId, slab));
    if (u) u.lastUsed = at;
  }

  // LRU: evict whole units by lastUsed until under `max` (to 90 % of it), never a pinned key.
  evict(max: number, pinned: ReadonlySet<string>): number {
    if (this.programCount <= max) return 0;
    const target = Math.floor(max * 0.9);
    const order = [...this.units.entries()].filter(([k]) => !pinned.has(k)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let n = 0;
    for (const [, u] of order) {
      if (this.programCount <= target) break;
      this.delete(u.channelId, u.slab);
      n++;
    }
    return n;
  }
}

// ---------------------------------------------------------------------------------------------------
// IndexedDB layer
// ---------------------------------------------------------------------------------------------------

interface SlabRecord {
  s: string; // server id
  u: string; // user id
  c: string; // channel id
  k: number; // slab
  p: ProgramLite[];
  f: number; // fetchedAt
  g: boolean; // genres
  lu: number; // lastUsed
}

export interface ChannelsRecord<R = unknown, C = unknown, P = unknown> {
  s: string;
  u: string;
  rows: R[];
  fetchedAt: number;
  caps?: C;
  staleBefore?: number;
  guideEnd?: number;
  prefs?: P; // the last DisplayPreferences read, shown while the next one is on its way
}

const reqP = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
  });

type IdleFn = (cb: () => void) => void;
const idle: IdleFn = (cb) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(cb, { timeout: 2000 });
  else setTimeout(cb, 50);
};

export interface DbCounters {
  reads: number;
  hits: number;
  writes: number;
  purged: number;
  failures: number;
  diskUnits: number; // units on disk (every scope), recounted after each write, purge or scope delete
}

export class GuideDb {
  private db: Promise<IDBDatabase | null>;
  private pending: SlabRecord[] = [];
  private flushing = false;
  private disabled = false;
  readonly counters: DbCounters = { reads: 0, hits: 0, writes: 0, purged: 0, failures: 0, diskUnits: 0 };
  onWritten: ((scope: string, keys: string[]) => void) | null = null;

  constructor(factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB) {
    this.db = factory ? this.open(factory) : Promise.resolve(null);
    void this.recount();
  }

  get enabled(): boolean {
    return !this.disabled;
  }

  private open(factory: IDBFactory): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      let r: IDBOpenDBRequest;
      try {
        r = factory.open(IDB_NAME, IDB_VERSION);
      } catch {
        this.fail();
        resolve(null);
        return;
      }
      // A schema change bumps IDB_VERSION and drops the stores.
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
        db.createObjectStore('channels', { keyPath: ['s', 'u'] });
        const slabs = db.createObjectStore('slabs', { keyPath: ['s', 'u', 'c', 'k'] });
        slabs.createIndex('lastUsed', 'lu');
        slabs.createIndex('slab', 'k');
        slabs.createIndex('scope', ['s', 'u']);
      };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      r.onerror = () => {
        this.fail();
        resolve(null);
      };
      r.onblocked = () => undefined;
    });
  }

  private fail(): void {
    this.disabled = true;
    this.counters.failures++;
    this.pending = [];
  }

  private async store(name: 'channels' | 'slabs', mode: IDBTransactionMode): Promise<{ tx: IDBTransaction; os: IDBObjectStore } | null> {
    if (this.disabled) return null;
    const db = await this.db;
    if (!db || this.disabled) return null;
    try {
      const tx = db.transaction(name, mode);
      return { tx, os: tx.objectStore(name) };
    } catch {
      this.fail();
      return null;
    }
  }

  async getChannels<R, C, P = unknown>(s: string, u: string): Promise<ChannelsRecord<R, C, P> | null> {
    const st = await this.store('channels', 'readonly');
    if (!st) return null;
    try {
      return ((await reqP(st.os.get([s, u]))) as ChannelsRecord<R, C, P> | undefined) ?? null;
    } catch {
      this.fail();
      return null;
    }
  }

  async putChannels<R, C, P>(rec: ChannelsRecord<R, C, P>): Promise<void> {
    const st = await this.store('channels', 'readwrite');
    if (!st) return;
    try {
      st.os.put(rec);
      await txDone(st.tx);
    } catch {
      this.fail();
    }
  }

  // Units for the given (channel, slab) pairs; missing pairs are simply absent.
  async getUnits(s: string, u: string, pairs: readonly [string, number][]): Promise<Unit[]> {
    if (!pairs.length) return [];
    const st = await this.store('slabs', 'readonly');
    if (!st) return [];
    this.counters.reads += pairs.length;
    try {
      const recs = await Promise.all(pairs.map(([c, k]) => reqP(st.os.get([s, u, c, k])) as Promise<SlabRecord | undefined>));
      const out: Unit[] = [];
      for (const r of recs) if (r) out.push({ channelId: r.c, slab: r.k, programs: r.p, fetchedAt: r.f, genres: r.g, lastUsed: r.lu });
      this.counters.hits += out.length;
      return out;
    } catch {
      this.fail();
      return [];
    }
  }

  // Queued and written in idle time, at most IDB_BATCH rows per transaction.
  queueUnits(s: string, u: string, units: readonly Unit[]): void {
    if (this.disabled || !units.length) return;
    for (const x of units) this.pending.push({ s, u, c: x.channelId, k: x.slab, p: x.programs, f: x.fetchedAt, g: x.genres, lu: x.lastUsed });
    if (!this.flushing) {
      this.flushing = true;
      idle(() => void this.flush());
    }
  }

  // Resolves when every queued unit is written (tests, the OSD window waiting for a write).
  async drain(): Promise<void> {
    while (this.pending.length || this.flushing) await new Promise((r) => setTimeout(r, 20));
  }

  private async flush(): Promise<void> {
    while (this.pending.length && !this.disabled) {
      const batch = this.pending.splice(0, IDB_BATCH);
      const st = await this.store('slabs', 'readwrite');
      if (!st) break;
      try {
        for (const r of batch) st.os.put(r);
        await txDone(st.tx);
        this.counters.writes += batch.length;
        // Another window reloads exactly these units (BroadcastChannel), now that they are readable.
        if (this.onWritten) {
          const byScope = new Map<string, string[]>();
          for (const r of batch) {
            const scope = `${r.s}:${r.u}`;
            let keys = byScope.get(scope);
            if (!keys) byScope.set(scope, (keys = []));
            keys.push(coverageKey(r.c, r.k));
          }
          for (const [scope, keys] of byScope) this.onWritten(scope, keys);
        }
      } catch {
        this.fail();
      }
      if (this.pending.length) await new Promise<void>((r) => idle(r));
    }
    this.flushing = false;
    void this.recount();
  }

  private async recount(): Promise<void> {
    const st = await this.store('slabs', 'readonly');
    if (!st) return;
    try {
      this.counters.diskUnits = await reqP(st.os.count());
    } catch {
      // a counter only
    }
  }

  // Startup: drop slabs that ended more than 6 h ago (every scope), then enforce the cap by lastUsed.
  async purge(now: number, maxPrograms = IDB_MAX_PROGRAMS): Promise<void> {
    const st = await this.store('slabs', 'readwrite');
    if (!st) return;
    try {
      const lastEnded = slabOf(now - PURGE_ENDED_MS) - 1; // slabEnd(k) <= now - 6 h
      let n = 0;
      await new Promise<void>((resolve, reject) => {
        const cur = st.os.index('slab').openCursor(IDBKeyRange.upperBound(lastEnded));
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return resolve();
          c.delete();
          n++;
          c.continue();
        };
        cur.onerror = () => reject(cur.error);
      });
      // Newest first; everything past the cap goes.
      let total = 0;
      await new Promise<void>((resolve, reject) => {
        const cur = st.os.index('lastUsed').openCursor(null, 'prev');
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return resolve();
          total += (c.value as SlabRecord).p.length;
          if (total > maxPrograms) {
            c.delete();
            n++;
          }
          c.continue();
        };
        cur.onerror = () => reject(cur.error);
      });
      await txDone(st.tx);
      this.counters.purged += n;
    } catch {
      this.fail();
    }
    void this.recount();
  }

  // User switch or sign-out: that user's records go (§7.2).
  async deleteScope(s: string, u: string): Promise<void> {
    const db = await this.db;
    if (!db || this.disabled) return;
    try {
      const tx = db.transaction(['slabs', 'channels'], 'readwrite');
      tx.objectStore('channels').delete([s, u]);
      const idx = tx.objectStore('slabs').index('scope');
      await new Promise<void>((resolve, reject) => {
        const cur = idx.openCursor(IDBKeyRange.only([s, u]));
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return resolve();
          c.delete();
          c.continue();
        };
        cur.onerror = () => reject(cur.error);
      });
      await txDone(tx);
    } catch {
      this.fail();
    }
    void this.recount();
  }
}


// ---------------------------------------------------------------------------------------------------
// Tile loader
// ---------------------------------------------------------------------------------------------------

export interface Viewport {
  rows: readonly string[]; // channel ids in lens order
  firstRow: number;
  lastRow: number;
  from: number; // visible time span
  to: number;
  dir: -1 | 0 | 1;
}

// A tile fetch: raw DTOs of /LiveTv/Programs (the loader normalises them). Throws on failure; the
// loader classifies the error through `retryable` and `isTimeout`.
export type TileFetcher = (req: TileRequest, genres: boolean) => Promise<Record<string, unknown>[]>;

interface Job {
  req: TileRequest;
  keep: boolean; // explicit demand: never dropped by a viewport change
  attempt: number;
  gen: number;
}

export interface LoaderOpts {
  serverId: string;
  userId: string;
  kind: ServerKind;
  tuning: PlatformTuning;
  fetcher: TileFetcher;
  db: GuideDb | null;
  now: () => number; // server time (clock skew applied)
  caps: () => Pick<LiveCaps, 'categorySource'>;
  retryable: (err: unknown) => boolean;
  isTimeout: (err: unknown) => boolean;
  onChange: () => void; // memory changed (the caller coalesces)
  onRaw?: (req: TileRequest, raw: readonly Record<string, unknown>[], programs: readonly ProgramLite[]) => void; // probes
  idleIds?: () => readonly string[]; // P3 idle prefetch set (§2.2)
}

export interface LoaderCounters {
  tiles: number; // network tiles completed
  dropped: number; // tiles a viewport change dropped: queued ones, and the ones a fling passed over
  deduped: number; // wanted pairs already queued or in flight
  retries: number;
  timeouts: number;
  failedPairs: number;
  idbUnits: number; // units loaded from IndexedDB
  evicted: number;
  deferredPlans: number; // plans postponed while flinging
  queued: number;
  inFlight: number;
  maxInFlight: number;
}

// A viewport moving faster than a screen per FLING_MS is flinging: planning waits until it
// settles, so slabs the scroll only passes over are never requested.
export const FLING_MS = 120;

const keyParts = (key: string): [string, number] => {
  const bar = key.lastIndexOf('|');
  return [key.slice(0, bar), Number(key.slice(bar + 1))];
};

export class TileLoader {
  readonly cache = new GuideCache();
  readonly counters: LoaderCounters = { tiles: 0, dropped: 0, deduped: 0, retries: 0, timeouts: 0, failedPairs: 0, idbUnits: 0, evicted: 0, deferredPlans: 0, queued: 0, inFlight: 0, maxInFlight: 0 };
  staleBefore = 0; // server time of the last guide refresh
  private o: LoaderOpts;
  private gen = 0;
  private viewport: Viewport | null = null;
  private lastPlan: { at: number; from: number; first: number } | null = null;
  private flingTimer: ReturnType<typeof setTimeout> | null = null;
  private flingSkipped = new Set<string>(); // pairs counted as dropped during the current fling
  private queue: Job[] = [];
  private inflight = new Set<Job>();
  private pendingPairs = new Set<string>(); // queued or in flight on the network
  private dedupedPairs = new Set<string>();
  private idbPending = new Set<string>();
  private idbChecked = new Set<string>();
  private failed = new Set<string>(); // gave up: row-level "Réessayer"
  private waiters: { keys: string[]; fresh: boolean; resolve: () => void }[] = [];
  private planQueued = false;
  private idleQueued = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(o: LoaderOpts) {
    this.o = o;
  }

  private fresh(): Freshness {
    return { now: this.o.now(), staleBefore: this.staleBefore, needGenres: this.o.caps().categorySource === 'genres' };
  }

  isFresh(channelId: string, slab: number): boolean {
    const u = this.cache.unit(channelId, slab);
    return !!u && unitFresh(u, this.fresh());
  }

  private busy(key: string): boolean {
    return this.pendingPairs.has(key) || this.idbPending.has(key);
  }

  // Fresh, on its way (network or IndexedDB) or given up: the planner leaves it alone.
  private settled(key: string, id: string, k: number, f: Freshness): boolean {
    const u = this.cache.unit(id, k);
    return (!!u && unitFresh(u, f)) || this.busy(key) || this.failed.has(key);
  }

  // ---- Reads for the UI ----

  // The channel's list when every slab of [from, to) is loaded (stale counts), else undefined
  // (the NavModel.programs contract of nav.ts).
  programs(channelId: string, from: number, to: number): ProgramLite[] | undefined {
    return this.cache.covers(channelId, from, to) ? this.cache.programs(channelId) : undefined;
  }

  window(channelId: string, from: number, to: number): ProgramLite[] {
    return programsInWindow(this.cache.programs(channelId), from, to);
  }

  at(channelId: string, t: number): ProgramLite | null {
    return programAt(this.cache.programs(channelId), t);
  }

  // The airing programme (or null) and the one after it.
  nowNext(channelId: string, t: number): [ProgramLite | null, ProgramLite | null] {
    const list = this.cache.programs(channelId);
    const i = firstEndingAfter(list, t);
    const cur = i < list.length && list[i].start <= t ? list[i] : null;
    return [cur, list[cur ? i + 1 : i] ?? null];
  }

  // A row whose tiles failed (twice, or once on a timeout) in [from, to): "Réessayer".
  rowFailed(channelId: string, from: number, to: number): boolean {
    if (!this.failed.size) return false;
    return slabRange(from, to).some((k) => this.failed.has(coverageKey(channelId, k)));
  }

  // A slab of [from, to) is on its way for the row (aria-busy).
  rowLoading(channelId: string, from: number, to: number): boolean {
    return slabRange(from, to).some((k) => this.busy(coverageKey(channelId, k)));
  }

  retryRow(channelId: string): void {
    for (const k of [...this.failed]) if (k.startsWith(`${channelId}|`)) this.failed.delete(k);
    this.counters.failedPairs = this.failed.size;
    this.schedulePlan();
  }

  // ---- Lifecycle ----

  // Answers of an older generation (server or user change, dispose) are dropped.
  reset(): void {
    this.gen++;
    this.queue = [];
    this.pendingPairs.clear();
    this.dedupedPairs.clear();
    this.idbPending.clear();
    this.idbChecked.clear();
    this.failed.clear();
    this.cache.clear();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.flingTimer) clearTimeout(this.flingTimer);
    this.flingTimer = null;
    for (const w of this.waiters.splice(0)) w.resolve();
    this.sync();
  }

  dispose(): void {
    this.reset();
    this.viewport = null;
  }

  // A guide refresh (ScheduledTaskEnded): every slab becomes stale and the visible ones revalidate.
  markAllStale(at = this.o.now()): void {
    this.staleBefore = at;
    this.failed.clear();
    this.counters.failedPairs = 0;
    this.schedulePlan();
  }

  // Another window wrote these units: reload the ones held in memory from IndexedDB (the old copy
  // stays on screen until then), and let the others be found there when needed.
  invalidate(keys: readonly string[]): void {
    const reload: [string, number][] = [];
    for (const key of keys) {
      this.idbChecked.delete(key);
      const [id, k] = keyParts(key);
      if (!this.busy(key) && this.cache.has(id, k)) reload.push([id, k]);
    }
    const db = this.o.db;
    if (!reload.length || !db) return;
    const gen = this.gen;
    for (const [id, k] of reload) this.idbChecked.add(coverageKey(id, k));
    void db.getUnits(this.o.serverId, this.o.userId, reload).then((units) => {
      if (gen !== this.gen) return;
      let n = 0;
      for (const u of units) {
        const cur = this.cache.unit(u.channelId, u.slab);
        if (!cur || cur.fetchedAt < u.fetchedAt) {
          this.cache.put(u);
          n++;
        }
      }
      if (n) this.o.onChange();
    });
  }

  // ---- Planning ----

  setViewport(v: Viewport): void {
    this.viewport = v;
    const last = this.lastPlan;
    const span = v.to - v.from;
    const rowsShown = Math.max(1, v.lastRow - v.firstRow + 1);
    const now = performance.now();
    // Speed, not distance: frames are ~16 ms apart, so project the move over FLING_MS.
    const scale = last ? FLING_MS / Math.max(1, now - last.at) : 0;
    const fling = last !== null && now - last.at < FLING_MS && (Math.abs(v.from - last.from) * scale > span || Math.abs(v.firstRow - last.first) * scale > rowsShown);
    if (fling) {
      this.counters.deferredPlans++;
      // The tiles this frame would have queued are dropped: the fling only passes over them (S2).
      const skipped = this.wanted(v, this.flingSkipped);
      for (const r of skipped) for (const id of r.channelIds) for (const k of r.slabs) this.flingSkipped.add(coverageKey(id, k));
      this.counters.dropped += skipped.length;
      if (this.flingTimer) clearTimeout(this.flingTimer);
      this.flingTimer = setTimeout(() => {
        this.flingTimer = null;
        this.schedulePlan();
      }, FLING_MS);
      this.lastPlan = { at: now, from: v.from, first: v.firstRow };
      // Queued tiles the fling left behind are dropped right away.
      this.dropLeftBehind();
      return;
    }
    this.schedulePlan();
  }

  schedulePlan(): void {
    if (this.planQueued || this.flingTimer) return;
    this.planQueued = true;
    queueMicrotask(() => {
      this.planQueued = false;
      this.plan();
    });
  }

  private dropLeftBehind(): void {
    const v = this.viewport;
    if (!v) return;
    const queued = this.queue.filter((j) => !j.keep);
    if (!queued.length) return;
    const { dropped } = dropStale(
      queued.map((j) => j.req),
      { ...v, tuning: this.o.tuning },
    );
    if (!dropped.length) return;
    const gone = new Set(dropped);
    this.queue = this.queue.filter((j) => j.keep || !gone.has(j.req));
    for (const req of dropped) for (const id of req.channelIds) for (const k of req.slabs) this.pendingPairs.delete(coverageKey(id, k));
    this.counters.dropped += dropped.length;
    this.sync();
  }

  private plan(): void {
    const v = this.viewport;
    if (!v || !v.rows.length) return;
    this.lastPlan = { at: performance.now(), from: v.from, first: v.firstRow };
    this.flingSkipped.clear();
    this.dropLeftBehind();
    this.dispatch(this.wanted(v), false);
    this.planIdle();
    this.evict();
  }

  // The tiles the viewport needs. Without `skip` (a real plan) it also counts de-duplicated pairs;
  // with it (a fling frame) those pairs count as covered.
  private wanted(v: Viewport, skip?: ReadonlySet<string>): TileRequest[] {
    const t = this.o.tuning;
    const w = planWindow({ ...v, tuning: t });
    const f = this.fresh();
    // Coverage restricted to the plan window (plus the look-ahead slab on each side).
    const covered: string[] = [];
    for (let r = w.rowFrom; r <= w.rowTo; r++) {
      const id = v.rows[r];
      for (let k = w.slabFrom - 1; k <= w.slabTo + 1; k++) {
        const key = coverageKey(id, k);
        if (skip?.has(key)) {
          covered.push(key);
          continue;
        }
        if (!this.settled(key, id, k, f)) continue;
        covered.push(key);
        if (!skip && this.pendingPairs.has(key) && r >= v.firstRow && r <= v.lastRow && !this.dedupedPairs.has(key)) {
          this.dedupedPairs.add(key);
          this.counters.deduped++;
        }
      }
    }
    return planTiles({ ...v, covered, tuning: t });
  }

  // Exact batching of ids × slabs (no overscan), relabelled with a priority.
  private exactPlan(ids: readonly string[], slabs: readonly number[], prio: 0 | 1 | 2 | 3): TileRequest[] {
    if (!ids.length || !slabs.length) return [];
    const f = this.fresh();
    const covered: string[] = [];
    for (const id of ids) {
      for (const k of slabs) {
        const key = coverageKey(id, k);
        if (this.settled(key, id, k, f)) covered.push(key);
      }
    }
    const exact: PlatformTuning = { ...this.o.tuning, rowOverscan: 0, timeOverscanMin: 0 };
    return planTiles({ rows: ids, firstRow: 0, lastRow: ids.length - 1, from: slabStart(slabs[0]), to: slabEnd(slabs[slabs.length - 1]), dir: 0, covered, tuning: exact }).map((r) => ({ ...r, priority: prio }));
  }

  // P3: in idle time, the slab covering now for the idle set (favourites, then the first rows).
  private planIdle(): void {
    if (this.idleQueued || !this.o.idleIds) return;
    this.idleQueued = true;
    idle(() => {
      this.idleQueued = false;
      if (!this.viewport) return;
      const ids = this.o.idleIds?.() ?? [];
      this.dispatch(this.exactPlan(ids, [slabOf(this.o.now())], 3), true);
    });
  }

  // Explicit demand: resolves when every pair of ids × [from, to) is loaded (stale counts) or has
  // failed. Never dropped by a viewport change. Stale pairs revalidate in the background; with
  // `revalidated`, the promise also waits for them (a guide refresh re-reading its windows).
  ensure(ids: readonly string[], from: number, to: number, priority: 0 | 1 | 2 | 3 = 0, revalidated = false): Promise<void> {
    const slabs = slabRange(from, to);
    const f = this.fresh();
    const missing = new Set<string>();
    const stale = new Set<string>();
    const keys: string[] = [];
    for (const id of ids) {
      for (const k of slabs) {
        const u = this.cache.unit(id, k);
        if (!u) {
          missing.add(id);
          keys.push(coverageKey(id, k));
        } else if (!unitFresh(u, f)) {
          stale.add(id);
          if (revalidated) keys.push(coverageKey(id, k));
        }
      }
    }
    this.dispatch(this.exactPlan([...missing], slabs, priority), true);
    this.dispatch(this.exactPlan([...stale], slabs, 2), true);
    return this.waitFor(keys, revalidated);
  }

  // present: loaded (stale counts), failed, or nothing on its way. fresh: nothing on its way any more.
  private done(key: string, fresh: boolean): boolean {
    if (this.failed.has(key) || !this.busy(key)) return true;
    if (fresh) return false;
    const [id, k] = keyParts(key);
    return this.cache.has(id, k);
  }

  private waitFor(keys: string[], fresh = false): Promise<void> {
    const open = keys.filter((k) => !this.done(k, fresh));
    if (!open.length) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ keys: open, fresh, resolve }));
  }

  private settleWaiters(): void {
    if (!this.waiters.length) return;
    this.waiters = this.waiters.filter((w) => {
      if (!w.keys.every((k) => this.done(k, w.fresh))) return true;
      w.resolve();
      return false;
    });
  }

  // IndexedDB first for pairs not checked yet this session, then the network for what is missing
  // or stale there (each request keeps its shape, minus the channels IndexedDB satisfied).
  private dispatch(reqs: readonly TileRequest[], keep: boolean): void {
    if (!reqs.length) return;
    const db = this.o.db?.enabled ? this.o.db : null;
    const lookups: [string, number][] = [];
    const deferred: TileRequest[] = [];
    for (const req of reqs) {
      let unchecked = false;
      if (db) {
        for (const id of req.channelIds) {
          for (const k of req.slabs) {
            const key = coverageKey(id, k);
            if (this.idbChecked.has(key)) continue;
            this.idbChecked.add(key);
            this.idbPending.add(key);
            lookups.push([id, k]);
            unchecked = true;
          }
        }
      }
      if (unchecked) deferred.push(req);
      else this.enqueue(req, keep);
    }
    if (lookups.length && db) {
      const gen = this.gen;
      void db.getUnits(this.o.serverId, this.o.userId, lookups).then((units) => {
        if (gen !== this.gen) return;
        for (const u of units) {
          const cur = this.cache.unit(u.channelId, u.slab);
          if (!cur || cur.fetchedAt < u.fetchedAt) this.cache.put(u);
        }
        this.counters.idbUnits += units.length;
        for (const [id, k] of lookups) this.idbPending.delete(coverageKey(id, k));
        const f = this.fresh();
        for (const req of deferred) {
          const ids = req.channelIds.filter((id) =>
            req.slabs.some((k) => {
              const key = coverageKey(id, k);
              return !this.settled(key, id, k, f);
            }),
          );
          if (ids.length) this.enqueue({ ...req, channelIds: ids }, keep);
        }
        if (units.length) this.o.onChange();
        this.settleWaiters();
        this.pump();
      });
    }
    this.pump();
  }

  private enqueue(req: TileRequest, keep: boolean): void {
    for (const id of req.channelIds) for (const k of req.slabs) this.pendingPairs.add(coverageKey(id, k));
    this.queue.push({ req, keep, attempt: 0, gen: this.gen });
    this.sync();
  }

  private sync(): void {
    this.counters.queued = this.queue.length;
    this.counters.inFlight = this.inflight.size;
    this.counters.maxInFlight = Math.max(this.counters.maxInFlight, this.inflight.size);
  }

  // Lowest priority value first, FIFO inside a priority. A tier waits while a more urgent one is in
  // flight, so the visible tiles (P0) reach the screen before any overscan or look-ahead request
  // leaves (first paint = 1 channels page + the P0 tiles); the planner may still drop the waiting ones.
  private pump(): void {
    while (this.inflight.size < this.o.tuning.concurrency && this.queue.length) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i].req.priority < this.queue[best].req.priority) best = i;
      let urgent = 4;
      for (const j of this.inflight) urgent = Math.min(urgent, j.req.priority);
      if (this.queue[best].req.priority > urgent) break;
      this.send(this.queue.splice(best, 1)[0]);
    }
    this.sync();
  }

  private send(job: Job): void {
    this.inflight.add(job);
    this.sync();
    const genres = this.o.caps().categorySource === 'genres';
    const settle = (): void => {
      this.inflight.delete(job);
      this.sync();
    };
    this.o
      .fetcher(job.req, genres)
      .then((raw) => {
        settle();
        if (job.gen !== this.gen) return;
        const programs: ProgramLite[] = [];
        for (const dto of raw) {
          const p = normalizeProgram(dto, { kind: this.o.kind, categorySource: genres ? 'genres' : this.o.caps().categorySource });
          if (p) programs.push(p);
        }
        this.o.onRaw?.(job.req, raw, programs);
        const at = this.o.now();
        const { byChannel } = ingestTile(job.req, programs);
        const written: Unit[] = [];
        for (const [id, list] of byChannel) written.push(...this.cache.putChannel(id, job.req.slabs, list, at, genres));
        for (const id of job.req.channelIds) {
          for (const k of job.req.slabs) {
            const key = coverageKey(id, k);
            this.pendingPairs.delete(key);
            this.dedupedPairs.delete(key);
            this.failed.delete(key);
          }
        }
        this.counters.tiles++;
        this.o.db?.queueUnits(this.o.serverId, this.o.userId, written);
        this.o.onChange();
      })
      .catch((err: unknown) => {
        settle();
        if (job.gen !== this.gen) return;
        const timeout = this.o.isTimeout(err);
        if (timeout) this.counters.timeouts++;
        // F9: one retry after 2 s on a connection error or a 5xx; never after a timeout.
        if (!timeout && job.attempt === 0 && this.o.retryable(err)) {
          this.counters.retries++;
          const timer = setTimeout(() => {
            this.timers.delete(timer);
            if (job.gen !== this.gen) return;
            this.queue.unshift({ ...job, attempt: 1 });
            this.pump();
          }, RETRY_DELAY_MS);
          this.timers.add(timer);
          return;
        }
        for (const id of job.req.channelIds) {
          for (const k of job.req.slabs) {
            const key = coverageKey(id, k);
            this.pendingPairs.delete(key);
            this.dedupedPairs.delete(key);
            this.failed.add(key);
          }
        }
        this.counters.failedPairs = this.failed.size;
        this.o.onChange();
      })
      .finally(() => {
        this.settleWaiters();
        this.pump();
      });
  }

  // Units around the viewport stay; the rest is evicted by lastUsed above the tuning cap.
  private evict(): void {
    const max = this.o.tuning.lruPrograms;
    if (this.cache.programCount <= max) return;
    const v = this.viewport;
    const pinned = new Set<string>();
    if (v) {
      const w = planWindow({ ...v, tuning: this.o.tuning });
      const at = Date.now();
      for (let r = w.rowFrom; r <= w.rowTo; r++) {
        for (let k = w.slabFrom; k <= w.slabTo; k++) {
          pinned.add(coverageKey(v.rows[r], k));
          this.cache.touch(v.rows[r], k, at);
        }
      }
    }
    const n = this.cache.evict(max, pinned);
    if (!n) return;
    this.counters.evicted += n;
    // Evicted pairs may come back from IndexedDB.
    this.idbChecked.clear();
  }
}
