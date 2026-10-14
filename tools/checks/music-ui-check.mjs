// Feishin-inspired library UI (music-feishin-navidrome spec §4.C), no Electron: the release type (C4) and the album
// jump (C9) against fixtures/music/ui-vectors.json (:core MusicUiTest.kt runs its release cases on Android), the
// row multi-select (C3), the quality badge (C6), the new music shortcuts (C9) and the design rule that the cover's
// dominant colour is never a text, fill or accent colour.
// Usage: node tools/checks/music-ui-check.mjs
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { albumJump, audioBadge, releaseType, selectIds } from '../../apps/desktop/src/shared/music-ui.ts';

const root = path.resolve(import.meta.dirname, '../..');
const V = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'music', 'ui-vectors.json'), 'utf8'));
let n = 0;

for (const c of V.release) assert.equal(releaseType(c.tracks, c.ms, c.artist), c.expect, `release: ${c.name}`), n++;
for (const c of V.albumJump) assert.equal(albumJump(c.albums, c.index, c.dir), c.expect, `albumJump: ${c.name}`), n++;

// ---- C3 multi-select ----
const order = ['a', 'b', 'c', 'd', 'e'];
assert.deepEqual(selectIds([], order, 'c', null, false), ['c']);
assert.deepEqual(selectIds(['c'], order, 'a', 'c', false), ['a', 'c'], 'Ctrl-click adds, in list order');
assert.deepEqual(selectIds(['a', 'c'], order, 'c', 'c', false), ['a'], 'Ctrl-click again removes');
assert.deepEqual(selectIds(['a'], order, 'd', 'b', true), ['b', 'c', 'd'], 'Shift-click: the range from the anchor');
assert.deepEqual(selectIds([], order, 'b', 'e', true), ['b', 'c', 'd', 'e'], 'Shift-click upwards');
assert.deepEqual(selectIds([], order, 'b', null, true), ['b'], 'Shift-click with no anchor toggles');
n += 6;

// ---- C6 quality badge ----
const fr = (x) => new Intl.NumberFormat('fr-FR').format(x);
assert.equal(audioBadge({ Codec: 'flac', BitDepth: 16, SampleRate: 44100, BitRate: 1411000 }, fr), 'FLAC · 16/44,1 kHz · 1 411 kbps');
assert.equal(audioBadge({ Codec: 'mp3', SampleRate: 48000, BitRate: 320000 }), 'MP3 · 48 kHz · 320 kbps');
assert.equal(audioBadge({ Codec: 'aac' }), 'AAC');
assert.equal(audioBadge(undefined), '');
n += 4;

// ---- C9 shortcuts: the new rows are bound (shortcuts-check.mjs checks conflicts and labels) and run ----
const table = readFileSync(path.join(root, 'apps/desktop/src/shared/shortcuts.ts'), 'utf8');
const bar = readFileSync(path.join(root, 'apps/desktop/src/renderer/components/music/NowPlayingBar.svelte'), 'utf8');
for (const id of ['showPlaying', 'nextAlbum', 'previousAlbum']) {
  assert.ok(table.includes(`music('${id}', ['`), `music.${id} bound`);
  assert.ok(bar.includes(`case 'music.${id}':`), `music.${id} handled by the bar`);
  n += 2;
}

// ---- Design: the dominant colour (--tint) only ever paints backgrounds ----
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));
for (const f of walk(path.join(root, 'apps/desktop/src/renderer')).filter((f) => f.endsWith('.svelte'))) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('var(--tint)')) continue;
    assert.ok(!/(^|[\s;{])(color|fill|stroke|--accent|border-color|outline-color)\s*:/.test(line), `${path.relative(root, f)}: --tint used outside a background: ${line.trim()}`);
    n++;
  }
}

console.log(`music-ui-check: ${n} checks OK`);
