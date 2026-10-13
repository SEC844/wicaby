// The files dialect (file-sources-spec FS-04), in Node without Electron, against the WebDAV mock and a temp tree:
// the same Emby-shaped calls on a local source and a WebDAV one give the same answers. Views has one root;
// listings hide NAS clutter and sort naturally (E2 before E10); the poster resolves; the NFO title wins over the
// file name; sidecar subtitles are External streams; unknown routes are FILES-UNMAPPED; search and filters are
// empty; played, hide and the Continue row are local; §4.3 shapes: Series, Season, Episode and film-folder cards
// with the /Shows/<id>/Seasons and /Episodes routes. Then the guards: EVIL hrefs dropped, a symlink and a
// junction out of a local root refused (the junction on Windows only; without the symlink privilege the symlink is
// simulated by its realpath), and TLS: verify fails on the self-signed
// mock, the pin passes, and after /Mock/RotateCert the pin fails before any request reaches the mock.
// Usage: node tools/checks/files-routes-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { buildFilesFixture } from '../mock-server/files-fixture.mjs';
import { startMockWebdav } from '../mock-server/mock-webdav.mjs';
import { bundleFiles, identity, quiet } from './files-bundle.mjs';

const F = await bundleFiles();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-files-routes-'));
const tree = buildFilesFixture(path.join(tmp, 'tree'), { video: false }).dir;
let passed = 0;
const ok = (c, m) => (assert.ok(c, m), passed++);
const id = (rel) => F.encodeId(rel);
const relay = new F.LoopbackRelay();

function client(name, backend) {
  const progress = new F.ProgressStore(path.join(tmp, `progress-${name}.json`));
  return new F.FilesClient({ id: name.padEnd(32, '0'), name, protocol: backend instanceof F.WebDavBackend ? 'webdav' : 'local' }, backend, progress, identity, relay);
}

const dav = await startMockWebdav({ root: tree, port: 0, env: { MOCK_DAV_EVIL: '1' } });
const creds = { user: 'demo', pass: 'demo' };
const sources = {
  local: client('aaaaaa', new F.LocalBackend(tree)),
  webdav: client('bbbbbb', new F.WebDavBackend(dav.base, creds, { mode: 'insecure-http' })),
};

