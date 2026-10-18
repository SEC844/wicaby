// Self-check for the token-leak guards on media URLs: token parameters stripped from
// server URLs, foreign origins never treated as the server, wicaby-media:// origin and
// path checks, HLS playlist rewriting, the remote-image allow-list and address filter,
// and renderer image ids. No server, no network.
// Run: node tools/checks/media-url-check.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-media-url-'));
const electronNames = ['app', 'net', 'protocol', 'session', 'powerSaveBlocker', 'powerMonitor', 'BrowserWindow', 'BaseWindow', 'WebContentsView', 'screen', 'shell', 'dialog', 'ipcMain', 'nativeImage', 'nativeTheme', 'Menu', 'Tray', 'globalShortcut', 'Notification', 'clipboard', 'utilityProcess', 'systemPreferences'];
const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onResolve({ filter: /stores\.svelte$/ }, () => ({ path: 'stores', namespace: 'stub' }));
    b.onLoad({ filter: /^electron$/, namespace: 'stub' }, () => ({
      contents:
        `export const app = { isReady: () => false, isPackaged: true, getLocale: () => 'fr', getPath: () => '.', on() {} };\n` +
        `export const net = { fetch: () => Promise.reject(new Error('no network in checks')), request: (o) => { if (globalThis.__netRequest) return globalThis.__netRequest(o); throw new Error('no network in checks'); } };\n` +
        electronNames.filter((n) => n !== 'app' && n !== 'net').map((n) => `export const ${n} = {};`).join('\n'),
    }));
    b.onLoad({ filter: /^stores$/, namespace: 'stub' }, () => ({ contents: `export const sessionFor = () => undefined;` }));
  },
};
async function load(rel) {
  const out = path.join(dir, `${path.basename(rel).replace(/\W/g, '_')}.mjs`);
  await build({ entryPoints: [path.join(root, rel)], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [stubs], packages: 'external' });
  return import(pathToFileURL(out).href);
}

const { stripTokenParams, isServerOrigin, serverPath, resolveServerUrl, plainHttpUrl, sameServer, fetchFollowing } = await load('src/main/connection/api-client.ts');
const { mediaOriginAllowed, apiPathRefused, stripPlaylistTokens, readPlaylist, MAX_PLAYLIST_BYTES } = await load('src/main/protocols.ts');
const { allowedImageHost, providerUrl, publicAddress, checkImageUrl, previewType } = await load('src/main/admin/item-images.ts');
const { mediaApiUrl, validId, redirectTarget } = await load('src/main/playback/playback-model.ts');
globalThis.devicePixelRatio = 1;
const { imageUrl, userImageUrl, posterUrl } = await load('src/renderer/lib/images.ts');

// --- M2/M3: token parameters
assert.equal(stripTokenParams('/Videos/1/master.m3u8?MediaSourceId=a&api_key=SECRET&x=1'), '/Videos/1/master.m3u8?MediaSourceId=a&x=1');
assert.equal(stripTokenParams('/v?ApiKey=SECRET'), '/v');
assert.equal(stripTokenParams('/v?APIKEY=S&API_KEY=S&X-Emby-Token=S&api%5Fkey=S#frag'), '/v#frag');
assert.equal(stripTokenParams('/v?a=%2F&b=c+d'), '/v?a=%2F&b=c+d', 'other parameters untouched');
assert.equal(stripTokenParams('/v'), '/v');

const emby = { address: 'http://srv.example:8096', prefix: '/emby', kind: 'emby' };
const jf = { address: 'https://media.example/jf', prefix: '', kind: 'jellyfin' };
assert.ok(isServerOrigin(emby, '/videos/1/master.m3u8'));
assert.ok(isServerOrigin(emby, 'videos/1/stream'));
assert.ok(isServerOrigin(emby, 'http://SRV.example:8096/emby/videos/1'));
assert.ok(!isServerOrigin(emby, 'https://srv.example:8096/emby/videos/1'), 'scheme is part of the origin');
assert.ok(!isServerOrigin(emby, 'http://srv.example:8097/x'), 'port is part of the origin');
assert.ok(!isServerOrigin(emby, 'http://cdn.example/x'));
assert.ok(!isServerOrigin(emby, '//cdn.example/x'), 'protocol-relative is another origin');
assert.ok(isServerOrigin(jf, 'https://media.example:443/jf/x'));

