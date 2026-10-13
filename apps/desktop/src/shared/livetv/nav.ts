// Live TV guide navigation on the data model (spec §6.9, §21.6): cells with gap fillers, the
// D-pad moves with focusT, restore by identity after a reload, the pending jump and key-repeat
// coalescing. The desktop guide (D-4) and the TV grid (TV-2, C/livetv/GuideNav.kt) call it; they
// never re-implement it. Pure and erasable TypeScript only (vectors: guide-nav.json).
import { firstEndingAfter, programsInWindow } from './tiles';
import type { ProgramLite } from './model';

export const MINUTE_MS = 60_000;
export const GAP_FILLER_MS = 10 * MINUTE_MS; // a gap over 10 min becomes a focusable filler
export const SCROLL_BACK_MS = 30 * MINUTE_MS;

export interface Cell {
  kind: 'program' | 'filler';
  channelId: string;
  start: number;
  end: number;
  programId?: string;
}

export type FocusKind = 'channel' | 'program' | 'filler' | 'loading';
export interface GuideFocus {
  kind: FocusKind;
  channelId: string;
  focusT: number; // kept by vertical moves, reset by horizontal ones
  programId?: string;
  start?: number;
  end?: number;
}

// The guide as navigation sees it. programs(id) is undefined while that row's slabs around the
// viewport are not loaded, [] when the channel has no EPG there. Gaps inside the returned list
// (and before its first programme, back to rangeStart) read as "no programme information" fillers,
// so return undefined rather than a list with unloaded holes.
export interface NavModel {
  rows: readonly string[]; // channel ids in lens order
  programs: (channelId: string) => readonly ProgramLite[] | undefined;
  rangeStart: number; // canvas: start of today (local)
  rangeEnd: number; // GuideInfo.EndDate
  left: number; // viewport time span
  right: number;
  now: number;
}

export type NavMove = 'left' | 'right' | 'up' | 'down' | 'page-up' | 'page-down' | 'first' | 'last';

export interface NavResult {
  focus: GuideFocus | null; // null when focus leaves the grid
  exit?: 'left' | 'up'; // channel column → sidebar; row 0 → day strip
  scrollLeft?: number; // new viewport left time, when the viewport must move
  rowIndex?: number; // the row to scroll into view
}

// Cells of one row inside [from, to): programmes plus fillers for gaps over 10 min. Filler bounds
// come from the neighbouring programmes (or the canvas), so they are stable while scrolling.
// A row with no EPG is one filler per window. undefined = not loaded.
export function rowCells(m: Pick<NavModel, 'programs' | 'rangeStart' | 'rangeEnd'>, channelId: string, from: number, to: number): Cell[] | undefined {
  const list = m.programs(channelId);
  if (list === undefined) return undefined;
  if (!list.length) return [{ kind: 'filler', channelId, start: from, end: to }];
  const out: Cell[] = [];
  const i0 = firstEndingAfter(list, from);
  let cursor = i0 > 0 ? list[i0 - 1].end : Math.min(m.rangeStart, list[0].start);
  for (const p of programsInWindow(list, from, to)) {
    if (p.start - cursor > GAP_FILLER_MS) out.push({ kind: 'filler', channelId, start: cursor, end: p.start });
    out.push({ kind: 'program', channelId, start: p.start, end: p.end, programId: p.id });
    cursor = Math.max(cursor, p.end);
  }
  const next = list[i0 + out.filter((c) => c.kind === 'program').length];
  const tail = next ? next.start : Math.max(m.rangeEnd, cursor);
  if (cursor < to && tail - cursor > GAP_FILLER_MS) out.push({ kind: 'filler', channelId, start: cursor, end: tail });
  return out.filter((c) => c.end > from && c.start < to);
}

const focusOf = (c: Cell, focusT: number): GuideFocus =>
  c.kind === 'program' ? { kind: 'program', channelId: c.channelId, focusT, programId: c.programId, start: c.start, end: c.end } : { kind: 'filler', channelId: c.channelId, focusT, start: c.start, end: c.end };

// Cells around t on a row, wide enough for a neighbour lookup (one viewport on each side).
// A row with no EPG is one filler over the viewport.
function cellsAround(m: NavModel, channelId: string, t: number): Cell[] | undefined {
  const list = m.programs(channelId);
  if (list === undefined) return undefined;
  if (!list.length) return [{ kind: 'filler', channelId, start: m.left, end: m.right }];
  const span = Math.max(m.right - m.left, MINUTE_MS);
  return rowCells(m, channelId, Math.min(t, m.left) - span, Math.max(t, m.right) + span);
}

