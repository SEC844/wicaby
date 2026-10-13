// Intro range and credits start from Emby chapter markers or Jellyfin MediaSegments. Pure and
// dependency-free: tools/checks/parity-check.mjs runs it, and Android's Segments.kt follows the
// same rules (both read tools/checks/fixtures/segments.json). Recap, preview and commercial segments are
// desktop only for now (tools/checks/skip-check.mjs).
import type { MediaMarkers, SkipSegment, SkipSegmentType } from './contract';
import type { ChapterInfo } from './models';

export interface MediaSegment {
  Type: string;
  StartTicks: number;
  EndTicks: number;
}

// Server ticks are 100 ns (contract.ts TICKS_PER_MS; a value import would break the plain-Node check).
const ms = (t?: number) => (t === undefined ? undefined : t / 10_000);
// A credits marker at 0 would mark the item watched as it starts.
const credits = (t?: number) => (t !== undefined && t > 0 ? ms(t) : undefined);

// Emby markers are points: the intro ends at the first IntroEnd after IntroStart, else at the next entry.
export function embyMarkers(chapters: ChapterInfo[] = []): MediaMarkers {
  const sorted = [...chapters].sort((a, b) => a.StartPositionTicks - b.StartPositionTicks);
  const start = sorted.find((c) => c.MarkerType === 'IntroStart')?.StartPositionTicks;
  const after = start === undefined ? [] : sorted.filter((c) => c.StartPositionTicks > start);
  const end = (after.find((c) => c.MarkerType === 'IntroEnd') ?? after[0])?.StartPositionTicks;
  const creditsStartMs = credits(sorted.find((c) => c.MarkerType === 'CreditsStart')?.StartPositionTicks);
  const segments = embySegments(sorted);
  const extra = segments.length ? { segments } : {};
  return end === undefined ? { creditsStartMs, ...extra } : { introStartMs: ms(start), introEndMs: ms(end), creditsStartMs, ...extra };
}

const SEGMENT_TYPES: Record<string, SkipSegmentType> = { Recap: 'recap', Preview: 'preview', Commercial: 'commercial' };

// Emby: a <Type>Start marker up to the next <Type>End. Emby 4.8/4.9 only write intro and credits markers,
// so this stays empty until a server (or a plugin) adds RecapStart, PreviewStart or CommercialStart.
function embySegments(sorted: ChapterInfo[]): SkipSegment[] {
  const out: SkipSegment[] = [];
  for (const [name, type] of Object.entries(SEGMENT_TYPES)) {
    for (const c of sorted.filter((x) => x.MarkerType === `${name}Start`)) {
      const end = sorted.find((x) => x.MarkerType === `${name}End` && x.StartPositionTicks > c.StartPositionTicks);
      if (end) out.push({ type, startMs: c.StartPositionTicks / 10_000, endMs: end.StartPositionTicks / 10_000 });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

// Jellyfin: the earliest Intro segment, credits at the earliest Outro, every Recap, Preview and
// Commercial as a segment. Null when there is none of them.
export function jellyfinMarkers(items: MediaSegment[] = []): MediaMarkers | null {
  const first = (type: string) => items.filter((s) => s.Type === type).sort((a, b) => a.StartTicks - b.StartTicks)[0];
  const intro = first('Intro');
  const outro = first('Outro');
  const segments = items
    .filter((s) => SEGMENT_TYPES[s.Type] && s.EndTicks > s.StartTicks)
    .map((s) => ({ type: SEGMENT_TYPES[s.Type], startMs: s.StartTicks / 10_000, endMs: s.EndTicks / 10_000 }))
    .sort((a, b) => a.startMs - b.startMs);
  if (!intro && !outro && !segments.length) return null;
  const m: MediaMarkers = { introStartMs: ms(intro?.StartTicks), introEndMs: ms(intro?.EndTicks), creditsStartMs: credits(outro?.StartTicks) };
  return segments.length ? { ...m, segments } : m;
}

// The recap, preview or commercial playing at pos (until 2 s before its end, like the intro) that `want` accepts.
export function activeSegment(m: MediaMarkers | undefined, pos: number, want: (s: SkipSegment) => boolean): SkipSegment | undefined {
  return m?.segments?.find((s) => pos >= s.startMs && pos < s.endMs - 2000 && want(s));
}

// Settings > Playback key of each segment type.
export const SEGMENT_SETTING = { recap: 'skipRecap', preview: 'skipPreview', commercial: 'skipCommercial' } as const;
