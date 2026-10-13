// Photos spec PH-11: mock-immich answers the routes Wicaby uses in their documented shape (field names pinned by
// fixtures/photos/immich-contract.json), the key only in the x-api-key header, the scope 403s, archived assets kept
// off the timeline, the broken-timeline switch, and no file taken from the Immich repository.
// Usage: node tools/checks/immich-mock-check.mjs   (starts the mock on free loopback ports, then stops it)
// Never prints a coordinate.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const C = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/photos/immich-contract.json'), 'utf8'));
const KEY = 'mock-immich-key';
const TODAY = '2026-03-15';
let n = 0;
const ok = (msg) => console.log(`ok ${++n} - ${msg}`);

function start(env = {}) {
  const child = spawn(process.execPath, [path.join(root, 'tools/mock-server/mock-immich.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_PHOTOS: '200', MOCK_TODAY: TODAY, ...env } });
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`mock-immich exited (${code})`)));
    child.stdout.on('data', (d) => {
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d));
      if (m) resolve({ child, base: `http://127.0.0.1:${m[1]}` });
    });
  });
}
const stop = ({ child }) => (child.removeAllListeners('exit'), child.kill());

const has = (obj, fields, what) => {
  for (const f of fields) assert.ok(obj && Object.hasOwn(obj, f), `${what}: field ${f}`);
};

