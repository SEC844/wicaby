// Photos spec PH-00: the mocks' generated photo libraries on Emby and Jellyfin. The skeleton query pages in
// DateCreated order, favourites, albums (recursive), /Years, the premiere-date bounds behind "on this day", EXIF as each
// server shapes it, a 90° asset's top marker (unrotated, then AutoOrient on Emby), the download permission, the
// 100,000-asset start and page times, and no committed binary photo.
// Usage: node tools/checks/photos-mock-check.mjs   (starts the mocks on 8978-8980, then stops them)
// Never prints a coordinate.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '../..');
const DEVICE = 'Client="Wicaby", Device="check", DeviceId="photos-check", Version="0"';
const COUNT = 600;
const TODAY = '2026-03-15';

function start(script, port, env = {}) {
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(root, 'tools/mock-server', script), String(port)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_PHOTOS: String(COUNT), MOCK_TODAY: TODAY, ...env } });
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`${script} exited (${code}): is port ${port} taken?`)));
    child.stdout.on('data', (d) => String(d).includes(`:${port}`) && resolve(Object.assign(child, { startMs: Date.now() - t0 })));
  });
}

// Our own PNG writer's output: 8-bit RGB, filter 0 on every row.
function decodePng(buf) {
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const idat = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o);
    if (buf.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const at = (x, y) => [...raw.subarray(y * (w * 3 + 1) + 1 + x * 3, y * (w * 3 + 1) + 4 + x * 3)];
  return { w, h, at };
}
const magenta = ([r, g, b]) => r === 255 && g === 0 && b === 255;

