// Self-check for the desktop update notice (apps/desktop/src/shared/app-update.ts): version compare, the asset per
// kind of install, and the trust boundary on the GitHub "latest release" answer. Plus source guards for the wiring.
// Run: node tools/checks/app-update-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions, installKind, parseVersion, releaseUpdate, trimRelease } from '../../apps/desktop/src/shared/app-update.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// 1. Versions.
assert.ok(compareVersions('0.10.6', '0.10.5') > 0);
assert.ok(compareVersions('v0.10.0', '0.9.9') > 0, 'numeric, not string order');
assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
assert.equal(compareVersions('v0.10.5', '0.10.5'), 0);
assert.ok(compareVersions('0.10.4', '0.10.5') < 0);
for (const bad of ['0.10', '0.10.5-beta.1', 'v1.2.3.4', '', null, 'latest']) assert.equal(parseVersion(bad), null, String(bad));

// 2. Kind of install.
assert.equal(installKind('win32', {}), 'setup');
assert.equal(installKind('win32', { PORTABLE_EXECUTABLE_DIR: 'D:\\Apps' }), 'portable');
assert.equal(installKind('linux', { APPIMAGE: '/home/a/Wicaby.AppImage' }), 'appimage');
assert.equal(installKind('linux', {}), 'deb');

// 3. The release answer, with this repo's real asset names.
const dl = (tag, name) => `https://github.com/WicaebethTheo/wicaby/releases/download/${tag}/${name}`;
const release = (tag = 'v0.10.6', extra = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/WicaebethTheo/wicaby/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  assets: [
    'SHA256SUMS.txt', `Wicaby-${tag.slice(1)}-x64-setup.exe`, `Wicaby-${tag.slice(1)}-x64-portable.exe`,
    `Wicaby-${tag.slice(1)}-arm64.AppImage`, `Wicaby-${tag.slice(1)}-x86_64.AppImage`, `Wicaby-${tag.slice(1)}-amd64.deb`, `Wicaby-${tag.slice(1)}.tar.gz`,
    `Wicaby-TV-foss-${tag.slice(1)}-arm64.apk`,
  ].map((name) => ({ name, browser_download_url: dl(tag, name) })),
  ...extra,
});
const page = 'https://github.com/WicaebethTheo/wicaby/releases/tag/v0.10.6';
assert.deepEqual(releaseUpdate(release(), '0.10.5', 'setup'), { version: '0.10.6', notesUrl: page, downloadUrl: dl('v0.10.6', 'Wicaby-0.10.6-x64-setup.exe') });
assert.equal(releaseUpdate(release(), '0.10.5', 'portable').downloadUrl, dl('v0.10.6', 'Wicaby-0.10.6-x64-portable.exe'));
assert.equal(releaseUpdate(release(), '0.10.5', 'appimage').downloadUrl, dl('v0.10.6', 'Wicaby-0.10.6-x86_64.AppImage'), 'never the arm64 AppImage');
assert.equal(releaseUpdate(release(), '0.10.5', 'deb').downloadUrl, dl('v0.10.6', 'Wicaby-0.10.6-amd64.deb'));
// The trimmed cache copy gives the same answer.
assert.deepEqual(releaseUpdate(trimRelease(release()), '0.10.5', 'deb'), releaseUpdate(release(), '0.10.5', 'deb'));
// Not newer, draft, prerelease, bad tag, junk: nothing.
assert.equal(releaseUpdate(release(), '0.10.6', 'setup'), null);
assert.equal(releaseUpdate(release(), '0.11.0', 'setup'), null);
assert.equal(releaseUpdate(release('v0.10.6', { draft: true }), '0.10.5', 'setup'), null);
assert.equal(releaseUpdate(release('v0.10.6', { prerelease: true }), '0.10.5', 'setup'), null);
assert.equal(releaseUpdate(release('v0.11.0-beta.1'), '0.10.5', 'setup'), null);
for (const junk of [null, 'x', 42, [], {}]) assert.equal(releaseUpdate(junk, '0.10.5', 'setup'), null);

// 4. Trust boundary: only https://github.com/WicaebethTheo/wicaby/releases/download/<tag>/… is ever opened.
const hostile = (url) => release('v0.10.6', { assets: [{ name: 'Wicaby-0.10.6-x64-setup.exe', browser_download_url: url }] });
for (const url of [
  'https://evil.example/Wicaby-0.10.6-x64-setup.exe',
  'http://github.com/WicaebethTheo/wicaby/releases/download/v0.10.6/Wicaby-0.10.6-x64-setup.exe',
  'https://github.com/someone/wicaby/releases/download/v0.10.6/Wicaby-0.10.6-x64-setup.exe',
  'https://github.com/WicaebethTheo/wicaby/releases/download/v0.9.0/Wicaby-0.10.6-x64-setup.exe',
  'https://github.com/WicaebethTheo/wicaby/releases/download/v0.10.6/../../../../x.exe',
  'https://user:pass@github.com/WicaebethTheo/wicaby/releases/download/v0.10.6/Wicaby-0.10.6-x64-setup.exe',
  'https://github.com.evil.example/WicaebethTheo/wicaby/releases/download/v0.10.6/Wicaby-0.10.6-x64-setup.exe',
  'javascript:alert(1)',
  42,
]) assert.equal(releaseUpdate(hostile(url), '0.10.5', 'setup').downloadUrl, page, `refused: ${url}`);
// A strange html_url falls back to the page built from the tag.
assert.equal(releaseUpdate(release('v0.10.6', { html_url: 'https://evil.example/' }), '0.10.5', 'setup').notesUrl, page);
// No asset for this kind: the release page.
assert.equal(releaseUpdate(release('v0.10.6', { assets: [] }), '0.10.5', 'appimage').downloadUrl, page);

// 5. Wiring: off-thread start, ETag, timeout, dev-only version stub, default on, no renderer-supplied URL.
const svc = read('apps/desktop/src/main/features/app-updates.ts');
assert.match(svc, /FIRST_CHECK_MS = 30_000/);
assert.match(svc, /EVERY_MS = 24 \* 60 \* 60 \* 1000/);
assert.match(svc, /'If-None-Match'/);
assert.match(svc, /AbortSignal\.timeout\(/);
assert.match(svc, /'User-Agent'/);
assert.match(svc, /net\.isOnline\(\)/);
assert.match(svc, /shortcut: .*electron-updater/);
const main = read('apps/desktop/src/main/index.ts');
assert.match(main, /if \(app\.isPackaged\) \{[^}]*delete process\.env\.WICABY_FAKE_VERSION;/, 'WICABY_FAKE_VERSION is dropped in packaged builds');
assert.match(read('apps/desktop/src/main/core/settings.ts'), /updates: \{ autoCheck: true \}/);
assert.match(read('apps/desktop/src/main/ipc.ts'), /target === 'notes' \|\| target === 'download'/);

console.log('app-update-check: ok');
