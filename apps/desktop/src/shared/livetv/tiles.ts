// Live TV guide data windowing (spec §2.2, §6.2, §6.3, §21.3): slab maths, the per-device tuning
// table, the device class, EPG hygiene, the row lookup (binary search) and the tile planner.
// Pure and erasable TypeScript only; C/livetv/Tiles.kt mirrors it (vectors: tiles.json).
import type { DeviceClass, PlatformTuning, ProgramLite } from './model';

// ---- Tuning (§2.2, §21.3) ----

export const TUNING: Readonly<Record<DeviceClass, PlatformTuning>> = {
  desktop: { channelPage: 500, channelPagesInFlight: 2, tileChannels: 50, tileMaxSlabs: 4, concurrency: 4, rowOverscan: 4, timeOverscanMin: 120, maxCells: 250, lruPrograms: 40_000, persistMb: 60, idleFavoritesOnly: false, idleMax: 200, artDelayMs: 0 },
  'tv-low': { channelPage: 200, channelPagesInFlight: 1, tileChannels: 25, tileMaxSlabs: 2, concurrency: 2, rowOverscan: 2, timeOverscanMin: 60, maxCells: 80, lruPrograms: 8_000, persistMb: 16, idleFavoritesOnly: true, idleMax: 50, artDelayMs: 400 },
  tv: { channelPage: 500, channelPagesInFlight: 2, tileChannels: 40, tileMaxSlabs: 3, concurrency: 3, rowOverscan: 3, timeOverscanMin: 60, maxCells: 140, lruPrograms: 16_000, persistMb: 32, idleFavoritesOnly: true, idleMax: 50, artDelayMs: 250 },
  'mobile-low': { channelPage: 200, channelPagesInFlight: 1, tileChannels: 25, tileMaxSlabs: 2, concurrency: 2, rowOverscan: 2, timeOverscanMin: 60, maxCells: 80, lruPrograms: 8_000, persistMb: 16, idleFavoritesOnly: true, idleMax: 50, artDelayMs: 400 },
  mobile: { channelPage: 200, channelPagesInFlight: 2, tileChannels: 25, tileMaxSlabs: 2, concurrency: 3, rowOverscan: 3, timeOverscanMin: 60, maxCells: 100, lruPrograms: 12_000, persistMb: 24, idleFavoritesOnly: true, idleMax: 50, artDelayMs: 0 },
};

export interface DeviceFacts {
  platform: 'desktop' | 'tv' | 'mobile';
  is64Bit?: boolean;
  lowRam?: boolean; // ActivityManager.isLowRamDevice()
  totalMemBytes?: number;
  memoryClassMb?: number;
  override?: DeviceClass | null; // debug setting
}

export const LOW_TOTAL_MEM = 2.2 * 1024 ** 3;
export const LOW_MEMORY_CLASS_MB = 192;

// §21.3: a 32-bit process, a low-RAM device, ≤ 2.2 GiB or a memoryClass ≤ 192 MB is "-low".
export function deviceClass(f: DeviceFacts): DeviceClass {
  if (f.override) return f.override;
  if (f.platform === 'desktop') return 'desktop';
  const low = f.is64Bit === false || f.lowRam === true || (f.totalMemBytes !== undefined && f.totalMemBytes <= LOW_TOTAL_MEM) || (f.memoryClassMb !== undefined && f.memoryClassMb <= LOW_MEMORY_CLASS_MB);
  if (f.platform === 'tv') return low ? 'tv-low' : 'tv';
  return low ? 'mobile-low' : 'mobile';
}

// ---- Slabs: 3 h aligned to UTC (fetch unit only; days and dayparts are local) ----

export const SLAB_MS = 10_800_000;
export const slabOf = (t: number): number => Math.floor(t / SLAB_MS);
export const slabStart = (k: number): number => k * SLAB_MS;
export const slabEnd = (k: number): number => (k + 1) * SLAB_MS;

// Slabs intersecting [from, to).
export function slabRange(from: number, to: number): number[] {
  if (!(to > from)) return [];
  const out: number[] = [];
  for (let k = slabOf(from); k <= slabOf(to - 1); k++) out.push(k);
  return out;
}

export const coverageKey = (channelId: string, slab: number): string => `${channelId}|${slab}`;

