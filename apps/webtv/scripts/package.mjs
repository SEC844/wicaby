// Packs the web TV build (apps/webtv/dist/tv, npm run build:webtv) for the TVs (docs/webtv.md), with Node alone:
//   - dist/packages/wicaby-webos-<version>.ipk: LG webOS (an ar archive like ares-package makes: debian-binary,
//     control.tar.gz, data.tar.gz under usr/palm/applications/<id>), for Developer Mode or the Homebrew Channel;
//   - dist/packages/wicaby-tizen-<version>.wgt: Samsung Tizen, UNSIGNED (a .wgt is signed with the certificate of the
//     TV it goes to: Tizen Studio or the CLI signs it, docs/webtv.md).
// Run: node apps/webtv/scripts/package.mjs (tools/checks/webtv-check.mjs reads back what it writes)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { zip } from '../../../tools/mock-server/cbz-fixture.mjs';

const here = import.meta.dirname;
const root = path.resolve(here, '..');
const repo = path.resolve(root, '../..');
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
export const WEBOS_ID = 'com.wika.wicaby';
// Tizen: a 10-character package id, the app id is <package>.<name>.
export const TIZEN_PACKAGE = 'WicabyWeb1';

// ---- archive writers (ustar and ar: a few dozen lines, no dependency) ----

function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

