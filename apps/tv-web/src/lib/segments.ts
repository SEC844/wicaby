// What a "Skip" button can skip, the credits, and the resume / watched / up-next rules (Android core Segments.kt,
// the same rules as the desktop's shared/markers.ts; both follow tools/checks/fixtures/segments.json). Times in ms.
import type { MediaSegment } from '$shared/markers';
import type { ChapterInfo } from '$shared/models';

export type SegmentKind = 'Intro' | 'Recap' | 'Preview' | 'Commercial';

export interface SkipRange {
  kind: SegmentKind;
  startMs: number;
  endMs: number;
}

export interface Segments {
  credits?: number;
  // Every skippable range, the intro included, in time order.
  ranges: SkipRange[];
}

const TICKS_PER_MS = 10_000;
const OTHER_KINDS: SegmentKind[] = ['Recap', 'Preview', 'Commercial'];
// A credits marker at 0 would mark the item watched as it starts.
const creditsMs = (ticks?: number) => (ticks && ticks > 0 ? ticks / TICKS_PER_MS : undefined);
const sorted = (list: SkipRange[]) => list.filter((r) => r.endMs > r.startMs).sort((a, b) => a.startMs - b.startMs);

// Emby web hides the button 2 s before the end so a late press does not land in the episode.
export function skippableAt(s: Segments, ms: number): SkipRange | undefined {
  return s.ranges.find((r) => ms >= r.startMs && ms < r.endMs - 2000);
}

// Emby stores markers as point chapters; an intro without IntroEnd ends at the next chapter, and one with nothing
// after it is no intro. A RecapStart/PreviewStart/CommercialStart runs to its next matching End.
export function embySegments(chapters: ChapterInfo[] = []): Segments {
  const list = [...chapters].sort((a, b) => a.StartPositionTicks - b.StartPositionTicks);
  const start = list.find((c) => c.MarkerType === 'IntroStart');
  const after = start ? list.filter((c) => c.StartPositionTicks > start.StartPositionTicks) : [];
  const end = after.find((c) => c.MarkerType === 'IntroEnd') ?? after[0];
  const others: SkipRange[] = [];
  for (const kind of OTHER_KINDS) {
    for (const c of list.filter((x) => (x.MarkerType as string) === `${kind}Start`)) {
      const e = list.find((x) => (x.MarkerType as string) === `${kind}End` && x.StartPositionTicks > c.StartPositionTicks);
      if (e) others.push({ kind, startMs: c.StartPositionTicks / TICKS_PER_MS, endMs: e.StartPositionTicks / TICKS_PER_MS });
    }
  }
  const intro = start && end ? [{ kind: 'Intro' as const, startMs: start.StartPositionTicks / TICKS_PER_MS, endMs: end.StartPositionTicks / TICKS_PER_MS }] : [];
  return { credits: creditsMs(list.find((c) => c.MarkerType === 'CreditsStart')?.StartPositionTicks), ranges: sorted([...others, ...intro]) };
}

// The earliest Intro, credits at the earliest Outro; every Recap, Preview and Commercial is a range too.
export function jellyfinSegments(items: MediaSegment[] = []): Segments {
  const first = (type: string) => items.filter((m) => m.Type === type).sort((a, b) => a.StartTicks - b.StartTicks)[0];
  const intro = first('Intro');
  const ranges = items
    .filter((m) => (OTHER_KINDS as string[]).includes(m.Type))
    .map((m) => ({ kind: m.Type as SegmentKind, startMs: m.StartTicks / TICKS_PER_MS, endMs: m.EndTicks / TICKS_PER_MS }));
  if (intro) ranges.push({ kind: 'Intro', startMs: intro.StartTicks / TICKS_PER_MS, endMs: intro.EndTicks / TICKS_PER_MS });
  return { credits: creditsMs(first('Outro')?.StartTicks), ranges: sorted(ranges) };
}

// Resume and watched rules shared by Emby (5 % / 90 % defaults) and Jellyfin.
const MIN_RESUME = 0.05;
const MAX_RESUME = 0.9;

export function resumeFrom(positionMs: number, durationMs: number): number {
  if (durationMs <= 0 || positionMs <= 0) return Math.max(0, positionMs);
  const f = positionMs / durationMs;
  return f >= MIN_RESUME && f <= MAX_RESUME ? positionMs : 0;
}

// Watched at 90 % or once the credits have started, whichever comes first.
export function isWatched(positionMs: number, durationMs: number, credits?: number): boolean {
  return durationMs > 0 && (positionMs >= durationMs * MAX_RESUME || (credits !== undefined && credits > 0 && positionMs >= credits));
}

// Stopped in the credits before 90 %: the client marks the item played itself.
export function markPlayedByCredits(positionMs: number, durationMs: number, credits?: number): boolean {
  return isWatched(positionMs, durationMs, credits) && !isWatched(positionMs, durationMs);
}

// When the "next episode" card appears: at the credits, or for the last 30 s.
export function upNextAt(durationMs: number, credits?: number): number | undefined {
  if (durationMs <= 0) return undefined;
  return credits !== undefined && credits > 0 && credits < durationMs ? credits : Math.max(0, durationMs - 30_000);
}

// "Still watching?" after this many episodes started by the countdown with no input.
export const STILL_WATCHING_AFTER = 3;
