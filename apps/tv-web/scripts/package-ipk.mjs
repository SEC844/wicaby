// Packages dist/ as an LG webOS app: release/tv-web/Wicaby-webOS-<version>.ipk at the repo root, for Developer Mode
// (ares-install) or the Homebrew Channel. The archive is what ares-package makes (an ar of debian-binary,
// control.tar.gz and data.tar.gz under usr/palm/applications/<id>), written with the web TV app's own tar and ar
// writers (apps/webtv/scripts/package.mjs), so no webOS SDK is needed. The licence texts ship inside, as on desktop.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ar, tar } from '../../webtv/scripts/package.mjs';

const app = path.resolve(import.meta.dirname, '..');
const root = path.resolve(app, '..', '..');
// The repository's version (the release tag), shared by every app.
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// Its own id: it installs beside the other web TV app (com.wika.wicaby) without replacing it.
const ID = 'com.wika.wicaby.tvweb';
const dist = path.join(app, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('dist/index.html missing: run npm run build first');

execFileSync(process.execPath, [path.join(root, 'tools/release/licenses.mjs'), path.join(dist, 'licenses')], { stdio: 'inherit' });

const files = [];
for (const f of fs.readdirSync(dist, { recursive: true }).sort()) {
  const abs = path.join(dist, f);
  if (fs.statSync(abs).isFile()) files.push({ rel: f.split(path.sep).join('/'), data: fs.readFileSync(abs) });
}

const appInfo = {
  id: ID,
  version,
  vendor: 'Wika',
  type: 'web',
  main: 'index.html',
  title: 'Wicaby',
  icon: 'icon.png',
  largeIcon: 'largeIcon.png',
  resolution: '1920x1080',
  // The Back key reaches the page as keyCode 461 (platform/keys.ts) instead of driving the history.
  disableBackHistoryAPI: true,
  uiRevision: 2,
};

const dir = `./usr/palm/applications/${ID}`;
const icons = path.join(root, 'apps', 'webtv', 'platform');
const data = [
  ...files.map((f) => ({ name: `${dir}/${f.rel}`, data: f.data })),
  { name: `${dir}/appinfo.json`, data: Buffer.from(JSON.stringify(appInfo, null, 2)) },
  { name: `${dir}/icon.png`, data: fs.readFileSync(path.join(icons, 'icon-80.png')) },
  { name: `${dir}/largeIcon.png`, data: fs.readFileSync(path.join(icons, 'icon-130.png')) },
  {
    name: `./usr/palm/packages/${ID}/packageinfo.json`,
    data: Buffer.from(JSON.stringify({ app: ID, id: ID, loc_name: 'Wicaby', package_format_version: 2, vendor: 'Wika', version }, null, 2)),
  },
];
const control = [
  `Package: ${ID}`,
  `Version: ${version}`,
  'Section: misc',
  'Priority: optional',
  'Architecture: all',
  `Installed-Size: ${Math.ceil(data.reduce((n, f) => n + f.data.length, 0) / 1024)}`,
  'Maintainer: Wika',
  'Description: Wicaby, an Emby and Jellyfin client',
  'webOS-Package-Format-Version: 2',
  'webOS-Packager-Version: x.y.x',
  '',
].join('\n');

const outDir = path.join(root, 'release', 'tv-web');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `Wicaby-webOS-${version}.ipk`);
fs.writeFileSync(
  out,
  ar([
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: zlib.gzipSync(tar([{ name: './control', data: Buffer.from(control) }])) },
    { name: 'data.tar.gz', data: zlib.gzipSync(tar(data)) },
  ]),
);
console.log(`${out} (${files.length} files, ${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
