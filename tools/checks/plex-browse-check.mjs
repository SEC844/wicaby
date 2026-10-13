// Browsing a Plex server through the adapter (plex-spec §3.3, §4, §8, PX-06 and D-6), with the real
// ConnectionManager and PlexClient (bundled for Node) against tools/mock-server/mock-plex.mjs on loopback, signed in
// as the owner. The renderer's own calls, Emby-shaped in and out:
// - Home: the promoted hubs, Continue Watching (/hubs/continueWatching) and On Deck as next up;
// - libraries: 12 films, each with a poster that loads through wicaby-media (a /photo/:/transcode path, the token as
//   a header); the flattened show answers no seasons and lists its episodes; the film with two editions has two
//   versions and the one with a missing part only its readable version; search finds a single shared film;
//   collections and playlists; the watchlist is Favorites (heart on, the Favorites list, heart off);
// - an unknown route answers 404 PLEX-UNMAPPED; the notifications socket turns a scrobble into UserDataChanged;
// - /Mock/State: zero UNMAPPED, TOKEN-IN-URL, NO-CLIENT-ID and ACCOUNT-TOKEN-ON-PMS.
// Usage: node tools/checks/plex-browse-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MACHINE_ID, startMockPlex } from '../mock-server/mock-plex.mjs';
import { bundlePlex, identity, quiet, refused } from './plex-bundle.mjs';

const F = await bundlePlex();
let n = 0;
const ok = (c, msg) => (assert.ok(c, msg), n++);
const mock = await quiet(() => startMockPlex({ port: 0, tvPort: 0, relayPort: 0, env: { MOCK_PLEX_SECOND: '0', MOCK_PLEX_TLS: '0' } }));
process.env.WICABY_PLEXTV_BASE = mock.plextv;

