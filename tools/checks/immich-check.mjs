// Photos spec PH-12 (desktop): the Immich source against mock-immich, in plain Node. main/photos/immich.ts (bundled
// with esbuild) and the timeline adapter renderer/lib/photos/immich-timeline.ts:
//  1. the address and path allow-lists (JSON calls, wicaby-media://immich paths);
//  2. Test: version, key, missing permissions; a 1.x server is refused (AC 5); the key is in the vault only, bound to
//     its address, and only ever sent in the x-api-key header (AC 1: never in a URL, the mock tags it otherwise);
//  3. the timeline through the adapter: archived assets absent (AC 6), a person, an album, favourites;
//  4. MOCK_IMMICH_TIMELINE=broken falls back to search/metadata with the same photos (AC 3);
//  5. a key without person.read: People answers 403, the rest works (AC 4); thumbnails and originals via media();
//  6. the renderer never handles the key (no x-api-key in renderer code).
// Usage: node tools/checks/immich-check.mjs   (loopback only: the mock on free ports)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { columnsToAssets, durationMs, loadTimeline, wallClock } from '../../apps/desktop/src/renderer/lib/photos/immich-timeline.ts';

const root = path.resolve(import.meta.dirname, '../..');
const KEY = 'mock-immich-key';
let n = 0;
const ok = (msg) => console.log(`ok ${++n} - ${msg}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-immich-'));
const out = path.join(tmp, 'immich.mjs');
await build({ entryPoints: [path.join(root, 'apps/desktop/src/main/photos/immich.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
const { ImmichService, normalizeImmichUrl, isJsonRoute, isMediaPath } = await import(pathToFileURL(out).href);

function start(env = {}) {
  const child = spawn(process.execPath, [path.join(root, 'tools/mock-server/mock-immich.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_PHOTOS: '200', ...env } });
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`mock-immich exited (${code})`)));
    child.stdout.on('data', (d) => {
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d));
      if (m) resolve({ child, base: `http://127.0.0.1:${m[1]}` });
    });
  });
}
const stop = ({ child }) => (child.removeAllListeners('exit'), child.kill());

// Every request the service makes: loopback only, recorded to check where the key went.
const sent = [];
const guarded = (url, init) => {
  const u = new URL(url);
  assert.ok(u.hostname === '127.0.0.1', `non-loopback request to ${u.host}`);
  sent.push({ url, key: init?.headers?.['x-api-key'] });
  return fetch(url, init);
};
const vaultOf = () => {
  const m = new Map();
  return { m, get: (k) => m.get(k), set: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k) };
};
const service = (vault, dir = fs.mkdtempSync(path.join(tmp, 's-'))) => new ImmichService({ file: path.join(dir, 'immich.json'), vault, fetch: guarded, downloads: () => path.join(dir, 'dl') });

// 1. Allow-lists.
assert.equal(normalizeImmichUrl('photos.local:2283'), 'http://photos.local:2283');
assert.equal(normalizeImmichUrl('https://nas/immich/api/'), 'https://nas/immich');
assert.equal(normalizeImmichUrl('ftp://nas'), null);
assert.equal(normalizeImmichUrl('http://u:p@nas'), null);
const id = '0b1c2d3e-4f50-4a61-b728-394a5b6c7d8e';
assert.ok(isJsonRoute('GET', '/timeline/buckets') && isJsonRoute('PUT', '/assets') && isJsonRoute('GET', `/assets/${id}`));
assert.ok(!isJsonRoute('DELETE', '/assets') && !isJsonRoute('GET', '/users/me') && !isJsonRoute('GET', '/api-keys') && !isJsonRoute('POST', '/assets'));
assert.ok(isMediaPath(`/assets/${id}/thumbnail`, new URLSearchParams('size=preview')) && isMediaPath(`/people/${id}/thumbnail`, new URLSearchParams()));
assert.ok(!isMediaPath(`/assets/${id}/thumbnail`, new URLSearchParams('size=preview&apiKey=x')) && !isMediaPath(`/assets/../users/thumbnail`, new URLSearchParams()) && !isMediaPath('/download/archive', new URLSearchParams()));
ok('address normalisation and the JSON / media allow-lists');

