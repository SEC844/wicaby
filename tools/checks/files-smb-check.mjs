// SMB file sources on the desktop (file-sources-spec FS-12, UNC part), protocol layer only: no share is ever
// contacted. Windows plays an SMB source by its UNC path with the session's own credentials; stored SMB
// credentials and smb:// on Linux need the go-smb2 gateway (FS-11/FS-12), not built yet, so both are refused as
// 'unsupported'. Checked: the accepted address forms, UNC building from \\STORAGE\media plus a relative path,
// the path guard in front of it (no hostile path gets an id, so none is ever joined to a share), device-path
// roots refused, and credentials kept out of the stored URL.
// Usage: node tools/checks/files-smb-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleFiles, fakeHost, identity } from './files-bundle.mjs';

const F = await bundleFiles();
const paths = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'files', 'paths.json'), 'utf8'));
let passed = 0;
const ok = (c, m) => (assert.ok(c, m), passed++);

// ---- address forms ----
for (const input of ['\\\\STORAGE\\media', 'smb://STORAGE/media', 'STORAGE/media', 'smb://STORAGE/media/']) {
  ok(F.parseSourceUrl(input)?.url === 'smb://STORAGE/media', `${input} → smb://STORAGE/media`);
}
const withCreds = F.parseSourceUrl('smb://user:secret@STORAGE/media/sub');
ok(withCreds.url === 'smb://STORAGE/media/sub' && withCreds.user === 'user' && withCreds.pass === 'secret', 'user:pass@ leaves the URL for the credential fields');
for (const bad of ['\\\\STORAGE', 'smb://STORAGE', 'smb://STORAGE:445/media', 'smb://STORAGE/media/../other', 'smb://bad host/media', '\\\\STORAGE\\me|dia']) ok(F.parseSourceUrl(bad) === null, `refused: ${bad}`);

// ---- UNC paths ----
ok(F.uncPath('smb://STORAGE/media') === '\\\\STORAGE\\media', 'root: \\\\STORAGE\\media');
ok(F.uncPath('smb://STORAGE/media', 'Films/Example Movie (2019)/Example.mkv') === '\\\\STORAGE\\media\\Films\\Example Movie (2019)\\Example.mkv', 'rel joined with backslashes');
ok(F.uncPath('smb://192.0.2.10/me%20dia', 'Été/a b.mkv') === '\\\\192.0.2.10\\me dia\\Été\\a b.mkv', 'escapes decoded, non-ASCII kept');
for (const v of paths.valid.filter((x) => x.rel)) {
  const id = v.id;
  const rel = F.decodeId(id);
  const unc = rel === null ? null : F.uncPath('smb://STORAGE/media', rel);
  ok(unc && unc.startsWith('\\\\STORAGE\\media\\') && !unc.slice(2).includes('\\\\') && !/(^|\\)\.\.(\\|$)/.test(unc), `guarded ${JSON.stringify(rel).slice(0, 40)} stays under the share`);
}
for (const h of paths.hostile) ok(F.encodeId(h) === null, `hostile ${JSON.stringify(h).slice(0, 40)} gets no id`);
for (const h of paths.hostileIds) ok(F.decodeId(h) === null, `hostile id ${h.slice(0, 30)} decodes to nothing`);

// ---- what the store accepts (nothing is contacted: every case is refused before any I/O) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-files-smb-'));
const vault = await F.CredentialVault.open(path.join(tmp, 'vault.bin'));
const win = new F.FileSources(path.join(tmp, 'win'), vault, identity, fakeHost(), 'win32');
const lin = new F.FileSources(path.join(tmp, 'lin'), vault, identity, fakeHost(), 'linux');
ok((await win.test({ protocol: 'smb', url: '\\\\STORAGE\\media', user: 'user', pass: 'secret' })).code === 'unsupported', 'Windows, stored credentials: unsupported until the gateway');
ok((await win.test({ protocol: 'smb', url: 'smb://user:secret@STORAGE/media' })).code === 'unsupported', 'credentials in the URL count as stored credentials');
ok((await lin.test({ protocol: 'smb', url: 'smb://STORAGE/media' })).code === 'unsupported', 'Linux: unsupported until the gateway');
ok((await win.test({ protocol: 'smb', url: 'https://dav.example/media' })).code === 'invalid', 'a WebDAV URL is not an SMB source');
ok((await win.test({ protocol: 'smb', url: '\\\\STORAGE' })).code === 'invalid', 'a host without a share is refused');

// ---- device paths are never a root ----
for (const root of ['\\\\?\\C:\\media', '\\\\.\\pipe\\x', 'relative\\media']) {
  await assert.rejects(() => new F.LocalBackend(root, 'win32').list(''), (e) => e.code === 'invalid', `root ${root} refused`);
  passed++;
}
win.shutdown();
lin.shutdown();
console.log(`files-smb-check: ok (${passed} checks; protocol layer only, no SMB server contacted)`);