try {
  await quiet(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-plexbrowse-'));
    const vault = await F.CredentialVault.open(path.join(dir, 'vault.bin'));
    const cm = new F.ConnectionManager(path.join(dir, 'servers.json'), vault, identity);
    const pin = await cm.plexLink();
    await fetch(`${mock.plextv}/Mock/Pin/Link?code=${pin.code}`, { method: 'POST' });
    for (let i = 0; i < 100 && (await cm.plexPoll()).status !== 'linked'; i++) await new Promise((r) => setTimeout(r, 50));
    await cm.select(MACHINE_ID);
    await cm.plexConfirm(MACHINE_ID, cm.session.sessions[0].confirm);
    await cm.login('Wika', '', MACHINE_ID);
    const s = cm.sessionFor(MACHINE_ID);
    ok(s.status === 'signed-in' && s.user.isAdmin === true, 'signed in as the owner (D-2: Refresh metadata is theirs)');
    const messages = [];
    cm.on('server-message', (msg) => messages.push(msg.MessageType));
    const api = cm.apiFor(MACHINE_ID);
    const uid = s.user.id;
    const get = (p, q) => api.request('GET', p, q);
    const fields = { Fields: 'PrimaryImageAspectRatio,Overview', EnableImageTypes: 'Primary,Backdrop,Thumb,Logo', ImageTypeLimit: 1 };

    // Home
    const views = await get(`/Users/${uid}/Views`);
    ok(views.Items.map((v) => v.CollectionType).join() === 'movies,tvshows,music', 'three libraries');
    const hubs = await get('/Hubs');
    ok(hubs.some((h) => h.Name === 'Recently Added TV') && hubs.some((h) => h.Name === 'Sagas' && h.Items.length === 3), `promoted hubs (${hubs.map((h) => h.Name)})`);
    const resume = await get(`/Users/${uid}/Items/Resume`, { Limit: 24, MediaTypes: 'Video', ...fields });
    ok(resume.Items.length >= 2 && resume.Items.every((i) => i.UserData.PlaybackPositionTicks > 0), 'Continue Watching');
    const nextUp = await get('/Shows/NextUp', { UserId: uid, Limit: 24, ...fields });
    ok(nextUp.Items.length >= 1 && nextUp.Items.every((i) => i.Type === 'Episode'), 'On Deck as next up');
    const latest = await get(`/Users/${uid}/Items/Latest`, { ParentId: views.Items[0].Id, Limit: 24, ...fields });
    ok(Array.isArray(latest) && latest.length > 0, 'latest of a library');

    // Library: 12 films with posters that load.
    const films = await get(`/Users/${uid}/Items`, { ParentId: views.Items[0].Id, IncludeItemTypes: 'Movie', Recursive: true, SortBy: 'SortName', SortOrder: 'Ascending', StartIndex: 0, Limit: 100, ...fields });
    ok(films.TotalRecordCount === 12 && films.Items.length === 12 && films.Items.every((f) => f.ImageTags?.Primary), '12 films, each with a poster tag');
    for (const f of films.Items.slice(0, 3)) {
      const mapped = await api.mediaPath(`/Items/${f.Id}/Images/Primary?tag=${f.ImageTags.Primary}&maxWidth=300&quality=90`);
      ok(mapped?.startsWith('/photo/:/transcode?') && !/token/i.test(mapped), `poster path ${mapped}`);
      const res = await fetch(`${mock.pms}${mapped}`, { headers: api.authHeaders() });
      ok(res.ok && /image/.test(res.headers.get('content-type') ?? ''), 'the poster loads with the token as a header');
    }
    const sorted = films.Items.map((f) => f.Name);
    ok(JSON.stringify(sorted) === JSON.stringify([...sorted].sort((a, b) => a.replace(/^(The|Le|La|Les) /, '').toLowerCase().localeCompare(b.replace(/^(The|Le|La|Les) /, '').toLowerCase()))), 'sorted by sort name');

    // Shows: the flattened one has no seasons and lists its episodes.
    const flat = await get(`/Shows/2100/Seasons`, { UserId: uid });
    const flatEps = await get(`/Shows/2100/Episodes`, { UserId: uid });
    ok(flat.Items.length === 0 && flatEps.Items.length === 4, 'flattenSeasons: no seasons, 4 episodes');
    const seasons = await get(`/Shows/2200/Seasons`, { UserId: uid });
    const s2 = await get(`/Shows/2200/Episodes`, { UserId: uid, SeasonId: seasons.Items[1].Id });
    ok(seasons.Items.length === 2 && s2.Items.length === 3, 'a show with two seasons');

    // Items: editions, a missing part, extras.
    const two = await get(`/Users/${uid}/Items/1000`);
    ok(two.MediaSources.map((m) => m.Name).join() === "Theatrical,Director's Cut", 'two editions, two versions');
    ok(two.LocalTrailerCount === 1 && (await get(`/Users/${uid}/Items/1000/SpecialFeatures`)).length === 1, 'a trailer and a featurette');
    const gone = await get(`/Users/${uid}/Items/1001`);
    ok(gone.MediaSources.length === 1, 'the version whose file is missing is hidden');
    const similar = await get('/Items/1000/Similar', { UserId: uid, Limit: 16 });
    ok(similar.Items.length > 0, 'similar');

    // Search finds a single shared item (#702).
    const found = await get(`/Users/${uid}/Items`, { SearchTerm: 'Agent 327', Recursive: true, Limit: 60, IncludeItemTypes: 'Movie,Series,Episode,MusicAlbum,MusicArtist,Audio,BoxSet,Book', ...fields });
    ok(found.Items.some((i) => i.Id === '1100'), 'search finds the single shared film');

    // Collections and playlists.
    const cols = await get(`/Users/${uid}/Items`, { IncludeItemTypes: 'BoxSet', Recursive: true, SortBy: 'SortName' });
    ok(cols.Items.some((c) => c.Name === 'Sagas'), 'collections');
    const col = await get(`/Users/${uid}/Items`, { ParentId: '5000', SortBy: 'ProductionYear,SortName' });
    ok(col.Items.length === 3, 'a collection lists its films');
    const lists = await get(`/Users/${uid}/Items`, { IncludeItemTypes: 'Playlist', Recursive: true, SortBy: 'SortName' });
    ok(lists.Items.some((p) => p.Name === 'Sci-fi night' && p.Type === 'Playlist'), 'playlists');
    const entries = await get('/Playlists/6000/Items', { UserId: uid });
    ok(entries.Items.length === 3 && entries.Items.every((e) => e.PlaylistItemId), 'playlist entries with their entry ids');
    await api.request('POST', '/Playlists/6000/Items/' + entries.Items[2].PlaylistItemId + '/Move/0');
    ok((await get('/Playlists/6000/Items', { UserId: uid })).Items[0].Id === entries.Items[2].Id, 'move an entry to the top');

    // The watchlist is Favorites (D-6).
    await api.request('POST', `/Users/${uid}/FavoriteItems/1003`);
    ok((await get(`/Users/${uid}/Items/1003`)).UserData.IsFavorite === true, 'heart on: the film is on the watchlist');
    const favs = await get(`/Users/${uid}/Items`, { Filters: 'IsFavorite', Recursive: true, IncludeItemTypes: 'Movie,Series,Episode,MusicAlbum,BoxSet,Book', SortBy: 'SortName', Limit: 24 });
    ok(favs.Items.map((i) => i.Id).join() === '1003', 'the Favorites list is the watchlist');
    await api.request('DELETE', `/Users/${uid}/FavoriteItems/1003`);
    ok((await get(`/Users/${uid}/Items`, { Filters: 'IsFavorite', Recursive: true, IncludeItemTypes: 'Movie' })).Items.length === 0, 'heart off');
    await assert.rejects(api.request('POST', `/Users/${uid}/FavoriteItems/1000`), (e) => e.status === 404 && /PLEX-UNMAPPED/.test(e.message), 'a legacy-agent item cannot be watchlisted: 404, not a wrong answer');
    ok(mock.state.tokens.plextv.includes('mock-account-token') && !mock.state.tokens.pms.includes('mock-account-token'), 'the watchlist goes to plex.tv only');

    // Unknown route, played state, notifications.
    await assert.rejects(api.request('GET', '/Items/1000/InstantMix', { UserId: uid }), (e) => e.status === 404 && /^PLEX-UNMAPPED GET/.test(e.message), 'an unknown route: 404 PLEX-UNMAPPED');
    await assert.rejects(api.request('GET', `/Users/${uid}/Items`, { ParentId: 'section-1', HasTrailer: true }), (e) => e.status === 404, 'an unknown query key: 404, not a dropped filter');
    await new Promise((r) => setTimeout(r, 300));
    await api.request('POST', `/Users/${uid}/PlayedItems/1005`);
    ok((await get(`/Users/${uid}/Items/1005`)).UserData.Played === true, 'mark as played');
    const t0 = Date.now();
    while (!messages.includes('UserDataChanged') && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 50));
    ok(messages.includes('UserDataChanged'), 'the notifications socket turns the scrobble into UserDataChanged');
    await api.request('DELETE', `/Users/${uid}/PlayedItems/1005`);
    await api.request('POST', '/Items/1005/Refresh', { MetadataRefreshMode: 'FullRefresh' });
    ok(mock.state.refreshes.includes('1005'), 'Refresh metadata (owner, D-2)');
    cm.disconnect();

    const bad = mock.state.tags.filter((t) => ['UNMAPPED', 'TOKEN-IN-URL', 'NO-CLIENT-ID', 'ACCOUNT-TOKEN-ON-PMS', 'NO-TOKEN'].includes(t));
    ok(bad.length === 0, `no Plezy tag (${bad})`);
  });
} finally {
  await mock.close();
}
ok(refused.length === 0, `nothing left loopback (refused: ${refused})`);
console.log(`plex-browse-check: ok (${n} assertions)`);
process.exit(0);
