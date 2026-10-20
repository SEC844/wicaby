// Self-check for the web TV app's shared pieces (docs/webtv.md): the 'tv' device profile, image URLs through
// mediaBase (the desktop's unchanged), the TV Back keys, and the web bridge's auth header and demo server.
// No network: the demo server answers in-process.
// Run: node tools/checks/webtv-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { build } from 'esbuild';

const repo = path.resolve(import.meta.dirname, '..', '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-webtv-'));
const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /stores\.svelte$/ }, () => ({ path: 'stores', namespace: 'stub' }));
    b.onResolve({ filter: /router\.svelte$/ }, () => ({ path: 'router', namespace: 'stub' }));
    b.onLoad({ filter: /^stores$/, namespace: 'stub' }, () => ({ contents: `export const sessionFor = () => undefined;` }));
    b.onLoad({ filter: /^router$/, namespace: 'stub' }, () => ({ contents: `export const back = () => {}; export const router = { route: { name: 'home' } };` }));
    // i18n.svelte.ts globs the catalogues through Vite: the key stands in for the text.
    b.onResolve({ filter: /i18n\.svelte$/ }, () => ({ path: 'i18n', namespace: 'stub' }));
    b.onLoad({ filter: /^i18n$/, namespace: 'stub' }, () => ({ contents: `export const t = (k) => k; export const fmt = {}; export const has = () => false;` }));
  },
};
async function load(rel) {
  const out = path.join(dir, `${path.basename(rel).replace(/\W/g, '_')}.mjs`);
  await build({ entryPoints: [path.join(repo, rel)], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [stubs], packages: 'external', define: { 'import.meta.env.VITE_WICABY_DEMO': '"1"', 'import.meta.env.VITE_WICABY_VERSION': '"0"' } });
  return import(pathToFileURL(out).href);
}

// --- The 'tv' profile: would the server direct play this file? (the server's DirectPlayProfiles match, simplified)
const { buildDeviceProfile } = await load('apps/desktop/src/shared/device-profile.ts');
const tv = buildDeviceProfile('tv', 40_000_000, 'emby');
const directPlays = (p, container, video, audio) =>
  p.DirectPlayProfiles.some(
    (d) => d.Type === 'Video' && d.Container.split(',').includes(container) && d.VideoCodec?.split(',').includes(video) && d.AudioCodec?.split(',').includes(audio),
  );
assert.ok(directPlays(tv, 'mkv', 'hevc', 'eac3'), 'tv: mkv HEVC EAC3 direct plays');
assert.ok(directPlays(tv, 'mp4', 'h264', 'aac'));
assert.ok(directPlays(tv, 'ts', 'h264', 'ac3'));
assert.ok(!directPlays(tv, 'mkv', 'hevc', 'dts'), 'tv: DTS is transcoded');
assert.ok(!directPlays(tv, 'mkv', 'h264', 'truehd'), 'tv: TrueHD is transcoded');
assert.ok(!directPlays(tv, 'avi', 'mpeg4', 'mp3'), 'tv: other containers are transcoded');
assert.equal(tv.TranscodingProfiles[0].Protocol, 'hls');
assert.equal(tv.TranscodingProfiles[0].VideoCodec, 'h264');
assert.ok(!tv.TranscodingProfiles[0].AudioCodec.includes('dts'));
const sub = (p, f) => p.SubtitleProfiles.find((s) => s.Format === f)?.Method;
assert.equal(sub(tv, 'srt'), 'External');
assert.equal(sub(tv, 'vtt'), 'External');
assert.equal(sub(tv, 'ass'), 'Encode', 'ASS is burnt in on TV');
assert.equal(sub(tv, 'pgssub'), 'Encode', 'PGS is burnt in on TV');
// The desktop profiles are untouched by the third branch.
const html = buildDeviceProfile('html', 1, 'emby');
assert.ok(!directPlays(html, 'mkv', 'hevc', 'eac3'));
assert.deepEqual(buildDeviceProfile('mpv', 1, 'emby').DirectPlayProfiles, [{ Type: 'Video' }, { Type: 'Audio' }]);
assert.equal(buildDeviceProfile('tv', 1, 'emby', 1080).CodecProfiles[0].Conditions[1].Value, '1080');

