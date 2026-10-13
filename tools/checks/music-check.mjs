// Music model (music-spec MU-01 AC1): the LRC parser and the queue operations against the shared vectors in
// fixtures/music/. The Android side runs the same files in :core (music/LrcTest.kt, music/MusicQueueTest.kt).
// Usage: node tools/checks/music-check.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { formatDuration, lyricsFromJellyfin, parseLrc } from '../../apps/desktop/src/shared/music.ts';
import { applyQueueOp, nextIndex } from '../../apps/desktop/src/shared/music-queue.ts';

const cases = (name) => JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'music', `${name}.json`), 'utf8')).cases;

const lrc = cases('lrc-cases');
for (const c of lrc) assert.deepEqual(parseLrc(c.input), c.expected, c.name);

const queue = cases('queue-vectors');
assert.ok(queue.length >= 25, 'at least 25 queue vectors');
for (const c of queue) {
  const before = structuredClone(c.state);
  const s = c.ops.reduce(applyQueueOp, c.state);
  assert.deepEqual({ ids: s.ids, index: s.index, repeat: s.repeat, unshuffled: s.unshuffled, next: nextIndex(s), nextManual: nextIndex(s, true) }, c.expect, c.name);
  // The ops never change the state they are given.
  assert.deepEqual(c.state, before, `${c.name}: state left alone`);
}

assert.equal(formatDuration(187_400), '3:07');
assert.equal(formatDuration(3_723_000), '1:02:03');
assert.equal(formatDuration(-5), '0:00');
assert.deepEqual(lyricsFromJellyfin({ Metadata: { IsSynced: true }, Lyrics: [{ Text: 'A', Start: 12_500_000 }] }), { synced: true, lines: [{ startMs: 1250, text: 'A' }] });
assert.deepEqual(lyricsFromJellyfin({ Metadata: { IsSynced: false }, Lyrics: [{ Text: 'A' }] }), { synced: false, lines: [{ text: 'A' }] });
assert.equal(lyricsFromJellyfin({ Lyrics: [] }), null);

console.log(`music-check: ${lrc.length} LRC cases and ${queue.length} queue vectors OK`);
