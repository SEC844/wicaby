// The mocks' small music library (tools/mock-server/music-fixture.mjs, Android TV music stopgap) on Emby and Jellyfin:
// the "music" view, albums, album artists, an artist's and an album's tracks in play order, the A-Z bounds, and
// tracks that stream as WAV silence (every sample zero: nothing audible ever plays from a test).
// Usage: node tools/checks/music-mock-check.mjs   (starts both mocks with MOCK_MUSIC=1 on 8964/8965, then stops them)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const EMBY = 8964;
const JELLYFIN = 8965;
const DEVICE = 'Client="Wicaby", Device="check", DeviceId="music-check", Version="0"';

function start(script, port) {
  const child = spawn(process.execPath, [path.join(root, 'tools/mock-server', script), String(port)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_MUSIC: '1' } });
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`${script} exited (${code}): is port ${port} taken?`)));
    child.stdout.on('data', (d) => String(d).includes(`:${port}`) && resolve(child));
  });
}

async function flavour(name, base, login, tokenHeader, items, views, uid) {
  const r = await fetch(`${base}/Users/AuthenticateByName`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...login }, body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }) });
  assert.equal(r.status, 200, `${name}: sign-in`);
  const { AccessToken, User } = await r.json();
  const H = tokenHeader(AccessToken);
  const get = async (p) => {
    const res = await fetch(base + p, { headers: H });
    assert.equal(res.status, 200, `${name}: ${p}`);
    return res.json();
  };
  const lib = (await get(views(User.Id))).Items.find((v) => v.CollectionType === 'music');
  assert.ok(lib, `${name}: a music library`);
  const albums = (await get(items(User.Id, `ParentId=${lib.Id}&IncludeItemTypes=MusicAlbum&Recursive=true&SortBy=SortName`))).Items;
  assert.deepEqual(albums.map((a) => a.Name), ['Brume', 'Marée basse', 'Neon Avenue', 'Trois vents'], `${name}: albums by name`);
  const songs = await get(items(User.Id, `ParentId=${lib.Id}&IncludeItemTypes=Audio&Recursive=true&Limit=0`));
  assert.equal(songs.TotalRecordCount, 12, `${name}: every song of the library`);
  const artists = (await get(`/Artists/AlbumArtists?ParentId=${lib.Id}&SortBy=SortName&${uid}`)).Items;
  assert.deepEqual(artists.map((a) => a.Name), ['Les Ondes Calmes', 'Night Arcade', 'Zéphyr Trio'], `${name}: album artists`);
  assert.equal((await get(`/Artists/AlbumArtists?ParentId=${lib.Id}&NameLessThan=n&Limit=0&${uid}`)).TotalRecordCount, 1, `${name}: A-Z bound on artists`);
  const night = artists[1];
  const byArtist = (await get(items(User.Id, `ArtistIds=${night.Id}&IncludeItemTypes=Audio&Recursive=true&SortBy=Album,ParentIndexNumber,IndexNumber,SortName`))).Items;
  assert.deepEqual(byArtist.map((t) => t.Name), ['Insert Coin', 'High Score', 'Continue?', 'Game Over'], `${name}: an artist's tracks in album order`);
  const album = albums.find((a) => a.Name === 'Marée basse');
  const tracks = (await get(items(User.Id, `ParentId=${album.Id}&IncludeItemTypes=Audio&Recursive=true&SortBy=ParentIndexNumber,IndexNumber,SortName`))).Items;
  assert.deepEqual(tracks.map((t) => t.IndexNumber), [1, 2, 3], `${name}: an album's tracks by number`);
  assert.equal(tracks[0].Album, 'Marée basse', `${name}: a track names its album`);
  assert.ok(tracks[0].AlbumId && tracks[0].Artists?.length, `${name}: and its album id and artists`);

  const pbi = await fetch(`${base}/Items/${tracks[0].Id}/PlaybackInfo?UserId=${User.Id}`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' });
  const src = (await pbi.json()).MediaSources[0];
  assert.equal(src.Container, 'wav', `${name}: a WAV source`);
  assert.ok(src.SupportsDirectPlay, `${name}: played directly`);
  const wav = Buffer.from(await (await fetch(`${base}/Audio/${tracks[0].Id}/stream?static=true`, { headers: H })).arrayBuffer());
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF', `${name}: a WAV file`);
  assert.ok(wav.length > 44 && wav.subarray(44).every((b) => b === 0), `${name}: silence only`);
}

const children = [];
try {
  children.push(await start('mock-emby.mjs', EMBY), await start('mock-jellyfin.mjs', JELLYFIN));
  await flavour(
    'emby', `http://127.0.0.1:${EMBY}/emby`, { 'X-Emby-Authorization': `Emby ${DEVICE}` }, (t) => ({ 'X-Emby-Token': t }),
    (id, q) => `/Users/${id}/Items?${q}`, (id) => `/Users/${id}/Views`, 'UserId=u-wika',
  );
  await flavour(
    'jellyfin', `http://127.0.0.1:${JELLYFIN}`, { Authorization: `MediaBrowser ${DEVICE}` }, (t) => ({ Authorization: `MediaBrowser ${DEVICE}, Token="${t}"` }),
    (id, q) => `/Items?userId=${id}&${q}`, (id) => `/UserViews?userId=${id}`, 'userId=x',
  );
  console.log('music-mock-check: music view, albums, artists, track order, A-Z bounds and silent WAV streams OK on Emby and Jellyfin');
} finally {
  for (const c of children) c.kill();
}