// --- Image URLs: the desktop's are unchanged; apps/webtv swaps the base.
globalThis.devicePixelRatio = 1;
const images = await load('apps/desktop/src/renderer/lib/images.ts');
const sid = '0123456789abcdef0123456789abcdef';
assert.equal(images.mediaBase(), 'wicaby-media://api');
assert.equal(images.mediaBase(sid), `wicaby-media://api/${sid}`);
assert.equal(images.imageUrl('movie-1', 'Primary', { tag: 't1', maxHeight: 360 }), 'wicaby-media://api/Items/movie-1/Images/Primary?quality=90&tag=t1&maxHeight=360');
assert.equal(images.imageUrl('movie-1', 'Backdrop', { server: sid, maxWidth: 1920 }), `wicaby-media://api/${sid}/Items/movie-1/Images/Backdrop?quality=90&maxWidth=1920`);
assert.equal(images.userImageUrl('u-wika', 'a', 48, sid), `wicaby-media://api/${sid}/Users/u-wika/Images/Primary?quality=90&maxHeight=96&tag=a`);
images.setMediaBase((s) => (s ? `https://media.example/emby` : 'http://127.0.0.1:8096/emby'));
assert.equal(images.imageUrl('movie-1', 'Primary', { tag: 't1' }), 'http://127.0.0.1:8096/emby/Items/movie-1/Images/Primary?quality=90&tag=t1');
assert.equal(images.imageUrl('movie-1', 'Logo', { server: sid }), 'https://media.example/emby/Items/movie-1/Images/Logo?quality=90');
assert.equal(images.imageUrl('../x', 'Primary'), '', 'ids are still checked with another base');

// --- TV remote Back keys.
const { isBackKey } = await load('apps/desktop/src/renderer/lib/spatial.ts');
assert.ok(isBackKey({ key: 'BrowserBack', keyCode: 166 }));
assert.ok(isBackKey({ key: 'GoBack', keyCode: 461 }), 'LG Back');
assert.ok(isBackKey({ key: 'XF86Back', keyCode: 10009 }), 'Samsung Back');
assert.ok(!isBackKey({ key: 'Escape', keyCode: 27 }));

// --- Web bridge: the auth header (as the desktop's ApiClient), log redaction, media URLs.
const http = await load('apps/webtv/src/http.ts');
const id = { client: 'Wicaby', version: '1.2.3', deviceId: 'dev1', deviceName: 'LG webOS TV' };
assert.deepEqual(http.authHeaders({ kind: 'emby', token: 'TOK', userId: 'u1' }, id), {
  'X-Emby-Authorization': 'Emby UserId="u1", Client="Wicaby", Device="LG%20webOS%20TV", DeviceId="dev1", Version="1.2.3"',
  'X-Emby-Token': 'TOK',
});
assert.deepEqual(http.authHeaders({ kind: 'jellyfin', token: 'TOK' }, id), { Authorization: 'MediaBrowser Client="Wicaby", Device="LG%20webOS%20TV", DeviceId="dev1", Version="1.2.3", Token="TOK"' });
assert.deepEqual(http.authHeaders({ kind: 'emby' }, id), { 'X-Emby-Authorization': 'Emby Client="Wicaby", Device="LG%20webOS%20TV", DeviceId="dev1", Version="1.2.3"' }, 'no token before sign-in');
assert.equal(http.apiBase({ address: 'http://h:8096', kind: 'emby' }), 'http://h:8096/emby');
assert.equal(http.apiBase({ address: 'https://h/jf', kind: 'jellyfin' }), 'https://h/jf');
assert.deepEqual(http.addressCandidates('media.example'), ['https://media.example', 'http://media.example:8096', 'http://media.example']);
assert.deepEqual(http.addressCandidates('10.0.0.5:8920/'), ['http://10.0.0.5:8920', 'https://10.0.0.5:8920']);
const leak = 'GET /Videos/1/stream?api_key=SECRET1&x=1 X-Emby-Token: SECRET2 {"AccessToken":"SECRET3"} Token="SECRET4" /v?ApiKey=SECRET5';
assert.ok(!/SECRET/.test(http.redact(leak)), http.redact(leak));
assert.ok(http.redact(leak).includes('x=1'));

