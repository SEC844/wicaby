// The Navidrome (OpenSubsonic) dialect on the desktop (music-feishin-navidrome spec §4.B, MU-N0 to MU-N2):
// - the shared vectors (fixtures/subsonic/vectors.json, also read by Android's SubsonicVectorsTest): token auth, ids,
//   the album list a library query asks for, the scrobble threshold, lyrics, a song record, log redaction;
// - the real SubsonicClient (bundled for Node, Electron stubbed) against tools/mock-server/mock-navidrome.mjs on
//   loopback: views, albums paged with an exact total, favourites, an album's tracks, artists, genres, the songs tab,
//   search, star/unstar by kind, playlists (list, entries, add, remove, move, create, another user's: 403), the
//   scrobble rule (now playing, one submission per play past the threshold), lyrics (OpenSubsonic and plain
//   Subsonic), instant mix, PlaybackInfo, the media paths (no credential in what the renderer gets) and the signed
//   stream, error codes 40 and 41, an unmapped route; then /Mock/State has no tag and no socket left loopback.
// Usage: node tools/checks/subsonic-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startMockNavidrome } from '../mock-server/mock-navidrome.mjs';
import { electronStub, identity, quiet, refused } from './plex-bundle.mjs';

const desktop = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop', 'src');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-subsonic-')), 'subsonic.mjs');
await build({
  stdin: {
    contents: ["export * from './shared/subsonic/map';", "export { SubsonicClient, SubsonicError, subsonicAuth } from './main/connection/subsonic-client';", "export { redact } from './main/core/log';", "export { musicViews, musicSources } from './shared/music-source';", "export { ConnectionManager } from './main/connection/connection-manager';", "export { t } from './main/i18n';"].join('\n'),
    resolveDir: desktop,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  plugins: [electronStub],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const F = await import(pathToFileURL(out).href);
const V = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'subsonic', 'vectors.json'), 'utf8'));
let n = 0;
const ok = (c, msg) => (assert.ok(c, msg), n++);
const eq = (a, b, msg) => (assert.deepEqual(a, b, msg), n++);

// ---- Vectors ----
for (const v of V.auth) eq(F.subsonicAuth('u', v.password, v.salt).t, v.token, `auth ${v.name}`);
const a1 = F.subsonicAuth('wika', 'x');
const a2 = F.subsonicAuth('wika', 'x');
ok(a1.s !== a2.s && a1.s.length >= 12 && !('p' in a1) && a1.f === 'json', 'a fresh salt per request, never p=, JSON');
for (const v of V.ids) {
  eq(F.encodeId(v.kind, v.raw), v.id, `encode ${v.raw}`);
  eq(F.decodeId(v.id), { kind: v.kind, raw: v.raw }, `decode ${v.id}`);
  ok(/^[A-Za-z0-9_-]{1,64}$/.test(v.id), `${v.id} fits the cast relay`);
}
for (const bad of V.badIds) eq(F.decodeId(bad), null, `bad id ${JSON.stringify(bad)}`);
for (const v of V.albumList) eq(F.albumListArgs(v.query), v.args, `album list ${JSON.stringify(v.query)}`);
for (const v of V.scrobble) eq(F.scrobbleDue(v.positionS * 1e7, v.runTimeS * 1e7), v.due, `scrobble ${v.positionS}/${v.runTimeS}`);
for (const v of V.lyrics) eq(F.lyricsToJellyfin(v.structured, v.legacy), v.expected, `lyrics ${v.name}`);
{
  const s = F.songItem(V.song.record);
  const e = V.song.expected;
  for (const k of ['Id', 'Name', 'Type', 'MediaType', 'Album', 'AlbumId', 'IndexNumber', 'ParentIndexNumber', 'RunTimeTicks', 'Container', 'NormalizationGain']) eq(s[k], e[k], `song ${k}`);
  eq([s.ImageTags.Primary, s.UserData.IsFavorite, s.UserData.PlayCount, s.ArtistItems[0].Id], [e.Primary, e.IsFavorite, e.PlayCount, e.ArtistId], 'song art, star, plays, artist');
  ok(s.MediaSources[0].Id === s.Id && s.MediaSources[0].SupportsDirectPlay, 'song direct-play source');
}
for (const v of V.redact) eq(F.redact(v.input), v.expected, `redact ${v.input}`);
for (const v of V.musicSource) eq(F.musicViews(V.musicSourceViews, v.source).map((x) => x.Id), v.expected, `music source: ${v.name}`);
eq(F.musicSources(V.musicSourceViews), ['emby1', 'nd1'], 'music sources: servers with a music library');