async function flavour(name, base, login, tokenHeader, items, views, years) {
  const r = await fetch(`${base}/Users/AuthenticateByName`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...login }, body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }) });
  assert.equal(r.status, 200, `${name}: sign-in`);
  const { AccessToken, User } = await r.json();
  const H = tokenHeader(AccessToken);
  const get = async (p) => {
    const res = await fetch(base + p, { headers: H });
    assert.equal(res.status, 200, `${name}: ${p}`);
    return res.json();
  };
  const all = (await get(views(User.Id))).Items;
  const lib = all.find((v) => v.Id === 'lib-photos');
  assert.equal(lib?.CollectionType, 'homevideos', `${name}: a homevideos photo library`);
  assert.equal(all.find((v) => v.Id === 'lib-photos-legacy')?.CollectionType, 'photos', `${name}: the legacy photos type`);

  // The skeleton query, in three pages.
  const skeleton = `ParentId=${lib.Id}&Recursive=true&IncludeItemTypes=Photo,Video&SortBy=DateCreated,SortName&SortOrder=Descending&Fields=PrimaryImageAspectRatio,Width,Height,DateCreated,PremiereDate&EnableUserData=true`;
  const pages = [];
  for (let start = 0; start < COUNT; start += 250) pages.push(await get(items(User.Id, `${skeleton}&StartIndex=${start}&Limit=250`)));
  assert.ok(pages.every((pg) => pg.TotalRecordCount === COUNT), `${name}: TotalRecordCount = MOCK_PHOTOS`);
  const assets = pages.flatMap((pg) => pg.Items);
  assert.equal(assets.length, COUNT, `${name}: every asset paged`);
  assert.ok(assets.every((a, i) => i === 0 || a.DateCreated <= assets[i - 1].DateCreated), `${name}: DateCreated descending across pages`);
  const photos = assets.filter((a) => a.Type === 'Photo');
  const videos = assets.filter((a) => a.Type === 'Video');
  assert.ok(videos.length > 5 && videos.every((v) => v.RunTimeTicks >= 5e7 && v.RunTimeTicks <= 6e8), `${name}: 5–60 s clips`);
  assert.ok(assets.some((a) => !a.PremiereDate), `${name}: some assets without PremiereDate`);
  const p = photos.find((a) => a.Latitude !== undefined);
  assert.ok(p, `${name}: geotagged photos`);
  assert.equal(p.CameraMake, 'Wicaby Test', `${name}: fake camera make`);
  assert.ok(Number.isFinite(p.Altitude) && Number.isFinite(p.Longitude), `${name}: altitude and longitude`);
  // APEX: Av = 2·log2(N) for N in 1.8…11 lies in 1.7…7.
  assert.ok(photos.every((a) => a.Aperture >= 1.6 && a.Aperture <= 7 && a.ExposureTime > 0), `${name}: Aperture in APEX units, ExposureTime in seconds`);
  const zoneless = name === 'jellyfin';
  assert.ok(assets.filter((a) => a.PremiereDate).every((a) => /Z$/.test(a.PremiereDate) !== zoneless), `${name}: PremiereDate ${zoneless ? 'wall-clock without a zone' : 'with Z'}`);
  assert.ok(assets.every((a) => /Z$/.test(a.DateCreated)), `${name}: DateCreated in UTC`);
  assert.equal(!!p.ImageBlurHashes, zoneless, `${name}: BlurHashes only on Jellyfin`);
  const pairs = assets.filter((a) => /^IMG_900\d$/.test(a.Name));
  assert.equal(pairs.length, 6, `${name}: three live-photo pairs`);

  const favs = await get(items(User.Id, `${skeleton}&Filters=IsFavorite`));
  assert.ok(favs.TotalRecordCount > 0 && favs.TotalRecordCount < COUNT / 4 && favs.Items.every((a) => a.UserData?.IsFavorite), `${name}: Filters=IsFavorite`);

  const albums = (await get(items(User.Id, `ParentId=${lib.Id}&IncludeItemTypes=PhotoAlbum&Recursive=false&SortBy=SortName`))).Items;
  assert.equal(albums.length, 6, `${name}: six albums`);
  const album = albums[0];
  const inAlbum = await get(items(User.Id, `ParentId=${album.Id}&Recursive=true&IncludeItemTypes=Photo,Video&Limit=1000`));
  assert.ok(inAlbum.TotalRecordCount > 0 && inAlbum.TotalRecordCount === album.ChildCount && inAlbum.Items.every((a) => a.ParentId === album.Id), `${name}: an album's assets`);

  const ys = (await get(years(User.Id, `ParentId=${lib.Id}&IncludeItemTypes=Photo&Recursive=true&SortBy=SortName&SortOrder=Descending`))).Items.map((y) => y.ProductionYear);
  assert.ok(ys.length >= 8 && ys[0] === 2026 && ys.at(-1) === 2014 && ys.every((y, i) => i === 0 || y < ys[i - 1]), `${name}: /Years`);

  // "On this day": today ±1 day, one year back, on the wall-clock month and day.
  for (const back of [1, 3, 7]) {
    const y = 2026 - back;
    const mem = await get(items(User.Id, `ParentId=${lib.Id}&Recursive=true&IncludeItemTypes=Photo,Video&MinPremiereDate=${y}-03-14T00:00:00&MaxPremiereDate=${y}-03-16T23:59:59&Limit=30`));
    const onDay = mem.Items.filter((a) => a.PremiereDate.slice(5, 10) === '03-15');
    assert.ok(onDay.length >= 7, `${name}: about 10 assets on this day ${back} year(s) ago (got ${onDay.length})`);
  }

  // A 90° asset: the marker on the expected side edge of the unrotated pixels.
  const side = photos.find((a) => a.ImageOrientation === 'RightTop');
  const other = photos.find((a) => a.ImageOrientation === 'LeftBottom');
  assert.ok(side && other && side.Width > side.Height, `${name}: 90° assets with unrotated Width/Height`);
  const png = async (id, extra = '') => decodePng(Buffer.from(await (await fetch(`${base}/Items/${id}/Images/Primary?maxHeight=120&tag=x${extra}`)).arrayBuffer()));
  const a = await png(side.Id);
  assert.ok(a.w > a.h && magenta(a.at(0, a.h >> 1)) && !magenta(a.at(a.w >> 1, 0)), `${name}: RightTop marker on the left edge`);
  const b = await png(other.Id);
  assert.ok(magenta(b.at(b.w - 1, b.h >> 1)) && !magenta(b.at(0, b.h >> 1)), `${name}: LeftBottom marker on the right edge`);
  const c = await png(side.Id, '&AutoOrient=true');
  if (name === 'emby') assert.ok(c.h > c.w && magenta(c.at(c.w >> 1, 0)), 'emby: AutoOrient=true answers upright pixels');
  else assert.ok(c.w > c.h, 'jellyfin: no AutoOrient');
  const up = await png(photos.find((x) => x.ImageOrientation === 'TopLeft').Id);
  assert.ok(magenta(up.at(up.w >> 1, 0)) && !magenta(up.at(0, up.h >> 1)), `${name}: an upright photo's marker on top`);

  return { H, side };
}

