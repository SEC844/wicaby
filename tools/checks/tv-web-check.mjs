// Self-check for the TV web app (apps/tv-web, docs/tv-web.md): its own DEFLATE decoder against zlib, the ZIP reader
// over Range requests on a real CBZ (stored and deflated pages, ComicInfo flags, deleted pages), the comic page order
// and spreads, when the home rows reload by themselves, AniSkip's answers as the player's segments, its MD5 and PBKDF2
// against node:crypto, scrobbling's queue, the server addresses raced (B09), and, when apps/tv-web/dist holds a
// build, that the bundle parses as ES2016 (the Chromium 53 floor: webOS 4 and Tizen 4, 2018 models). No network: the
// book and the services' answers are served from memory.
// Run: node tools/checks/tv-web-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { parse } from 'acorn';
import { build } from 'esbuild';
import { comicPage, zip } from '../mock-server/cbz-fixture.mjs';

const repo = path.resolve(import.meta.dirname, '..', '..');
const app = path.join(repo, 'apps', 'tv-web');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-tv-web-'));
async function load(rel) {
  const out = path.join(dir, `${path.basename(rel).replace(/\W/g, '_')}.mjs`);
  await build({ entryPoints: [path.join(app, rel)], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', define: { __APP_VERSION__: '"0.0.0-check"' } });
  return import(pathToFileURL(out).href);
}

// --- inflate ---
const { inflate } = await load('src/lib/inflate.ts');
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 16) & 0xff;
for (const level of [0, 1, 6, 9])
  for (const kind of ['random', 'text', 'runs', 'empty']) {
    const n = kind === 'empty' ? 0 : 150_000;
    const data = Buffer.alloc(n);
    for (let i = 0; i < n; i++) data[i] = kind === 'random' ? rand() : kind === 'text' ? 'lorem ipsum dolor sit amet '.charCodeAt(i % 27) : (i >> 7) & 1 ? 255 : 0;
    const packed = zlib.deflateRawSync(data, { level, strategy: level === 1 ? zlib.constants.Z_FIXED : undefined });
    assert.ok(Buffer.from(inflate(new Uint8Array(packed), n)).equals(data), `inflate: ${kind} at level ${level}`);
  }
// A bomb (8 MiB of zeros) claiming 1 KiB, a stored block whose length and complement disagree, a stored block cut
// short: each refused, none read past its input.
const bomb = new Uint8Array(zlib.deflateRawSync(Buffer.alloc(8 << 20)));
assert.throws(() => inflate(bomb, 1024), /larger than claimed/, 'inflate: output capped at the claimed size');
assert.throws(() => inflate(bomb, 0x7fffffff), /too large/, 'inflate: claim over the hard maximum');
const storedBlock = new Uint8Array(zlib.deflateRawSync(Buffer.from('stored bytes'), { level: 0 }));
const badLen = storedBlock.slice();
badLen[3] ^= 1;
assert.throws(() => inflate(badLen, 12), /bad stored length/, 'inflate: stored LEN/NLEN mismatch');
assert.throws(() => inflate(storedBlock.subarray(0, storedBlock.length - 4), 12), /truncated/, 'inflate: stored block cut short');

// --- A CBZ over Range requests ---
const pages = Array.from({ length: 6 }, (_, i) => ({ name: `Tome/${i + 1}.png`, data: comicPage(i + 1, [80, 120, 200], 60, 90), store: i % 2 === 0 }));
const book = zip([
  ...pages,
  { name: 'Tome/10.png', data: comicPage(10, [80, 120, 200], 120, 90) },
  { name: '__MACOSX/._1.png', data: Buffer.from('x') },
  { name: 'Tome/.hidden.png', data: Buffer.from('x') },
  { name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Manga>YesAndRightToLeft</Manga><Pages><Page Image="6" Type="Deleted"/><Page Image="2" DoublePage="True"/></Pages></ComicInfo>') },
]);
let ranges = 0;
const serve = (bytes, honourRange) => async (_url, init) => {
  const range = /bytes=(\d*)-(\d*)/.exec(init?.headers?.Range ?? '');
  if (!honourRange || !range) return new Response(bytes, { status: 200 });
  ranges++;
  const start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  return new Response(bytes.subarray(start, end + 1), { status: 206 });
};
const { ComicBook, natural, spreads, startPage } = await load('src/lib/comic.ts');
const api = { url: (p) => `http://192.0.2.1${p}`, authHeaders: () => ({}) };
const item = { Id: 'b1', Path: '/books/Tome.cbz', UserData: { PlaybackPositionTicks: 3 * 10_000 } };
for (const honourRange of [true, false]) {
  globalThis.fetch = serve(book, honourRange);
  const b = await ComicBook.open(api, item);
  // 7 images in natural order (1..6, 10), the deleted 7th (index 6, "10.png") gone, the hidden and fork files out.
  assert.deepEqual(
    b.pages.map((e) => e.name),
    ['Tome/1.png', 'Tome/2.png', 'Tome/3.png', 'Tome/4.png', 'Tome/5.png', 'Tome/6.png'],
    `zip (${honourRange ? 'range' : 'whole'}): page order`,
  );
  assert.equal(b.rtl, true, 'ComicInfo: manga order');
  assert.ok(b.doubles.has(2), 'ComicInfo: double page');
  // Every page comes back whole (stored and deflated alike), through the book's ZIP (object URLs are a browser
  // concern).
  for (let i = 0; i < b.pages.length; i++) assert.ok(Buffer.from(await b.zip.read(b.pages[i])).equals(pages[i].data), `zip: page ${i + 1} bytes`);
  assert.equal(startPage(item, b.pages.length), 3, 'resume page from ticks');
}
assert.ok(ranges >= 3, 'zip: read through Range requests');
// A server ignoring Range with a book over the in-memory limit: refused from its Content-Length, before the body.
{
  const { Zip, MAX_WHOLE } = await load('src/lib/zip.ts');
  let read = false;
  globalThis.fetch = async () => {
    const body = new ReadableStream({ pull: (c) => ((read = true), c.close()) }, { highWaterMark: 0 });
    return new Response(body, { status: 200, headers: { 'Content-Length': String(MAX_WHOLE + 1) } });
  };
  await assert.rejects(new Zip('http://192.0.2.1/b', {}).open(), /too-large/, 'zip: whole file over the limit refused');
  assert.equal(read, false, 'zip: refused before its body is read');
}

// --- Page order and spreads ---
assert.deepEqual(['10.jpg', '2.jpg', '01.jpg', 'b.jpg', 'A.jpg'].sort(natural), ['01.jpg', '2.jpg', '10.jpg', 'A.jpg', 'b.jpg'], 'natural order');
const portrait = { width: 2, height: 3 };
const wide = { width: 3, height: 2 };
assert.deepEqual(spreads([portrait, portrait, portrait, wide, portrait, portrait, portrait], 7, true), [[0], [1, 2], [3], [4, 5], [6]], 'spreads: cover, pairs, wide alone, last alone');
assert.deepEqual(spreads([], 3, false), [[0], [1], [2]], 'spreads: single pages');

// --- When the rows reload by themselves (Android HomeRefreshTest) ---
const { HomeRefresh, PERIOD_MS } = await load('src/lib/home-refresh.ts');
let clock = 0;
const r = new HomeRefresh(() => clock);
clock = 60_000;
r.onMessage('SessionsStart');
clock += 10_000;
assert.equal(r.due(), false, 'refresh: other messages do nothing');
r.onMessage('UserDataChanged');
clock += 1_000;
r.onMessage('LibraryChanged');
assert.equal(r.due(), false, 'refresh: 2 s debounce');
clock += 1_000;
assert.equal(r.due(), true, 'refresh: after the debounce');
assert.equal(r.due(), false, 'refresh: one reload per burst');
clock += 2_000;
r.onMessage('UserDataChanged');
clock += 10_000;
assert.equal(r.due(), false, 'refresh: at most every 30 s');
clock += 18_000;
assert.equal(r.due(), true, 'refresh: held, not lost');
clock += PERIOD_MS - 1;
assert.equal(r.due(), false, 'refresh: not before 5 min');
clock += 1;
assert.equal(r.due(), true, 'refresh: every 5 min');
clock += PERIOD_MS - 1;
r.done();
clock += 1;
assert.equal(r.due(), false, 'refresh: a return restarts the period');

// --- AniSkip: the shared fixtures' saved answers, as the player's segments (no network) ---
const aniskipFx = JSON.parse(fs.readFileSync(path.join(repo, 'tools', 'checks', 'fixtures', 'aniskip.json'), 'utf8'));
const { aniskipSegments, mergeAniskip } = await load('src/lib/aniskip.ts');
const anime = {
  item: async (id) => ({ Id: id, ProviderIds: id === 'season-1' ? { MyAnimeList: '5114' } : {} }),
};
const asked = [];
for (const [n, c] of aniskipFx.cases.filter((x) => x.response).entries()) {
  globalThis.fetch = async (url) => (asked.push(String(url)), new Response(JSON.stringify(c.response), { status: c.response.statusCode ?? 200 }));
  const ep = { Id: `ep-${n}`, Type: 'Episode', SeasonId: 'season-1', SeriesId: 'series-1', IndexNumber: n + 1, ParentIndexNumber: 1, RunTimeTicks: 1440 * 10_000_000 };
  const s = await aniskipSegments(anime, ep);
  if (!c.expect) assert.equal(s, null, `aniskip: ${c.name}`);
  else {
    const intro = s.ranges.find((r) => r.kind === 'Intro');
    assert.deepEqual([intro?.startMs, intro?.endMs, s.credits], [c.expect.introStartMs, c.expect.introEndMs, c.expect.creditsStartMs], `aniskip: ${c.name}`);
    const recap = s.ranges.find((r) => r.kind === 'Recap');
    assert.deepEqual(recap ? [recap.startMs, recap.endMs] : null, c.expect.recap, `aniskip: ${c.name} recap`);
  }
}
assert.ok(asked.every((u) => u.startsWith('https://api.aniskip.com/v2/skip-times/5114/')), 'aniskip: the season MAL id and episode');
const merged = mergeAniskip({ ranges: [{ kind: 'Recap', startMs: 1, endMs: 2 }] }, { credits: 9, ranges: [{ kind: 'Intro', startMs: 3, endMs: 4 }, { kind: 'Recap', startMs: 5, endMs: 6 }] });
assert.deepEqual(merged, { credits: 9, ranges: [{ kind: 'Recap', startMs: 1, endMs: 2 }, { kind: 'Intro', startMs: 3, endMs: 4 }] }, 'aniskip: the server recap wins');

// --- MD5 (Last.fm's api_sig on a TV) against node:crypto ---
const { md5 } = await load('src/platform/node-crypto.ts');
const crypto = await import('node:crypto');
for (const s of ['', 'a', 'abc', 'message digest', 'é😀 Wicaby', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000)])
  assert.equal(md5(s), crypto.createHash('md5').update(s, 'utf8').digest('hex'), `md5 of ${s.length} chars`);

// --- Scrobbling: a listen sent, a failed one queued then sent with the next (no network: fetch answers) ---
// The module's $state is Svelte's; outside the compiler it is the plain value.
globalThis.$state = Object.assign((v) => v, { snapshot: (v) => structuredClone(v) });
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const sc = await load('src/lib/scrobble.svelte.ts');
const sent = [];
let lbDown = false;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith('/1/validate-token')) return new Response(JSON.stringify({ valid: true, user_name: 'nora' }), { status: 200 });
  if (u.endsWith('/1/submit-listens')) {
    if (lbDown) return new Response('', { status: 503 });
    sent.push(JSON.parse(init.body));
    return new Response('{"status":"ok"}', { status: 200 });
  }
  return new Response('{}', { status: 404 });
};
assert.equal(await sc.connectListenBrainz('abcdefgh-1234'), true, 'scrobble: ListenBrainz connects');
assert.equal(sc.scrobble.lbUser, 'nora', 'scrobble: the user name');
const song = (n) => ({ Id: `t${n}`, Type: 'Audio', Name: `Fil ${n}`, Artists: ['Nora Vale'], Album: 'Lignes claires', RunTimeTicks: 200 * 10_000_000 });
sc.scrobbleListened(song(1), 1_700_000_000, 10_000);
lbDown = true;
sc.scrobbleListened(song(2), 1_700_000_200, 150_000);
await new Promise((r) => setTimeout(r, 50));
assert.equal(sent.length, 0, 'scrobble: under half a track is no listen');
assert.equal(sc.scrobble.queued, 1, 'scrobble: a listen the service refused waits');
lbDown = false;
sc.scrobbleListened(song(3), 1_700_000_400, 120_000);
await new Promise((r) => setTimeout(r, 50));
assert.deepEqual(sent.map((b) => b.payload[0].track_metadata.track_name), ['Fil 3', 'Fil 2'], 'scrobble: the next listen, then the waiting one');
assert.equal(sc.scrobble.queued, 0, 'scrobble: the queue is empty again');
await sc.disconnectListenBrainz();
assert.equal(sc.scrobble.lbUser, null, 'scrobble: disconnected');

