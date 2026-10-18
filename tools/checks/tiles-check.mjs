// Photos map, opt-in (photos spec PH-09): the tile proxy (apps/desktop/src/main/photos/tiles.ts) against a fake tile
// server on 127.0.0.1, no Internet. Off: no request at all. On: an identifying User-Agent, 2 requests at a time at
// most, zoom 19 at most, only the configured host (no redirect elsewhere), a 7-day minimum cache whatever the headers
// say, LRU within the cap, nothing logged. Plus the settings defaults (off, OSM) and the clusters on the mock's photos.
// The renderer side (visible tiles only, attribution shown, no map while off) is photos-map-cdp.mjs.
// Run: node tools/checks/tiles-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { expiresAt, MIN_TTL_MS, tileService, tileTarget } from '../../apps/desktop/src/main/photos/tiles.ts';
import { cluster } from '../../apps/desktop/src/renderer/lib/photos/cluster.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a3f2a9e10000000049454e44ae426082', 'hex');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-tiles-'));

// ---- The fake tile server: counts requests, concurrency and User-Agents; per-path answers ----
const seen = [];
let active = 0;
let peak = 0;
let headers = { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=60' };
const other = http.createServer((req, res) => (seen.push({ url: req.url, other: true }), res.end(PNG)));
await new Promise((r) => other.listen(0, '127.0.0.1', r));
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, ua: req.headers['user-agent'], cacheControl: req.headers['cache-control'], pragma: req.headers.pragma });
  peak = Math.max(peak, ++active);
  setTimeout(() => {
    active--;
    if (req.url.startsWith('/redirect/')) return res.writeHead(302, { Location: `http://127.0.0.1:${other.address().port}/x.png` }).end();
    if (req.url.startsWith('/html/')) return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>no</p>');
    res.writeHead(200, headers).end(PNG);
  }, 40);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let clock = Date.UTC(2026, 9, 13);
const cfg = { enabled: false, tileUrl: `${base}/{z}/{x}/{y}.png` };
const ua = 'Wicaby/0.4.4 (+https://github.com/WicaebethTheo/wicaby-releases)';
const tiles = tileService({ config: () => cfg, userAgent: ua, dir, now: () => clock });

// 1. Off: nothing leaves the machine.
for (const p of ['/3/4/2', '/0/0/0', '/12/2048/1361']) assert.equal((await tiles(p)).status, 404, `off: ${p}`);
assert.equal(seen.length, 0, 'map off: zero tile requests');

