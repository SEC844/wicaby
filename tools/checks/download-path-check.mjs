// Self-check for untrusted-input file handling:
//  - the downloads folder setting (src/main/core/settings.ts): a drive-absolute
//    Windows path with either separator, never relative or UNC;
//  - download target paths (src/main/downloads/download-path.ts): server fields
//    such as Container, Path, ProductionYear or IndexNumber must never take a
//    download outside the downloads folder, onto a Win32 device name, or onto
//    a file type Explorer acts on (.lnk, .url, .bat, desktop.ini...); records
//    from older builds get their folder back only when their path matches;
//  - comic ZIP archives (src/main/comics/zip.ts): inflating is capped by the
//    declared size, forged directory sizes and offsets never drive an
//    allocation past the file, and page heads stop early instead of failing.
// Run: node tools/checks/download-path-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { png, zip } from '../mock-server/cbz-fixture.mjs';
import { buildTargetPath, isInside, legacyRoot, pickExtension, safeExt, safeInt, safeName, unreserve } from '../../apps/desktop/src/main/downloads/download-path.ts';
import { imageSize } from '../../apps/desktop/src/main/comics/image-size.ts';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { listEntries, MAX_CD_SIZE, MAX_ENTRY_SIZE, readEntry, readHeads } from '../../apps/desktop/src/main/comics/zip.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-dlpath-'));
// settings.ts pulls Electron in through i18n: bundled with a stub.
const settingsOut = path.join(dir, 'settings.mjs');
await build({
  entryPoints: [path.join(import.meta.dirname, '../../apps/desktop/src/main/core/settings.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: settingsOut,
  logLevel: 'error',
  plugins: [{ name: 'electron-stub', setup: (b) => {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const app = {};' }));
  } }],
});
const { isLocalAbsoluteFolder } = await import(pathToFileURL(settingsOut).href);
const root = path.join(dir, 'Downloads');
const folder = (k, p) => (k === 'season' ? `Season ${p?.number}` : k);
const inside = (p) => isInside(root, p);
const rel = (p) => path.relative(root, p);

// Folder names exactly as the app has them, per language (main namespace).
const locales = path.join(import.meta.dirname, '../../apps/desktop/src/renderer/locales');
const langFolders = ['fr', 'en'].map((lang) => {
  const names = JSON.parse(fs.readFileSync(path.join(locales, lang, 'main.json'), 'utf8')).downloads.folders;
  return (k, p) => names[k].replace('{number}', p?.number ?? '');
});

try {
  // ---- downloads folder setting (Windows): drive-absolute with either separator; relative, drive-relative and UNC refused ----
  for (const ok of ['D:\\Media', 'D:/Media', 'd:\\', 'C:\\Users\\me\\Videos\\Wicaby']) assert.ok(isLocalAbsoluteFolder(ok, 'win32'), `${ok} accepted`);
  for (const bad of ['Media', '.\\Media', '..\\x', 'D:Media', '\\Media', '/Media', '\\\\server\\share', '//server/share', '\\\\?\\D:\\Media', '\\\\.\\D:\\', 'D:\\a|b', '', 42]) {
    assert.ok(!isLocalAbsoluteFolder(bad, 'win32'), `${JSON.stringify(bad)} refused`);
  }
  // ---- downloads folder setting (Linux): absolute POSIX paths only ----
  for (const ok of ['/home/me/Videos/Wicaby', '/', '/media/disk 2/Films']) assert.ok(isLocalAbsoluteFolder(ok, 'linux'), `${ok} accepted (linux)`);
  for (const bad of ['Media', './Media', '~/Videos', 'D:\\Media', 'D:/Media', '\\Media', '/a\nb', '/a|b', '', 42]) {
    assert.ok(!isLocalAbsoluteFolder(bad, 'linux'), `${JSON.stringify(bad)} refused (linux)`);
  }
  // Without a platform the running one applies.
  assert.equal(isLocalAbsoluteFolder('D:\\Media'), process.platform === 'win32');

  // ---- extensions ----
  assert.equal(pickExtension({ Path: 'D:\\Films\\a.MKV' }, {}), 'mkv', 'extension from the media path');
  assert.equal(pickExtension({ Container: 'mp4,m4v' }, {}), 'mp4', 'first container');
  assert.equal(pickExtension({ Container: 'x/../../../../Startup/run.bat' }, {}), 'mkv', 'container with separators');
  assert.equal(pickExtension({ Path: '/m/a.bat\\..\\..\\x' }, { Path: 'b.avi' }), 'mkv', 'path extension with separators');
  assert.equal(pickExtension({ Container: 'averyverylongext' }, {}), 'mkv', 'over-long extension');
  assert.equal(pickExtension({ Container: 42 }, {}), 'mkv', 'non-string container');
  assert.equal(pickExtension({ Path: 'video.mp4?token=x', Container: 'webm' }, {}), 'webm', 'URL query falls back to the container');
  // Shape-valid but dangerous types: Explorer resolves .lnk/.url icons when it shows
  // the folder (NTLM leak), and scripts run on a double-click.
  for (const bad of ['lnk', 'url', 'scf', 'bat', 'cmd', 'com', 'exe', 'ps1', 'hta', 'js', 'vbs', 'wsf', 'ini', 'iso', 'msi', 'reg', 'library', 'cpl', 'html', 'svg']) {
    assert.equal(safeExt(bad), undefined, `.${bad} refused`);
    assert.equal(pickExtension({ Container: bad }, { Type: 'Movie' }), 'mkv', `.${bad} container becomes .mkv`);
  }
  for (const ok of ['mkv', 'MP4', 'm4v', 'ts', 'flac', 'mp3', 'opus', 'cbz', 'zip', 'epub', 'pdf', 'srt', 'jxl', 'PEF', '3fr', 'x3f']) assert.equal(safeExt(ok), ok.toLowerCase(), `.${ok} kept`);
  assert.equal(pickExtension({ Container: 'lnk' }, { Type: 'Audio' }), 'mka', 'audio default');
  assert.equal(pickExtension({ Container: 'lnk' }, { Type: 'Book' }), 'bin', 'book default');
  assert.equal(rel(buildTargetPath(root, { Type: 'Book', Name: 'evil' }, { Container: 'lnk' }, folder)), path.join('books', 'evil.bin'));
  assert.equal(rel(buildTargetPath(root, { Type: 'Book', Name: 'Free movie' }, { Path: '/x/a.url' }, folder)), path.join('books', 'Free movie.bin'));
  assert.equal(rel(buildTargetPath(root, { Type: 'Book', Name: 'desktop' }, { Container: 'ini' }, folder)), path.join('books', 'desktop.bin'));
  assert.equal(rel(buildTargetPath(root, { Type: 'Book', Name: 'Tome 1' }, { Container: 'cbz' }, folder)), path.join('books', 'Tome 1.cbz'));
  // Photo originals keep their own file name and extension; anything else still falls back.
  assert.equal(rel(buildTargetPath(root, { Type: 'Photo', Name: 'Plage', Path: '/photos/2019/IMG_0001.HEIC' }, undefined, folder)), path.join('photos', 'IMG_0001.heic'));
  assert.equal(rel(buildTargetPath(root, { Type: 'Photo', Name: 'Plage', Path: String.raw`C:\Photos\..\x.lnk` }, undefined, folder)), path.join('photos', 'x.bin'));
  assert.equal(rel(buildTargetPath(root, { Type: 'Photo', Name: 'Plage' }, undefined, folder)), path.join('photos', 'Plage.bin'));

  // ---- numbers ----
  assert.equal(safeInt(2024), 2024);
  assert.equal(safeInt('2024'), undefined, 'string year dropped');
  assert.equal(safeInt('/../../x'), undefined);
  assert.equal(safeInt(1.5), undefined);
  assert.equal(safeInt(-1), undefined);
  assert.equal(safeInt(Number.NaN), undefined);

  // ---- segments and device names ----
  for (const bad of ['..', '.', ' .. ', '../..', '..\\..', 'a/../../b', 'C:\\Windows', '\u0000', '']) {
    const s = safeName(bad, 'fallback');
    assert.ok(!/[\\/:\u0000]/.test(s) && s !== '..' && s !== '.', `safeName(${JSON.stringify(bad)}) = ${JSON.stringify(s)}`);
  }
  for (const dev of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'nul.txt', 'COM1', 'COM0', 'LPT9', 'COM\u00b9', 'COM\u00b2', 'LPT\u00b3', 'CONIN$', 'conout$', 'CLOCK$', 'con .x', 'aux  .tar.gz', 'NUL ']) {
    const s = safeName(dev, 'x');
    assert.ok(s.startsWith('_'), `device name ${JSON.stringify(dev)} prefixed: ${JSON.stringify(s)}`);
  }
  for (const plain of ['CONSOLE', 'COM10', 'LPT', 'Aux Frontières', 'connect', 'nul-point', 'CON (2020)']) {
    assert.equal(safeName(plain, 'x'), plain, `${JSON.stringify(plain)} is not a device`);
  }
  assert.equal(unreserve('con .mkv'), '_con .mkv', 'whole file names are checked too');
  assert.equal(safeName(undefined, '..'), 'untitled', 'unsafe fallback');
  assert.equal(safeName({ toString: () => '../x' }, 'fb'), 'fb', 'non-string name');
  assert.equal(rel(buildTargetPath(root, { Type: 'Movie', Name: 'COM\u00b9' }, undefined, folder)), path.join('movies', '_COM\u00b9.mkv'));
  assert.equal(
    rel(buildTargetPath(root, { Type: 'Episode', Name: 'x', SeriesName: 'CONOUT$', ParentIndexNumber: 1, IndexNumber: 1 }, undefined, folder)),
    path.join('series', '_CONOUT$', 'Season 01', '_CONOUT$ S01E01 - x.mkv'),
  );
  for (const p of [
    buildTargetPath(root, { Type: 'Audio', Name: 'CLOCK$', AlbumArtist: 'LPT\u00b2', Album: 'con .x' }, { Container: 'flac' }, folder),
    buildTargetPath(root, { Type: 'Book', Name: 'nul' }, { Container: 'pdf' }, folder),
  ]) {
    for (const part of rel(p).split(path.sep)) assert.ok(!/^(con|prn|aux|nul|com.|lpt.|conin\$|conout\$|clock\$)\s*(\.|$)/i.test(part), `no device segment in ${p}`);
  }

  // ---- traversal ----
  const evil = '..\\..\\..\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Autorun\\run';
  const items = [
    { Type: 'Movie', Name: evil, ProductionYear: '/../../../../x' },
    { Type: 'Movie', Name: '..', ProductionYear: 2020 },
    { Type: 'Episode', Name: evil, SeriesName: '../../..', ParentIndexNumber: '../../..', IndexNumber: '..\\..' },
    { Type: 'Audio', Name: '../a', AlbumArtist: '..', Album: '../../..' },
    { Type: 'Book', Name: '/etc/passwd' },
    { Type: 'Video', Name: 'x', Path: 'C:\\a.mkv/../../../run.bat' },
  ];
  const sources = [undefined, { Container: 'x/../../../../../Startup/run.bat' }, { Path: '\\\\srv\\share\\..\\..\\a.bat' }, { Container: '../..' }, { Container: 'lnk' }];
  for (const item of items) {
    for (const source of sources) {
      const p = buildTargetPath(root, item, source, folder);
      assert.ok(inside(p), `inside root: ${p}`);
      assert.ok(!p.slice(root.length).split(/[\\/]/).some((s) => s === '..' || s === '.'), `no dot segments: ${p}`);
      assert.ok(!p.includes('Startup'), `container text never reaches the path: ${p}`);
      assert.ok(safeExt(path.extname(p).slice(1)) || /\.bin$/.test(p), `allowed extension: ${p}`);
    }
  }
  assert.equal(rel(buildTargetPath(root, { Type: 'Movie', Name: 'Dune', ProductionYear: 2021 }, { Container: 'mkv' }, folder)), path.join('movies', 'Dune (2021).mkv'), 'regular movie');
  assert.equal(
    rel(buildTargetPath(root, { Type: 'Episode', Name: 'Pilot', SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 2 }, { Path: '/tv/p.mp4' }, folder)),
    path.join('series', 'Show', 'Season 01', 'Show S01E02 - Pilot.mp4'),
    'regular episode',
  );
  assert.equal(rel(buildTargetPath(root, { Type: 'Movie', Name: 'Old', ProductionYear: '1999' }, undefined, folder)), path.join('movies', 'Old.mkv'), 'string year dropped from the name');

  // The guard used before every write, rename and remove.
  assert.ok(!isInside(root, root), 'root itself is not inside');
  assert.ok(!isInside(root, path.join(root, '..', 'x')));
  assert.ok(!isInside(root, `${root}-evil${path.sep}x`), 'sibling folder with the same prefix');
  assert.ok(!isInside('', path.join(root, 'x')), 'empty root');
  assert.ok(isInside(root + path.sep, path.join(root, 'a', 'b')), 'root with a trailing separator');

  // ---- records from builds that did not store their folder ----
  // The previous build's layout, verbatim (safeName, pad, extension rule).
  const oldSafe = (n, f) => n.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120) || f('untitled');
  const oldPad = (n) => String(n ?? 0).padStart(2, '0');
  const oldTarget = (r, it, src, f) => {
    const srcPath = src?.Path ?? it.Path;
    const fromPath = srcPath ? path.win32.extname(srcPath).slice(1) : '';
    const ext = (fromPath || src?.Container?.split(',')[0] || 'mkv').toLowerCase();
    if (it.Type === 'Episode') {
      const series = oldSafe(it.SeriesName ?? f('show'), f);
      return path.join(r, f('series'), series, f('season', { number: oldPad(it.ParentIndexNumber) }), `${series} S${oldPad(it.ParentIndexNumber)}E${oldPad(it.IndexNumber)} - ${oldSafe(it.Name, f)}.${ext}`);
    }
    if (it.Type === 'Audio') return path.join(r, f('music'), oldSafe(it.AlbumArtist ?? f('artist'), f), oldSafe(it.Album ?? f('album'), f), `${oldSafe(it.Name, f)}.${ext}`);
    if (it.Type === 'Book') return path.join(r, f('books'), `${oldSafe(it.Name, f)}.${ext}`);
    return path.join(r, f('movies'), `${oldSafe(it.Name, f)}${it.ProductionYear ? ` (${it.ProductionYear})` : ''}.${ext}`);
  };
  const oldRoot = path.join(dir, 'Old Downloads');
  const honest = [
    [{ Type: 'Movie', Name: 'Dune: Part Two', ProductionYear: 2024 }, { Container: 'mkv' }],
    [{ Type: 'Episode', Name: 'Pilot', SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 2 }, { Path: '/tv/p.mp4' }],
    [{ Type: 'Episode', Name: 'Pilot', ParentIndexNumber: 1, IndexNumber: 2 }, undefined],
    [{ Type: 'Audio', Name: 'Song', AlbumArtist: 'Band', Album: 'LP' }, { Container: 'flac' }],
    [{ Type: 'Audio', Name: 'Song' }, { Container: 'mp3' }],
    [{ Type: 'Book', Name: 'Tome 1' }, { Container: 'cbz' }],
    [{ Type: 'Video', Name: 'Clip' }, { Path: '/v/clip.strm' }], // extension a current build refuses
  ];
  for (const lf of langFolders) {
    for (const [it, src] of honest) {
      const old = oldTarget(oldRoot, it, src, lf);
      assert.equal(legacyRoot(old, it, src, langFolders), oldRoot, `legacy folder recovered for ${old}`);
    }
  }
  // Paths the previous build let a hostile server choose are not trusted.
  const hostile = [
    [{ Type: 'Movie', Name: 'x' }, { Container: 'x/../../../../Startup/run.bat' }],
    [{ Type: 'Movie', Name: 'x', ProductionYear: '../../../y' }, { Container: 'mkv' }],
    [{ Type: 'Book', Name: 'evil' }, { Container: 'x\\..\\..\\..\\a.lnk' }],
  ];
  for (const [it, src] of hostile) {
    const old = oldTarget(oldRoot, it, src, langFolders[1]);
    assert.equal(legacyRoot(old, it, src, langFolders), undefined, `hostile legacy path refused: ${old}`);
  }
  const dune = honest[0];
  assert.equal(legacyRoot(oldTarget(oldRoot, { ...dune[0], Name: 'Other' }, dune[1], langFolders[0]), dune[0], dune[1], langFolders), undefined, 'path of another item');
  assert.equal(legacyRoot(path.join('movies', 'Dune Part Two (2024).mkv'), dune[0], dune[1], langFolders), undefined, 'relative path');
  assert.equal(legacyRoot([oldRoot, 'x', '..', 'Films', 'Dune Part Two (2024).mkv'].join(path.sep), dune[0], dune[1], langFolders), undefined, 'dot segments');
  assert.equal(legacyRoot(path.join(oldRoot, 'Elsewhere', 'Dune Part Two (2024).mkv'), dune[0], dune[1], langFolders), undefined, 'unknown type folder');
  assert.equal(legacyRoot(undefined, dune[0], dune[1], langFolders), undefined, 'no path');

  // ---- zip: inflate caps ----
  const big = Buffer.alloc(2 * 1024 * 1024); // zeros: ~2 KiB deflated
  const file = path.join(dir, 'bomb.cbz');
  fs.writeFileSync(file, zip([{ name: 'p.png', data: big }]));
  const [entry] = await listEntries(file);
  assert.ok((await readEntry(file, entry)).equals(big), 'honest entry inflates');
  await assert.rejects(readEntry(file, { ...entry, size: 1000 }), /plus grande/, 'inflating past the declared size fails');
  await assert.rejects(readEntry(file, { ...entry, size: MAX_ENTRY_SIZE + 1 }), /volumineuse/, 'declared size over the cap');
  await assert.rejects(readEntry(file, { ...entry, compressedSize: 2 ** 40 }), /volumineuse/, 'absurd compressed size');
  await assert.rejects(readEntry(file, { ...entry, headerOffset: 2 ** 40 }), /corrompue/, 'header offset past the end of the file');
  const short = await readEntry(file, { ...entry, method: 0, size: 60 * 1024 * 1024, compressedSize: 60 * 1024 * 1024 });
  assert.ok(short.length < fs.statSync(file).size, 'stored read is clamped to the file');

  // ---- zip: forged directory sizes ----
  const small = zip([{ name: 'a.png', data: png(2, 2, () => [1, 2, 3]) }]);
  const forge = (name, edit) => {
    const b = Buffer.from(small);
    edit(b, b.length - 22);
    const f = path.join(dir, name);
    fs.writeFileSync(f, b);
    return f;
  };
  const before = process.memoryUsage().arrayBuffers;
  await assert.rejects(listEntries(forge('cd-size.cbz', (b, e) => b.writeUInt32LE(0xfffffffe, e + 12))), /corrompu/, 'directory larger than the file');
  await assert.rejects(listEntries(forge('cd-offset.cbz', (b, e) => b.writeUInt32LE(0xfffffff0, e + 16))), /corrompu/, 'directory past the end of the file');
  await assert.rejects(listEntries(forge('cd-end.cbz', (b, e) => b.writeUInt32LE(b.readUInt32LE(e + 16) + 30, e + 16))), /corrompu/, 'directory running past the end');
  assert.ok(process.memoryUsage().arrayBuffers - before < 64 * 1024 * 1024, 'no large allocation for a forged directory');
  // A huge archive: the forged directory fits in the file but passes the directory cap.
  const padded = Buffer.concat([Buffer.alloc(MAX_CD_SIZE + 1024), small]);
  // A real directory entry at offset 0, so only the cap (not a bad signature) can reject it.
  const smallCd = small.readUInt32LE(small.length - 22 + 16);
  small.copy(padded, 0, smallCd, small.length - 22);
  padded.writeUInt32LE(MAX_CD_SIZE + 1, padded.length - 22 + 12);
  padded.writeUInt32LE(0, padded.length - 22 + 16);
  fs.writeFileSync(path.join(dir, 'cd-cap.cbz'), padded);
  await assert.rejects(listEntries(path.join(dir, 'cd-cap.cbz')), /corrompu/, 'directory over the size cap');

  // ZIP64: a forged directory size, and an extra field shorter than the values it should hold.
  const z64 = zip([{ name: 'a.png', data: png(2, 2, () => [1, 2, 3]) }], { zip64: true });
  const z64End = z64.length - 22 - 20 - 56;
  const bigCd = Buffer.from(z64);
  bigCd.writeBigUInt64LE(2n ** 52n, z64End + 40);
  fs.writeFileSync(path.join(dir, 'z64-cd.cbz'), bigCd);
  await assert.rejects(listEntries(path.join(dir, 'z64-cd.cbz')), /corrompu/, 'ZIP64 directory size past the file');
  const shortExtra = Buffer.from(z64);
  const cdAt = shortExtra.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const fieldAt = shortExtra.indexOf(Buffer.from([0x01, 0x00, 0x18, 0x00]), cdAt);
  assert.ok(cdAt > 0 && fieldAt > cdAt, 'fixture has a ZIP64 extra field');
  shortExtra.writeUInt16LE(8, fieldAt + 2); // room for the size only
  fs.writeFileSync(path.join(dir, 'z64-extra.cbz'), shortExtra);
  const [clipped] = await listEntries(path.join(dir, 'z64-extra.cbz'));
  assert.equal(clipped.compressedSize, 0xffffffff, 'values beyond the field length are not read');
  await assert.rejects(readEntry(path.join(dir, 'z64-extra.cbz'), clipped), /volumineuse/, 'and the entry is refused');

  // ---- zip: heads of very compressible pages ----
  // A 2x2 PNG followed by 8 MiB of zeros: a few KiB deflated, far more inflated.
  const flat = Buffer.concat([png(2, 2, () => [0, 0, 0]), Buffer.alloc(8 * 1024 * 1024)]);
  const flatFile = path.join(dir, 'flat.cbz');
  fs.writeFileSync(flatFile, zip([{ name: '1.png', data: flat }, { name: '2.png', data: png(3, 5, () => [9, 9, 9]) }]));
  const flatEntries = await listEntries(flatFile);
  const heads = await readHeads(flatFile, flatEntries);
  assert.deepEqual(imageSize(heads[0]), [2, 2], 'dimensions of a page that inflates past the head cap');
  assert.ok(heads[0].length <= 256 * 1024, `head stays small (${heads[0].length})`);
  assert.deepEqual(imageSize(heads[1]), [3, 5], 'next page still read');

  // ---- zip: many pages at once ----
  // Six ~60 MiB pages read together: the in-flight budget queues them, and all complete.
  const page = Buffer.alloc(60 * 1024 * 1024, 7);
  const manyFile = path.join(dir, 'many.cbz');
  fs.writeFileSync(manyFile, zip(Array.from({ length: 6 }, (_, i) => ({ name: `${i}.png`, data: page }))));
  const many = await listEntries(manyFile);
  const lengths = await Promise.all(many.map((e) => readEntry(manyFile, e).then((b) => b.length)));
  assert.deepEqual(lengths, many.map(() => page.length), 'concurrent reads all complete');

  console.log('download-path-check: all assertions passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
