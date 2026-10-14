// Photo file sources: the EXIF/TIFF reader (apps/desktop/src/shared/files/exif.ts) against the shared vectors in
// fixtures/photos/exif-vectors.json (Android's ExifReaderTest reads the same file in place), the vectors against
// their generator (no drift), then the photo index through FileSources and FilesClient (the calls the photo UI
// makes) over a temp folder of generated photos and over the WebDAV mock (loopback only).
// Run: node tools/checks/photo-files-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { heicExifItem, orientationName, readPhotoHead } from '../../apps/desktop/src/shared/files/exif.ts';
import { buildPhotoTree, exifVectors, pngPhoto, tiff } from '../mock-server/photo-files-fixture.mjs';
import { startMockWebdav } from '../mock-server/mock-webdav.mjs';
import { bundleFiles, fakeHost, identity } from './files-bundle.mjs';

const F = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'photos', 'exif-vectors.json'), 'utf8'));
let n = 0;
const ok = (c, m) => (assert.ok(c, m), n++);

assert.deepEqual(F, JSON.parse(JSON.stringify(exifVectors())), 'exif-vectors.json is stale: node tools/mock-server/photo-files-fixture.mjs --vectors');

function same(got, want, name) {
  const keys = new Set([...Object.keys(got), ...Object.keys(want)]);
  for (const k of keys) {
    if (typeof want[k] === 'number') assert.ok(Math.abs(want[k] - got[k]) < 1e-6, `${name}: ${k} ${got[k]} != ${want[k]}`);
    else assert.deepEqual(got[k], want[k], `${name}: ${k}`);
  }
}

for (const v of F.vectors) {
  same(readPhotoHead(Buffer.from(v.b64, 'base64')), v.expected, v.name);
  if (v.item) same(heicExifItem(Buffer.from(v.item, 'base64')), v.itemExpected, `${v.name} (item)`);
  n++;
}
F.orientationNames.forEach((name, i) => assert.equal(orientationName(i + 1), name));
assert.equal(orientationName(0), undefined);
assert.equal(orientationName(9), undefined);
// Random bytes never throw.
for (let i = 0; i < 200; i++) {
  const b = Buffer.alloc(64 + i * 7);
  for (let k = 0; k < b.length; k++) b[k] = (Math.imul(k + 1, 2654435761 + i) >>> 13) & 255;
  if (i % 4 === 0) b.set([0xff, 0xd8, 0xff, 0xe1, 0, 60, 0x45, 0x78, 0x69, 0x66, 0, 0], 0);
  readPhotoHead(b);
}
n++;

// ---- The photo index through FileSources and FilesClient ----
const B = await bundleFiles();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-photo-files-'));
const today = '2026-10-14';
const fx = buildPhotoTree(path.join(tmp, 'tree'), { today });
const logs = [];
const saved = { ...console };
for (const k of ['log', 'warn', 'error', 'info', 'debug']) console[k] = (...a) => logs.push(a.map(String).join(' '));
let geo = false;
const vault = await B.CredentialVault.open(path.join(tmp, 'vault.bin'));
const host = fakeHost();
const files = new B.FileSources(path.join(tmp, 'files'), vault, identity, host, 'win32', () => geo);
files.rememberPicked(fx.dir);
const dav = await startMockWebdav({ root: fx.dir, port: 0 });
const encode = (rel) => B.encodeId(rel);
const ALL = { ParentId: 'p.', Recursive: true, IncludeItemTypes: 'Photo,Video', SortBy: 'DateCreated,SortName', SortOrder: 'Descending', StartIndex: 0, Limit: 1000 };

