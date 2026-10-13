// Photos (spec PH-02): the timeline grid's geometry. Months stack with a header; at the larger densities each day
// group opens with a label. Rows come from layoutTimeline (justify.ts), the shared, vector-pinned layout.
import { layoutTimeline } from './justify';
import { buckets, type Bucket } from './timeline';

export interface GridRow {
  // Grid coordinates (px from the grid's top).
  y: number;
  h: number;
  month: number;
  items: { index: number; x: number; w: number }[];
}

export interface Month {
  key: string;
  top: number;
  height: number;
  // Day labels, grid coordinates (none at the densest size).
  days: { key: string; y: number }[];
}

export interface GridLayout {
  months: Month[];
  rows: GridRow[];
  height: number;
  // Asset index → its row.
  rowOf: Int32Array;
}

export const MONTH_H = 52;
export const DAY_H = 28;
export const MONTH_GAP = 12;

export function gridLayout(assets: { takenAt: string; aspect: number }[], width: number, targetH: number, gap: number, dayLabels: boolean): GridLayout {
  const aspects = assets.map((a) => a.aspect);
  const rowOf = new Int32Array(assets.length);
  const months: Month[] = [];
  const rows: GridRow[] = [];
  const days = dayLabels ? buckets(assets, 'day') : [];
  let d = 0;
  let top = 0;
  for (const m of buckets(assets, 'month')) {
    let groups: Bucket[] = [m];
    if (dayLabels) {
      groups = [];
      while (d < days.length && days[d].key.startsWith(m.key)) groups.push(days[d++]);
    }
    const sections = layoutTimeline(groups, aspects, width, targetH, gap, dayLabels ? DAY_H : 0);
    const month: Month = { key: m.key, top, height: 0, days: [] };
    for (const s of sections) {
      const y0 = top + MONTH_H + s.top;
      if (dayLabels) month.days.push({ key: s.key, y: y0 });
      for (const r of s.rows) {
        for (const it of r.items) rowOf[it.index] = rows.length;
        rows.push({ y: y0 + (dayLabels ? DAY_H : 0) + r.top, h: r.height, month: months.length, items: r.items });
      }
    }
    const last = sections[sections.length - 1];
    month.height = MONTH_H + (last ? last.top + last.height : 0);
    months.push(month);
    top += month.height + MONTH_GAP;
  }
  return { months, rows, height: Math.max(0, top - MONTH_GAP), rowOf };
}

// First row whose bottom reaches y (binary search on the sorted row tops).
export function rowAt(rows: GridRow[], y: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].y + rows[mid].h < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The month at grid y (the last one starting at or above it).
export function monthAt(months: Month[], y: number): number {
  let lo = 0;
  let hi = months.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (months[mid].top <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}