// ---- EPG hygiene (§4.4), on ingest ----
// De-duplicate by id (the later occurrence wins, so a fresher answer replaces the cache and a
// programme spanning two slabs merges), drop end <= start, sort by start (then longer first, then
// id), clip overlaps (prev.end = min(prev.end, next.start)) and drop what clipping emptied.
export function cleanPrograms(list: readonly ProgramLite[]): ProgramLite[] {
  const byId = new Map<string, ProgramLite>();
  for (const p of list) {
    if (byId.has(p.id)) byId.delete(p.id);
    byId.set(p.id, p);
  }
  const sorted = [...byId.values()].filter((p) => p.end > p.start).sort((a, b) => a.start - b.start || b.end - a.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: ProgramLite[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const next = sorted[i + 1];
    const end = next && next.start < p.end ? next.start : p.end;
    if (end <= p.start) continue;
    out.push(end === p.end ? p : { ...p, end });
  }
  return out;
}

export function mergePrograms(cached: readonly ProgramLite[], incoming: readonly ProgramLite[]): ProgramLite[] {
  return cleanPrograms([...cached, ...incoming]);
}

// ---- Row lookup on a clean (start-sorted, non-overlapping) list ----

// First index whose end > t (list.length when none).
export function firstEndingAfter(list: readonly ProgramLite[], t: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].end > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// Programmes intersecting [from, to): binary search, then walk while start < to.
export function programsInWindow(list: readonly ProgramLite[], from: number, to: number): ProgramLite[] {
  const out: ProgramLite[] = [];
  for (let i = firstEndingAfter(list, from); i < list.length && list[i].start < to; i++) out.push(list[i]);
  return out;
}

export function programAt(list: readonly ProgramLite[], t: number): ProgramLite | null {
  const i = firstEndingAfter(list, t);
  return i < list.length && list[i].start <= t ? list[i] : null;
}

// ---- Tile planner (§6.3) ----

export interface PlanInput {
  rows: readonly string[]; // channel ids in lens order
  firstRow: number; // visible rows, inclusive
  lastRow: number;
  from: number; // visible time span [from, to)
  to: number;
  dir: -1 | 0 | 1; // horizontal scroll direction
  covered: Iterable<string>; // coverage keys (fresh), plus queued or in-flight keys
  tuning: PlatformTuning;
  idle?: boolean; // P3 runs only when idle
  now?: number;
  idleIds?: readonly string[]; // favourites first (then the first rows on desktop), see idleSet
}

export interface TileRequest {
  priority: 0 | 1 | 2 | 3;
  channelIds: string[];
  slabs: number[]; // contiguous
  from: number; // MinEndDate = first slab start
  to: number; // MaxStartDate = last slab end
}

// The P3 idle prefetch set (§2.2): favourites, then (desktop) the first rows of the lens.
export function idleSet(favorites: readonly string[], lensRows: readonly string[], tuning: PlatformTuning): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (out.length < tuning.idleMax && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  favorites.forEach(add);
  if (!tuning.idleFavoritesOnly) lensRows.forEach(add);
  return out;
}

// Visible rows plus overscan, slabs plus overscan: the window a queued request must still touch.
export function planWindow(input: Pick<PlanInput, 'rows' | 'firstRow' | 'lastRow' | 'from' | 'to' | 'tuning'>): { rowFrom: number; rowTo: number; slabFrom: number; slabTo: number } {
  const t = input.tuning;
  const ov = t.timeOverscanMin * 60_000;
  const slabs = slabRange(input.from - ov, input.to + ov);
  return {
    rowFrom: Math.max(0, input.firstRow - t.rowOverscan),
    rowTo: Math.min(input.rows.length - 1, input.lastRow + t.rowOverscan + t.tileChannels),
    slabFrom: (slabs[0] ?? slabOf(input.from)) - 1,
    slabTo: (slabs[slabs.length - 1] ?? slabOf(input.to)) + 1,
  };
}

export function planTiles(input: PlanInput): TileRequest[] {
  const t = input.tuning;
  const rows = input.rows;
  const last = rows.length - 1;
  const first = Math.max(0, Math.min(input.firstRow, last));
  const lastVis = Math.max(first, Math.min(input.lastRow, last));
  if (last < 0 || !(input.to > input.from)) return [];
  const taken = new Set<string>(input.covered);
  const ov = t.timeOverscanMin * 60_000;
  const visSlabs = slabRange(input.from, input.to);
  const ovSlabs = slabRange(input.from - ov, input.to + ov).filter((k) => !visSlabs.includes(k));
  const allSlabs = slabRange(input.from - ov, input.to + ov);
  const range = (a: number, b: number): number[] => {
    const out: number[] = [];
    for (let i = Math.max(0, a); i <= Math.min(last, b); i++) out.push(i);
    return out;
  };
  const visRows = range(first, lastVis);
  const ovRows = [...range(first - t.rowOverscan, first - 1), ...range(lastVis + 1, lastVis + t.rowOverscan)];
  const aheadRows = range(lastVis + t.rowOverscan + 1, lastVis + t.rowOverscan + t.tileChannels);
  const aheadSlab = input.dir > 0 ? allSlabs[allSlabs.length - 1] + 1 : input.dir < 0 ? allSlabs[0] - 1 : null;

  const tiers: [number[], number[]][][] = [
    [[visRows, visSlabs]],
    [
      [visRows, ovSlabs],
      [ovRows, visSlabs],
    ],
    [
      [visRows, aheadSlab === null ? [] : [aheadSlab]],
      [aheadRows, visSlabs],
    ],
  ];
  const out: TileRequest[] = [];
  tiers.forEach((parts, priority) => {
    const want = new Map<string, Set<number>>(); // channel → slabs, insertion = lens order
    const order: number[] = [];
    for (const [rowIdx, slabs] of parts) {
      for (const r of rowIdx) {
        const id = rows[r];
        for (const k of slabs) {
          const key = coverageKey(id, k);
          if (taken.has(key)) continue;
          taken.add(key);
          let s = want.get(id);
          if (!s) {
            s = new Set();
            want.set(id, s);
            order.push(r);
          }
          s.add(k);
        }
      }
    }
    order.sort((a, b) => a - b);
    out.push(...batch(order.map((r) => [rows[r], want.get(rows[r]) as Set<number>]), t, priority as 0 | 1 | 2));
  });
  if (input.idle && input.now !== undefined && input.idleIds?.length) {
    const k = slabOf(input.now);
    const items: [string, Set<number>][] = [];
    for (const id of input.idleIds) {
      const key = coverageKey(id, k);
      if (taken.has(key)) continue;
      taken.add(key);
      items.push([id, new Set([k])]);
    }
    out.push(...batch(items, t, 3));
  }
  return out;
}

// Contiguous runs per channel (≤ tileMaxSlabs), then channels sharing a run grouped in order
// into requests of ≤ tileChannels.
function batch(items: [string, Set<number>][], t: PlatformTuning, priority: 0 | 1 | 2 | 3): TileRequest[] {
  const buckets = new Map<string, { slabs: number[]; ids: string[] }>();
  for (const [id, set] of items) {
    const slabs = [...set].sort((a, b) => a - b);
    let run: number[] = [];
    const flush = (): void => {
      if (!run.length) return;
      const key = `${run[0]}-${run[run.length - 1]}`;
      const b = buckets.get(key);
      if (b) b.ids.push(id);
      else buckets.set(key, { slabs: run, ids: [id] });
      run = [];
    };
    for (const k of slabs) {
      if (run.length && (k !== run[run.length - 1] + 1 || run.length >= t.tileMaxSlabs)) flush();
      run.push(k);
    }
    flush();
  }
  const out: TileRequest[] = [];
  for (const { slabs, ids } of buckets.values()) {
    for (let i = 0; i < ids.length; i += t.tileChannels) {
      out.push({ priority, channelIds: ids.slice(i, i + t.tileChannels), slabs, from: slabStart(slabs[0]), to: slabEnd(slabs[slabs.length - 1]) });
    }
  }
  return out;
}

// Queued (unsent) requests whose rows or slabs all left the window plus overscan are dropped.
// P3 idle requests are never dropped by a viewport change.
export function dropStale(queued: readonly TileRequest[], input: Pick<PlanInput, 'rows' | 'firstRow' | 'lastRow' | 'from' | 'to' | 'tuning'>): { keep: TileRequest[]; dropped: TileRequest[] } {
  const w = planWindow(input);
  const index = new Map(input.rows.map((id, i) => [id, i] as const));
  const keep: TileRequest[] = [];
  const dropped: TileRequest[] = [];
  for (const q of queued) {
    if (q.priority === 3) {
      keep.push(q);
      continue;
    }
    const rowIn = q.channelIds.some((id) => {
      const i = index.get(id);
      return i !== undefined && i >= w.rowFrom && i <= w.rowTo;
    });
    const slabIn = q.slabs.some((k) => k >= w.slabFrom && k <= w.slabTo);
    (rowIn && slabIn ? keep : dropped).push(q);
  }
  return { keep, dropped };
}

// What an answer covers: every requested (channel, slab) pair, even when it held nothing for a
// channel (so a channel without EPG never loops), plus the answer grouped and cleaned per channel.
export function ingestTile(req: TileRequest, programs: readonly ProgramLite[]): { coverage: string[]; byChannel: Map<string, ProgramLite[]> } {
  const coverage: string[] = [];
  for (const id of req.channelIds) for (const k of req.slabs) coverage.push(coverageKey(id, k));
  const wanted = new Set(req.channelIds);
  const grouped = new Map<string, ProgramLite[]>();
  for (const id of req.channelIds) grouped.set(id, []);
  for (const p of programs) if (wanted.has(p.channelId)) (grouped.get(p.channelId) as ProgramLite[]).push(p);
  const byChannel = new Map<string, ProgramLite[]>();
  for (const [id, list] of grouped) byChannel.set(id, cleanPrograms(list));
  return { coverage, byChannel };
}