const m = await start();
const call = async (p, init = {}, key = KEY) => fetch(m.base + p, { ...init, headers: { ...(key ? { 'x-api-key': key } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
const json = async (p, init) => {
  const r = await call(p, init);
  assert.equal(r.status, 200, p);
  return r.json();
};
try {
  // 1. The contract: every route answers the fields the fixture names.
  const v = await (await fetch(`${m.base}/api/server/version`)).json();
  has(v, C.routes['GET /api/server/version'], 'server/version');
  assert.equal(`${v.major}.${v.minor}.${v.patch}`, C.immichVersion, 'the version the fixture was written from');
  const buckets = await json('/api/timeline/buckets?visibility=timeline');
  assert.ok(buckets.length > 10, 'buckets');
  has(buckets[0], C.routes['GET /api/timeline/buckets[]'], 'timeline/buckets');
  const b = await json(`/api/timeline/bucket?visibility=timeline&timeBucket=${encodeURIComponent(buckets[0].timeBucket)}`);
  has(b, C.routes['GET /api/timeline/bucket'], 'timeline/bucket');
  assert.equal(b.id.length, buckets[0].count, 'a bucket holds its count');
  assert.ok(Object.values(b).every((col) => Array.isArray(col) && col.length === b.id.length), 'columns are parallel arrays');
  const asset = await json(`/api/assets/${b.id[0]}`);
  has(asset, C.routes['GET /api/assets/{id}'], 'assets/{id}');
  has(asset.exifInfo, C.routes['GET /api/assets/{id}.exifInfo'], 'assets/{id}.exifInfo');
  const albums = await json('/api/albums');
  has(albums[0], C.routes['GET /api/albums[]'], 'albums');
  assert.equal(albums.filter((a) => a.isShared).length, 1, 'one shared album');
  assert.equal((await json('/api/albums?shared=true')).length, 1, 'albums?shared=true');
  const people = await json('/api/people');
  has(people, C.routes['GET /api/people'], 'people');
  has(people.people[0], C.routes['GET /api/people.people[]'], 'people[]');
  assert.equal(people.people.length, 4, 'four fictional people');
  const markers = await json('/api/map/markers');
  has(markers[0], C.routes['GET /api/map/markers[]'], 'map/markers');
  const mem = await json(`/api/memories?for=${TODAY}`);
  assert.ok(mem.length >= 2, 'memories on the mock day');
  has(mem[0], C.routes['GET /api/memories[]'], 'memories');
  const meta = await json('/api/search/metadata', { method: 'POST', body: JSON.stringify({ visibility: 'timeline', size: 50, page: 1, order: 'desc' }) });
  has(meta.assets, C.routes['POST /api/search/metadata.assets'], 'search/metadata');
  assert.equal(meta.assets.nextPage, '2', 'search/metadata pages');
  ok('every route answers the contract fields (Immich 3.3.0)');

  // 2. Filters: favourites, an album, a person, and archived assets absent from the timeline but in the library.
  const total = buckets.reduce((s, x) => s + x.count, 0);
  const all = (await json('/api/search/metadata', { method: 'POST', body: JSON.stringify({ size: 1000 }) })).assets.total;
  assert.ok(all > total && total > 0, 'archived assets stay off the timeline');
  const archived = (await json('/api/search/metadata', { method: 'POST', body: JSON.stringify({ visibility: 'archive', size: 1000 }) })).assets.items;
  assert.ok(archived.length > 0 && !markers.some((x) => archived.some((a) => a.id === x.id)), 'and off the map');
  const favCount = (await json('/api/timeline/buckets?visibility=timeline&isFavorite=true')).reduce((s, x) => s + x.count, 0);
  assert.ok(favCount > 0 && favCount < total, 'isFavorite filter');
  const inAlbum = (await json(`/api/timeline/buckets?albumId=${albums[1].id}`)).reduce((s, x) => s + x.count, 0);
  assert.equal(inAlbum, albums[1].assetCount, 'albumId filter matches assetCount');
  const withPerson = (await json(`/api/timeline/buckets?visibility=timeline&personId=${people.people[0].id}`)).reduce((s, x) => s + x.count, 0);
  assert.ok(withPerson > 0 && withPerson < total, 'personId filter');
  ok(`filters: ${total} on the timeline, ${all - total} archived, ${favCount} favourites, album and person`);

  // 3. Images and favourites.
  const thumb = await call(`/api/assets/${b.id[0]}/thumbnail?size=thumbnail`);
  assert.equal(thumb.headers.get('content-type'), 'image/png');
  const px = Buffer.from(await thumb.arrayBuffer());
  assert.ok(px.readUInt32BE(20) <= 250, 'thumbnail at most 250 px high');
  assert.equal((await call(`/api/assets/${b.id[0]}/thumbnail?size=preview`)).status, 200);
  assert.equal((await call(`/api/assets/${b.id[0]}/original`)).status, 200);
  assert.equal((await call(`/api/people/${people.people[0].id}/thumbnail`)).headers.get('content-type'), 'image/png');
  const was = asset.isFavorite;
  assert.equal((await call('/api/assets', { method: 'PUT', body: JSON.stringify({ ids: [asset.id], isFavorite: !was }) })).status, 204);
  assert.equal((await json(`/api/assets/${asset.id}`)).isFavorite, !was, 'favourite toggled');
  await call('/api/assets', { method: 'PUT', body: JSON.stringify({ ids: [asset.id], isFavorite: was }) });
  ok('thumbnail, preview, original, face thumbnail, favourite toggle');

  // 4. Auth: no key or a wrong key is 401; a key in the URL is tagged; smart search refuses flat fields.
  assert.equal((await call('/api/albums', {}, null)).status, 401);
  assert.equal((await call('/api/albums', {}, 'wrong')).status, 401);
  await fetch(`${m.base}/api/albums?apiKey=${KEY}`, { headers: { 'x-api-key': KEY } });
  const smartFlat = await call('/api/search/smart', { method: 'POST', body: JSON.stringify({ query: 'paris', isFavorite: true }) });
  assert.equal(smartFlat.status, 400, 'flat fields refused');
  const smart = await json('/api/search/smart', { method: 'POST', body: JSON.stringify({ query: 'video', filter: { visibility: 'timeline' } }) });
  assert.ok(smart.assets.items.every((a) => a.type === 'VIDEO'), 'smart search with the filter object');
  const st = await (await fetch(`${m.base}/Mock/State`)).json();
  assert.deepEqual([...new Set(st.tags.map((x) => x.tag))].sort(), ['BAD-KEY', 'FLAT-FIELDS', 'KEY-IN-URL', 'NO-KEY'], 'tags');
  ok('401 without the key, KEY-IN-URL tagged, smart search uses the filter object');
} finally {
  stop(m);
}

// 5. Scopes: a key without person.read gets 403 there and 200 elsewhere.
{
  const s = await start({ MOCK_IMMICH_SCOPES: 'asset.read,asset.view,album.read' });
  try {
    const r = await fetch(`${s.base}/api/people`, { headers: { 'x-api-key': KEY } });
    assert.equal(r.status, 403);
    assert.match((await r.json()).message, /person\.read/);
    assert.equal((await fetch(`${s.base}/api/map/markers`, { headers: { 'x-api-key': KEY } })).status, 403);
    assert.equal((await fetch(`${s.base}/api/albums`, { headers: { 'x-api-key': KEY } })).status, 200);
    ok('MOCK_IMMICH_SCOPES: 403 naming the missing scope');
  } finally {
    stop(s);
  }
}

// 6. MOCK_IMMICH_TIMELINE=broken changes the bucket shape; MOCK_IMMICH_VERSION and v2's "shared".
{
  const s = await start({ MOCK_IMMICH_TIMELINE: 'broken', MOCK_IMMICH_VERSION: '2.5.0' });
  try {
    const H = { headers: { 'x-api-key': KEY } };
    const [first] = await (await fetch(`${s.base}/api/timeline/buckets?visibility=timeline`, H)).json();
    const b = await (await fetch(`${s.base}/api/timeline/bucket?visibility=timeline&timeBucket=${first.timeBucket}`, H)).json();
    assert.ok(!Array.isArray(b.id) && Array.isArray(b.assets), 'broken shape');
    assert.equal((await (await fetch(`${s.base}/api/server/version`)).json()).major, 2);
    assert.ok('shared' in (await (await fetch(`${s.base}/api/albums`, H)).json())[0], 'v2 albums say shared');
    ok('MOCK_IMMICH_TIMELINE=broken and MOCK_IMMICH_VERSION=2.5.0');
  } finally {
    stop(s);
  }
}

// 7. Clean room (spec §0): nothing tracked comes from the Immich repository.
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
assert.deepEqual(tracked.filter((f) => /immich-openapi-specs|open-api\/typescript-sdk/i.test(f)), [], 'an Immich API spec file in the tree');
ok('no Immich OpenAPI file in the tree');

console.log(`immich-mock-check: ${n} checks passed`);