// 2. On: the identifying User-Agent, never a no-cache request, 2 at a time at most.
cfg.enabled = true;
const batch = await Promise.all(Array.from({ length: 6 }, (_, i) => tiles(`/5/${i}/7`)));
assert.ok(batch.every((r) => r.status === 200 && r.headers.get('content-type') === 'image/png'), 'tiles served');
assert.equal(seen.length, 6);
assert.ok(seen.every((r) => /^Wicaby\/\d+\.\d+\.\d+ \(\+https:\/\//.test(r.ua)), 'User-Agent');
assert.ok(seen.every((r) => !r.cacheControl && !r.pragma), 'no no-cache header');
assert.ok(peak <= 2, `at most 2 requests at a time (saw ${peak})`);
assert.deepEqual(seen.map((r) => r.url).sort(), Array.from({ length: 6 }, (_, i) => `/5/${i}/7.png`).sort(), 'only the tiles asked for: no prefetch, no other zoom');

// 3. Cache: max-age=60 still served after 1 h (7-day minimum), fetched again after 8 days.
seen.length = 0;
clock += 3_600_000;
assert.equal((await tiles('/5/0/7')).status, 200);
assert.equal(seen.length, 0, 'served from the cache an hour later');
clock += 8 * 86_400_000;
assert.equal((await tiles('/5/0/7')).status, 200);
assert.equal(seen.length, 1, 'fetched again after 8 days');
// A longer lifetime from the server is kept; Expires counts too; never below 7 days.
const h = (o) => new Headers(o);
assert.equal(expiresAt(h({ 'cache-control': 'public, max-age=1209600' }), 0), 1_209_600_000);
assert.equal(expiresAt(h({ expires: new Date(30 * 86_400_000).toUTCString() }), 0), 30 * 86_400_000);
assert.equal(expiresAt(h({ 'cache-control': 'no-cache' }), 0), MIN_TTL_MS);
// The cache survives a restart (a new service over the same folder).
seen.length = 0;
const again = tileService({ config: () => cfg, userAgent: ua, dir, now: () => clock });
assert.equal((await again('/5/0/7')).status, 200);
assert.equal(seen.length, 0, 'disk cache read back after a restart');
// Offline with a stale tile: the stale tile, not a hole.
clock += 30 * 86_400_000;
const offline = tileService({ config: () => cfg, userAgent: ua, dir, now: () => clock, fetch: async () => { throw new Error('offline'); } });
assert.equal((await offline('/5/2/7')).status, 200, 'stale tile when the host cannot be reached');

// 4. Refused: zoom past 19, off-world x/y, malformed paths; nothing is fetched for them.
seen.length = 0;
for (const p of ['/20/0/0', '/3/8/0', '/3/0/8', '/3/0', '/a/b/c', '/3/0/0/extra', '/../3/0/0', '/3/0/0.jpg', '/-1/0/0']) assert.equal((await tiles(p)).status, 404, `refused: ${p}`);
assert.equal((await tiles('/19/0/0')).status, 200, 'zoom 19 is fine');
assert.equal(seen.length, 1);
assert.equal(tileTarget(cfg.tileUrl, '/19/524287/524287')?.host, `127.0.0.1:${server.address().port}`);
assert.equal(tileTarget(cfg.tileUrl, '/19/524288/0'), null);
assert.equal(tileTarget('file:///{z}/{x}/{y}', '/1/0/0'), null, 'http(s) only');

// 5. Only the configured host: a redirect elsewhere is not followed, a non-image answer is not served.
seen.length = 0;
cfg.tileUrl = `${base}/redirect/{z}/{x}/{y}`;
assert.equal((await tiles('/4/1/1')).status, 502);
assert.ok(seen.every((r) => !r.other), 'the redirect target is never asked');
cfg.tileUrl = `${base}/html/{z}/{x}/{y}`;
assert.equal((await tiles('/4/1/1')).status, 502, 'not an image');
cfg.tileUrl = `${base}/{z}/{x}/{y}.png`;

// 6. LRU: past the cap, the least recently used tiles go first.
const small = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-tiles-lru-'));
const lru = tileService({ config: () => cfg, userAgent: ua, dir: small, now: () => clock, maxBytes: PNG.length * 3 });
for (let i = 0; i < 3; i++) (clock += 1000), await lru(`/6/${i}/0`);
clock += 1000;
await lru('/6/0/0'); // touched: now the newest
clock += 1000;
await lru('/6/3/0'); // evicts /6/1/0, the least recently used
assert.equal(fs.readdirSync(small).length, 3);
seen.length = 0;
await lru('/6/0/0');
assert.equal(seen.length, 0, 'recently used tile kept');
await lru('/6/1/0');
assert.equal(seen.length, 1, 'least recently used tile evicted');

// 6b. Cancelled tiles: a request aborted while it waits for a slot is never fetched, and an aborted fetch
//     frees its slot (a stalled host cannot hold the two slots).
{
  let calls = 0;
  const stall = (_u, init) => (calls++, new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))));
  const hang = tileService({ config: () => cfg, userAgent: ua, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-tiles-abort-')), now: () => clock, fetch: stall });
  const ctl = [new AbortController(), new AbortController(), new AbortController()];
  const pending = ctl.map((c, i) => hang(`/7/${i}/0`, c.signal));
  await new Promise((r) => setTimeout(r, 20));
  ctl[2].abort();
  ctl[0].abort();
  ctl[1].abort();
  assert.deepEqual((await Promise.all(pending)).map((r) => r.status), [502, 502, 502]);
  assert.equal(calls, 2, 'the tile panned away before its turn is not fetched');
}

// 6c. The fetch timeout starts when a tile gets its slot: a tile queued behind slow ones is not born timed out.
{
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = () => timeout(60);
  try {
    let n = 0;
    const slow = (_u, init) => init.signal.aborted ? Promise.reject(new Error('aborted'))
      : new Promise((r) => setTimeout(() => r(new Response(PNG, { headers: { 'Content-Type': 'image/png' } })), n++ < 2 ? 100 : 0));
    const queued = tileService({ config: () => cfg, userAgent: ua, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-tiles-queue-')), now: () => clock, fetch: slow });
    const all = await Promise.all([0, 1, 2, 3].map((i) => queued(`/8/${i}/0`)));
    assert.deepEqual(all.map((r) => r.status), [200, 200, 200, 200], 'queued tiles keep their full timeout');
  } finally {
    AbortSignal.timeout = timeout;
  }
}

// 7. Nothing in the tile code logs (a tile address is a place, spec §6.1).
const src = fs.readFileSync(path.join(import.meta.dirname, '../../apps/desktop/src/main/photos/tiles.ts'), 'utf8');
assert.ok(!/\b(console|log)\.\w+\(/.test(src), 'tiles.ts logs nothing');
const proto = fs.readFileSync(path.join(import.meta.dirname, '../../apps/desktop/src/main/protocols.ts'), 'utf8');
assert.ok(/url\.host === 'tile' \? '' : url\.pathname/.test(proto), 'protocols.ts leaves tile paths out of its warning');

// 8. Settings: the map is off by default, on OpenStreetMap; only http(s) templates with {z} {x} {y} are kept.
const settingsOut = path.join(dir, 'settings.mjs');
await build({
  entryPoints: [path.join(import.meta.dirname, '../../apps/desktop/src/main/core/settings.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: settingsOut,
  logLevel: 'error',
  plugins: [{ name: 'electron-stub', setup: (b) => {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const app = { getPath: () => "/tmp" };' }));
  } }],
});
const { defaultSettings, isTileTemplate, OSM_TILES, SettingsService } = await import(pathToFileURL(settingsOut).href);
assert.deepEqual(defaultSettings().photos.map, { enabled: false, tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' });
assert.ok(isTileTemplate(OSM_TILES) && isTileTemplate('http://192.0.2.10:8080/tiles/{z}/{x}/{y}.png') && isTileTemplate('https://t.example/{z}/{x}/{y}.png?key=abc'));
for (const bad of ['', 'ftp://t.example/{z}/{x}/{y}', 'https://t.example/{z}/{x}.png', 'https://u:p@t.example/{z}/{x}/{y}', 'https://t.example/{z}/{x}/{y}/{z}', 'https://t.example/{z}/{x}/{y} x', 'javascript:{z}{x}{y}', 42, null])
  assert.ok(!isTileTemplate(bad), `refused template: ${bad}`);
// A refused edit keeps the self-hosted server in use (not a silent switch to OpenStreetMap).
const svc = new SettingsService(path.join(dir, 'settings.json'));
const own = 'http://192.0.2.10:8080/tiles/{z}/{x}/{y}.png';
assert.equal(svc.update({ photos: { map: { tileUrl: own } } }).photos.map.tileUrl, own);
assert.equal(svc.update({ photos: { map: { tileUrl: 'http://192.0.2.10:8080/tiles/{z}/{x}.png' } } }).photos.map.tileUrl, own, 'refused edit keeps the previous server');
svc.flush();
// 8b. (settings.ts robustness) A hand-edited file with null sections loads with the defaults instead of crashing
// the start; window bounds that are not numbers never reach the screen APIs; one stale shortcut drops alone.
{
  const bad = path.join(dir, 'settings-bad.json');
  fs.writeFileSync(bad, JSON.stringify({ ui: { theme: 'light', shortcuts: { 'vod.mute': ['U'], 'gone.action': ['X'] } }, playback: 'x', window: null }));
  const s = new SettingsService(bad);
  assert.equal(s.value.playback.player, 'auto');
  assert.deepEqual(s.value.window, {});
  assert.deepEqual(s.value.ui.shortcuts, { 'vod.mute': ['U'] });
  assert.deepEqual(s.update({ window: { bounds: { x: 'a', y: 0, width: 10, height: 10 }, maximized: true } }).window, { maximized: true });
  assert.equal(s.update({ window: null, ui: null }).ui.theme, 'light');
  s.flush();
}

// 9. Clusters on the mock's generated photos (PH-00): every geotagged photo in exactly one cluster at each zoom;
// one cluster per landmark from zoom 6 to 8. The spec's "6 at zoom 3" cannot hold with 60 px groups: at zoom 3 Paris,
// Lyon and Mont Blanc lie within 30 px of each other.
process.env.MOCK_PHOTOS = '600';
const { addPhotos } = await import('../mock-server/photos-fixture.mjs');
const items = [];
addPhotos({ add: (x) => items.push(x), ud: () => ({}) });
const geo = items.filter((x) => x.Latitude != null && x.Longitude != null).map((x) => ({ lat: x.Latitude, lon: x.Longitude, takenAt: x.PremiereDate ?? x.DateCreated }));
assert.ok(geo.length > 200, `geotagged photos (${geo.length})`);
for (const z of [1, 3, 7, 12]) assert.equal(cluster(geo, z).reduce((n, c) => n + c.count, 0), geo.length, `zoom ${z}: counts sum to the geotagged total`);
for (const z of [6, 7, 8]) assert.equal(cluster(geo, z).length, 6, `zoom ${z}: one cluster per landmark`);
assert.ok(cluster(geo, 3).length < 6, 'zoom 3: the nearby landmarks merge');

server.close();
other.close();
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(small, { recursive: true, force: true });
console.log('tiles-check: OK');