// --- B09: the addresses raced, what is learned, the switch when the stored one does not answer ---
const ad = await load('src/lib/addresses.svelte.ts');
assert.deepEqual(ad.candidates('https://media.example.org', { local: 'http://192.168.1.10:8096', remote: 'https://alt.example.org/' }), ['https://media.example.org', 'https://alt.example.org'], 'addresses: no learned plain HTTP for an HTTPS server');
assert.deepEqual(ad.candidates('https://media.example.org', { local: 'http://192.168.1.10:8096', edited: true }), ['https://media.example.org', 'http://192.168.1.10:8096'], 'addresses: a typed one is used');
assert.deepEqual(ad.candidates('http://lan:8096/jf', { remote: 'https://h.example.org', local: 'http://10.0.0.2/jf' }), ['http://lan:8096/jf', 'http://10.0.0.2/jf'], 'addresses: the path must fit');
assert.deepEqual(ad.learned({}, { LocalAddress: 'http://192.168.1.10:8096', WanAddress: 'http://203.0.113.5:8096' }), { local: 'http://192.168.1.10:8096', remote: undefined }, 'addresses: no plain-HTTP remote on the internet');
assert.deepEqual(ad.learned({ local: 'x', edited: true }, { LocalAddress: 'http://192.168.1.10:8096' }), { local: 'x', edited: true }, 'addresses: typed ones are kept');
assert.deepEqual(['192.168.0.4', '10.1.2.3', '172.20.0.1', '172.32.0.1', 'nas.local', '8.8.8.8'].map(ad.isLanHost), [true, true, true, false, true, false], 'addresses: LAN hosts');
globalThis.fetch = async (url) => {
  if (String(url).startsWith('http://down.example')) throw new TypeError('Failed to fetch');
  return new Response(JSON.stringify({ Id: 'srv-1', LocalAddress: 'http://192.168.1.10:8096' }), { status: 200 });
};
assert.equal(ad.editAddresses('srv-1', 'http://down.example:8096', false, 'http://192.168.1.10:8096', ''), true, 'addresses: edited');
await new Promise((r) => setTimeout(r, 20));
assert.equal(ad.addressInUse('srv-1', 'http://down.example:8096'), 'http://192.168.1.10:8096', 'addresses: the one that answers is used');
assert.equal(ad.editAddresses('srv-1', 'http://down.example:8096', false, 'ftp://x', ''), false, 'addresses: not an http(s) URL');