for (const [kind, c] of Object.entries(sources)) {
  const get = (p, q) => c.request('GET', p, q);
  const views = await get('/Users/local/Views');
  ok(views.Items.length === 1 && views.Items[0].Id === 'p.' && views.Items[0].Type === 'CollectionFolder', `${kind}: Views has one root`);
  const root = await quiet(() => get('/Users/local/Items', { ParentId: 'p.' }));
  const names = root.Items.map((x) => x.Name);
  ok(names.join() === 'Films,Shows', `${kind}: root lists Films, Shows, hiding @eaDir, #recycle, dot-files (${names.join()})`);
  const season = await get('/Users/local/Items', { ParentId: id('Shows/Example Show/Season 1') });
  const eps = season.Items.map((x) => x.IndexNumber);
  ok(season.TotalRecordCount === 10 && eps.join() === '1,2,3,4,5,6,7,8,9,10', `${kind}: Season 1 has 10 episodes in natural order`);
  ok(season.Items[0].Name.startsWith('S1:E1') && season.Items[0].Type === 'Episode', `${kind}: an episode reads "S1:E1 · …"`);
  const e1 = season.Items[0];
  ok(e1.SeriesId === id('Shows/Example Show') && e1.SeasonId === id('Shows/Example Show/Season 1') && e1.SeriesName === 'Example Show' && e1.ParentIndexNumber === 1, `${kind}: §4.3 an episode card knows its series and season`);
  const seasons = await get('/Users/local/Items', { ParentId: id('Shows/Example Show') });
  ok(seasons.Items.map((x) => x.Name).join() === 'Season 1,Season 2,Season 10', `${kind}: Season 2 before Season 10`);
  ok(seasons.Items.every((x) => x.Type === 'Season' && x.IsFolder && x.SeriesId === id('Shows/Example Show')) && seasons.Items.map((x) => x.IndexNumber).join() === '1,2,10', `${kind}: §4.3 season folders are Season cards`);
  const shows = await get('/Users/local/Items', { ParentId: id('Shows') });
  ok(shows.Items.find((x) => x.Name === 'Example Show')?.Type === 'Series', `${kind}: §4.3 a folder with tvshow.nfo or season folders is a Series card`);
  const films = await get('/Users/local/Items', { ParentId: id('Films') });
  const filmCard = films.Items[0];
  ok(films.Items.length === 1 && filmCard.Type === 'Movie' && !filmCard.IsFolder && filmCard.Id === id('Films/Example Movie (2019)/Example.Movie.2019.1080p.mkv') && filmCard.Name === 'Example Movie' && filmCard.ProductionYear === 2019, `${kind}: §4.3 a film folder's card opens the film directly (${filmCard.Type} ${filmCard.Name})`);
  const showSeasons = await get(`/Shows/${id('Shows/Example Show')}/Seasons`);
  ok(showSeasons.Items.map((x) => x.Name).join() === 'Season 1,Season 2,Season 10', `${kind}: /Shows/<id>/Seasons`);
  const s1 = await get(`/Shows/${id('Shows/Example Show')}/Episodes`, { SeasonId: id('Shows/Example Show/Season 1') });
  ok(s1.Items.length === 10 && s1.Items.map((x) => x.IndexNumber).join() === '1,2,3,4,5,6,7,8,9,10', `${kind}: /Shows/<id>/Episodes of a season, in episode order`);
  const all = await get(`/Shows/${id('Shows/Example Show')}/Episodes`);
  ok(all.Items.length >= 10 && all.Items[0].Id === e1.Id && all.Items.every((x, i, a) => i === 0 || (a[i - 1].ParentIndexNumber ?? 0) <= (x.ParentIndexNumber ?? 0)), `${kind}: /Shows/<id>/Episodes of the series, seasons in order (${all.Items.length})`);
  const paged = await get('/Users/local/Items', { ParentId: id('Shows/Example Show/Season 1'), StartIndex: 8, Limit: 5 });
  ok(paged.Items.length === 2 && paged.Items[0].IndexNumber === 9, `${kind}: paging by StartIndex/Limit`);
  const bySize = await get('/Users/local/Items', { ParentId: id('Films/Example Movie (2019)'), SortBy: 'Size', SortOrder: 'Descending' });
  ok(bySize.Items.length === 1, `${kind}: only the video is listed (posters, NFO, subtitles are sidecars)`);

  const film = await get(`/Users/local/Items/${id('Films/Example Movie (2019)/Example.Movie.2019.1080p.mkv')}`);
  ok(film.Name === 'Example Movie & Friends' && film.ProductionYear === 2019 && film.ProviderIds?.Imdb === 'tt0000001', `${kind}: the NFO title wins over the file name`);
  const subs = film.MediaSources[0].MediaStreams.filter((s) => s.Type === 'Subtitle' && s.IsExternal && s.DeliveryMethod === 'External');
  ok(subs.length === 2 && subs.some((s) => s.Language === 'fr') && subs.some((s) => s.Language === 'en' && s.IsForced), `${kind}: sidecar subtitles are External streams`);
  ok(film.ImageTags?.Primary && !JSON.stringify(film).includes(tree) && !film.Path, `${kind}: a poster tag, and no path in the item`);
  const poster = await c.media(`/Items/${film.Id}/Images/Primary`, 'GET', undefined);
  ok(poster.status === 200 && poster.headers.get('content-type') === 'image/jpeg' && (await poster.arrayBuffer()).byteLength > 20, `${kind}: the poster resolves`);
  const folderPoster = await c.media(`/Items/${id('Shows/Example Show')}/Images/Primary`, 'GET', undefined);
  ok(folderPoster.status === 200, `${kind}: a folder poster resolves`);
  ok((await c.media(`/Items/${id('Shows/Example Show/Season 1')}/Images/Primary`, 'GET', undefined)).status === 404, `${kind}: no poster is a 404`);
  const ranged = await c.media(`/Items/${film.Id}/File`, 'GET', 'bytes=0-9');
  ok(ranged.status === 206 && (await ranged.arrayBuffer()).byteLength === 10, `${kind}: the file with Range (HTML player)`);
  const sub = await c.media(`/Items/${film.Id}/Subtitles/${subs[0].Index}`, 'GET', undefined);
  ok(sub.status === 200 && (await sub.text()).includes('-->'), `${kind}: a sidecar subtitle`);
  ok((await c.media(`/Items/p.Li4/Images/Primary`, 'GET', undefined)).status === 400, `${kind}: a hostile id is refused`);
  const show = await get(`/Users/local/Items/${id('Shows/Example Show')}`);
  ok(show.Name === 'Example Show' && show.ProductionYear === 2020 && show.IsFolder && show.Type === 'Series', `${kind}: tvshow.nfo names the folder (a Series)`);
  ok(film.Type === 'Movie', `${kind}: the film of a film folder is a Movie on its page too`);

  await assert.rejects(() => get(`/Items/${film.Id}/Similar`), /FILES-UNMAPPED/);
  await assert.rejects(() => get('/Items/x/PlaybackInfo'), /FILES-UNMAPPED/);
  await assert.rejects(() => c.request('POST', '/Users/local/FavoriteItems/p.'), (e) => e.status === 404 && /FILES-UNMAPPED/.test(e.message));
  passed++;
  ok((await get('/Users/local/Items', { SearchTerm: 'Example', Recursive: true })).TotalRecordCount === 0, `${kind}: search is empty (folder mode)`);
  ok((await get('/Users/local/Items', { Filters: 'IsFavorite', Recursive: true })).Items.length === 0, `${kind}: favorites are empty`);
  ok((await get('/Users/local/Items/Latest')).length === 0 && (await get('/Shows/NextUp')).Items.length === 0, `${kind}: Latest and NextUp are empty`);

  // Local user data: progress reports, played, hide, the Continue row and "next in folder".
  const ep1 = id('Shows/Example Show/Season 1/Example.Show.S01E01.720p.mkv');
  const ep2 = id('Shows/Example Show/Season 1/Example.Show.S01E02.720p.mkv');
  await get(`/Users/local/Items/${ep1}`);
  await c.request('POST', '/Sessions/Playing/Stopped', undefined, { ItemId: ep1, PositionTicks: 300 * 10_000_000, RunTimeTicks: 600 * 10_000_000 });
  const resumed = await get(`/Users/local/Items/${ep1}`);
  ok(resumed.UserData.PlaybackPositionTicks === 300 * 10_000_000 && resumed.RunTimeTicks === 600 * 10_000_000, `${kind}: stopping at 50 % keeps the position and the duration`);
  ok((await get('/Users/local/Items/Resume')).Items[0]?.Id === ep1, `${kind}: Continue shows it`);
  await c.request('POST', `/Users/local/Items/${ep1}/HideFromResume`, { Hide: true });
  ok((await get('/Users/local/Items/Resume')).Items.length === 0, `${kind}: hidden from Continue`);
  await c.request('POST', `/Users/local/PlayedItems/${ep1}`);
  const next = await get('/Users/local/Items/Resume');
  ok((await get(`/Users/local/Items/${ep1}`)).UserData.Played && next.Items[0]?.Id === ep2, `${kind}: played, then Continue offers the next file in the folder`);
  await c.request('DELETE', `/Users/local/PlayedItems/${ep1}`);
  ok(!(await get(`/Users/local/Items/${ep1}`)).UserData.Played, `${kind}: unmarked`);
}