const { mediaUrl } = await load('apps/webtv/src/playback.ts');
const emby = { address: 'http://127.0.0.1:8096', kind: 'emby', token: 'T' };
const jf = { address: 'https://h.example/jf', kind: 'jellyfin', token: 'T' };
assert.equal(mediaUrl(emby, '/Videos/1/stream?Static=true'), 'http://127.0.0.1:8096/emby/Videos/1/stream?Static=true&api_key=T');
assert.equal(mediaUrl(emby, '/emby/videos/1/master.m3u8?api_key=T'), 'http://127.0.0.1:8096/emby/videos/1/master.m3u8?api_key=T', 'an Emby URL with its prefix and token');
assert.equal(mediaUrl(jf, '/Videos/1/stream'), 'https://h.example/jf/Videos/1/stream?ApiKey=T', 'Jellyfin takes ApiKey');
assert.equal(mediaUrl(jf, 'https://cdn.example/x.mp4'), 'https://cdn.example/x.mp4', 'another origin gets no token');
assert.equal(mediaUrl(jf, 'file:///etc/passwd'), null);

// --- A forced transcode resumes at the resume point: the HLS playlist covers the whole film, so hls.js seeks there.
{
  const { WebPlayback } = await load('apps/webtv/src/playback.ts');
  const { defaultSettings } = await load('apps/desktop/src/shared/default-settings.ts');
  const settings = defaultSettings('');
  settings.playback.forceTranscode = true;
  const loads = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = String(url).includes('/PlaybackInfo')
      ? { PlaySessionId: 'p1', MediaSources: [{ Id: 'src1', SupportsDirectPlay: true, TranscodingUrl: '/videos/m1/master.m3u8?PlaySessionId=p1', TranscodingSubProtocol: 'hls', MediaStreams: [] }] }
      : { Id: 'm1', Name: 'M', Type: 'Movie', RunTimeTicks: 72_000_000_000, MediaSources: [{ Id: 'src1', MediaStreams: [] }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const host = { server: () => ({ id: 's1', address: 'http://127.0.0.1:8096', kind: 'jellyfin', token: 'T', userId: 'u1' }), identity: id, settings: () => settings, load: (l) => loads.push(l), command: () => {}, publish: () => {}, log: () => {} };
  try {
    await new WebPlayback(host).play({ itemIds: ['m1'], serverId: 's1', startPositionTicks: 600_000_000 });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(loads[0]?.isHls, true);
  assert.equal(loads[0].startMs, 55_000, 'resume at 60 s minus the 5 s rewind, not 0:00');
}

// --- Playback edge cases: 'previous' on the first item, a player error, a refused second item.
{
  const { WebPlayback } = await load('apps/webtv/src/playback.ts');
  const { defaultSettings } = await load('apps/desktop/src/shared/default-settings.ts');
  const settings = defaultSettings('');
  const commands = [];
  const published = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/Items/refused')) return new Response('no', { status: 500 });
    const body = u.includes('/PlaybackInfo')
      ? { PlaySessionId: 'p1', MediaSources: [{ Id: 'src1', SupportsDirectPlay: true, MediaStreams: [] }] }
      : u.includes('/Sessions/')
        ? {}
        : { Id: 'm1', Name: 'M', Type: 'Movie', RunTimeTicks: 72_000_000_000, MediaSources: [{ Id: 'src1', MediaStreams: [] }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const host = { server: () => ({ id: 's1', address: 'http://127.0.0.1:8096', kind: 'emby', token: 'T', userId: 'u1' }), identity: id, settings: () => settings, load: () => {}, command: (c) => commands.push(c), publish: (s) => published.push(s), log: () => {} };
  try {
    const pb = new WebPlayback(host);
    await pb.play({ itemIds: ['m1'], serverId: 's1' });
    await pb.command({ type: 'previous' });
    assert.deepEqual(commands.at(-1), { type: 'seek', positionMs: 0 }, "'previous' on the first item restarts it");
    assert.equal(pb.value.active, true);

    pb.onEvent({ type: 'error', message: 'codec' });
    assert.ok(published.some((s) => s.error === 'codec'), 'a player error is published before the reset');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(pb.value.active, false);

    await pb.play({ itemIds: ['m1'], serverId: 's1' });
    commands.length = 0;
    await assert.rejects(pb.play({ itemIds: ['refused'], serverId: 's1' }));
    assert.deepEqual(commands, [{ type: 'unload' }], 'a refused new item unloads the old one');
    assert.equal(pb.value.active, false);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- Web bridge: a re-added server on another origin loses its token; the selected server survives a restart.
{
  const mem = () => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  };
  const saved = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, window: globalThis.window, fetch: globalThis.fetch };
  Object.assign(globalThis, { localStorage: mem(), sessionStorage: mem(), window: { addEventListener: () => {} } });
  const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/System/Info/Public')) return new Response(JSON.stringify({ Id: ID, ServerName: 'S', ProductName: 'Emby Server' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/AuthenticateByName')) return new Response(JSON.stringify({ AccessToken: 'TOK', User: { Id: 'u1', Name: 'Wika' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ Id: 'u1', Name: 'Wika' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const { createWebBridge } = await load('apps/webtv/src/bridge.ts');
    const w = createWebBridge().bridge;
    await w.servers.add('https://media.example');
    await w.session.login('Wika', 'pw', ID);
    assert.equal((await w.servers.add('https://media.example')).hasToken, true, 'same origin keeps the sign-in');
    const moved = await w.servers.add('http://evil.example');
    assert.equal(moved.hasToken, false, 'a server Id answered by another origin does not inherit the token');
    assert.equal(moved.userId, undefined);
    await w.servers.add('http://127.0.0.1:8096');
    assert.equal((await w.servers.list()).length, 1);
    const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/System/Info/Public')) return json({ Id: u.includes(':8097') ? B : ID, ServerName: 'S' });
      if (u.includes('/AuthenticateByName')) return json({ AccessToken: 'TOK', User: { Id: 'u1', Name: 'Wika' } });
      return json({ Id: 'u1', Name: 'Wika' });
    };
    await w.servers.add('http://127.0.0.1:8097');
    await w.session.login('Wika', 'pw', B);
    await w.session.login('Wika', 'pw', ID);
    await w.servers.select(B);
    assert.equal((await createWebBridge().bridge.session.get()).server?.id, B, 'the selected server is still first after a restart');
  } finally {
    Object.assign(globalThis, saved);
  }
}

// --- The demo server: browse, favourites, progress, all in the page.
const demo = await load('apps/webtv/src/demo.ts');
const cat = {
  server: { Id: 'x', ServerName: 'Wicaby Demo', Version: '1', ProductName: 'Emby Server' },
  user: { Id: 'u-wika', Name: 'Wika' },
  views: [{ Id: 'lib-movies', Name: 'Movies', Type: 'CollectionFolder', CollectionType: 'movies' }],
  items: {
    'movie-0': { Id: 'movie-0', Name: 'B', Type: 'Movie', _view: 'lib-movies', DateCreated: '2026-01-02', Genres: ['Animation'] },
    'movie-1': { Id: 'movie-1', Name: 'A', Type: 'Movie', _view: 'lib-movies', DateCreated: '2026-01-01', Genres: ['Animation'] },
  },
  children: {},
};
await demo.loadDemo(cat);
const q = (p, query, method = 'GET', body) => demo.demoRequest(method, p, query, body);
assert.equal((await q('/System/Info/Public')).Id, demo.DEMO_ID);
assert.deepEqual((await q('/Users/u-wika/Items', { ParentId: 'lib-movies', SortBy: 'SortName' })).Items.map((i) => i.Name), ['A', 'B']);
assert.deepEqual((await q('/Users/u-wika/Items/Latest', { ParentId: 'lib-movies' })).map((i) => i.Id), ['movie-0', 'movie-1']);
assert.equal((await q('/Users/u-wika/Items/movie-0')).ServerId, demo.DEMO_ID);
await q('/Users/u-wika/FavoriteItems/movie-1', {}, 'POST');
assert.deepEqual((await q('/Users/u-wika/Items', { Filters: 'IsFavorite', Recursive: true })).Items.map((i) => i.Id), ['movie-1']);
await q('/Sessions/Playing/Stopped', {}, 'POST', { ItemId: 'movie-0', PositionTicks: 50_000_000 });
assert.equal((await q('/Users/u-wika/Items/Resume')).Items[0]?.Id, 'movie-0', 'a stopped clip resumes');
await q('/Sessions/Playing/Stopped', {}, 'POST', { ItemId: 'movie-0', PositionTicks: 290_000_000 });
assert.equal((await q('/Users/u-wika/Items/movie-0')).UserData.Played, true, 'played to the end: watched');
assert.equal((await q('/Items/movie-0/PlaybackInfo', {}, 'POST')).MediaSources[0].Container, 'mp4');
assert.equal(await q('/Something/Else', {}, 'POST'), undefined);

// --- TV packages: the .ipk is an ar of debian-binary, control.tar.gz and data.tar.gz with appinfo.json under
// usr/palm/applications/<id>; the .wgt a zip with config.xml at its root.
const pkg = await import(pathToFileURL(path.join(repo, 'apps/webtv/scripts/package.mjs')).href);
const files = [
  { rel: 'index.html', data: Buffer.from('<!doctype html>') },
  { rel: 'assets/index.js', data: Buffer.from('x') },
];
const ipk = pkg.webosIpk(files);
assert.equal(ipk.subarray(0, 8).toString('ascii'), '!<arch>\n');
const members = [];
for (let at = 8; at < ipk.length; ) {
  const name = ipk.subarray(at, at + 16).toString('ascii').trim();
  const size = Number(ipk.subarray(at + 48, at + 58).toString('ascii').trim());
  members.push({ name, data: ipk.subarray(at + 60, at + 60 + size) });
  at += 60 + size + (size % 2);
}
assert.deepEqual(members.map((m) => m.name), ['debian-binary', 'control.tar.gz', 'data.tar.gz']);
assert.equal(members[0].data.toString(), '2.0\n');
const untar = (gz) => {
  const t = zlib.gunzipSync(gz);
  const out = [];
  for (let at = 0; at + 512 <= t.length; ) {
    const name = t.subarray(at, at + 100).toString('utf8').split('\0')[0];
    if (!name) break;
    const size = parseInt(t.subarray(at + 124, at + 136).toString('ascii'), 8);
    out.push({ name, body: t.subarray(at + 512, at + 512 + size).toString('utf8') });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
};
assert.ok(untar(members[1].data).some((f) => f.name === './control' && f.body.includes(`Package: ${pkg.WEBOS_ID}`)));
const data = untar(members[2].data);
const appinfo = data.find((f) => f.name === `./usr/palm/applications/${pkg.WEBOS_ID}/appinfo.json`);
assert.ok(appinfo, data.map((f) => f.name).join(' '));
assert.equal(JSON.parse(appinfo.body).main, 'index.html');
assert.equal(JSON.parse(appinfo.body).disableBackHistoryAPI, true);
assert.ok(data.some((f) => f.name.endsWith('/assets/index.js')));
assert.ok(data.some((f) => f.name === `./usr/palm/packages/${pkg.WEBOS_ID}/packageinfo.json`));
const wgt = pkg.tizenWgt(files);
assert.equal(wgt.readUInt32LE(0), 0x04034b50);
assert.equal(wgt.subarray(30, 30 + wgt.readUInt16LE(26)).toString(), 'config.xml', 'config.xml first, at the root');
assert.ok(pkg.tizenConfig().includes('<access origin="*" subdomains="true"/>'));
assert.ok(pkg.tizenConfig().includes('http://tizen.org/privilege/tv.inputdevice'));
assert.ok(pkg.tizenConfig().includes(`package="${pkg.TIZEN_PACKAGE}"`));
assert.match(pkg.TIZEN_PACKAGE, /^[0-9A-Za-z]{10}$/);

// --- CSS for Chromium 79-85 (apps/webtv/scripts/legacy-css.mjs): Svelte's :where() scoping, :focus-visible, :has(),
// individual transforms, inset and scroll-driven animations.
{
  const { default: postcss } = await import('postcss');
  const { legacyCss } = await import(pathToFileURL(path.join(repo, 'apps/webtv/scripts/legacy-css.mjs')).href);
  const out = (css) => postcss([legacyCss()]).process(css, { from: undefined }).css.replace(/\s+/g, ' ').trim();
  assert.equal(out('.a.svelte-x .b:where(.svelte-x):focus-visible{color:red}'), '.a.svelte-x .b.svelte-x:focus{color:red}');
  assert.equal(out('.a:hover,.a:has(.b){color:red}'), '.a:hover{color:red}');
  assert.equal(out('.a:has(.b){color:red}'), '');
  assert.equal(out('.t{left:50%;translate:-50%}'), '.t{left:50%;transform:translate(-50%)}');
  assert.equal(out('.t{transform:rotate(1deg);scale:1.03}'), '.t{transform:scale(1.03) rotate(1deg)}');
  assert.equal(out('@keyframes k{to{translate:0 -34px}}'), '@keyframes k{to{transform:translate(0, -34px)}}');
  assert.equal(out('.h{height:calc(100vh - 40px);--g:clamp(24px,3.4vw,56px);--vh:1vh}'), '.h{height:calc(calc(100 * var(--vh)) - 40px);--g:clamp(24px,calc(3.4 * var(--vw)),56px);--vh:1vh}');
  assert.equal(out('.r{display:flex;gap:12px}'), '.r{display:flex;gap:12px} .no-flex-gap .r > * + *{margin-left:12px}', 'flex gap for Chromium 79');
  assert.equal(out('.c{display:inline-flex;flex-direction:column;gap:4px 8px}'), '.c{display:inline-flex;flex-direction:column;gap:4px 8px} .no-flex-gap .c > * + *{margin-top:4px}');
  assert.equal(out('.g{display:grid;gap:12px}'), '.g{display:grid;gap:12px}', 'grid gap is Chromium 66');
  assert.equal(out('.p{inset:0 0 0 var(--rail)}'), '.p{top:0;right:0;bottom:0;left:var(--rail)}');
  assert.equal(
    out('.s{position:absolute;animation:out linear both;animation-timeline:scroll()}'),
    '.s{position:absolute} @supports (animation-timeline: scroll()){ .s{animation:out linear both;animation-timeline:scroll()}}',
  );
}

// --- A TV build, when there is one (npm run build:webtv): one classic script that parses as ES2019, the syntax of
// Chromium 79 (webOS 6): no optional chaining or ?? left over by the lowering.
const assets = path.join(repo, 'apps/webtv/dist/tv/assets');
if (fs.existsSync(assets)) {
  const { parse } = await import('acorn');
  const html = fs.readFileSync(path.join(repo, 'apps/webtv/dist/tv/index.html'), 'utf8');
  assert.ok(!/type="module"/.test(html) && html.includes('<script defer src="./assets/'), 'a classic deferred script (file:// on the TV)');
  for (const f of fs.readdirSync(assets).filter((n) => n.endsWith('.js'))) parse(fs.readFileSync(path.join(assets, f), 'utf8'), { ecmaVersion: 2019, sourceType: 'script' });
}
fs.rmSync(dir, { recursive: true, force: true });
console.log('webtv-check: all checks passed');