// Foreign absolute URLs come back stripped and unrouted; server ones resolve as before.
assert.equal(resolveServerUrl(emby, '/videos/1/master.m3u8?api_key=S&a=1'), 'http://srv.example:8096/emby/videos/1/master.m3u8?a=1');
assert.equal(resolveServerUrl(emby, '/emby/videos/1/stream'), 'http://srv.example:8096/emby/videos/1/stream');
assert.equal(resolveServerUrl(emby, 'https://cdn.example/x.m3u8?api_key=S'), 'https://cdn.example/x.m3u8');
assert.equal(resolveServerUrl(jf, '/Videos/1/Subtitles/2/0/Stream.srt?ApiKey=S'), 'https://media.example/jf/Videos/1/Subtitles/2/0/Stream.srt');

// Nothing but http(s) ever reaches a player: a UNC or network path would hand mpv (and
// Windows SMB, with the user's NTLM hash) another host, other schemes local files or filters.
for (const bad of ['//attacker.example/share/x.mkv', '\\\\attacker.example\\share\\x.mkv', '\\/attacker.example/x', 'file://attacker.example/share/x', 'file:///C:/Windows/win.ini', 'edl://x', 'av://lavfi:testsrc', 'smb://attacker.example/x', 'ftp://cdn.example/x', 'https://user:pw@cdn.example/x', 'javascript:alert(1)']) {
  assert.equal(resolveServerUrl(emby, bad), null, bad);
  assert.equal(serverPath(emby, bad), null, bad);
}
// '/\host' is a network path to WHATWG too: refused. A backslash later on stays in the path.
assert.equal(resolveServerUrl(emby, '/\\attacker.example/x'), null);
assert.equal(resolveServerUrl(emby, '/Videos\\..\\..\\x'), 'http://srv.example:8096/x', 'dot segments never leave the server origin');
// WHATWG form for FFmpeg: 'srv\@evil' would otherwise parse as userinfo@evil there.
assert.equal(resolveServerUrl(emby, 'http://srv.example:8096\\@evil.example/x'), 'http://srv.example:8096/@evil.example/x');
assert.equal(plainHttpUrl('https://cdn.example/a b.m3u8?api_key=S&x=1'), 'https://cdn.example/a%20b.m3u8?x=1');
assert.equal(plainHttpUrl('//cdn.example/x'), null);
assert.equal(plainHttpUrl('file:///C:/x'), null);
// Redirect hops: only the server's own origin (or its loopback forwarder) keeps the auth headers.
assert.ok(sameServer(emby, 'http://srv.example:8096/emby/Videos/1/stream'));
assert.ok(!sameServer(emby, 'https://srv.example:8096/x'));
assert.ok(!sameServer(emby, 'http://cdn.example/x.mkv'));
assert.ok(!sameServer(emby, 'file:///C:/x'));

assert.equal(serverPath(emby, 'http://srv.example:8096/emby/videos/1/main.m3u8?api_key=S'), '/emby/videos/1/main.m3u8');
assert.equal(serverPath(jf, 'https://media.example/jf/Videos/1/stream?ApiKey=S&x=1'), '/Videos/1/stream?x=1');
assert.equal(serverPath(emby, 'https://cdn.example/x'), null);
assert.equal(serverPath(emby, 'videos/1?api_key=S'), '/videos/1');

// Renderer URLs never carry a token.
assert.equal(mediaApiUrl('/Videos/1/master.m3u8?api_key=SECRET&x=1', 'abc'), 'wicaby-media://api/abc/Videos/1/master.m3u8?x=1');
assert.equal(mediaApiUrl('Videos/1/stream?ApiKey=SECRET'), 'wicaby-media://api/Videos/1/stream');
// Ids and paths that would hop to another server are refused where URLs are built.
const sidA = '0123456789abcdef0123456789abcdef';
for (const bad of [`/Videos/../../${sidA}/Users/x`, '/Videos/%2e%2e/x', '/Videos/a%2Fb', '/Videos/a\\b', '//evil.example/x', '/Videos/./x'])
  assert.throws(() => mediaApiUrl(bad, sidA), bad);
