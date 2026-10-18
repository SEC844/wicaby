// Comic covers (desktop comic-service cover(), Android ComicCover): a CBZ the server has no Primary image
// for shows its first page. Checks the page choice (natural order, no __MACOSX or dotfiles, "cover"/"000"
// first), which books get one, and, against the Emby mock, that the cover is read with Range requests:
// the end of the archive and one entry, never the whole file.
// Usage: node tools/checks/comic-cover-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..', '..');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { coverEntry, httpSource, listEntries, listEntriesFrom, readEntry, readEntryFrom } = await imp('apps/desktop/src/main/comics/zip.ts');
const { comicCoverVersion } = await imp('apps/desktop/src/shared/comic-cover.ts');
const E = await imp('tools/mock-server/mock-emby.mjs');

// 1. Which entry is the cover.
const names = (list) => coverEntry(list.map((name) => ({ name, method: 0, compressedSize: 1, size: 1, headerOffset: 0 })))?.name;
assert.equal(names(['b/10.jpg', 'b/2.jpg', 'b/1.jpg']), 'b/1.jpg', 'natural order: 1 before 2 before 10');
assert.equal(names(['__MACOSX/._01.jpg', '.thumb.jpg', 'x/.DS_Store.png', 'p/02.jpg', 'p/03.jpg']), 'p/02.jpg', '__MACOSX and dotfiles are skipped');
assert.equal(names(['ComicInfo.xml', 'p/', 'p/notes.txt', 'p/01.webp']), 'p/01.webp', 'images only');
assert.equal(names(['p/01.jpg', 'p/02.jpg', 'p/Cover.JPG']), 'p/Cover.JPG', 'a page named cover wins');
assert.equal(names(['p/01.jpg', 'p/cover_front.png']), 'p/cover_front.png', 'cover_* counts as cover');
assert.equal(names(['p/001.jpg', 'p/000.jpg', 'p/002.jpg']), 'p/000.jpg', '000 is a cover');
assert.equal(names(['p/01.jpg', 'p/coverage.jpg']), 'p/01.jpg', 'a word that only starts with "cover" does not count');
assert.equal(names(['ComicInfo.xml']), undefined, 'no image, no cover');

// 2. Which books get a generated cover.
assert.equal(comicCoverVersion({ Id: 'a', Name: 'a', Type: 'Book', Container: 'cbz', DateCreated: 'd1' }), 'd1');
assert.equal(comicCoverVersion({ Id: 'a', Name: 'a', Type: 'Book', Path: '/b/x.CBZ', Etag: 'e1', DateCreated: 'd1' }), 'e1', 'Etag first');
assert.equal(comicCoverVersion({ Id: 'a', Name: 'a', Type: 'Book' }), '', 'format unknown: tried');
assert.equal(comicCoverVersion({ Id: 'a', Name: 'a', Type: 'Book', Container: 'cbz', ImageTags: { Primary: 't' } }), null, 'the server cover wins');
assert.equal(comicCoverVersion({ Id: 'a', Name: 'a', Type: 'Book', Path: '/b/x.mobi' }), null, 'a format the reader does not open');
for (const ext of ['cbr', 'cb7', 'cbt', 'pdf', 'epub']) assert.equal(comicCoverVersion({ Id: 'a', Name: 'a', Type: 'Book', Container: ext, DateCreated: 'd' }), 'd', `${ext} gets a cover`);
assert.equal(comicCoverVersion({ Id: 'a', Name: 'a', Type: 'Movie' }), null);

// 3. A server that ignores Range (200, whole file) is refused, not read.
await assert.rejects(httpSource(async () => new Response(Buffer.alloc(1 << 20), { status: 200 })), /Range/, 'a 200 answer is refused');

// 3b. A server that ignores the end of "bytes=a-b" (Emby streams to the end of the file): keep what was asked.
{
  const file = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));
  const src = await httpSource(async (range) => {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = m[1] ? Number(m[1]) : file.length - Number(m[2]);
    return new Response(file.subarray(start), { status: 206, headers: { 'content-range': `bytes ${start}-${file.length - 1}/${file.length}` } });
  });
  const got = await src.read(1000, 50);
  assert.equal(got.length, 50, 'an open-ended 206 is cut to the asked length');
  assert.deepEqual([...got], [...file.subarray(1000, 1050)], 'and holds the asked bytes');
}