// ---- WebDAV guards ----
const evil = await quiet(() => sources.webdav.request('GET', '/Users/local/Items', { ParentId: 'p.' }));
ok(evil.Items.every((x) => !/Other|Escape|Too|passwd|a\/b/.test(x.Name)) && dav.state.tags.includes('HREF-ESCAPE'), 'EVIL hrefs are dropped');
ok(dav.state.calls.every((x) => x.auth) && !dav.state.tags.includes('AUTH-IN-URL') && !dav.state.tags.includes('DEPTH-INFINITY'), 'every request authenticated, never in the URL, never Depth infinity');

// ---- local guards: links out of the root ----
const outside = path.join(tmp, 'outside');
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'Secret.mkv'), 'x');
const linkRoot = path.join(tmp, 'linked');
fs.mkdirSync(linkRoot);
fs.writeFileSync(path.join(linkRoot, 'Inside.mkv'), 'x');
let linked = 0;
const tryLink = (target, name, type) => {
  try {
    fs.symlinkSync(target, path.join(linkRoot, name), type);
    linked++;
    return true;
  } catch {
    return false;
  }
};
const haveJunction = process.platform === 'win32' && tryLink(outside, 'Junction', 'junction');
const haveSymlink = tryLink(path.join(outside, 'Secret.mkv'), 'Link.mkv', 'file') | tryLink(outside, 'LinkDir', 'dir');
const lc = client('cccccc', new F.LocalBackend(linkRoot));
const shown = (await lc.request('GET', '/Users/local/Items', { ParentId: 'p.' })).Items.map((x) => x.Name);
ok(shown.join() === 'Inside', `links out of the root are not listed (${shown.join()})`);
for (const rel of ['Junction/Secret.mkv', 'Link.mkv', 'LinkDir/Secret.mkv']) {
  if (!fs.existsSync(path.join(linkRoot, ...rel.split('/')))) continue;
  await assert.rejects(() => lc.request('GET', `/Users/local/Items/${id(rel)}`), (e) => e.code === 'invalid', `${rel} is refused`);
  ok((await lc.media(`/Items/${id(rel)}/File`, 'GET', undefined)).status === 400, `${rel}: no bytes either`);
}
if (process.platform === 'win32') ok(haveJunction, 'a junction could be made (no privilege needed)');
// Real symlinks, when they could be made, went through the loop above.
if (!haveSymlink) {
  // No symlink privilege (Windows without Developer Mode): the OS answer for a file symlink is simulated, a
  // realpath that leads out of the root, so the same containment the real link would hit is what refuses it.
  const sim = path.join(linkRoot, 'SimLink.mkv');
  fs.writeFileSync(sim, 'x');
  const realpath = fs.promises.realpath;
  fs.promises.realpath = (p, ...a) => (path.resolve(String(p)) === sim ? Promise.resolve(path.join(outside, 'Secret.mkv')) : realpath(p, ...a));
  try {
    await assert.rejects(() => lc.request('GET', `/Users/local/Items/${id('SimLink.mkv')}`), (e) => e.code === 'invalid', 'a file symlink out of the root is refused');
    ok((await lc.media(`/Items/${id('SimLink.mkv')}/File`, 'GET', undefined)).status === 400, 'a file symlink out of the root: no bytes either (simulated)');
    ok(!(await lc.playTarget(id('Inside.mkv'), 'mpv', () => '')).url.includes('outside'), 'a file inside still plays from inside');
  } finally {
    fs.promises.realpath = realpath;
  }
}
await assert.rejects(() => lc.request('GET', `/Users/local/Items/p.${Buffer.from('../outside').toString('base64url')}`), (e) => e.code === 'invalid');
passed++;