assert.throws(() => mediaApiUrl('/Videos/1/stream', '../x'));
assert.equal(mediaApiUrl('/Videos/1/Subtitles/2/0/Stream.srt?x=a%2Fb'), 'wicaby-media://api/Videos/1/Subtitles/2/0/Stream.srt?x=a%2Fb');
for (const ok of ['12345', sidA, 'a-b']) assert.ok(validId(ok), ok);
for (const bad of ['../x', 'a/b', '', 'x'.repeat(65), 'a.b', undefined, 1]) assert.ok(!validId(bad), String(bad));

// HLS playlists relayed by wicaby-media:// lose their token parameters.
const playlist = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="/Videos/1/Subtitles/2/subtitles.m3u8?SegmentLength=3&ApiKey=SECRET"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1000',
  'main.m3u8?MediaSourceId=a&api_key=SECRET',
  'hls1/main/0.ts?x=1',
  '',
].join('\n');
const cleaned = stripPlaylistTokens(playlist);
assert.ok(!/SECRET/.test(cleaned), cleaned);
assert.ok(cleaned.includes('URI="/Videos/1/Subtitles/2/subtitles.m3u8?SegmentLength=3"'));
assert.ok(cleaned.includes('\nmain.m3u8?MediaSourceId=a\n'));
assert.ok(cleaned.includes('\nhls1/main/0.ts?x=1\n'));
assert.equal(stripPlaylistTokens('#EXT-X-MEDIA:TYPE=SUBTITLES,URI = "/s.m3u8?api_key=SECRET"'), '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="/s.m3u8"');
assert.equal(stripPlaylistTokens('#EXT-X-KEY:METHOD=AES-128,uri="/k?ApiKey=SECRET"'), '#EXT-X-KEY:METHOD=AES-128,URI="/k"');

// Playlist bodies are capped before the rewrite: a declared or streamed body past the cap is refused.
assert.equal(await readPlaylist(new Response('#EXTM3U\nmain.m3u8 é')), '#EXTM3U\nmain.m3u8 é');
assert.equal(await readPlaylist(new Response('x', { headers: { 'content-length': String(MAX_PLAYLIST_BYTES + 1) } })), null, 'declared length over the cap');
let pulled = 0;
const endless = new ReadableStream({ pull: (c) => (pulled++, c.enqueue(new Uint8Array(1024 * 1024))) });
assert.equal(await readPlaylist(new Response(endless)), null, 'endless body');
assert.ok(pulled < MAX_PLAYLIST_BYTES / (1024 * 1024) + 4, `stops reading at the cap (${pulled} chunks)`);

// --- L3: wicaby-media:// origin and api path checks
assert.ok(mediaOriginAllowed(null, undefined));
assert.ok(mediaOriginAllowed('app://wicaby', undefined));
assert.ok(mediaOriginAllowed('http://localhost:5173', 'http://localhost:5173'));
assert.ok(!mediaOriginAllowed('http://localhost:5173', undefined));
assert.ok(!mediaOriginAllowed('https://www.youtube-nocookie.com', 'http://localhost:5173'));
assert.ok(!mediaOriginAllowed('null', undefined));
assert.ok(!mediaOriginAllowed('app://wicaby.evil', undefined));

assert.ok(!apiPathRefused('wicaby-media://api/0123456789abcdef0123456789abcdef/Items/1/Images/Primary?tag=a%2Fb'), 'encoded slash in the query is fine');
assert.ok(!apiPathRefused('wicaby-media://api/Videos/1/stream.mkv?Static=true'));
assert.ok(apiPathRefused('wicaby-media://api/sidA/../sidB/Items'));
assert.ok(apiPathRefused('wicaby-media://api/sidA/%2e%2e/sidB/Items'));
assert.ok(apiPathRefused('wicaby-media://api/sidA/.%2E/x'));
assert.ok(apiPathRefused('wicaby-media://api/Items%2F..%2Fx'));
assert.ok(apiPathRefused('wicaby-media://api/Items%5C..%5Cx'));
assert.ok(apiPathRefused('wicaby-media://api//evil.example/x'));
assert.ok(apiPathRefused('wicaby-media://api/Items/./x'));
// Userinfo, port or another host: a regex anchored on '://api' missed these.
assert.ok(apiPathRefused('wicaby-media://x@api/a/%2e%2e/%2fb'));
assert.ok(apiPathRefused('wicaby-media://u:p@api/Items'));
assert.ok(apiPathRefused('wicaby-media://api:8080/Items'));
assert.ok(apiPathRefused('wicaby-media://local/Items'));
assert.ok(apiPathRefused('not a url'));
// Other escapes in a path are legitimate.
assert.ok(!apiPathRefused('wicaby-media://api/Items/1/Images/Primary%20x'));
assert.ok(!apiPathRefused('wicaby-media://api/Videos/1/file%2Emkv'));