async function check(label, info) {
  ok(info.photos && host.sessions.get(info.id)?.info.files?.photos === true, `${label}: a photo source session`);
  const c = files.client(info.id);
  await c.photos.rescan();
  const st = files.list().find((s) => s.id === info.id).photos;
  ok(st.state === 'ready' && st.count === fx.photos.length + fx.videos.length && st.scannedAt > 0, `${label}: scan status ${JSON.stringify(st)}`);
  const get = (p, q) => c.request('GET', p, q);
  const views = await get('/Users/u/Views');
  ok(views.Items[0].CollectionType === 'photos' && views.Items[0].Id === 'p.', `${label}: the root is a photo library`);
  const all = await get('/Users/u/Items', ALL);
  ok(all.TotalRecordCount === fx.photos.length + 1 && all.Items.length === all.TotalRecordCount, `${label}: every photo and the clip, hidden files left out`);
  for (const p of fx.photos) {
    const it = all.Items.find((x) => x.Id === encode(p.rel));
    assert.ok(it, `${label}: ${p.rel} listed`);
    if (p.mtimeOnly) assert.ok(!it.PremiereDate && it.DateCreated === '2020-06-15T10:00:00.000Z', `${label}: ${p.rel} dated by its mtime`);
    else assert.equal(it.PremiereDate, p.takenAt, `${label}: ${p.rel} EXIF date`);
    assert.equal(it.ImageOrientation, p.orientation === 6 ? 'RightTop' : p.orientation === 1 ? 'TopLeft' : undefined, `${label}: ${p.rel} orientation`);
    assert.deepEqual([it.Width, it.Height, it.Type, it.Latitude], [p.w, p.h, 'Photo', undefined], `${label}: ${p.rel} size, type, no GPS with the map off`);
    assert.ok(it.ImageTags?.Primary, `${label}: ${p.rel} has a thumbnail`);
  }
  n++;
  const keys = all.Items.map((x) => x.PremiereDate ?? x.DateCreated);
  ok(keys.every((k, i) => i === 0 || k.slice(0, 4) <= keys[i - 1].slice(0, 4)), `${label}: newest first`);
  const clip = all.Items.find((x) => x.Type === 'Video');
  ok(clip && !clip.ImageTags, `${label}: the clip is a Video`);
  geo = true;
  const withGeo = await get('/Users/u/Items', { ParentId: 'p.', Recursive: true, IncludeItemTypes: 'Photo', Limit: 5 });
  ok(withGeo.Items.some((x) => typeof x.Latitude === 'number') && !withGeo.Items.some((x) => x.Type === 'Video'), `${label}: coordinates only with the map on; Photo only`);
  geo = false;
  // Albums: the folders that hold photos, each its own timeline.
  const albums = await get('/Users/u/Items', { ParentId: 'p.', IncludeItemTypes: 'PhotoAlbum', Recursive: false, SortBy: 'SortName', SortOrder: 'Ascending' });
  const names = albums.Items.map((a) => a.Name);
  ok(JSON.stringify(names) === JSON.stringify(['Famille › Anniversaires', 'Montagne', 'Vacances 2019']) && albums.Items.every((a) => a.Type === 'PhotoAlbum' && a.ImageTags?.Primary), `${label}: albums ${names}`);
  const vac = albums.Items.find((a) => a.Name === 'Vacances 2019');
  const inVac = await get('/Users/u/Items', { ParentId: vac.Id, Recursive: true, IncludeItemTypes: 'Photo,Video' });
  ok(inVac.TotalRecordCount === fx.photos.filter((p) => p.rel.startsWith('Vacances 2019/')).length + 1, `${label}: an album's timeline`);
  // Favourites are local.
  await c.request('POST', `/Users/u/FavoriteItems/${encode(fx.photos[4].rel)}`);
  const favs = await get('/Users/u/Items', { ParentId: 'p.', Recursive: true, IncludeItemTypes: 'Photo,Video', Filters: 'IsFavorite' });
  ok(favs.TotalRecordCount === 1 && favs.Items[0].UserData.IsFavorite, `${label}: favourites`);
  // "On this day": /Years then one date range per year.
  const years = await get('/Years', { Recursive: true, IncludeItemTypes: 'Photo' });
  ok(years.Items.map((y) => y.ProductionYear).includes(2016), `${label}: /Years`);
  const md = today.slice(5);
  const range = await get('/Users/u/Items', { Recursive: true, IncludeItemTypes: 'Photo', MinPremiereDate: `2016-${md}T00:00:00`, MaxPremiereDate: `2016-${md}T23:59:59`, SortBy: 'PremiereDate', SortOrder: 'Ascending', Limit: 90 });
  ok(range.TotalRecordCount >= 1 && range.Items.every((x) => x.PremiereDate.startsWith(`2016-${md}`)), `${label}: a memories range`);
  // The info panel's item; a thumbnail (no decoder in checks: the original) and an album cover.
  const one = await get(`/Users/u/Items/${encode(fx.photos[0].rel)}`);
  ok(one.CameraMake === 'ExampleCam' && one.Type === 'Photo' && one.UserData.IsFavorite === false, `${label}: the item`);
  const img = await c.media(`/Items/${encode(fx.photos[0].rel)}/Images/Primary`, 'GET', undefined, new URLSearchParams('maxHeight=360'));
  ok(img.status === 200 && (await img.arrayBuffer()).byteLength === fs.statSync(path.join(fx.dir, fx.photos[0].rel)).size, `${label}: Images/Primary`);
  const cover = await c.media(`/Items/${vac.Id}/Images/Primary`, 'GET', undefined, new URLSearchParams('maxHeight=240'));
  ok(cover.status === 200 && (await cover.arrayBuffer()).byteLength > 0, `${label}: an album cover`);
  return c;
}