// ---- TLS: verify, pin, rotation ----
const secure = await startMockWebdav({ root: tree, port: 0, env: { MOCK_DAV_TLS: '1' } });
const verify = new F.WebDavBackend(secure.base, creds, { mode: 'verify' });
await assert.rejects(() => verify.list(''), (e) => e.code === 'certUntrusted', 'verify fails on the self-signed mock');
passed++;
ok(secure.state.calls.length === 0, 'verify: nothing reached the mock');
const cert = await verify.peek();
const pin = { mode: 'pin', sha256: cert.sha256, subject: cert.subject, notAfter: cert.validTo };
const pinned = new F.WebDavBackend(secure.base, creds, pin);
ok((await pinned.list('')).length >= 2 && secure.state.calls.length === 1, 'the pin passes');
pinned.close();
// The mock's own route is behind the same TLS: posted without verification.
await new Promise((resolve, reject) => https.request(`${secure.origin}/Mock/RotateCert`, { method: 'POST', rejectUnauthorized: false }, (r) => (r.resume(), resolve())).on('error', reject).end());
const before = secure.state.calls.length;
const afterRotate = new F.WebDavBackend(secure.base, creds, pin);
await assert.rejects(() => afterRotate.list(''), (e) => e.code === 'certChanged' && e.cert?.sha256 && e.cert.sha256 !== pin.sha256, 'after rotation the pin fails');
passed++;
ok(secure.state.calls.length === before, 'and no request reached the mock after the handshake');
afterRotate.close();
verify.close();

relay.close();
for (const c of Object.values(sources)) c.backend.close?.();
await Promise.all([dav.close(), secure.close()]);
console.log(`files-routes-check: ok (${passed} checks; links made: ${linked}${haveSymlink ? '' : ', symlinks need a privilege here: junction real, symlink simulated'})`);
