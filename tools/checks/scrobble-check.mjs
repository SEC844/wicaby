// Self-check for the desktop's music scrobbling (ListenBrainz, Last.fm), headless with a fake fetch:
// - the rule (30 s, half or 4 min), trackInfo, the ListenBrainz body, the Last.fm signature and parameters;
// - ScrobbleService (Electron stubbed): token validation, Last.fm web auth, playing now then one listen,
//   seeks and pauses not counted, the offline queue (kept, dropped, capped, sent again), no secret in the log.
// Usage: node tools/checks/scrobble-check.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = import.meta.dirname;
const root = path.resolve(here, '..', '..', 'apps', 'desktop');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-scrobble-'));
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export const app = { isPackaged: false, isReady: () => false, getLocale: () => 'en', getVersion: () => '9.9.9' }; export const net = { fetch: (u, i) => globalThis.__fetch(u, i) };`,
    }));
  },
};
const out = path.join(tmp, 'scrobble.mjs');
await build({ entryPoints: [path.join(root, 'src/main/features/scrobble.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [electronStub] });
const clientOut = path.join(tmp, 'scrobble-client.mjs');
await build({ entryPoints: [path.join(root, 'src/main/features/scrobble-client.ts')], bundle: true, platform: 'node', format: 'esm', outfile: clientOut, logLevel: 'error' });
const { shouldScrobble, trackInfo, listenBody, lastfmSign, lastfmTrackParams } = await import(pathToFileURL(clientOut).href);

// ---- Pure helpers ----
assert.equal(shouldScrobble(29_000, 29_000), false, 'under 30 s never');
assert.equal(shouldScrobble(30_000, 15_000), true, 'half of a 30 s track');
assert.equal(shouldScrobble(200_000, 99_999), false);
assert.equal(shouldScrobble(200_000, 100_000), true);
assert.equal(shouldScrobble(1_200_000, 240_000), true, '4 min of a long track');
assert.equal(shouldScrobble(1_200_000, 239_999), false);
assert.equal(shouldScrobble(0, 239_999), false, 'unknown length: 4 min');
assert.equal(shouldScrobble(0, 240_000), true);

const REC = '0f3b6e2a-8c3e-4b8e-9f4d-1a2b3c4d5e6f';
const song = {
  Id: 'a1',
  Type: 'Audio',
  Name: ' Song ',
  Artists: ['A', ' B '],
  AlbumArtist: 'A',
  Album: 'Album',
  RunTimeTicks: 40_000 * 10_000,
  IndexNumber: 3,
  ProviderIds: { MusicBrainzRecording: REC.toUpperCase(), MusicBrainzAlbum: 'not-a-uuid' },
};
const info = trackInfo(song);
assert.deepEqual(info, { artists: ['A', 'B'], track: 'Song', album: 'Album', albumArtist: 'A', durationMs: 40_000, trackNumber: 3, mbids: { recording_mbid: REC } });
assert.equal(trackInfo({ ...song, Type: 'Movie' }), null, 'only songs');
assert.equal(trackInfo({ ...song, Name: '' }), null, 'no title');
assert.deepEqual(trackInfo({ Id: 'x', Type: 'Audio', Name: 'T', AlbumArtist: 'Z' }).artists, ['Z'], 'album artist fallback');
assert.equal(trackInfo({ Id: 'x', Type: 'Audio', Name: 'T' }), null, 'no artist');

const single = listenBody(info, 1700000000, '1.2.3');
assert.equal(single.listen_type, 'single');
assert.equal(single.payload[0].listened_at, 1700000000);
assert.equal(single.payload[0].track_metadata.artist_name, 'A, B');
assert.equal(single.payload[0].track_metadata.release_name, 'Album');
assert.equal(single.payload[0].track_metadata.additional_info.recording_mbid, REC);
assert.equal(single.payload[0].track_metadata.additional_info.submission_client_version, '1.2.3');
const now = listenBody(info, null, '1.2.3');
assert.equal(now.listen_type, 'playing_now');
assert.equal('listened_at' in now.payload[0], false);

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');
assert.equal(lastfmSign({ token: 't', method: 'auth.getSession', api_key: 'k', format: 'json' }, 's'), md5('api_keykmethodauth.getSessiontokents'), 'sorted, format left out');
assert.equal(lastfmSign({ track: 'Café' }, 'x'), md5('trackCaféx'), 'UTF-8');
assert.deepEqual(lastfmTrackParams(info, 123), { artist: 'A', track: 'Song', album: 'Album', albumArtist: 'A', trackNumber: '3', duration: '40', mbid: REC, timestamp: '123' });
assert.equal('timestamp' in lastfmTrackParams(info, null), false);

// ---- ScrobbleService against a fake fetch ----
const LB_TOKEN = 'lb-token-0123456789';
const FM_KEY = 'a'.repeat(32);
const FM_SECRET = 'b'.repeat(32);
const SK = 'session-key-xyz';
process.env.WICABY_LISTENBRAINZ_URL = 'http://lb.test';
process.env.WICABY_LASTFM_URL = 'http://fm.test/';
process.env.WICABY_DEV_URL = 'check'; // the logger echoes to the console, captured below
const logged = [];
for (const k of ['log', 'warn', 'error', 'info', 'debug']) {
  const orig = console[k];
  console[k] = (...a) => (logged.push(a.join(' ')), k === 'error' && orig(...a));
}

const calls = [];
// Per call kind: 'ok', 'down' (network), or a function returning [status, json].
const mode = { lb: 'ok', fm: 'ok' };
let sessionPolls = 0;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.__fetch = async (url, init) => {
  const u = new URL(url);
  if (u.host === 'lb.test') {
    const call = { to: 'lb', path: u.pathname, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : null };
    if (u.pathname === '/1/validate-token') return json(200, call.auth === `Token ${LB_TOKEN}` ? { valid: true, user_name: 'wika' } : { valid: false });
    calls.push(call);
    if (mode.lb === 'down') throw new TypeError('fetch failed');
    if (typeof mode.lb === 'function') return json(...mode.lb());
    return json(200, { status: 'ok' });
  }
  const params = Object.fromEntries(init.method === 'POST' ? new URLSearchParams(init.body) : u.searchParams);
  const { api_sig, format, ...signed } = params;
  assert.equal(format, 'json');
  assert.equal(api_sig, md5(Object.keys(signed).sort().map((k) => k + signed[k]).join('') + FM_SECRET), `signature of ${params.method}`);
  if (params.method === 'auth.getToken') return json(200, { token: 'tok' });
  if (params.method === 'auth.getSession') return ++sessionPolls < 2 ? json(403, { error: 14, message: 'not authorized' }) : json(200, { session: { name: 'wika', key: SK } });
  calls.push({ to: 'fm', method: params.method, params });
  if (mode.fm === 'down') throw new TypeError('fetch failed');
  if (typeof mode.fm === 'function') return json(...mode.fm());
  return json(200, { scrobbles: { '@attr': { accepted: 1 } } });
};

let clock = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => clock;
const { ScrobbleService } = await import(pathToFileURL(out).href);
const entries = new Map();
const vault = { get: (k) => entries.get(k), set: async (k, v) => void entries.set(k, v), delete: async (k) => void entries.delete(k) };
const until = async (cond, ms = 10_000) => {
  const end = realNow() + ms;
  while (!(await cond())) {
    if (realNow() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const idle = (svc) => svc.chain;

const svc = new ScrobbleService(vault, path.join(tmp, 'queue.json'));
// Nothing connected: nothing sent.
svc.report('start', song, 0, 40_000);
clock += 30_000;
svc.report('stop', song, 30_000, 40_000);
await idle(svc);
assert.equal(calls.length, 0, 'off by default');

await assert.rejects(svc.connectListenBrainz('bad token!'), /ListenBrainz/);
await assert.rejects(svc.connectListenBrainz('wrong-token-123456'), /ListenBrainz/, 'refused by validate-token');
let st = await svc.connectListenBrainz(` ${LB_TOKEN} `);
assert.equal(st.listenbrainz.user, 'wika');
await assert.rejects(svc.connectLastfm('short', 'x'), /Last.fm/);
st = await svc.connectLastfm(FM_KEY, FM_SECRET);
assert.equal(st.lastfm.authUrl, `https://www.last.fm/api/auth/?api_key=${FM_KEY}&token=tok`);
assert.equal(st.lastfm.user, null);
await until(() => svc.state().lastfm.user === 'wika');
assert.equal(svc.state().lastfm.authUrl, null);
assert.equal(sessionPolls, 2, 'polled until the user allowed it');

