// Recap, preview and commercial segments (apps/desktop/src/shared/markers.ts): Jellyfin MediaSegments,
// Emby <Type>Start/<Type>End markers, and the range in which one is skippable.
// Run: node tools/checks/skip-check.mjs
import assert from 'node:assert/strict';
import { activeSegment, embyMarkers, jellyfinMarkers } from '../../apps/desktop/src/shared/markers.ts';

const T = 10_000; // ticks per ms

// Jellyfin: every Recap / Preview / Commercial, sorted; Intro and Outro keep their own fields; empty ranges dropped.
const jf = jellyfinMarkers([
  { Type: 'Preview', StartTicks: 80_000 * T, EndTicks: 90_000 * T },
  { Type: 'Intro', StartTicks: 5_000 * T, EndTicks: 20_000 * T },
  { Type: 'Recap', StartTicks: 0, EndTicks: 4_000 * T },
  { Type: 'Commercial', StartTicks: 50_000 * T, EndTicks: 50_000 * T },
  { Type: 'Unknown', StartTicks: 1, EndTicks: 2 },
]);
assert.equal(jf.introEndMs, 20_000);
assert.deepEqual(jf.segments, [
  { type: 'recap', startMs: 0, endMs: 4_000 },
  { type: 'preview', startMs: 80_000, endMs: 90_000 },
]);
// Only a recap: still markers (no intro, no credits).
assert.deepEqual(jellyfinMarkers([{ Type: 'Recap', StartTicks: 0, EndTicks: 3_000 * T }]), {
  introStartMs: undefined,
  introEndMs: undefined,
  creditsStartMs: undefined,
  segments: [{ type: 'recap', startMs: 0, endMs: 3_000 }],
});
assert.equal(jellyfinMarkers([{ Type: 'Unknown', StartTicks: 0, EndTicks: 9 }]), null);
// Intro and outro only: no segments key (what the Android parity fixtures expect stays unchanged).
assert.equal('segments' in jellyfinMarkers([{ Type: 'Intro', StartTicks: 0, EndTicks: 9_000 * T }]), false);

// Emby: a CommercialStart up to the next CommercialEnd; a start with no end is ignored.
const emby = embyMarkers([
  { StartPositionTicks: 0, MarkerType: 'Chapter' },
  { StartPositionTicks: 30_000 * T, MarkerType: 'CommercialStart' },
  { StartPositionTicks: 10_000 * T, MarkerType: 'CommercialEnd' },
  { StartPositionTicks: 32_000 * T, MarkerType: 'CommercialEnd' },
  { StartPositionTicks: 70_000 * T, MarkerType: 'RecapStart' },
]);
assert.deepEqual(emby.segments, [{ type: 'commercial', startMs: 30_000, endMs: 32_000 }]);
assert.equal('segments' in embyMarkers([{ StartPositionTicks: 0, MarkerType: 'Chapter' }]), false);

// Skippable from its start until 2 s before its end, and only when `want` accepts it.
const all = () => true;
assert.equal(activeSegment(jf, 0, all)?.type, 'recap');
assert.equal(activeSegment(jf, 1_999, all)?.type, 'recap');
assert.equal(activeSegment(jf, 2_000, all), undefined);
assert.equal(activeSegment(jf, 85_000, all)?.type, 'preview');
assert.equal(activeSegment(jf, 85_000, (s) => s.type !== 'preview'), undefined);
assert.equal(activeSegment(undefined, 0, all), undefined);

console.log('skip-check: ok');
