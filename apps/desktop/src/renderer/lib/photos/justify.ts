// Photos (spec PH-01, §0): our own justified rows, a textbook greedy row fill. No Immich or Flickr code.
// Kotlin twin: core photos/Justify.kt (same fixtures).
import type { Bucket } from "./timeline";

export interface Row {
  top: number;
  height: number;
  items: { index: number; x: number; w: number }[];
}

export interface Section {
  key: string;
  top: number;
  height: number;
  // Row tops count from below the section header.
  rows: Row[];
}

// Fills a row at targetH until it is as wide as `width`, then scales it down to fit, unless dropping its last item
// gives a height closer to targetH (at most maxScale × targetH). A panorama wider than 3:1 gets a row of its own
// (at most maxScale × targetH high). A row cut short, the last one or one before a panorama, keeps targetH,
// left-aligned. Indexes start at `first`; a bad aspect counts as 1.
export function justify(aspects: number[], width: number, targetH: number, gap: number, maxScale = 1.6, first = 0): Row[] {
  const rows: Row[] = [];
  if (!(width > 0 && targetH > 0)) return rows;
  const ar = (i: number) => (aspects[i] > 0 && Number.isFinite(aspects[i]) ? aspects[i] : 1);
  const fit = (row: number[]) => {
    let sum = 0;
    for (const i of row) sum += ar(i);
    return (width - gap * (row.length - 1)) / sum;
  };
  let top = 0;
  const emit = (row: number[], h: number) => {
    let x = 0;
    const items = row.map((i) => {
      const w = ar(i) * h;
      const it = { index: i + first, x, w };
      x += w + gap;
      return it;
    });
    rows.push({ top, height: h, items });
    top += h + gap;
  };
  let row: number[] = [];
  for (let i = 0; i < aspects.length; i++) {
    if (ar(i) > 3) {
      if (row.length) emit(row, Math.min(fit(row), targetH));
      row = [];
      emit([i], Math.min(width / ar(i), targetH * maxScale));
      continue;
    }
    row.push(i);
    const h = fit(row);
    if (h > targetH) continue;
    if (row.length > 1) {
      const without = row.slice(0, -1);
      const h2 = fit(without);
      if (h2 <= targetH * maxScale && h2 / targetH < targetH / h) {
        emit(without, h2);
        row = [i];
        if (fit(row) <= targetH) {
          emit(row, fit(row));
          row = [];
        }
        continue;
      }
    }
    emit(row, h);
    row = [];
  }
  if (row.length) emit(row, Math.min(targetH, fit(row)));
  return rows;
}

// The timeline: per bucket a header, then its rows; section tops feed the date scrubber.
export function layoutTimeline(buckets: Bucket[], aspects: number[], width: number, targetH: number, gap: number, headerH: number, maxScale = 1.6): Section[] {
  let top = 0;
  return buckets.map((b) => {
    const rows = justify(aspects.slice(b.firstIndex, b.firstIndex + b.count), width, targetH, gap, maxScale, b.firstIndex);
    const last = rows[rows.length - 1];
    const height = headerH + (last ? last.top + last.height : 0);
    const s = { key: b.key, top, height, rows };
    top += height + gap;
    return s;
  });
}