// A full listen: playing now on start, one listen at the stop, stamped with the start.
const t0 = Math.floor(clock / 1000);
svc.report('start', song, 0, 40_000);
clock += 25_000;
svc.report('stop', song, 25_000, 40_000);
await idle(svc);
assert.deepEqual(
  calls.map((c) => (c.to === 'lb' ? c.body.listen_type : c.method)),
  ['playing_now', 'track.updateNowPlaying', 'single', 'track.scrobble'],
);
assert.equal(calls[0].auth, `Token ${LB_TOKEN}`);
assert.equal(calls[2].body.payload[0].listened_at, t0);
assert.equal(calls[3].params.timestamp, String(t0));
assert.equal(calls[3].params.sk, SK);
calls.length = 0;

// A seek forward and a pause add nothing: 5 s + 10 s heard of a 40 s track.
svc.report('start', song, 0, 40_000);
clock += 5_000;
svc.report('pause', song, 30_000, 40_000);
clock += 100_000;
svc.report('start', song, 30_000, 40_000);
clock += 10_000;
svc.report('stop', song, 40_000, 40_000);
await idle(svc);
assert.deepEqual(calls.map((c) => c.body?.listen_type ?? c.method), ['playing_now', 'track.updateNowPlaying'], 'not scrobbled');
calls.length = 0;