// --- L2: remote image proxy
for (const ok of ['image.tmdb.org', 'artworks.thetvdb.com', 'thetvdb.com', 'assets.fanart.tv', 'm.media-amazon.com', 'images.metahub.space', 'IMAGE.TMDB.ORG', 'ia800.us.archive.org'])
  assert.ok(allowedImageHost(ok), ok);
for (const bad of ['localhost', 'localhost.', 'image.tmdb.org.', 'evil.image.tmdb.org', 'tmdb.org', 'image.tmdb.org.evil.com', 'archive.org.evil', '127.0.0.1', '', '.archive.org'])
  assert.ok(!allowedImageHost(bad), bad);
assert.ok(providerUrl('https://image.tmdb.org/t/p/original/a.jpg'));
assert.equal(providerUrl('https://user:pw@image.tmdb.org/a.jpg'), null);
assert.equal(providerUrl('https://image.tmdb.org:8443/a.jpg'), null);
assert.equal(providerUrl('ftp://image.tmdb.org/a.jpg'), null);
assert.equal(providerUrl('http://localhost./a.jpg'), null);
assert.equal(providerUrl('http://[::1]/a.jpg'), null);

for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.50.1', '169.254.169.254', '100.101.102.103', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd7a:115c:a1e0::1', '::ffff:127.0.0.1', '::ffff:192.168.50.1', '::ffff:7f00:1', 'not an ip'])
  assert.ok(!publicAddress(ip), ip);
