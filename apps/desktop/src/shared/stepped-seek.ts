// X-04 merged and accelerated seeking (feature-specs.md §4). Pure; the Kotlin twin is
// C/player/SteppedSeek.kt and both replay tools/checks/fixtures/seek/stepped-seek.json.

// The seek commits this long after the last press (or on key-up after a hold).
export const MERGE_MS = 800;

// Hold acceleration by key-repeat count: ×1 for 1–5, ×1.5 to 15, ×3 to 30, ×6 to 60, then ×10 (the cap).
export function multiplier(repeats: number): number {
  return repeats <= 5 ? 1 : repeats <= 15 ? 1.5 : repeats <= 30 ? 3 : repeats <= 60 ? 6 : 10;
}

export interface PendingSeek {
  origin: number; // playhead when the first press came
  target: number;
  repeats: number; // 1 for a fresh press, +1 per key-repeat event
}

// One press of ±stepMs. The target stays inside [0, duration] (no upper bound while the duration is unknown).
export function press(p: PendingSeek | null, positionMs: number, durationMs: number, stepMs: number, repeat: boolean): PendingSeek {
  const repeats = repeat && p ? p.repeats + 1 : 1;
  const max = durationMs > 0 ? durationMs : Infinity;
  const target = Math.max(0, Math.min(max, (p?.target ?? positionMs) + stepMs * multiplier(repeats)));
  return { origin: p?.origin ?? positionMs, target, repeats };
}

// What the badge shows: the distance actually applied, to the nearest second.
export const appliedSeconds = (p: PendingSeek): number => Math.round((p.target - p.origin) / 1000);

// FF/REW with chapters: the next chapter start; back to the current chapter's start, or to the one
// before within 3 s of it; nothing within 500 ms of 0 or past the last chapter. Same rule as Kotlin.
export function chapterTarget(starts: readonly number[], positionMs: number, forward: boolean): number | null {
  if (forward) return starts.find((s) => s > positionMs) ?? null;
  if (positionMs < 500) return null;
  const i = starts.findLastIndex((s) => s <= positionMs);
  if (i < 0) return 0;
  return positionMs - starts[i] < 3000 ? (starts[i - 1] ?? 0) : starts[i];
}
