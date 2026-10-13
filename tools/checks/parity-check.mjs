// Desktop side of the TS/Kotlin parity fixtures (tools/checks/fixtures/{hdr,tracks,segments,servers}.json).
// The Android side runs the same files in :core's ParityFixturesTest.
// Run: node tools/checks/parity-check.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hdrChip, hdrFromStream } from '../../apps/desktop/src/shared/hdr.ts';
import { embyMarkers, jellyfinMarkers } from '../../apps/desktop/src/shared/markers.ts';
import { selectTracks } from '../../apps/desktop/src/main/playback/track-selection.ts';
import { itemKey, merge } from '../../apps/desktop/src/renderer/lib/items.ts';

const cases = (name) => JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8')).cases;

for (const c of cases('hdr')) {
  const s = { Index: 0, Type: 'Video', ...c.stream };
  const f = hdrFromStream(s);
  assert.deepEqual({ kind: f?.kind ?? null, dvProfile: f?.dvProfile ?? null, chip: hdrChip(s) }, { kind: c.kind, dvProfile: c.dvProfile, chip: c.chip }, c.name);
}

// No client-side preference: the server's defaults, validated against the streams.
const noPrefs = { mode: 'default', audioLanguage: '', subtitleLanguage: '' };
for (const c of cases('tracks')) {
  const src = c.source;
  const got = selectTracks(src.MediaStreams, { audio: src.DefaultAudioStreamIndex, subtitle: src.DefaultSubtitleStreamIndex }, noPrefs);
  // `applied` (X-05 remembered tracks) is not part of the parity fixture: no memory here.
  assert.deepEqual({ audio: got.audio, subtitle: got.subtitle }, { audio: c.audio, subtitle: c.subtitle }, c.name);
  assert.equal(got.applied, false, c.name);
}

for (const c of cases('segments')) {
  const m = (c.chapters ? embyMarkers(c.chapters) : jellyfinMarkers(c.segments)) ?? {};
  const got = { introStartMs: m.introStartMs ?? null, introEndMs: m.introEndMs ?? null, creditsStartMs: m.creditsStartMs ?? null };
  assert.deepEqual(got, { introStartMs: c.introStartMs, introEndMs: c.introEndMs, creditsStartMs: c.creditsStartMs }, c.name);
}

// TP-06: several servers merged (Android: core ServersTest).
for (const c of JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'servers.json'), 'utf8')).merge)
  assert.deepEqual(merge(c.lists, c.byDate).map(itemKey), c.expected, c.name);

console.log('parity-check: ok');