// ---- Against the mock ----
const mock = await startMockNavidrome({ port: 0, quiet: true });
const plain = await startMockNavidrome({ port: 0, quiet: true, env: { MOCK_ND_NO_EXT: '1' } });
try {
  await quiet(async () => {
    const api = new F.SubsonicClient(mock.url, identity, 'mock-pass', 'wika');
    const get = (p, q) => api.request('GET', p, q);
    const state = async () => (await (await fetch(`${mock.url}/Mock/State`)).json())['subsonic-response'];

    const views = await get('/Users/wika/Views');
    eq(views.Items.map((v) => [v.Id, v.CollectionType]), [['mf_1', 'music']], 'one music view per folder');
    eq((await get('/UserViews', { userId: 'wika' })).Items.length, 1, 'Jellyfin form too');
    eq((await get('/Users/wika/Items/Resume', { Limit: 24 })).Items, [], 'no resume row');
    eq((await get('/Shows/NextUp')).Items, [], 'no next up');
    ok((await get('/Users/wika/Items/Latest', { ParentId: 'mf_1', Limit: 3 })).length === 3, 'latest albums');

    // Albums, paged, with the exact total.
    const q = { ParentId: 'mf_1', IncludeItemTypes: 'MusicAlbum', Recursive: true, SortBy: 'SortName', SortOrder: 'Ascending' };
    const p1 = await get('/Users/wika/Items', { ...q, StartIndex: 0, Limit: 5 });
    const p2 = await get('/Users/wika/Items', { ...q, StartIndex: 5, Limit: 5 });
    eq([p1.Items.length, p2.Items.length, p1.TotalRecordCount], [5, 4, 9], 'albums 5 + 4 of 9');
    const names = [...p1.Items, ...p2.Items].map((x) => x.Name);
    eq(names, [...names].sort((a, b) => a.localeCompare(b, 'fr')), 'sorted by name');
    ok(p1.Items.every((x) => x.Type === 'MusicAlbum' && x.Id.startsWith('al_') && x.AlbumArtists.length === 1), 'album shape');
    const fav = await get('/Users/wika/Items', { ...q, Filters: 'IsFavorite' });
    eq(fav.Items.map((x) => x.Id), ['al_album-0-0'], 'favourite albums');
    eq((await get('/Users/wika/Items', { ...q, Genres: 'Classique' })).TotalRecordCount, 2, 'albums of a genre');
    eq((await get('/Users/wika/Items', { ...q, Years: '2020,2021,2022,2023,2024,2025,2026,2027,2028,2029', Limit: 100 })).TotalRecordCount, 8, 'albums of a decade');

    // An album's tracks, an item, artists, genres, songs, search.
    const suites = await get('/Users/wika/Items', { ParentId: 'al_album-4-0', SortBy: 'ParentIndexNumber,IndexNumber' });
    eq([suites.Items.length, suites.Items[6].ParentIndexNumber, suites.Items[6].IndexNumber], [12, 2, 1], '2-disc album');
    const track = await get('/Users/wika/Items/tr_track-3-0-0');
    eq([track.Name, track.Type, track.AlbumId, track.UserData.IsFavorite], ['Fil', 'Audio', 'al_album-3-0', true], 'a track');
    const gain = await get('/Items/tr_track-5-0-0', { userId: 'wika' });
    ok(typeof gain.NormalizationGain === 'number' && gain.Container === 'flac', 'ReplayGain as NormalizationGain');
    const artist = await get('/Users/wika/Items/ar_artist-3');
    ok(artist.Name === 'Nora Vale' && /inventé/.test(artist.Overview ?? '') && !/<b>/.test(artist.Overview), 'artist biography as text');
    const aa = await get('/Artists/AlbumArtists', { ParentId: 'mf_1', SortBy: 'SortName', StartIndex: 0, Limit: 3 });
    ok(aa.Items.length === 3 && aa.TotalRecordCount >= 6, 'album artists paged');
    eq((await get('/Artists/AlbumArtists', { ParentId: 'mf_1', NameStartsWith: 'N' })).Items.map((x) => x.Name).sort(), ['Night Arcade', 'Nora Vale'], 'A-Z rail');
    eq((await get('/MusicGenres', { ParentId: 'mf_1' })).Items.map((g) => g.Name), ['Chanson', 'Classique', 'Électro'], 'genres');
    const artistAlbums = await get('/Users/wika/Items', { ParentId: 'mf_1', IncludeItemTypes: 'MusicAlbum', AlbumArtistIds: 'ar_artist-3', Recursive: true });
    eq(artistAlbums.Items.map((x) => x.Name).sort(), ['Lignes claires', 'Seule'], 'an artist\'s albums');
    const songs = await get('/Users/wika/Items', { ParentId: 'mf_1', IncludeItemTypes: 'Audio', Recursive: true, StartIndex: 0, Limit: 10 });
    ok(songs.Items.length === 10 && songs.TotalRecordCount > 10, 'songs tab: a full page promises more');
    const last = await get('/Users/wika/Items', { ParentId: 'mf_1', IncludeItemTypes: 'Audio', Recursive: true, StartIndex: 30, Limit: 10 });
    eq(last.TotalRecordCount, 30 + last.Items.length, 'songs tab: the last page ends it');
    eq((await get('/Users/wika/Items', { ParentId: 'mf_1', IncludeItemTypes: 'Audio', Filters: 'IsFavorite' })).Items.map((x) => x.Id).sort(), ['tr_track-1-0-1', 'tr_track-3-0-0'], 'favourite songs');
    const found = await get('/Users/wika/Items', { SearchTerm: 'Fil', Recursive: true, Limit: 60, IncludeItemTypes: 'Movie,Series,MusicAlbum,MusicArtist,Audio' });
    ok(found.Items.some((x) => x.Id === 'tr_track-3-0-0'), 'search');

    // Favourites: star / unstar with the parameter of the id's kind.
    await api.request('POST', '/Users/wika/FavoriteItems/tr_track-1-0-0');
    await api.request('POST', '/UserFavoriteItems/al_album-1-0', { userId: 'wika' });
    await api.request('POST', '/UserFavoriteItems/ar_artist-1', { userId: 'wika' });
    await api.request('DELETE', '/Users/wika/FavoriteItems/tr_track-1-0-0');
    eq((await state()).stars.map((s) => `${s.op}:${s.as}:${s.id}`), ['star:id:track-1-0-0', 'star:albumId:album-1-0', 'star:artistId:artist-1', 'unstar:id:track-1-0-0'], 'star by kind');
    eq((await get('/Users/wika/Items/tr_track-1-0-0')).UserData.IsFavorite, false, 'unstarred');

    // Playlists.
    const lists = await get('/Users/wika/Items', { IncludeItemTypes: 'Playlist', Recursive: true, SortBy: 'SortName' });
    eq(lists.Items.map((x) => x.Name).sort(), ['Mix du dimanche', 'Playlist de Léa'], 'own and public playlists');
    const mine = 'pl_playlist-music';
    const before = mock.playlists().get('playlist-music').songs.slice();
    const entries = await get(`/Playlists/${mine}/Items`, { UserId: 'wika' });
    eq(entries.Items.map((x) => x.PlaylistItemId), ['pe_0', 'pe_1', 'pe_2', 'pe_3', 'pe_4'], 'entry ids');
    await api.request('POST', `/Playlists/${mine}/Items`, { Ids: 'tr_track-6-0-0', UserId: 'wika' });
    await api.request('DELETE', `/Playlists/${mine}/Items`, { EntryIds: 'pe_0,pe_2' });
    eq(mock.playlists().get('playlist-music').songs, [before[1], before[3], before[4], 'track-6-0-0'], 'add then remove (indexes high first)');
    eq((await state()).playlistEdits.at(-1).remove, [2, 0], 'removal indexes sent descending');
    await api.request('POST', `/Playlists/${mine}/Items/pe_0/Move/2`);
    eq(mock.playlists().get('playlist-music').songs, [before[3], before[4], before[1], 'track-6-0-0'], 'move');
    const made = await api.request('POST', '/Playlists', { Name: 'Nouvelle', Ids: 'tr_track-0-0-0,al_album-1-0', UserId: 'wika', MediaType: 'Audio' }, { Name: 'Nouvelle', Ids: ['tr_track-0-0-0', 'al_album-1-0'] });
    eq(made.Id, 'pl_playlist-new-1', 'created');
    eq(mock.playlists().get('playlist-new-1').songs.length, 5, 'an album id stands for its tracks');
    await assert.rejects(api.request('POST', '/Playlists/pl_playlist-lea/Items', { Ids: 'tr_track-0-0-0' }), (e) => e.status === 403 && e.message === F.t('errors.navidrome.notOwner'), 'another user\'s playlist: 403, the owner message');
    n++;

    // Scrobble: now playing, then one submission per play past half the track (or 4 min).
    const run = 20 * 1e7;
    await api.request('POST', '/Sessions/Playing', undefined, { ItemId: 'tr_track-0-0-0', PlaySessionId: 'p1', PositionTicks: 0 });
    await api.request('POST', '/Sessions/Playing/Progress', undefined, { ItemId: 'tr_track-0-0-0', PlaySessionId: 'p1', PositionTicks: run / 4 });
    await api.request('POST', '/Sessions/Playing/Stopped', undefined, { ItemId: 'tr_track-0-0-1', PlaySessionId: 'p0', PositionTicks: 2 * 1e7 });
    await api.request('POST', '/Sessions/Playing/Stopped', undefined, { ItemId: 'tr_track-0-0-0', PlaySessionId: 'p1', PositionTicks: run * 0.6 });
    await api.request('POST', '/Sessions/Playing/Stopped', undefined, { ItemId: 'tr_track-0-0-0', PlaySessionId: 'p1', PositionTicks: run });
    const st = await state();
    eq(st.scrobbles.map((s) => `${s.id}:${s.submission}`), ['track-0-0-0:false', 'track-0-0-0:true'], 'now playing + one submission; a skip under the threshold none');
    ok(!st.streams.length, 'reports never stream');

    // Lyrics: OpenSubsonic structured, then plain Subsonic getLyrics.
    const synced = await get('/Audio/tr_track-3-0-1/Lyrics');
    ok(synced.Metadata.IsSynced && synced.Lyrics.length >= 10 && synced.Lyrics[0].Start === 0, 'synced lyrics (offset applied, clamped)');
    ok(synced.Lyrics[1].Start === 12_500_000, `1.5 s with offset +250 ms: 1.25 s (${synced.Lyrics[1].Start})`);
    eq((await get('/Audio/tr_track-3-1-0/Lyrics')).Metadata.IsSynced, false, 'plain lyrics');
    await assert.rejects(get('/Audio/tr_track-0-0-0/Lyrics'), (e) => e.status === 404, 'no lyrics: 404');
    n++;
    const old = new F.SubsonicClient(plain.url, identity, 'mock-pass', 'wika');
    const legacy = await old.request('GET', '/Audio/tr_track-3-0-0/Lyrics');
    ok(!legacy.Metadata.IsSynced && legacy.Lyrics.some((l) => /Ligne/.test(l.Text)), 'plain Subsonic: getLyrics');

    // Instant mix (no similar songs on the server: the seed first, then its genre).
    const mix = await get('/Items/tr_track-3-0-0/InstantMix', { UserId: 'wika', Limit: 5 });
    ok(mix.Items.length === 5 && mix.Items[0].Id === 'tr_track-3-0-0', 'instant mix');

    // Playback and media.
    const info = await api.request('POST', '/Items/tr_track-0-0-0/PlaybackInfo', { UserId: 'wika' }, { DeviceProfile: {} });
    ok(info.MediaSources[0].SupportsDirectPlay && /^[0-9a-f]{32}$/.test(info.PlaySessionId), 'PlaybackInfo: direct play');
    const img = api.mediaPath('/Items/al_album-3-0/Images/Primary?tag=al-album-3-0_0&maxHeight=300&quality=90');
    eq(img, '/rest/getCoverArt?id=al-album-3-0_0&size=300', 'cover path, unsigned');
    eq(api.mediaPath('/Items/ar_artist-1/Images/Primary?maxWidth=200'), '/rest/getCoverArt?id=artist-1&size=200', 'cover by item id');
    eq(api.mediaPath('/Items/tr_track-0-0-0/Download'), '/rest/download?id=track-0-0-0', 'download path');
    eq(api.mediaPath('/Videos/x/stream'), null, 'not a track: 404');
    const cover = await fetch(api.sign(`${mock.url}${img}`));
    ok(cover.ok && cover.headers.get('content-type') === 'image/png', 'cover loads, signed');
    eq(api.sign(`${mock.url}${img}`, true), api.sign(`${mock.url}${img}`, true), 'a media URL signs the same each time (HTTP cache)');
    ok((await fetch(api.sign(`${mock.url}${img}`, true))).ok, 'cover loads with the client media salt');
    const stream = api.url('/Audio/tr_track-0-0-0/stream', { Static: true, MediaSourceId: 'tr_track-0-0-0', PlaySessionId: 'x', DeviceId: 'd' });
    ok(/\/rest\/stream\?id=track-0-0-0&format=raw&u=wika&t=[0-9a-f]{32}&s=[0-9a-f]+/.test(stream), `mpv URL signed for this machine (${F.redact(stream)})`);
    eq(F.redact(stream).includes('mock-pass') || /t=[0-9a-f]{32}/.test(F.redact(stream)), false, 'the signed URL redacts');
    const head = await fetch(stream, { method: 'HEAD' });
    const body = Buffer.from(await (await fetch(stream)).arrayBuffer());
    ok(head.ok && body.subarray(0, 4).toString() === 'RIFF' && body.subarray(44).every((b) => b === 0), 'the stream is silence (HEAD then GET: the same salt is fine for media)');

    // Add Source > Navidrome: the address probe (/rest/ping after the Emby and Plex probes), then the name and
    // password form; the password goes to the vault only, and a restart signs in again from it.
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-nd-cm-'));
      const vault = { e: {}, get(id) { return this.e[id]; }, set(id, c) { this.e[id] = JSON.parse(JSON.stringify(c)); }, delete(id) { delete this.e[id]; } };
      const cm = () => new F.ConnectionManager(path.join(tmp, 'servers.json'), vault, identity);
      const m = cm();
      const info = await m.add(mock.url);
      eq([info.kind, /^nd[0-9a-f]{16}$/.test(info.id), info.name], ['navidrome', true, 'Navidrome'], 'probe: a Navidrome server, id from its origin');
      await m.select(info.id);
      eq(await m.publicUsers(info.id), [], 'no public users: the name and password form');
      await assert.rejects(m.login('wika', 'nope', info.id), (e) => e.message === F.t('errors.connection.wrongCredentials'), 'wrong password');
      await assert.rejects(m.login('ldap', 'x', info.id), (e) => e.message === F.t('errors.navidrome.tokenUnsupported'), 'LDAP: token auth refused, clear message');
      const st = await m.login('wika', 'mock-pass', info.id);
      ok(st.sessions.some((s) => s.server.id === info.id && s.status === 'signed-in' && s.user?.name === 'wika'), 'signed in');
      m.flush();
      ok(!fs.readFileSync(path.join(tmp, 'servers.json'), 'utf8').includes('mock-pass'), 'the password is not in servers.json');
      ok(JSON.stringify(vault.e).includes('mock-pass'), 'the password is in the vault');
      const st2 = await cm().select(info.id);
      ok(st2.sessions.some((s) => s.server.id === info.id && s.status === 'signed-in'), 'a restart signs in from the vault');
      n += 2;
    }

    // Errors.
    await assert.rejects(new F.SubsonicClient(mock.url, identity, 'wrong', 'wika').request('GET', '/Users/wika/Views'), (e) => e.status === 401 && e.code === 40, 'wrong password: 401 (40)');
    await assert.rejects(new F.SubsonicClient(mock.url, identity, 'x', 'ldap').request('GET', '/Users/ldap/Views'), (e) => e.status === 401 && e.code === 41, 'LDAP user: 41');
    await assert.rejects(get('/LiveTv/Channels'), (e) => e.status === 404 && /^NAVIDROME-UNMAPPED/.test(e.message), 'unmapped: 404');
    n += 3;

    const final = await state();
    eq(final.tags, [], `mock tags (${final.tags})`);
    ok(final.covers.every((c) => c.size), 'every cover asked with a size');
  });
} finally {
  await mock.close();
  await plain.close();
}
eq(refused, [], 'no socket left loopback');
console.log(`subsonic-check: ok (${n} assertions)`);
