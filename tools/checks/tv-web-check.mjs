// Self-check for the TV web app (apps/tv-web, docs/tv-web.md): its own DEFLATE decoder against zlib, the ZIP reader
// over Range requests on a real CBZ (stored and deflated pages, ComicInfo flags, deleted pages), the comic page order
// and spreads, when the home rows reload by themselves, and, when apps/tv-web/dist holds a build, that the bundle
// parses as ES2016 (the Chromium 53 floor: webOS 4 and Tizen 4, 2018 models). No network: the book is served from
// memory.
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
  await build({ entryPoints: [path.join(app, rel)], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
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