// --- Profile PINs: the JavaScript PBKDF2-HMAC-SHA1 against Node's, the stored form, the waits ---
const pinMod = await load('src/lib/pin.ts');
for (const [pin, saltHex] of [['0000', '00'], ['1234', 'a1b2c3d4e5f60718293a4b5c6d7e8f90'], ['9876', 'ff'.repeat(16)]]) {
  const salt = Buffer.from(saltHex, 'hex');
  const want = crypto.pbkdf2Sync(pin, salt, 20_000, 32, 'sha1');
  assert.ok(Buffer.from(pinMod.pbkdf2Sha1(new TextEncoder().encode(pin), new Uint8Array(salt), 20_000, 32)).equals(want), `pin: PBKDF2 of ${pin}`);
}
const stored = await pinMod.hashPin('4321');
assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{64}$/, 'pin: salt:hash in hex');
assert.equal(await pinMod.pinMatches('4321', stored), true, 'pin: the right PIN');
assert.equal(await pinMod.pinMatches('4322', stored), false, 'pin: a wrong PIN');
assert.deepEqual([0, 4, 5, 6, 12, 20].map(pinMod.pinWaitMs), [0, 0, 30_000, 60_000, 3_600_000, 3_600_000], 'pin: five free tries, then 30 s doubling to 1 h');

// --- The bundle, when built ---
const assets = path.join(app, 'dist', 'assets');
if (fs.existsSync(assets)) {
  for (const f of fs.readdirSync(assets).filter((f) => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(assets, f), 'utf8');
    assert.doesNotThrow(() => parse(code, { ecmaVersion: 2016, sourceType: 'script' }), `${f} parses as ES2016 (Chromium 53)`);
  }
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('tv-web-check: ok');
