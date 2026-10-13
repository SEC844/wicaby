// Self-check for the desktop's Trakt scrobbling against tools/mock-server/mock-trakt.mjs:
// - scrobbleBody (provider-id matching) and hasTraktPlugin (Emby and Jellyfin plugin lists);
// - TraktClient: device code, polling, refresh, revoke, scrobble; the mock's /sync/history (Android TV);
// - TraktService (Electron stubbed): device-code connect, start/pause/stop in order, refresh
//   after a 401, servers skipped by plugin or by the user, and no token or secret in the log.
// Usage: node tools/checks/trakt-check.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = import.meta.dirname;
const root = path.resolve(here, '..', '..', 'apps', 'desktop');
const SECRET = 'mock-secret-123';
const CLIENT = 'wicaby-check-client';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-trakt-'));
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export const app = { isPackaged: false, isReady: () => false, getLocale: () => 'en' }; export const net = { fetch: (u, i) => fetch(u, i) };`,
    }));
  },
};
const out = path.join(tmp, 'trakt.mjs');
await build({ entryPoints: [path.join(root, 'src/main/features/trakt.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [electronStub] });
const clientOut = path.join(tmp, 'trakt-client.mjs');
await build({ entryPoints: [path.join(root, 'src/main/features/trakt-client.ts')], bundle: true, platform: 'node', format: 'esm', outfile: clientOut, logLevel: 'error' });
const { scrobbleBody, hasTraktPlugin, TraktClient, TraktError } = await import(pathToFileURL(clientOut).href);

// ---- Pure helpers ----
assert.deepEqual(scrobbleBody({ Type: 'Movie', ProviderIds: { Imdb: 'tt0111161', Tmdb: '278' } }, 12.3456), { movie: { ids: { imdb: 'tt0111161', tmdb: 278 } }, progress: 12.35 });
assert.deepEqual(scrobbleBody({ Type: 'Episode', ProviderIds: { TVDB: '349232', imdb: 'bogus' } }, 150), { episode: { ids: { tvdb: 349232 } }, progress: 100 });
assert.equal(scrobbleBody({ Type: 'Episode', ProviderIds: { Tvdb: 'x1' } }, 10), null, 'no usable id');
assert.equal(scrobbleBody({ Type: 'Movie' }, 10), null, 'no ids at all');
assert.equal(scrobbleBody({ Type: 'TvChannel', ProviderIds: { Imdb: 'tt1' } }, 10), null, 'live TV is never scrobbled');
assert.equal(scrobbleBody({ Type: 'Movie', ProviderIds: { Tmdb: '5' } }, NaN).progress, 0);
assert.equal(hasTraktPlugin([{ Name: 'Open Subtitles' }, { Name: 'Trakt', Version: '3.2.0.0' }]), true, 'Emby lists loaded plugins only');
assert.equal(hasTraktPlugin([{ Name: 'Trakt', Status: 'Disabled' }]), false, 'Jellyfin, disabled');
assert.equal(hasTraktPlugin([{ Name: 'Trakt', Status: 'Active' }]), true, 'Jellyfin, active');
assert.equal(hasTraktPlugin([{ Name: 'Webhooks' }]), false);
assert.equal(hasTraktPlugin({ Items: [] }), false);

// ---- Mock server ----
// Port 0: the mock takes a free port and prints it.
const mock = spawn(process.execPath, [path.resolve(here, '..', 'mock-server', 'mock-trakt.mjs'), '0'], { env: { ...process.env, MOCK_TRAKT_TTL: '3600' }, stdio: ['ignore', 'pipe', 'inherit'] });
const BASE = await new Promise((resolve, reject) => {
  mock.stdout.on('data', (d) => {
    const m = /Mock Trakt on (http:\/\/[\d.:]+)/.exec(String(d));
    if (m) resolve(m[1]);
  });
  mock.on('exit', (code) => reject(new Error(`mock-trakt exited (${code})`)));
});
const state = () => fetch(`${BASE}/mock/state`).then((r) => r.json());
const until = async (cond, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

try {
  // ---- TraktClient ----
  const c = new TraktClient(BASE, CLIENT);
  const code = await c.deviceCode();
  assert.ok(code.user_code && code.device_code);
  assert.equal(await c.pollToken(code.device_code, SECRET), 'pending');
  const tok = await c.pollToken(code.device_code, SECRET);
  assert.ok(tok.access_token && tok.refresh_token);
  await assert.rejects(c.pollToken(code.device_code, SECRET), (e) => e instanceof TraktError && e.status === 409, 'a used code');
  await assert.rejects(c.pollToken('nope', SECRET), (e) => e.status === 404);
  assert.equal(await c.username(tok.access_token), 'wika');
  await c.scrobble('start', tok.access_token, scrobbleBody({ Type: 'Movie', ProviderIds: { Tmdb: '278' } }, 1));
  const next = await c.refresh(tok.refresh_token, SECRET);
  await assert.rejects(c.refresh(tok.refresh_token, SECRET), (e) => e.status === 401, 'a refresh token works once');
  // ---- /sync/history (the Android client's watched marks, core/trakt/TraktClient.kt) ----
  const hist = (p, b, token = next.access_token) =>
    fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': CLIENT, Authorization: `Bearer ${token}` }, body: JSON.stringify(b) });
  assert.equal((await hist('/sync/history', { movies: [{ ids: { imdb: 'tt0111161' } }] }, 'nope')).status, 401, 'history needs a token');
  assert.equal((await hist('/sync/history', { movies: [{ ids: { imdb: 'tt0111161' } }], episodes: [{ ids: {} }] })).status, 201);
  assert.deepEqual((await (await hist('/sync/history/remove', { episodes: [{ ids: { tvdb: 349232 } }] })).json()).deleted, { movies: 0, episodes: 1 });
  assert.deepEqual(
    (await state()).history.map((h) => [h.action, h.media]),
    [
      ['add', 'movies'],
      ['remove', 'episodes'],
    ],
    'an entry without ids is ignored',
  );
  // "Unwatched" on Android removes the latest play only: search -> per-item history -> remove by history id.
  const get = async (p) =>
    (await fetch(`${BASE}${p}`, { headers: { 'trakt-api-version': '2', 'trakt-api-key': CLIENT, Authorization: `Bearer ${next.access_token}` } })).json();
  await hist('/sync/history', { movies: [{ ids: { imdb: 'tt0111161' } }] });
  const tid = (await get('/search/imdb/tt0111161?type=movie'))[0].movie.ids.trakt;
  const [latest, first] = await get(`/sync/history/movies/${tid}`);
  assert.ok(latest.id > first.id, 'newest first');
  assert.equal((await (await hist('/sync/history/remove', { ids: [latest.id] })).json()).deleted.movies, 1);
  assert.deepEqual((await get(`/sync/history/movies/${tid}`)).map((h) => h.id), [first.id], 'the earlier play stays');
  await c.revoke(next.access_token, SECRET);
  await assert.rejects(c.username(next.access_token), (e) => e.status === 401 && !e.message.includes(next.access_token));
  assert.equal((await state()).scrobbles.length, 1);

  // ---- TraktService ----
  process.env.WICABY_TRAKT_URL = BASE;
  process.env.WICABY_DEV_URL = 'check'; // the logger echoes to the console, captured below
  const logged = [];
  for (const k of ['log', 'warn', 'error']) {
    const orig = console[k];
    console[k] = (...a) => (logged.push(a.join(' ')), k === 'error' && orig(...a));
  }
  const { TraktService } = await import(pathToFileURL(out).href);
  const entries = new Map();
  const vault = { get: (k) => entries.get(k), set: async (k, v) => void entries.set(k, v), delete: async (k) => void entries.delete(k) };
  const settings = { value: { trakt: { offServers: [] } } };
  const plugins = { emby: [{ Name: 'Trakt' }], jf: [{ Name: 'Trakt', Status: 'Disabled' }] };
  const sessions = [
    { status: 'signed-in', server: { id: 'emby', name: 'Emby' }, user: { isAdmin: true } },
    { status: 'signed-in', server: { id: 'jf', name: 'Jellyfin' }, user: { isAdmin: true } },
    { status: 'signed-in', server: { id: 'user', name: 'Friend' }, user: { isAdmin: false } },
  ];
  const connection = {
    on() {},
    session: { sessions },
    sessionFor: (id) => sessions.find((s) => s.server.id === id),
    onlineApi: (id) => ({ get: async () => plugins[id] ?? Promise.reject(new Error('403')) }),
  };
  const svc = new TraktService(vault, settings, connection);
  await assert.rejects(svc.connect('short', 'x'), /Invalid Client ID|invalidClient|Client/);
  let st = await svc.connect(CLIENT, SECRET);
  assert.ok(st.pending?.userCode, 'device code shown');
  assert.equal(st.user, null);
  await until(async () => (await svc.state()).user === 'wika');
  st = await svc.state();
  assert.equal(st.pending, null);
  assert.deepEqual(
    st.servers.map((s) => [s.serverId, s.plugin]),
    [
      ['emby', true],
      ['jf', false],
      ['user', null],
    ],
  );

  const movie = { Id: 'm1', Type: 'Movie', ProviderIds: { Imdb: 'tt0111161' } };
  const before = (await state()).scrobbles.length;
  svc.scrobble('start', 'jf', movie, 60_000, 6_000_000);
  svc.scrobble('pause', 'jf', movie, 120_000, 6_000_000);
  svc.scrobble('stop', 'jf', movie, 5_400_000, 6_000_000);
  svc.scrobble('start', 'emby', movie, 0, 6_000_000); // the server's plugin scrobbles
  settings.value.trakt.offServers = ['user'];
  svc.scrobble('start', 'user', movie, 0, 6_000_000); // turned off by the user
  svc.scrobble('start', 'jf', { Id: 'x', Type: 'Movie' }, 0, 1); // nothing to match on
  await until(async () => (await state()).scrobbles.length >= before + 3);
  await new Promise((r) => setTimeout(r, 300));
  const got = (await state()).scrobbles.slice(before);
  assert.deepEqual(
    got.map((s) => [s.action, s.progress]),
    [
      ['start', 1],
      ['pause', 2],
      ['stop', 90],
    ],
    'in order, nothing for skipped servers',
  );

  // A revoked access token: one refresh, then the scrobble goes through.
  await fetch(`${BASE}/mock/expire`, { method: 'POST' });
  svc.scrobble('start', 'jf', movie, 0, 6_000_000);
  await until(async () => (await state()).scrobbles.length === before + 4);

  // Secrets and tokens stay in the vault, never in the log.
  const saved = JSON.parse(entries.get('trakt:account').token);
  assert.ok(saved.secret === SECRET && saved.access && saved.refresh && saved.expiresAt > Date.now());
  const log = logged.join('\n');
  for (const s of [SECRET, saved.access, saved.refresh]) assert.ok(!log.includes(s), 'a secret reached the log');

  st = await svc.disconnect();
  assert.equal(st.user, null);
  assert.equal(entries.has('trakt:account'), false);
  console.info('trakt-check: all assertions passed');
} finally {
  mock.kill();
}