// Pure adapter helpers.
assert.equal(wallClock('2019-10-12T08:30:00.000Z', 2), '2019-10-12T10:30:00');
assert.equal(wallClock('2019-10-12T23:30:00.000Z', -5), '2019-10-12T18:30:00');
assert.equal(durationMs('0:01:05.500000'), 65_500);
assert.equal(durationMs('0:00:00.00000'), undefined);
assert.throws(() => columnsToAssets({ id: ['a'], ratio: [] }, 'immich:x', false), /ratio/);
const cols = { id: ['a', 'b'], ratio: [1.5, 0.75], isImage: [true, false], isFavorite: [false, true], fileCreatedAt: ['2020-01-01T10:00:00Z', '2020-01-02T10:00:00Z'], localOffsetHours: [1, 0], duration: [null, '0:00:12.000000'], visibility: ['timeline', 'archive'], latitude: [1, 2], longitude: [3, 4] };
assert.deepEqual(columnsToAssets(cols, 'immich:x', false, 'timeline'), [{ id: 'a', serverId: 'immich:x', kind: 'photo', takenAt: '2020-01-01T11:00:00', aspect: 1.5, rotate: 0, favorite: false }]);
assert.equal(columnsToAssets(cols, 'immich:x', true)[1].durationMs, 12_000);
assert.equal(columnsToAssets(cols, 'immich:x', false)[1].lat, undefined, 'no coordinates unless the map is on');
ok('adapter: wall clock, durations, columns, visibility, no coordinates without the map');

const m = await start();
try {
  const vault = vaultOf();
  const dir = fs.mkdtempSync(path.join(tmp, 's-'));
  const svc = service(vault, dir);
  // 2. Test and add.
  assert.deepEqual(await svc.test(m.base, 'wrong'), { ok: false, error: 'auth', version: '3.3.0', missing: [] });
  assert.deepEqual(await svc.test(m.base, KEY), { ok: true, version: '3.3.0', missing: [] });
  assert.equal((await svc.test('http://127.0.0.1:1', KEY)).error, 'network');
  const added = await svc.add(`${m.base}/`, KEY);
  assert.ok(added.ok && /^[0-9a-f]{12}$/.test(added.source.id));
  assert.deepEqual(svc.list().map((s) => s.url), [m.base]);
  const disk = fs.readFileSync(path.join(dir, 'immich.json'), 'utf8');
  assert.ok(!disk.includes(KEY), 'the key is not in immich.json');
  assert.equal(vault.get(`immich:${added.source.id}`).token, KEY);
  ok('Test reports version and permissions; Connect keeps the key in the vault only');

  // 3. The timeline through the adapter, called the way the renderer does (main's request()).
  const sid = added.source.id;
  const call = (method, p, q, b) => svc.request(sid, method, p, q, b);
  const tl = await loadTimeline(call, `immich:${sid}`, {}, false);
  assert.equal(tl.fallback, false);
  const buckets = await call('GET', '/timeline/buckets', { visibility: 'timeline' });
  assert.equal(tl.assets.length, buckets.reduce((s, b) => s + b.count, 0), 'every bucket loaded');
  assert.ok(tl.assets.every((a, i) => i === 0 || tl.assets[i - 1].takenAt >= a.takenAt), 'newest first');
  const archived = (await call('POST', '/search/metadata', undefined, { visibility: 'archive', size: 1000 })).assets.items.map((a) => a.id);
  assert.ok(archived.length > 0 && !tl.assets.some((a) => archived.includes(a.id)), 'archived assets absent');
  const fav = await loadTimeline(call, `immich:${sid}`, { favorites: true }, false);
  assert.ok(fav.assets.length > 0 && fav.assets.every((a) => a.favorite));
  const albums = await call('GET', '/albums');
  const inAlbum = await loadTimeline(call, `immich:${sid}`, { albumId: albums[0].id }, false);
  assert.equal(inAlbum.assets.length, albums[0].assetCount);
  const people = (await call('GET', '/people')).people;
  assert.ok((await loadTimeline(call, `immich:${sid}`, { personId: people[0].id }, false)).assets.length > 0);
  ok(`timeline: ${tl.assets.length} assets in ${buckets.length} months, no archived one; favourites, album, person`);

  // Favourite toggle, media, original.
  const target = tl.assets.find((a) => a.kind === 'photo');
  await call('PUT', '/assets', undefined, { ids: [target.id], isFavorite: !target.favorite });
  assert.equal((await call('GET', `/assets/${target.id}`)).isFavorite, !target.favorite);
  await call('PUT', '/assets', undefined, { ids: [target.id], isFavorite: target.favorite });
  const pic = await svc.media(`/${sid}/assets/${target.id}/thumbnail`, new URLSearchParams('size=thumbnail'), () => null);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get('content-type'), 'image/png');
  await pic.arrayBuffer();
  assert.equal((await svc.media(`/${sid}/assets/${target.id}/thumbnail`, new URLSearchParams('size=huge'), () => null)).status, 400);
  assert.equal((await svc.media(`/ffffffffffff/assets/${target.id}/thumbnail`, new URLSearchParams(), () => null)).status, 404);
  await assert.rejects(call('GET', '/users/me'), /immich:400/);
  const f1 = await svc.saveOriginal(sid, target.id);
  const f2 = await svc.saveOriginal(sid, target.id);
  assert.ok(f1 !== f2 && fs.existsSync(f1) && fs.existsSync(f2) && path.dirname(f1) === path.join(dir, 'dl'), 'originals never overwrite');
  ok('favourite toggle, thumbnail through media(), refused paths, original saved without overwriting');

  // The key travelled in the header only, and only to the mock.
  assert.ok(sent.every((s) => !s.url.includes(KEY)), 'key in a URL');
  const st = await (await fetch(`${m.base}/Mock/State`)).json();
  assert.deepEqual(st.tags.filter((x) => x.tag === 'KEY-IN-URL'), []);
  // An edited address never gets the key: the binding fails and the source drops out.
  const doc = JSON.parse(disk);
  doc.sources[0].url = 'http://127.0.0.2:9';
  fs.writeFileSync(path.join(dir, 'immich.json'), JSON.stringify(doc));
  assert.deepEqual(service(vault, dir).list(), [], 'a source whose address changed loses its key');
  await svc.remove(sid);
  assert.equal(vault.get(`immich:${sid}`), undefined);
  ok('the key only in the x-api-key header, bound to its address, gone on Remove');
} finally {
  stop(m);
}

