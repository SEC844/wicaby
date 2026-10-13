// Photos (spec PH-01): timeline order and grouping. Kotlin twin: core photos/Timeline.kt (same fixtures).
export type Unit = "day" | "month" | "year";

export interface Bucket {
  key: string;
  count: number;
  firstIndex: number;
}

// "YYYY-MM-DD", "YYYY-MM" or "YYYY" of a wall-clock takenAt.
export function groupKey(takenAt: string, unit: Unit = "month"): string {
  return takenAt.slice(0, unit === "day" ? 10 : unit === "month" ? 7 : 4);
}

// The server pages by DateCreated (UTC); each loaded page is re-sorted by takenAt, newest first, so photos near
// midnight or taken in another zone fall in place. Ties by id, so every client agrees.
export function byTakenDesc(a: { id: string; takenAt: string }, b: { id: string; takenAt: string }): number {
  if (a.takenAt !== b.takenAt) return a.takenAt < b.takenAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Consecutive runs of one key, over assets already in timeline order.
export function buckets(assets: { takenAt: string }[], unit: Unit = "month"): Bucket[] {
  const out: Bucket[] = [];
  assets.forEach((a, i) => {
    const key = groupKey(a.takenAt, unit);
    const last = out[out.length - 1];
    if (last?.key === key) last.count++;
    else out.push({ key, count: 1, firstIndex: i });
  });
  return out;
}