// The cell airing at t, else the nearest one, else null.
function cellAt(cells: readonly Cell[], t: number): Cell | null {
  let best: Cell | null = null;
  let bestD = Infinity;
  for (const c of cells) {
    if (c.start <= t && t < c.end) return c;
    const d = t < c.start ? c.start - t : t - c.end + 1;
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

const sameCell = (c: Cell, f: GuideFocus): boolean => (f.kind === 'program' ? c.programId === f.programId : c.kind === 'filler' && c.start === f.start);

// focusT after a horizontal move: max(cell.start, viewport left + 1 min).
const focusTFor = (c: Cell, left: number): number => Math.max(c.start, left + MINUTE_MS);

function onRow(m: NavModel, row: number, focusT: number): GuideFocus {
  const id = m.rows[row];
  const cells = cellsAround(m, id, focusT);
  if (cells === undefined) return { kind: 'loading', channelId: id, focusT };
  const c = cellAt(cells, focusT);
  return c ? focusOf(c, focusT) : { kind: 'channel', channelId: id, focusT };
}

// Moves the viewport so [start, end) shows its start (or as much as fits).
function reveal(m: NavModel, c: Cell): number | undefined {
  if (c.start >= m.left && c.start < m.right) return undefined;
  if (c.start < m.left && c.end > m.left) return undefined; // already partly visible from the left edge
  return Math.max(m.rangeStart, c.start);
}

export function navMove(m: NavModel, f: GuideFocus, move: NavMove, pageRows = 1): NavResult {
  const row = m.rows.indexOf(f.channelId);
  if (row < 0) return { focus: f };
  switch (move) {
    case 'up':
    case 'down':
    case 'page-up':
    case 'page-down':
    case 'first':
    case 'last': {
      const step = move === 'up' ? -1 : move === 'down' ? 1 : move === 'page-up' ? -pageRows : move === 'page-down' ? pageRows : 0;
      if (move === 'up' && row === 0) return { focus: null, exit: 'up' };
      const target = move === 'first' ? 0 : move === 'last' ? m.rows.length - 1 : Math.max(0, Math.min(m.rows.length - 1, row + step));
      if (target === row && move !== 'first' && move !== 'last') return { focus: f };
      if (f.kind === 'channel') return { focus: { kind: 'channel', channelId: m.rows[target], focusT: f.focusT }, rowIndex: target };
      return { focus: onRow(m, target, f.focusT), rowIndex: target };
    }
    case 'right': {
      const nowInView = m.now >= m.left && m.now < m.right;
      const fromChannel = f.kind === 'channel' || f.kind === 'loading';
      const cells = cellsAround(m, f.channelId, fromChannel ? (nowInView ? m.now : m.left + MINUTE_MS) : (f.end ?? f.focusT));
      if (cells === undefined) return { focus: f };
      let next: Cell | undefined;
      if (fromChannel) {
        // The airing programme, else the first future one. When the view is away from now (another
        // day or time), the cell at the left edge instead, so the view never jumps.
        const t = nowInView ? m.now : m.left + MINUTE_MS;
        next = cells.find((c) => c.start <= t && t < c.end) ?? cells.find((c) => c.start > t);
      } else {
        const i = cells.findIndex((c) => sameCell(c, f));
        next = i >= 0 ? cells[i + 1] : cells.find((c) => c.start >= (f.end ?? f.focusT));
      }
      if (!next) return { focus: f };
      const scrollLeft = reveal(m, next);
      return { focus: focusOf(next, focusTFor(next, scrollLeft ?? m.left)), scrollLeft };
    }
    case 'left': {
      if (f.kind === 'channel') return { focus: null, exit: 'left' };
      const cells = cellsAround(m, f.channelId, f.start ?? f.focusT);
      if (cells === undefined) return { focus: { kind: 'channel', channelId: f.channelId, focusT: f.focusT } };
      const i = cells.findIndex((c) => sameCell(c, f));
      const cur = i >= 0 ? cells[i] : null;
      const prev = i > 0 ? cells[i - 1] : null;
      const curStart = cur ? cur.start : f.focusT;
      if (curStart <= m.left) {
        // First visible cell: scroll 30 min back while earlier programmes exist.
        const earlier = prev !== null || (curStart > m.rangeStart && m.left > m.rangeStart);
        if (!earlier) return { focus: { kind: 'channel', channelId: f.channelId, focusT: f.focusT } };
        const newLeft = Math.max(m.rangeStart, m.left - SCROLL_BACK_MS);
        const t = newLeft + MINUTE_MS;
        const c = cellAt(cells, t);
        return { focus: c ? focusOf(c, focusTFor(c, newLeft)) : f, scrollLeft: newLeft };
      }
      if (!prev) return { focus: { kind: 'channel', channelId: f.channelId, focusT: f.focusT } };
      const scrollLeft = prev.start < m.left ? Math.max(m.rangeStart, prev.start >= m.left - SCROLL_BACK_MS ? prev.start : m.left - SCROLL_BACK_MS) : undefined;
      return { focus: focusOf(prev, focusTFor(prev, scrollLeft ?? m.left)), scrollLeft };
    }
  }
}

// After a reload (lens, data or tiles): the same programme, else the cell at focusT on the same
// channel, else the row that now sits at the old index. The grid is never unmounted for this.
export function restoreFocus(m: NavModel, f: GuideFocus, oldRowIndex: number): GuideFocus | null {
  if (!m.rows.length) return null;
  let row = m.rows.indexOf(f.channelId);
  if (row < 0) row = Math.max(0, Math.min(m.rows.length - 1, oldRowIndex));
  const id = m.rows[row];
  if (f.kind === 'channel') return { kind: 'channel', channelId: id, focusT: f.focusT };
  if (id === f.channelId && f.programId) {
    const list = m.programs(id);
    const p = list?.find((x) => x.id === f.programId);
    if (p) return { kind: 'program', channelId: id, focusT: f.focusT, programId: p.id, start: p.start, end: p.end };
  }
  return onRow(m, row, f.focusT);
}

// ---- Pending jump (search, deep link, "Voir dans le guide") ----

export interface PendingJump {
  channelId: string;
  time: number;
  programId?: string;
}

export type JumpStep =
  | { status: 'wait' } // channels or the target row's programmes are not loaded: keep it and replay
  | { status: 'switch-lens' } // the channel is outside the lens: switch to Toutes, then replay
  | { status: 'done'; focus: GuideFocus; rowIndex: number; scrollLeft: number };

// channelsLoaded: the lineup is in. allRows: the whole lineup (to tell "outside the lens" from
// "unknown channel"); an unknown channel ends the jump on the first row.
export function resolveJump(m: NavModel, j: PendingJump, channelsLoaded: boolean, allRows: readonly string[]): JumpStep {
  if (!channelsLoaded) return { status: 'wait' };
  const row = m.rows.indexOf(j.channelId);
  if (row < 0) {
    if (allRows.includes(j.channelId)) return { status: 'switch-lens' };
    return { status: 'done', focus: { kind: 'channel', channelId: m.rows[0] ?? j.channelId, focusT: j.time }, rowIndex: 0, scrollLeft: j.time - 30 * MINUTE_MS };
  }
  const list = m.programs(j.channelId);
  if (list === undefined) return { status: 'wait' };
  const p = j.programId ? list.find((x) => x.id === j.programId) : undefined;
  const t = p ? p.start : j.time;
  const scrollLeft = Math.max(m.rangeStart, t - 30 * MINUTE_MS);
  if (p) return { status: 'done', focus: { kind: 'program', channelId: j.channelId, focusT: Math.max(p.start, scrollLeft + MINUTE_MS), programId: p.id, start: p.start, end: p.end }, rowIndex: row, scrollLeft };
  const view: NavModel = { ...m, left: scrollLeft, right: scrollLeft + (m.right - m.left) };
  return { status: 'done', focus: onRow(view, row, t), rowIndex: row, scrollLeft };
}

// ---- Key-repeat coalescing: at most one repeated move per frame ----

export interface RepeatGate {
  lastFrame: number;
}

export function repeatGateInit(): RepeatGate {
  return { lastFrame: -1 };
}

// A first press always passes; a repeat passes only on a frame that has not moved yet.
export function gateMove(g: RepeatGate, frame: number, repeat: boolean): { gate: RepeatGate; accept: boolean } {
  if (repeat && frame <= g.lastFrame) return { gate: g, accept: false };
  return { gate: { lastFrame: Math.max(g.lastFrame, frame) }, accept: true };
}
