// Music wave 5 on the desktop (music-spec MU-11, MU-13), no Electron, no mpv:
//   MU-11 the equalizer's mpv `af` string (band k at +6 dB gives the expected chain, flat gives no filter at all),
//         the four presets round-trip through presetOf, malformed settings come back flat.
//   MU-13 LRCLIB lyrics (main/music/lrclib.ts): with the setting off no request is made (a fetch spy counts zero
//         calls); on, the loopback mock's /mock/lrclib stub answers with the User-Agent and query LRCLIB documents,
//         the answer and a "not found" are cached per track id for 30 days, a server error is not, and LRCLIB_BASE
//         is ignored by a packaged build or when it is not loopback. Never the real lrclib.net: the spy refuses
//         any other host.
// Usage: node tools/checks/music-wave5-check.mjs   (starts mock-emby with MOCK_MUSIC=1 on 8967, then stops it)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { build } from 'esbuild';
import { EQ_FREQS, EQ_PRESETS, eqAf, presetOf, sanitizeEq } from '../../apps/desktop/src/shared/equalizer.ts';

const root = path.resolve(import.meta.dirname, '../..');
const PORT = 8967;
let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
};

// ---- MU-11 equalizer
const flat = { bands: [...EQ_PRESETS.flat], preampDb: 0 };
ok(eqAf(flat) === '', 'flat: no filter');
EQ_FREQS.forEach((f, k) => {
  const bands = flat.bands.map((g, i) => (i === k ? 6 : g));
  ok(eqAf({ bands, preampDb: 0 }, false) === `equalizer=f=${f}:t=o:w=1:g=6`, `band ${k} +6 dB`);
  ok(eqAf({ bands, preampDb: 0 }) === `volume=volume=-6dB,equalizer=f=${f}:t=o:w=1:g=6`, `band ${k} +6 dB with clipping headroom`);
});
ok(eqAf({ bands: flat.bands, preampDb: -3 }) === 'volume=volume=-3dB', 'preamp alone');
ok(eqAf({ bands: [...EQ_PRESETS.vocal], preampDb: 0 }, true).startsWith('volume=volume=-4dB,equalizer=f=31:t=o:w=1:g=-2,'), 'vocal preset chain');
for (const p of Object.keys(EQ_PRESETS)) ok(presetOf(sanitizeEq({ bands: [...EQ_PRESETS[p]], preampDb: 0 }).bands) === p, `preset ${p} round-trips`);
ok(presetOf([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]) === 'custom', 'custom');
assert.deepEqual(sanitizeEq({ bands: [1, 2] }), flat, 'wrong length → flat');
assert.deepEqual(sanitizeEq({ bands: [99, -99, 0.26, 'x', 0, 0, 0, 0, 0, 0], preampDb: 40 }), { bands: [12, -12, 0.5, 0, 0, 0, 0, 0, 0, 0], preampDb: 12 }, 'clamped');
assert.deepEqual(sanitizeEq(undefined), flat, 'missing → flat');
passed += 3;