// Videos are not music.
svc.report('start', { ...song, Type: 'Movie' }, 0, 40_000);
await idle(svc);
assert.equal(calls.length, 0);

const play = async (item = song) => {
  svc.report('start', item, 0, 40_000);
  clock += 40_000;
  svc.report('stop', item, 40_000, 40_000);
  await idle(svc);
};

// Offline: both kept. A Last.fm "try again" error is kept, a bad request (LB 400) is dropped.
mode.lb = 'down';
mode.fm = 'down';
await play();
assert.equal(svc.state().queued, 2);
mode.lb = () => [400, { code: 400, error: 'bad' }];
mode.fm = () => [200, { error: 16, message: 'temporarily unavailable' }];
await play();
assert.equal(svc.state().queued, 3, 'LB 400 dropped, Last.fm 16 kept');
svc.queue.flush();
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'queue.json'), 'utf8')).length, 3, 'persisted');
// A refused session key is kept and asks the user to connect again.
mode.fm = () => [403, { error: 9, message: 'Invalid session key' }];
await play({ ...song, Id: 'a2' });
assert.match(svc.state().error, /Last\.fm/);
assert.equal(svc.state().queued, 4);
// Back online: the next listen sends the queue too, oldest first.
mode.lb = 'ok';
mode.fm = 'ok';
calls.length = 0;
await play();
assert.equal(svc.state().queued, 0);
assert.equal(calls.filter((c) => c.body?.listen_type === 'single' || c.method === 'track.scrobble').length, 2 + 4);

// Disconnecting a service drops its waiting listens.
mode.fm = 'down';
await play();
assert.equal(svc.state().queued, 1);
st = await svc.disconnectLastfm();
assert.equal(st.queued, 0);
assert.equal(st.lastfm.user, null);
mode.fm = 'ok';

// Capped at 500, oldest dropped; flush() sends them again.
const q2 = path.join(tmp, 'queue2.json');
fs.writeFileSync(q2, JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ to: 'listenbrainz', at: i, info }))));
const svc2 = new ScrobbleService(vault, q2);
mode.lb = 'down';
svc2.report('start', song, 0, 40_000);
clock += 40_000;
svc2.report('stop', song, 40_000, 40_000);
await idle(svc2);
assert.equal(svc2.state().queued, 500);
assert.equal(svc2.queue.value[0].at, 1, 'the oldest went');
mode.lb = 'ok';
svc2.flush();
await idle(svc2);
assert.equal(svc2.state().queued, 0);

const log = logged.join('\n');
for (const s of [LB_TOKEN, FM_SECRET, SK]) assert.equal(log.includes(s), false, 'no secret in the log');
Date.now = realNow;
fs.rmSync(tmp, { recursive: true, force: true });
process.stdout.write('scrobble-check: OK\n');
process.exit(0);
