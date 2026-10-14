// The mocks' music library (music-spec MU-00, tools/mock-server/music-fixture.mjs) on Emby and Jellyfin: the
// "music" view, albums, artists vs album artists, A-Z bounds, track order across discs, the music filters and
// sorts, genres, instant mix on each server's routes, audio playlists, silent streams (WAV and the ReplayGain-tagged
// FLAC), PlaybackInfo, loudness, lyrics in each server's shape, the Mock/State music log and Jellyfin's LEGACY tags.
// AC1 routes and shapes, AC2 legacy user route, AC3 silent WAV whose length matches RunTimeTicks, AC4 synced lyrics.
// Usage: node tools/checks/music-mock-check.mjs   (starts both mocks with MOCK_MUSIC=1 on 8964/8965, then stops them)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseLrc } from '../../apps/desktop/src/shared/music.ts';

const root = path.resolve(import.meta.dirname, '../..');
const EMBY = 8964;
const JELLYFIN = 8965;
const DEVICE = 'Client="Wicaby", Device="check", DeviceId="music-check", Version="0"';
const TICKS_S = 10_000_000;
const out = { emby: [], jellyfin: [] };
// The Jellyfin mock's log line for a call (stdout lands a moment after the answer).
async function logged(prefix) {
  for (let i = 0; i < 40; i++) {
    if (out.jellyfin.some((l) => l.startsWith(prefix))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function start(script, port, name) {
  const child = spawn(process.execPath, [path.join(root, 'tools/mock-server', script), String(port)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, MOCK_MUSIC: '1' } });
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`${script} exited (${code}): is port ${port} taken?`)));
    child.stdout.on('data', (d) => {
      out[name].push(...String(d).split('\n'));
      if (String(d).includes(`:${port}`)) resolve(child);
    });
  });
}

// FLAC written by the mock: STREAMINFO, the Vorbis comments, then frames that are one CONSTANT subframe of 0 each
// with valid CRCs. Returns { samples, tags, frames }.
function readFlac(b) {
  assert.equal(b.toString('ascii', 0, 4), 'fLaC');
  let at = 4;
  let samples = 0;
  const tags = {};
  for (let last = false; !last; ) {
    last = Boolean(b[at] & 0x80);
    const type = b[at] & 0x7f;
    const len = b.readUIntBE(at + 1, 3);
    const data = b.subarray(at + 4, at + 4 + len);
    if (type === 0) samples = Number(data.readBigUInt64BE(10) & 0xfffffffffn);
    if (type === 4) {
      let p = 4 + data.readUInt32LE(0);
      const n = data.readUInt32LE(p);
      p += 4;
      for (let i = 0; i < n; i++) {
        const l = data.readUInt32LE(p);
        const [k, v] = data.toString('utf8', p + 4, p + 4 + l).split('=');
        tags[k] = v;
        p += 4 + l;
      }
    }
    at += 4 + len;
  }
  const crc16 = (buf) => buf.reduce((c, byte) => {
    c ^= byte << 8;
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
    return c;
  }, 0);
  let frames = 0;
  let decoded = 0;
  while (at < b.length) {
    assert.equal(b.readUInt16BE(at), 0xfff8, 'frame sync');
    const size = b.readUInt16BE(at + 5) + 1;
    assert.deepEqual([...b.subarray(at + 8, at + 11)], [0, 0, 0], 'a CONSTANT subframe of value 0');
    assert.equal(b.readUInt16BE(at + 11), crc16(b.subarray(at, at + 11)), 'frame CRC-16');
    decoded += size;
    frames++;
    at += 13;
  }
  assert.equal(decoded, samples, 'frames hold every sample');
  return { samples, tags, frames };
}