// Local folder: only from the picker.
ok((await files.test({ protocol: 'local', url: path.join(tmp, 'elsewhere'), photos: true })).code === 'invalid', 'a typed local path is refused');
const local = await files.add({ protocol: 'local', url: fx.dir, name: 'Photos locales', photos: true });
const lc = await check('local', local);

// Incremental: one photo changed, one added, one removed; only the first two are read again.
const reads = [];
const open0 = lc.backend.open.bind(lc.backend);
lc.backend.open = (rel, range, head) => (reads.push(rel), open0(rel, range, head));
const changed = fx.photos[1].rel;
fs.writeFileSync(path.join(fx.dir, changed), pngPhoto(tiff({ original: '2011:11:11 11:11:11' }), 40, 30));
fs.writeFileSync(path.join(fx.dir, 'Montagne', 'NEW_0001.png'), pngPhoto(tiff({ original: '2010:01:01 10:00:00' }), 30, 40));
fs.rmSync(path.join(fx.dir, fx.photos[4].rel));
await lc.photos.rescan();
ok(JSON.stringify(reads.sort()) === JSON.stringify([changed, 'Montagne/NEW_0001.png'].sort()), `incremental rescan reads only what changed (${reads})`);
const after = await lc.request('GET', '/Users/u/Items', ALL);
ok(after.TotalRecordCount === fx.photos.length + 1 && after.Items.find((x) => x.Id === encode(changed))?.PremiereDate === '2011-11-11T11:11:11', 'the rescan sees the change, the new file and the removal');
ok((await lc.request('GET', '/Users/u/Items', { Recursive: true, Filters: 'IsFavorite' })).TotalRecordCount === 0, "a removed photo's favourite goes with it");
lc.backend.open = open0;
// The index survives a restart and answers at once.
files.flush();
const reopened = new B.FileSources(path.join(tmp, 'files'), vault, identity, fakeHost(), 'win32', () => false);
reopened.start();
const st2 = reopened.client(local.id).photos.status;
ok(st2.state === 'ready' && st2.count === fx.photos.length + 1, `the stored index is ready after a restart (${JSON.stringify(st2)})`);
reopened.shutdown();

// WebDAV (the mock, loopback only): the same answers, the heads read with Range requests.
const webdav = await files.add({ protocol: 'webdav', url: dav.base, user: 'demo', pass: 'demo', insecure: true, name: 'Photos WebDAV', photos: true });
// The tree changed above: the WebDAV view checks against a fresh one.
fs.rmSync(fx.dir, { recursive: true, force: true });
Object.assign(fx, buildPhotoTree(fx.dir, { today }));
await check('webdav', webdav);
ok(dav.state.ranges.some((r) => r.start === 0 && r.status === 206 && /IMG_/.test(r.path)), 'WebDAV heads are Range reads');
ok(!JSON.stringify(files.list()).includes('demo'), 'no credential in the source list');

// Remove: the index file goes too.
await files.remove(local.id);
ok(!fs.existsSync(path.join(tmp, 'files', `photos-${local.id}.json`)), 'remove deletes the index');
files.shutdown();
await dav.close();
Object.assign(console, saved);
// Privacy: no coordinate and no photo path in the log.
const text = logs.join('\n');
ok(!/48\.85|2\.29|45\.76|64\.14/.test(text) && !text.includes('IMG_'), 'no coordinate or photo path in the log');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`photo-files-check: ${n} checks passed`);
process.exit(0);
