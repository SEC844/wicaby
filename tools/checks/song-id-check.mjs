// "What's this song?": the Shazam signature against a reference made offline by SongRec's own Python code
// (fixtures/song-id/signature.json), and the reading of a discovery answer. The Android side runs the same
// fixture in :core (songid/ShazamSignatureTest.kt).
// Usage: node tools/checks/song-id-check.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { shazamSignature, snippetWindow, songFromShazam, songLinks } from '../../apps/desktop/src/shared/song-id.ts';

const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'song-id', 'signature.json'), 'utf8'));

// Integer math only, so every language makes the same samples: three gated triangle waves over LCG noise.
function synth(total) {
  const out = new Int16Array(total);
  const tri = (n, p, k) => Math.floor((Math.abs((n % p) * 2 - p) * k) / p) - k / 2;
  let x = 12345;
  for (let n = 0; n < total; n++) {
    const sec = Math.floor(n / 16000);
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    let s = ((x >> 16) % 2001) - 1000 + tri(n, 9 + (sec % 3), 3000);
    if (Math.floor(n / 4000) % 3 !== 0) s += tri(n, 40 + 7 * (sec % 5), 8000);
    if (Math.floor(n / 2400) % 4 !== 1) s += tri(n, 23 + 3 * (sec % 4), 6000);
    out[n] = s;
  }
  return out;
}

const sig = shazamSignature(synth(fixture.samples));
assert.equal(sig.peaks, fixture.peaks, 'peak count');
assert.equal(sig.sampleMs, 12_000);
assert.equal(sig.uri, fixture.uri, 'signature matches SongRec byte for byte');
// Silence has no peaks but is still a well-formed signature (header only).
assert.equal(shazamSignature(new Int16Array(16000)).peaks, 0);

// The cache window: 10 s back and 2 s ahead, slid inside the cached range, refused under 4 s.
assert.deepEqual(snippetWindow(60_000, [[0, 120_000]]), [50_000, 62_000]);
assert.deepEqual(snippetWindow(60_000, [[0, 30_000], [55_000, 120_000]]), [55_000, 67_000]);
assert.deepEqual(snippetWindow(60_000, [[30_000, 61_000]]), [49_000, 61_000]);
assert.deepEqual(snippetWindow(60_000, [[57_000, 62_000]]), [57_000, 62_000]);
assert.equal(snippetWindow(60_000, [[58_000, 61_000]]), null);
assert.equal(snippetWindow(60_000, [[0, 50_000]]), null);

assert.equal(songFromShazam({ matches: [] }), null);
assert.equal(songFromShazam(null), null);
const song = songFromShazam({
  matches: [{ id: '1' }],
  track: {
    title: 'Song',
    subtitle: 'Artist',
    url: 'https://www.shazam.com/track/1/song',
    images: { coverart: 'https://img/1.jpg', coverarthq: 'http://insecure/1.jpg' },
    sections: [{ type: 'SONG', metadata: [{ title: 'Album', text: 'Record' }, { title: 'Released', text: '1999' }] }],
  },
});
assert.deepEqual(song, { title: 'Song', artist: 'Artist', album: 'Record', coverUrl: 'https://img/1.jpg', shazamUrl: 'https://www.shazam.com/track/1/song' });
const links = songLinks(song);
assert.deepEqual(links.map((l) => l.id), ['shazam', 'spotify', 'youtube', 'apple']);
assert.equal(links[1].url, 'https://open.spotify.com/search/Artist%20Song');

console.log(`song-id-check: signature (${sig.peaks} peaks) matches SongRec, answer parsing OK`);