// 3c. Book downloads stop past the cache cap and when the server goes quiet, and leave no file behind.
{
  const { download } = await imp('apps/desktop/src/main/comics/download.ts');
  const MSG = { tooLarge: 'larger', stalled: 'stopped sending' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-dl-'));
  const part = path.join(tmp, 'b.cbz.part');
  const body = (chunks, hang = false) =>
    new ReadableStream({
      async pull(c) {
        if (chunks.length) c.enqueue(chunks.shift());
        else if (!hang) c.close();
        else await new Promise(() => {});
      },
    });
  await download(async () => body([new Uint8Array(10), new Uint8Array(10)]), part, 20, 1000, MSG);
  assert.equal(fs.statSync(part).size, 20, 'a book at the cap is kept');
  await assert.rejects(download(async () => body([new Uint8Array(15), new Uint8Array(15)]), part, 20, 1000, MSG), /larger/, 'past the cap fails');
  assert.ok(!fs.existsSync(part), 'and removes the part file');
  await assert.rejects(download(async () => body([new Uint8Array(5)], true), part, 20, 50, MSG), /stopped sending/, 'a stalled body fails');
  await assert.rejects(download((signal) => new Promise((_, no) => signal.addEventListener('abort', () => no(new Error('aborted')))), part, 20, 50, MSG), /stopped sending/, 'a request with no answer fails');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 4. Against the mock: the comics without a server cover, read with Range requests.
E.hooks.log = () => {};
let served = 0;
const server = http.createServer((req, res) => {
  if (/\/Items\/[^/]+\/(File|Download)$/.test(req.url.split('?')[0])) {
    const end = res.end.bind(res);
    res.end = (chunk, ...rest) => {
      if (chunk && typeof chunk !== 'function') served += chunk.length;
      return end(chunk, ...rest);
    };
  }
  return E.handler(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/emby`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-cover-'));
try {
  const login = await fetch(`${base}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="checks", Device="c", DeviceId="cover-check", Version="1"' },
    body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }),
  }).then((r) => r.json());
  const H = { 'X-Emby-Token': login.AccessToken };
  const books = await fetch(`${base}/Users/${login.User.Id}/Items?ParentId=lib-books&Fields=DateCreated,Etag`, { headers: H }).then((r) => r.json());
  // The ZIP books here; comic-formats-check covers the others.
  const bare = books.Items.filter((b) => comicCoverVersion(b) !== null && b.Container === 'cbz');
  assert.ok(bare.length >= 1, 'the mock has a comic without a Primary image');
  assert.ok(books.Items.some((b) => b.ImageTags?.Primary), 'and comics with one');
  for (const book of bare) {
    const archive = E.cbz(book.Id);
    const file = path.join(dir, `${book.Id}.cbz`);
    fs.writeFileSync(file, archive);
    const want = await readEntry(file, coverEntry(await listEntries(file)));

    served = 0;
    let requests = 0;
    const src = await httpSource((range) => {
      requests++;
      return fetch(`${base}/Items/${book.Id}/File`, { headers: { ...H, Range: range } });
    });
    const entry = coverEntry(await listEntriesFrom(src));
    assert.match(entry.name, /\/01\.png$/, `${book.Id}: page 1 is the cover`);
    const got = await readEntryFrom(src, entry);
    assert.ok(got.equals(want), `${book.Id}: the cover is page 1's bytes`);
    assert.equal(got.subarray(1, 4).toString('latin1'), 'PNG');
    // Tail (≤ 64 KiB, holds the central directory) + local header + the page.
    const budget = 22 + 0xffff + 30 + entry.name.length + entry.compressedSize;
    assert.ok(served <= budget, `${book.Id}: ${served} bytes served, budget ${budget}`);
    assert.ok(served < archive.length, `${book.Id}: ${served} of ${archive.length} bytes, not the whole archive`);
    assert.ok(requests <= 3, `${book.Id}: ${requests} range requests`);
    console.log(`comic-cover-check: ${book.Id} cover from ${served} of ${archive.length} bytes in ${requests} requests`);
  }
  console.log('comic-cover-check: page choice, eligible books, Range reads and download limits OK');
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
