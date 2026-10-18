// Writes the mock's comic books (mock-emby COMICS, every format) into a folder, plus the refusal cases, for the
// Android unit tests (core ComicFormatsTest), which read the very bytes the mocks serve.
// Usage: node tools/mock-server/write-comic-fixtures.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';
import { comicPage } from './cbz-fixture.mjs';
import { epub, rar5 } from './comic-formats-fixture.mjs';
import { COMICS, cbz } from './mock-emby.mjs';

const out = process.argv[2];
if (!out) throw new Error('usage: write-comic-fixtures.mjs <dir>');
fs.mkdirSync(out, { recursive: true });
for (const [id, c] of Object.entries(COMICS)) fs.writeFileSync(path.join(out, `${id}.${c.ext ?? 'cbz'}`), cbz(id));
const pages = [1, 2].map((n) => comicPage(n, [90, 90, 90]));
fs.writeFileSync(path.join(out, 'drm.epub'), epub(pages, { drm: true }));
fs.writeFileSync(path.join(out, 'encrypted.cbr'), rar5(pages.map((data, i) => ({ name: `${i + 1}.png`, data })), { encrypted: true }));