const children = [];
try {
  const [emby, jelly] = await Promise.all([start('mock-emby.mjs', 8978, { MOCK_NO_DOWNLOAD: '1' }), start('mock-jellyfin.mjs', 8979)]);
  children.push(emby, jelly);
  const e = await flavour(
    'emby', 'http://127.0.0.1:8978/emby', { 'X-Emby-Authorization': `Emby ${DEVICE}` }, (t) => ({ 'X-Emby-Token': t }),
    (id, q) => `/Users/${id}/Items?${q}`, (id) => `/Users/${id}/Views`, (id, q) => `/Years?UserId=${id}&${q}`,
  );
  const j = await flavour(
    'jellyfin', 'http://127.0.0.1:8979', { Authorization: `MediaBrowser ${DEVICE}` }, (t) => ({ Authorization: `MediaBrowser ${DEVICE}, Token="${t}"` }),
    (id, q) => `/Items?userId=${id}&${q}`, (id) => `/UserViews?userId=${id}`, (id, q) => `/Years?userId=${id}&${q}`,
  );
  assert.equal((await fetch(`http://127.0.0.1:8978/emby/Items/${e.side.Id}/Download`, { headers: e.H })).status, 403, 'emby: MOCK_NO_DOWNLOAD=1 refuses the original');
  const dl = await fetch(`http://127.0.0.1:8979/Items/${j.side.Id}/Download`, { headers: j.H });
  assert.ok(dl.status === 200 && dl.headers.get('content-type') === 'image/png', 'jellyfin: the original downloads');
  for (const c of children.splice(0)) c.kill();

  // AC 2: 100,000 assets start in under 3 s and answer a 1,000-item page in under 300 ms.
  const big = await start('mock-emby.mjs', 8980, { MOCK_PHOTOS: '100000' });
  children.push(big);
  assert.ok(big.startMs < 3000, `100k start in ${big.startMs} ms`);
  const login = await (await fetch('http://127.0.0.1:8980/emby/Users/AuthenticateByName', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': `Emby ${DEVICE}` }, body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }) })).json();
  const url = `http://127.0.0.1:8980/emby/Users/${login.User.Id}/Items?ParentId=lib-photos&Recursive=true&IncludeItemTypes=Photo,Video&SortBy=DateCreated,SortName&SortOrder=Descending&StartIndex=50000&Limit=1000`;
  await fetch(url, { headers: { 'X-Emby-Token': login.AccessToken } }).then((r) => r.json());
  const t0 = performance.now();
  const page = await fetch(url, { headers: { 'X-Emby-Token': login.AccessToken } }).then((r) => r.json());
  const ms = Math.round(performance.now() - t0);
  assert.ok(page.TotalRecordCount === 100000 && page.Items.length === 1000, '100k: a full page');
  assert.ok(ms < 300, `100k: a 1,000-item page in ${ms} ms`);

  // AC 3: no binary photo committed under the mock server.
  const binaries = execFileSync('git', ['ls-files', 'tools/mock-server'], { cwd: root, encoding: 'utf8' }).split('\n').filter((f) => /\.(jpe?g|heic|png|dng)$/i.test(f) && /photo/i.test(f));
  assert.deepEqual(binaries, [], 'no committed binary photo');

  console.log(`photos-mock-check: skeleton paging, favourites, albums, /Years, on-this-day bounds, EXIF shapes, orientation markers and downloads OK on Emby and Jellyfin; 100k start ${big.startMs} ms, page ${ms} ms`);
} finally {
  for (const c of children) c.kill();
}
