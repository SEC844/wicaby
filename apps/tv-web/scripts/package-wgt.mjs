// Packages dist/ as a Tizen web app: release/tv-web/Wicaby-Tizen-<version>.wgt at the repo root.
// The package is unsigned; the installer (Tizen Studio, or Apps2Samsung with a Samsung certificate) signs it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { zip } from './archive.mjs';

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
  ['icon.png', fs.readFileSync(path.join(app, 'platform', 'icon-512.png'))],
];
for (const f of fs.readdirSync(dist, { recursive: true })) {
  const abs = path.join(dist, f);
  if (fs.statSync(abs).isFile()) files.push([f.split(path.sep).join('/'), fs.readFileSync(abs)]);
}

const outDir = path.join(root, 'release', 'tv-web');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `Wicaby-Tizen-${version}.wgt`);
fs.writeFileSync(out, zip(files.map(([name, data]) => ({ name, data }))));
console.log(`${out} (${files.length} files, ${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