// ---- MU-13 LRCLIB
const out = await build({ entryPoints: [path.join(root, 'apps/desktop/src/main/music/lrclib.ts')], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error' });
const { lrclibLyrics, lrclibBase, LRCLIB, LRCLIB_TTL_MS } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

ok(lrclibBase(undefined, false) === LRCLIB && LRCLIB === 'https://lrclib.net', 'default base');
ok(lrclibBase('http://127.0.0.1:1234/mock/lrclib/', false) === 'http://127.0.0.1:1234/mock/lrclib', 'loopback override (dev)');
ok(lrclibBase('http://127.0.0.1:1234', true) === LRCLIB, 'packaged ignores the override');
ok(lrclibBase('http://example.test:80', false) === LRCLIB, 'non-loopback override ignored');

const calls = [];
const spy = (url, init) => {
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1') throw new Error(`refused non-loopback request to ${u.host}`);
  calls.push({ url: u, ua: init?.headers?.['User-Agent'] });
  return fetch(url, init);
};
const store = () => ({ value: {}, update(fn) { const r = fn(this.value); if (r) this.value = r; } });
const track = { id: 'trk-1', artist: 'Les Ondes Calmes', title: 'Écume', album: 'Marée basse', durationMs: 25_000 };
const UA = 'Wicaby/0.0.0-check (+https://github.com/WicaebethTheo/wicaby-releases)';
const base = `http://127.0.0.1:${PORT}/mock/lrclib`;

// Off: not one request, whatever is asked.
let enabled = false;
const offCache = store();
ok((await lrclibLyrics(track, { base, userAgent: UA, enabled: () => enabled, cache: offCache, fetch: spy })) === null, 'off: null');
ok(calls.length === 0 && Object.keys(offCache.value).length === 0, 'off: zero requests, nothing cached');

const mock = spawn(process.execPath, [path.join(root, 'tools/mock-server/mock-emby.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_MUSIC: '1' } });
try {
  await new Promise((resolve, reject) => {
    mock.on('exit', (code) => reject(new Error(`mock-emby exited (${code}): is port ${PORT} taken?`)));
    mock.stdout.on('data', (d) => String(d).includes(`:${PORT}`) && resolve());
  });
  enabled = true;
  const cache = store();
  let now = 1_000_000;
  const opts = { base, userAgent: UA, enabled: () => enabled, cache, fetch: spy, now: () => now };
  const l = await lrclibLyrics(track, opts);
  ok(l?.synced === true && l.lines.length >= 2 && l.lines[0].text === 'En ligne 1' && l.lines[1].startMs === 1000, 'on: synced lyrics from the stub');
  ok(calls.length === 1, 'one request');
  const q = calls[0].url.searchParams;
  ok(calls[0].url.pathname === '/mock/lrclib/api/get', 'GET /api/get');
  ok(q.get('artist_name') === track.artist && q.get('track_name') === track.title && q.get('album_name') === track.album && q.get('duration') === '25', 'query: artist, title, album, duration in s');
  ok(calls[0].ua === UA, 'User-Agent names Wicaby');
  const state = await (await fetch(`http://127.0.0.1:${PORT}/Mock/State`)).json();
  ok(state.music.lrclib.at(-1)?.ua === UA, 'the stub saw the User-Agent');

  ok((await lrclibLyrics(track, opts)) !== null && calls.length === 1, 'cached: no second request');
  now += LRCLIB_TTL_MS - 1;
  await lrclibLyrics(track, opts);
  ok(calls.length === 1, 'still cached just before 30 days');
  now += 2;
  await lrclibLyrics(track, opts);
  ok(calls.length === 2, 'asked again after 30 days');

  const unknown = { ...track, id: 'trk-404', title: 'Inconnu' };
  ok((await lrclibLyrics(unknown, opts)) === null && calls.length === 3, '404: none');
  ok(unknown.id in cache.value && cache.value[unknown.id].lyrics === null, '404 cached');
  await lrclibLyrics(unknown, opts);
  ok(calls.length === 3, '404 not asked again');

  // A server error or a dead host is not cached.
  const failing = (url) => (calls.push({ url: new URL(url) }), Promise.resolve(new Response('busy', { status: 503 })));
  const failCache = store();
  ok((await lrclibLyrics(track, { ...opts, cache: failCache, fetch: failing })) === null && !(track.id in failCache.value), '503: none, not cached');
  ok((await lrclibLyrics(track, { ...opts, base: 'http://127.0.0.1:1', cache: failCache })) === null && !(track.id in failCache.value), 'unreachable: none, not cached');

  // Turned off again: the cache is not even read for a new track, and nothing is asked.
  enabled = false;
  const before = calls.length;
  ok((await lrclibLyrics({ ...track, id: 'trk-2' }, opts)) === null && calls.length === before, 'off again: zero requests');
} finally {
  mock.kill();
}

console.log(`music-wave5-check: ${passed} checks OK`);