async function flavour(name, base, login, tokenHeader, items, views, uid, userQuery) {
  const jellyfin = name === 'jellyfin';
  const r = await fetch(`${base}/Users/AuthenticateByName`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...login }, body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }) });
  assert.equal(r.status, 200, `${name}: sign-in`);
  const { AccessToken, User } = await r.json();
  const H = tokenHeader(AccessToken);
  const call = (p, init = {}) => fetch(base + p, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const get = async (p, status = 200) => {
    const res = await call(p);
    assert.equal(res.status, status, `${name}: ${p}`);
    return status === 200 ? res.json() : null;
  };
  const names = (list) => list.Items.map((x) => x.Name);
  const lib = (await get(views(User.Id))).Items.find((v) => v.CollectionType === 'music');
  assert.ok(lib, `${name}: a music library`);
  const q = (s) => items(User.Id, s);

  // Albums, songs, artists and album artists, A-Z.
  assert.deepEqual(names(await get(q(`ParentId=${lib.Id}&IncludeItemTypes=MusicAlbum&Recursive=true&SortBy=SortName`))), ['Brume', 'Compilation Graphite', 'Gain', 'Lignes claires', 'Marée basse', 'Neon Avenue', 'Seule', 'Suites en deux temps', 'Trois vents'], `${name}: albums by name`);
  assert.equal((await get(q(`ParentId=${lib.Id}&IncludeItemTypes=Audio&Recursive=true&Limit=0`))).TotalRecordCount, 39, `${name}: every song of the library`);
  const albumArtists = await get(`/Artists/AlbumArtists?ParentId=${lib.Id}&SortBy=SortName&${uid}`);
  assert.deepEqual(names(albumArtists), ['Divers artistes', 'Ensemble Quartz', 'Les Graphites', 'Les Ondes Calmes', 'Night Arcade', 'Nora Vale', 'Zéphyr Trio'], `${name}: album artists`);
  assert.deepEqual(names(await get(`/Artists?ParentId=${lib.Id}&SortBy=SortName&${uid}`)).filter((n) => !albumArtists.Items.some((a) => a.Name === n)), ['Basse Fidèle', 'Kaolin', 'Mira Sol'], `${name}: track artists are artists, not album artists`);
  assert.equal((await get(`/Artists/AlbumArtists?ParentId=${lib.Id}&NameLessThan=n&Limit=0&${uid}`)).TotalRecordCount, 4, `${name}: A-Z bound on artists`);
  const artist = (n) => albumArtists.Items.find((a) => a.Name === n);
  assert.deepEqual(names(await get(q(`ArtistIds=${artist('Night Arcade').Id}&IncludeItemTypes=Audio&Recursive=true&SortBy=Album,ParentIndexNumber,IndexNumber,SortName`))), ['Insert Coin', 'High Score', 'Continue?', 'Game Over'], `${name}: an artist's tracks in album order`);

  // Two discs in play order; album tracks name their album and artists.
  const albums = (await get(q(`ParentId=${lib.Id}&IncludeItemTypes=MusicAlbum&Recursive=true`))).Items;
  const album = (n) => albums.find((a) => a.Name === n);
  const suite = await get(q(`ParentId=${album('Suites en deux temps').Id}&IncludeItemTypes=Audio&Recursive=true&SortBy=ParentIndexNumber,IndexNumber,SortName`));
  assert.equal(suite.TotalRecordCount, 12, `${name}: 2 × 6 tracks`);
  assert.deepEqual(suite.Items.map((t) => `${t.ParentIndexNumber}.${t.IndexNumber}`), [1, 2].flatMap((d) => [1, 2, 3, 4, 5, 6].map((n) => `${d}.${n}`)), `${name}: disc then track order`);
  const tracks = (await get(q(`ParentId=${album('Marée basse').Id}&IncludeItemTypes=Audio&Recursive=true&SortBy=ParentIndexNumber,IndexNumber,SortName&Fields=MediaSources`))).Items;
  assert.deepEqual(tracks.map((t) => t.IndexNumber), [1, 2, 3], `${name}: an album's tracks by number`);
  assert.equal(tracks[0].Album, 'Marée basse', `${name}: a track names its album`);
  assert.ok(tracks[0].AlbumId && tracks[0].Artists?.length && tracks[0].AlbumArtists?.length && tracks[0].ArtistItems?.length && tracks[0].AlbumPrimaryImageTag, `${name}: and its album id, artists and art`);

  // Music filters and sorts.
  const nora = artist('Nora Vale').Id;
  assert.deepEqual(names(await get(q(`AlbumArtistIds=${nora}&IncludeItemTypes=MusicAlbum&Recursive=true&SortBy=SortName`))), ['Lignes claires', 'Seule'], `${name}: AlbumArtistIds`);
  // The artist page (desktop, Android TV): ArtistIds on albums is the album artist's own and the ones they appear on.
  assert.deepEqual(names(await get(q(`ArtistIds=${nora}&IncludeItemTypes=MusicAlbum&Recursive=true&SortBy=SortName`))), ['Compilation Graphite', 'Lignes claires', 'Seule'], `${name}: ArtistIds on albums`);
  assert.deepEqual(names(await get(q(`ArtistIds=${artist('Divers artistes').Id}&IncludeItemTypes=MusicAlbum&Recursive=true`))), ['Compilation Graphite'], `${name}: ArtistIds takes the album artist`);
  assert.deepEqual(names(await get(q(`ContributingArtistIds=${nora}&IncludeItemTypes=MusicAlbum&Recursive=true`))), ['Compilation Graphite'], `${name}: ContributingArtistIds (appears on)`);
  assert.deepEqual(names(await get(q(`GenreIds=genre-classique&IncludeItemTypes=MusicAlbum&Recursive=true&SortBy=SortName`))), ['Suites en deux temps', 'Trois vents'], `${name}: GenreIds`);
  assert.equal((await get(q(`AlbumIds=${album('Gain').Id}&IncludeItemTypes=Audio&Recursive=true`))).TotalRecordCount, 3, `${name}: AlbumIds`);
  assert.equal((await get(q(`Filters=IsFavorite&IncludeItemTypes=Audio&Recursive=true`))).TotalRecordCount, 2, `${name}: favourite tracks`);
  assert.deepEqual(names(await get(q(`IncludeItemTypes=Audio&Recursive=true&SortBy=PlayCount&SortOrder=Descending&Limit=2`))), ['Insert Coin', 'High Score'], `${name}: most played`);
  assert.equal((await get(q(`ParentId=${lib.Id}&IncludeItemTypes=Audio&Recursive=true&SortBy=Random&Limit=5`))).Items.length, 5, `${name}: random sort`);

  // Genres: Emby /MusicGenres, Jellyfin /Genres?IncludeItemTypes=MusicAlbum (its /MusicGenres is deprecated).
  const genres = await get(jellyfin ? `/Genres?includeItemTypes=MusicAlbum&parentId=${lib.Id}&userId=${User.Id}` : `/MusicGenres?ParentId=${lib.Id}&UserId=${User.Id}`);
  assert.deepEqual(names(genres).sort(), ['Chanson', 'Classique', 'Électro'], `${name}: music genres`);
  if (jellyfin) {
    await get(`/MusicGenres?parentId=${lib.Id}`);
    assert.ok(await logged('DEPRECATED GET /MusicGenres'), 'jellyfin: /MusicGenres logged DEPRECATED');
  }

  // Instant mix: /Items/{id}/InstantMix on both; the per-type routes as each server has them.
  const seed = tracks[0];
  const mix = await get(`/Items/${seed.Id}/InstantMix?${userQuery(User.Id)}&Limit=100`);
  assert.ok(mix.Items.length > 1 && mix.Items[0].Id === seed.Id && mix.Items.every((t) => t.Type === 'Audio'), `${name}: instant mix from a track`);
  await get(`/Albums/${album('Brume').Id}/InstantMix?${userQuery(User.Id)}`);
  await get(`/MusicGenres/Classique/InstantMix?${userQuery(User.Id)}`);
  await get(`/Artists/InstantMix?Id=${nora}&${userQuery(User.Id)}`, jellyfin ? 404 : 200);
  await get(`/Artists/${nora}/InstantMix?${userQuery(User.Id)}`, jellyfin ? 200 : 404);

  // Audio playlists: create (query, and Jellyfin's body), add, move, remove.
  const created = await (await call(`/Playlists?Name=Test&Ids=${tracks[0].Id}&MediaType=Audio&${userQuery(User.Id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Name: 'Test', Ids: [tracks[0].Id], MediaType: 'Audio' }) })).json();
  assert.ok(created.Id, `${name}: playlist created`);
  assert.equal((await call(`/Playlists/${created.Id}/Items?Ids=${tracks[1].Id},${tracks[2].Id}&${userQuery(User.Id)}`, { method: 'POST' })).status, 204);
  let entries = (await get(`/Playlists/${created.Id}/Items?${userQuery(User.Id)}`)).Items;
  assert.deepEqual(entries.map((e) => e.Id), tracks.map((t) => t.Id), `${name}: playlist entries`);
  assert.equal((await call(`/Playlists/${created.Id}/Items/${entries[2].PlaylistItemId}/Move/0`, { method: 'POST' })).status, 204);
  assert.equal((await call(`/Playlists/${created.Id}/Items?EntryIds=${entries[0].PlaylistItemId}`, { method: 'DELETE' })).status, 204);
  entries = (await get(`/Playlists/${created.Id}/Items?${userQuery(User.Id)}`)).Items;
  assert.deepEqual(entries.map((e) => e.Id), [tracks[2].Id, tracks[1].Id], `${name}: moved and removed`);

  // The static stream as Emby answers it: 400 without a DeviceId (Jellyfin does not ask), 400 for a MediaSourceId the
  // track does not have (an Emby source id is not the item id; Jellyfin takes the item id), 200 with the track's own.
  const dev = 'DeviceId=music-check';
  const source = tracks[0].MediaSources?.[0]?.Id;
  assert.ok(source, `${name}: tracks list their MediaSources when asked (Fields=MediaSources)`);
  assert.equal((await call(`/Audio/${tracks[0].Id}/stream?static=true&MediaSourceId=${source}`)).status, jellyfin ? 200 : 400, `${name}: a stream without a DeviceId`);
  assert.equal((await call(`/Audio/${tracks[0].Id}/stream?static=true&MediaSourceId=${tracks[0].Id}&${dev}`)).status, jellyfin ? 200 : 400, `${name}: the item id as MediaSourceId`);
  assert.equal((await call(`/Audio/${tracks[0].Id}/stream?static=true&MediaSourceId=nope&${dev}`)).status, 400, `${name}: an unknown MediaSourceId`);
  // AC3: a 20 s track is a WAV of silence whose length matches RunTimeTicks within 50 ms.
  const wav = Buffer.from(await (await call(`/Audio/${tracks[0].Id}/stream?static=true&mediaSourceId=${source}&${dev}&PlaySessionId=p0`)).arrayBuffer());
  assert.equal(wav.toString('ascii', 0, 4) + wav.toString('ascii', 8, 12), 'RIFFWAVE', `${name}: a WAV file`);
  const rate = wav.readUInt32LE(28);
  assert.ok(wav.length >= 44 + 65536 && wav.subarray(44, 44 + 65536).every((b) => b === 0), `${name}: 64 KB of silence`);
  assert.ok(wav.subarray(44).every((b) => b === 0), `${name}: silence only`);
  assert.ok(Math.abs(((wav.length - 44) / rate) * 1000 - tracks[0].RunTimeTicks / 10_000) <= 50, `${name}: length matches RunTimeTicks`);
  const part = await call(`/Audio/${tracks[0].Id}/stream.wav?${dev}`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(part.status, 206, `${name}: Range`);
  // The ReplayGain album: silent FLAC with track and album gain tags.
  const gain = (await get(q(`ParentId=${album('Gain').Id}&IncludeItemTypes=Audio&Recursive=true&SortBy=ParentIndexNumber,IndexNumber`))).Items;
  const flac = readFlac(Buffer.from(await (await call(`/Audio/${gain[0].Id}/stream.flac?static=true&${dev}`)).arrayBuffer()));
  assert.equal(flac.samples, (gain[0].RunTimeTicks / TICKS_S) * 8000, `${name}: FLAC length`);
  assert.match(flac.tags.REPLAYGAIN_TRACK_GAIN, /^-\d+\.\d\d dB$/, `${name}: track gain tag`);
  assert.match(flac.tags.REPLAYGAIN_ALBUM_GAIN, /^-\d+\.\d\d dB$/, `${name}: album gain tag`);
  // Universal: Emby wants a PlaySessionId (spec §3.4), Jellyfin does not.
  assert.equal((await call(`/Audio/${tracks[1].Id}/universal?${userQuery(User.Id)}&Container=mp3`)).status, jellyfin ? 200 : 400, `${name}: universal without a PlaySessionId`);
  assert.equal((await call(`/Audio/${tracks[1].Id}/universal?${userQuery(User.Id)}&PlaySessionId=p1`)).status, 200, `${name}: universal`);
  const state = await (await fetch(`${base.replace(/\/emby$/, '')}/Mock/State`)).json();
  assert.ok(state.music.streams.some((s) => s.id === gain[0].Id && s.container === 'flac' && s.static), `${name}: streams logged in Mock/State`);
  assert.ok(state.music.instantMix.some((m) => m.id === seed.Id && m.route === `/Items/${seed.Id}/InstantMix`), `${name}: instant mix logged`);

  // PlaybackInfo: direct play of the WAV and the FLAC.
  for (const [t, container] of [[tracks[0], 'wav'], [gain[0], 'flac']]) {
    const pbi = await call(`/Items/${t.Id}/PlaybackInfo?${userQuery(User.Id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const src = (await pbi.json()).MediaSources[0];
    assert.equal(src.Container, container, `${name}: a ${container} source`);
    assert.ok(src.SupportsDirectPlay, `${name}: played directly`);
  }

  // Loudness: Jellyfin NormalizationGain on tracks and albums; Emby none (spec §3.6).
  const one = await get(jellyfin ? `/Items/${tracks[0].Id}?userId=${User.Id}` : `/Users/${User.Id}/Items/${tracks[0].Id}`);
  const oneAlbum = await get(jellyfin ? `/Items/${tracks[0].AlbumId}?userId=${User.Id}` : `/Users/${User.Id}/Items/${tracks[0].AlbumId}`);
  if (jellyfin) assert.ok(typeof one.NormalizationGain === 'number' && one.NormalizationGain < 0 && typeof oneAlbum.NormalizationGain === 'number', 'jellyfin: NormalizationGain');
  else assert.ok(one.NormalizationGain === undefined && oneAlbum.NormalizationGain === undefined, 'emby: no NormalizationGain');
  assert.ok(!Object.keys(one).some((k) => k.startsWith('_')), `${name}: no fixture-private field`);

  // Lyrics. AC4: the synced fixture parses to ≥ 10 timed lines with strictly increasing starts.
  const lyricAlbum = (await get(q(`ParentId=${album('Lignes claires').Id}&IncludeItemTypes=Audio&Recursive=true&SortBy=ParentIndexNumber,IndexNumber&Fields=MediaStreams`))).Items;
  const single = (await get(q(`ParentId=${album('Seule').Id}&IncludeItemTypes=Audio&Recursive=true`))).Items[0];
  let synced;
  if (jellyfin) {
    assert.ok(lyricAlbum.every((t) => t.HasLyrics === true) && tracks[0].HasLyrics === false, 'jellyfin: HasLyrics');
    const dto = await get(`/Audio/${lyricAlbum[0].Id}/Lyrics`);
    assert.equal(dto.Metadata.IsSynced, true);
    synced = dto.Lyrics.map((l) => ({ startMs: l.Start / 10_000, text: l.Text }));
    const plain = await get(`/Audio/${single.Id}/Lyrics`);
    assert.ok(plain.Metadata.IsSynced === false && plain.Lyrics.every((l) => l.Start === undefined), 'jellyfin: plain lyrics');
    await get(`/Audio/${tracks[0].Id}/Lyrics`, 404);
    assert.ok(!lyricAlbum[0].MediaStreams?.some((s) => s.Type === 'Subtitle'), 'jellyfin: no Emby-style lyric stream');
  } else {
    // Emby (unverified shape, spec §3.5): an external lrc subtitle stream on the audio item.
    const stream = lyricAlbum[0].MediaStreams.find((s) => s.Type === 'Subtitle');
    assert.equal(stream?.Codec, 'lrc', 'emby: the lrc stream');
    const lrc = await (await call(`/Videos/${lyricAlbum[0].Id}/${lyricAlbum[0].Id}/Subtitles/${stream.Index}/Stream.lrc`)).text();
    synced = parseLrc(lrc).lines;
    const txt = await (await call(`/Videos/${single.Id}/${single.Id}/Subtitles/1/Stream.txt`)).text();
    assert.equal(parseLrc(txt).synced, false, 'emby: plain lyrics');
    await get(`/Audio/${lyricAlbum[0].Id}/Lyrics`, 404);
  }
  assert.ok(synced.length >= 10 && synced.every((l, i) => i === 0 || l.startMs > synced[i - 1].startMs), `${name}: ≥ 10 timed lines, strictly increasing`);

  // AC2: Jellyfin 12 refuses the obsolete user route, tagged LEGACY; /Items?userId= answers.
  if (jellyfin) {
    await get(`/Users/${User.Id}/Items?IncludeItemTypes=Audio`, 404);
    assert.ok(await logged('LEGACY user route GET /Users/'), 'jellyfin: tagged LEGACY');
  }
}

const children = [];
try {
  children.push(await start('mock-emby.mjs', EMBY, 'emby'), await start('mock-jellyfin.mjs', JELLYFIN, 'jellyfin'));
  await flavour(
    'emby', `http://127.0.0.1:${EMBY}/emby`, { 'X-Emby-Authorization': `Emby ${DEVICE}` }, (t) => ({ 'X-Emby-Token': t }),
    (id, q) => `/Users/${id}/Items?${q}`, (id) => `/Users/${id}/Views`, 'UserId=u-wika', (id) => `UserId=${id}`,
  );
  await flavour(
    'jellyfin', `http://127.0.0.1:${JELLYFIN}`, { Authorization: `MediaBrowser ${DEVICE}` }, (t) => ({ Authorization: `MediaBrowser ${DEVICE}, Token="${t}"` }),
    (id, q) => `/Items?userId=${id}&${q}`, (id) => `/UserViews?userId=${id}`, 'userId=x', (id) => `userId=${id}`,
  );
  console.log('music-mock-check: library, artists, discs, filters, genres, instant mix, playlists, silent WAV/FLAC streams, loudness, lyrics and legacy tags OK on Emby and Jellyfin');
} finally {
  for (const c of children) c.kill();
}