for (const ip of ['104.16.1.1', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.ok(publicAddress(ip), ip);
// IPv4 embedded in IPv6 (NAT64, IPv4-compatible, 6to4, Teredo) is judged by its IPv4 part.
for (const ip of ['64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '64:ff9b::c0a8:1', '::127.0.0.1', '::7f00:1', '::8.8.8.8', '2002:7f00:1::', '2002:c0a8:1::1', '2002:a00:1::', '2001:0:4136:e378::1', 'fe80::1%eth0', '0:0:0:0:0:ffff:7f00:1'])
  assert.ok(!publicAddress(ip), ip);
for (const ip of ['64:ff9b::808:808', '64:ff9b::8.8.8.8', '2002:808:808::1', '2a00:1450:4007:80e::200e']) assert.ok(publicAddress(ip), ip);

const dns = (map) => async (host) => {
  if (!(host in map)) throw new Error('ENOTFOUND');
  return map[host].map((address) => ({ address }));
};
assert.ok(await checkImageUrl('https://image.tmdb.org/t/p/w300/a.jpg', dns({ 'image.tmdb.org': ['104.16.1.1'] })));
assert.equal(await checkImageUrl('https://image.tmdb.org/a.jpg', dns({ 'image.tmdb.org': ['104.16.1.1', '192.168.50.10'] })), null, 'one private answer is enough to refuse');
assert.equal(await checkImageUrl('https://image.tmdb.org/a.jpg', dns({ 'image.tmdb.org': ['127.0.0.1'] })), null);
assert.equal(await checkImageUrl('https://image.tmdb.org/a.jpg', dns({})), null);
assert.equal(await checkImageUrl('https://evil.example/a.jpg', dns({ 'evil.example': ['104.16.1.1'] })), null);

assert.equal(previewType('image/jpeg'), 'image/jpeg');
assert.equal(previewType('Image/PNG; charset=binary'), 'image/png');
assert.equal(previewType('image/svg+xml'), null);
assert.equal(previewType('image/svg+xml; charset=utf-8'), null);
assert.equal(previewType('text/html'), null);
assert.equal(previewType(''), null);

// --- L3: renderer image ids
assert.equal(imageUrl('abc-123', 'Primary', { server: '0123456789abcdef0123456789abcdef', maxHeight: 100 }), 'wicaby-media://api/0123456789abcdef0123456789abcdef/Items/abc-123/Images/Primary?quality=90&maxHeight=100');
for (const bad of ['../Users', 'a/b', '%2e%2e', 'a?b', 'x'.repeat(65), '', 'a b']) assert.equal(imageUrl(bad, 'Primary'), '', bad);
assert.equal(imageUrl('abc', 'Primary', { server: '../x' }), '');
assert.equal(imageUrl('abc', 'Primary', { index: -1 }), '');
assert.equal(userImageUrl('../../Items'), '');
assert.ok(userImageUrl('u-wika').startsWith('wicaby-media://api/Users/u-wika/Images/Primary?'));
assert.equal(posterUrl({ Id: '../x', ImageTags: { Primary: 't' } }), null);

// --- Redirects: the token stays with the server (fetchFollowing, redirectTarget). A fake
// net.request: `hops` maps a URL to its 302 Location, anything else answers 200 "ok".
const sent = [];
let hops = {};
globalThis.__netRequest = ({ url }) => {
  const req = new EventEmitter();
  const headers = {};
  let at = url;
  const step = () => {
    sent.push({ url: at, headers: { ...headers } });
    if (hops[at]) return req.emit('redirect', 302, 'GET', hops[at]);
    const res = Object.assign(Readable.from([Buffer.from('ok')]), { statusCode: 200, headers: {} });
    req.emit('response', res);
  };
  Object.assign(req, {
    setHeader: (k, v) => (headers[k] = v),
    followRedirect: () => ((at = hops[at]), queueMicrotask(step)),
    abort: () => req.emit('abort'),
    end: () => queueMicrotask(step),
  });
  return req;
};
const SRV = 'http://srv.example:8096/emby';
const auth = { 'X-Emby-Token': 'SECRET' };
hops = { [`${SRV}/Items/1/Download`]: `${SRV}/strm`, [`${SRV}/strm`]: 'https://cdn.example/f.mkv?api_key=SECRET' };
const got = await fetchFollowing(emby, `${SRV}/Items/1/Download`, { method: 'GET', headers: { Range: 'bytes=5-' }, auth });
assert.equal(await got.text(), 'ok');
assert.deepEqual(sent.map((r) => [r.url, r.headers['X-Emby-Token'], r.headers.Range]), [
  [`${SRV}/Items/1/Download`, 'SECRET', 'bytes=5-'],
  [`${SRV}/strm`, 'SECRET', 'bytes=5-'],
  ['https://cdn.example/f.mkv', undefined, 'bytes=5-'],
], 'a hop to another origin goes without the token');
hops = { 'https://a.example/x': 'https://b.example/x', 'https://b.example/x': 'https://a.example/x', [`${SRV}/loop`]: 'https://a.example/x' };
assert.equal(await fetchFollowing(emby, `${SRV}/loop`, { method: 'GET', headers: {}, auth }), null, 'endless redirects end');
await assert.rejects(fetchFollowing(emby, `${SRV}/x`, { method: 'GET', headers: {}, auth, signal: AbortSignal.abort() }), /aborted/);
const embyApi = { ...emby, authHeaders: () => auth };
hops = { [`${SRV}/Videos/1/stream`]: 'https://cdn.example/v.mkv' };
assert.equal(await redirectTarget(embyApi, `${SRV}/Videos/1/stream`), 'https://cdn.example/v.mkv');
hops = {};
assert.equal(await redirectTarget(embyApi, `${SRV}/Videos/1/stream`), null, 'no redirect: played with the header');
const fake = globalThis.__netRequest;
globalThis.__netRequest = (o) => {
  if (o.method === 'HEAD') throw new Error('no HEAD');
  return fake(o);
};
hops = { [`${SRV}/Videos/1/stream`]: 'https://cdn.example/v.mkv' };
assert.equal(await redirectTarget(embyApi, `${SRV}/Videos/1/stream`), 'https://cdn.example/v.mkv', 'HEAD failed: a GET asks again');
assert.equal(sent.at(-1).headers.Range, 'bytes=0-0');
hops = {};
assert.equal(await redirectTarget(embyApi, `${SRV}/Videos/1/stream`), null, 'HEAD failed, GET did not redirect: played with the header');
globalThis.__netRequest = () => {
  throw new Error('offline');
};
await assert.rejects(redirectTarget(embyApi, `${SRV}/Videos/1/stream`), 'both failed: no playback at all');
delete globalThis.__netRequest;

fs.rmSync(dir, { recursive: true, force: true });
console.log('media-url-check: all assertions passed');