// 4. The broken Internal timeline: search/metadata serves the same photos.
{
  const b = await start({ MOCK_IMMICH_TIMELINE: 'broken' });
  try {
    const svc = service(vaultOf());
    const { source } = await svc.add(b.base, KEY);
    const call = (method, p, q, body) => svc.request(source.id, method, p, q, body);
    const tl = await loadTimeline(call, `immich:${source.id}`, {}, false);
    const total = (await call('GET', '/timeline/buckets', { visibility: 'timeline' })).reduce((s, x) => s + x.count, 0);
    assert.equal(tl.fallback, true);
    assert.equal(tl.assets.length, total, 'the fallback shows every photo');
    assert.ok(tl.assets.every((a) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(a.takenAt) && a.aspect > 0));
    ok(`MOCK_IMMICH_TIMELINE=broken: search/metadata fallback, ${tl.assets.length} photos`);
  } finally {
    stop(b);
  }
}

// 5. Permissions and versions.
{
  const s = await start({ MOCK_IMMICH_SCOPES: 'asset.read,asset.view,album.read' });
  try {
    const svc = service(vaultOf());
    const r = await svc.add(s.base, KEY);
    assert.deepEqual(r.missing, ['person.read', 'map.read', 'memory.read']);
    await assert.rejects(svc.request(r.source.id, 'GET', '/people'), /immich:403/);
    assert.ok((await svc.request(r.source.id, 'GET', '/albums')).length > 0);
    ok('a key without person.read: People answers 403 (the caption names it), albums still load');
  } finally {
    stop(s);
  }
  const noView = await start({ MOCK_IMMICH_SCOPES: 'asset.read' });
  try {
    assert.ok((await service(vaultOf()).test(noView.base, KEY)).missing.includes('asset.view'));
  } finally {
    stop(noView);
  }
  const old = await start({ MOCK_IMMICH_VERSION: '1.106.4' });
  try {
    const svc = service(vaultOf());
    assert.deepEqual(await svc.add(old.base, KEY), { ok: false, error: 'version', version: '1.106.4', missing: [] });
    assert.deepEqual(svc.list(), []);
    ok('missing asset.view reported; a 1.x server is refused with its version');
  } finally {
    stop(old);
  }
}

// 6. The renderer never handles the key.
const rendererFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? rendererFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const leaks = rendererFiles(path.join(root, 'apps/desktop/src/renderer')).filter((f) => /\.(ts|svelte)$/.test(f) && /x-api-key|apiKey=|api_key=/i.test(fs.readFileSync(f, 'utf8')));
assert.deepEqual(leaks, [], 'renderer code handling an API key');
ok('no API key handling in renderer code');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`immich-check: ${n} checks passed`);
