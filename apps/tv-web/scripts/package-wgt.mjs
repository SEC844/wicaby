// Packages dist/ as a Tizen web app: release/tv-web/Wicaby-Tizen-<version>.wgt at the repo root.
// The package is unsigned; the installer (Tizen Studio, or Apps2Samsung with a Samsung certificate) signs it.
// A plain ZIP writer (deflate, CRC from node:zlib) keeps the build free of archive dependencies.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const app = path.resolve(import.meta.dirname, '..');
const root = path.resolve(app, '..', '..');
// The repository's version (the release tag), shared by every app.
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(app, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('dist/index.html missing: run npm run build first');
// The licence texts ship inside the package, as on desktop.
execFileSync(process.execPath, [path.join(root, 'tools/release/licenses.mjs'), path.join(dist, 'licenses')], { stdio: 'inherit' });

const config = fs.readFileSync(path.join(app, 'tizen', 'config.xml'), 'utf8').replace('version="0.0.0"', `version="${version}"`);
const files = [
  ['config.xml', Buffer.from(config)],
  ['icon.png', fs.readFileSync(path.join(root, 'apps', 'desktop', 'resources', 'icon.png'))],
];
for (const f of fs.readdirSync(dist, { recursive: true })) {
  const abs = path.join(dist, f);
  if (fs.statSync(abs).isFile()) files.push([f.split(path.sep).join('/'), fs.readFileSync(abs)]);
}

const local = [];
const central = [];
let offset = 0;
for (const [name, data] of files) {
  const nameBuf = Buffer.from(name);
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const store = deflated.length >= data.length;
  const body = store ? data : deflated;
  const crc = zlib.crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(store ? 0 : 8, 8);
  head.writeUInt32LE(0x00210000, 10); // fixed DOS time (1980-01-01): reproducible archives
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(body.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(nameBuf.length, 26);
  local.push(head, nameBuf, body);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4);
  dir.writeUInt16LE(20, 6);
  dir.writeUInt16LE(0x0800, 8);
  dir.writeUInt16LE(store ? 0 : 8, 10);
  dir.writeUInt32LE(0x00210000, 12);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(body.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(nameBuf.length, 28);
  dir.writeUInt32LE(offset, 42);
  central.push(dir, nameBuf);
  offset += head.length + nameBuf.length + body.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

const outDir = path.join(root, 'release', 'tv-web');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `Wicaby-Tizen-${version}.wgt`);
fs.writeFileSync(out, Buffer.concat([...local, centralBuf, end]));
console.log(`${out} (${files.length} files, ${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