// files: [{ name, data: Buffer, mode? }]; directories are implied by the names (added before their files).
export function tar(files) {
  const blocks = [];
  const dirs = new Set();
  const mtime = Math.floor(Date.UTC(2026, 0, 1) / 1000); // fixed: the same build packs to the same bytes
  const header = (name, size, type, mode) => {
    const h = Buffer.alloc(512);
    const n = Buffer.from(name, 'utf8');
    // shortcut: no ustar prefix field; the app's paths stay well under 100 bytes. Add it if a longer one appears.
    if (n.length > 100) throw new Error(`tar: path too long: ${name}`);
    n.copy(h, 0);
    h.write(octal(mode, 8), 100, 'ascii');
    h.write(octal(0, 8), 108, 'ascii');
    h.write(octal(0, 8), 116, 'ascii');
    h.write(octal(size, 12), 124, 'ascii');
    h.write(octal(mtime, 12), 136, 'ascii');
    h.write('        ', 148, 'ascii');
    h.write(type, 156, 'ascii');
    h.write('ustar\0', 257, 'ascii');
    h.write('00', 263, 'ascii');
    h.write('root', 265, 'ascii');
    h.write('root', 297, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(octal(sum, 7) + ' ', 148, 'ascii');
    return h;
  };
  for (const f of files) {
    const parts = f.name.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const d = `${parts.slice(0, i).join('/')}/`;
      if (d === './' || dirs.has(d)) continue;
      dirs.add(d);
      blocks.push(header(d, 0, '5', 0o755));
    }
    blocks.push(header(f.name, f.data.length, '0', f.mode ?? 0o644), f.data, Buffer.alloc((512 - (f.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function ar(members) {
  const out = [Buffer.from('!<arch>\n', 'ascii')];
  for (const m of members) {
    const h = `${m.name.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(m.data.length).padEnd(10)}\`\n`;
    out.push(Buffer.from(h, 'ascii'), m.data);
    if (m.data.length % 2) out.push(Buffer.from('\n'));
  }
  return Buffer.concat(out);
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push({ rel: path.relative(base, p).split(path.sep).join('/'), data: fs.readFileSync(p) });
  }
  return out;
}

// ---- webOS ----

export function webosAppInfo() {
  return {
    id: WEBOS_ID,
    version,
    vendor: 'Wika',
    type: 'web',
    main: 'index.html',
    title: 'Wicaby',
    icon: 'icon.png',
    largeIcon: 'largeIcon.png',
    resolution: '1920x1080',
    // The Back key reaches the page as keyCode 461 (apps/webtv/src/tv.ts) instead of driving history.
    disableBackHistoryAPI: true,
    uiRevision: 2,
  };
}

export function webosIpk(files) {
  const app = `./usr/palm/applications/${WEBOS_ID}`;
  const data = [
    ...files.map((f) => ({ name: `${app}/${f.rel}`, data: f.data })),
    { name: `${app}/appinfo.json`, data: Buffer.from(JSON.stringify(webosAppInfo(), null, 2)) },
    { name: `${app}/icon.png`, data: fs.readFileSync(path.join(root, 'platform/icon-80.png')) },
    { name: `${app}/largeIcon.png`, data: fs.readFileSync(path.join(root, 'platform/icon-130.png')) },
    {
      name: `./usr/palm/packages/${WEBOS_ID}/packageinfo.json`,
      data: Buffer.from(JSON.stringify({ app: WEBOS_ID, id: WEBOS_ID, loc_name: 'Wicaby', package_format_version: 2, vendor: 'Wika', version }, null, 2)),
    },
  ];
  const size = Math.ceil(data.reduce((n, f) => n + f.data.length, 0) / 1024);
  const control = [
    `Package: ${WEBOS_ID}`,
    `Version: ${version}`,
    'Section: misc',
    'Priority: optional',
    'Architecture: all',
    `Installed-Size: ${size}`,
    'Maintainer: Wika',
    'Description: Wicaby, an Emby and Jellyfin client',
    'webOS-Package-Format-Version: 2',
    'webOS-Packager-Version: x.y.x',
    '',
  ].join('\n');
  return ar([
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: zlib.gzipSync(tar([{ name: './control', data: Buffer.from(control) }])) },
    { name: 'data.tar.gz', data: zlib.gzipSync(tar(data)) },
  ]);
}

// ---- Tizen ----

export function tizenConfig() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="urn:wicaby:webtv" version="${version}" viewmodes="maximized">
  <tizen:application id="${TIZEN_PACKAGE}.Wicaby" package="${TIZEN_PACKAGE}" required_version="6.5"/>
  <content src="index.html"/>
  <feature name="http://tizen.org/feature/screen.size.all"/>
  <icon src="icon.png"/>
  <name>Wicaby</name>
  <tizen:profile name="tv-samsung"/>
  <tizen:privilege name="http://tizen.org/privilege/internet"/>
  <tizen:privilege name="http://tizen.org/privilege/tv.inputdevice"/>
  <access origin="*" subdomains="true"/>
  <tizen:setting screen-orientation="landscape" context-menu="disable" background-support="disable" encryption="disable" install-location="auto" hwkey-event="enable"/>
</widget>
`;
}

export function tizenWgt(files) {
  return zip([
    { name: 'config.xml', data: Buffer.from(tizenConfig()) },
    { name: 'icon.png', data: fs.readFileSync(path.join(root, 'platform/icon-512.png')) },
    ...files.map((f) => ({ name: f.rel, data: f.data })),
  ]);
}

// ---- main ----

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const dist = path.join(root, 'dist', 'tv');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    console.error('package: apps/webtv/dist/tv is missing; run npm run build:webtv first');
    process.exit(1);
  }
  // The GPL text, the notices and the npm licence texts ship inside the packages, as on the desktop.
  execFileSync(process.execPath, [path.join(repo, 'tools/release/licenses.mjs'), path.join(dist, 'licenses')], { stdio: 'inherit' });
  const files = walk(dist);
  if (!files.some((f) => f.rel === 'licenses/LICENSE.txt')) throw new Error('package: licenses/LICENSE.txt missing');
  const out = path.join(root, 'dist', 'packages');
  fs.mkdirSync(out, { recursive: true });
  const ipk = path.join(out, `wicaby-webos-${version}.ipk`);
  const wgt = path.join(out, `wicaby-tizen-${version}.wgt`);
  fs.writeFileSync(ipk, webosIpk(files));
  fs.writeFileSync(wgt, tizenWgt(files));
  for (const f of [ipk, wgt]) console.log(`package: ${path.relative(repo, f)} (${Math.round(fs.statSync(f).size / 1024)} KB)`);
}
