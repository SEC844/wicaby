// File source store, vault and sessions (file-sources-spec FS-03), against the WebDAV mock on loopback:
// - test() answers ok / auth / digestOnly / certUntrusted for the mock's modes (and insecure without the http
//   acknowledgement); a pin only counts for a certificate test() showed;
// - add, restart, list: the source is back, its credentials are in the vault blob only (sources.json and every
//   log line hold no "demo"), and a fresh session reaches the mock with them;
// - local folders only from the picker; the settings export holds no password and no local source; an import
//   contacts nothing (pending, no pin and no http acknowledgement taken from the file) until Connect, and Connect
//   of an imported http address asks for the tick before any request;
// - a pinned source whose certificate changed: Save (empty user) re-tests with the stored credentials, shows
//   certChanged with both fingerprints, and trustCert then Save gets it back;
// - progress records named __proto__ / constructor never reach Object.prototype;
// - ConnectionManager: a file source is a signed-in session listed after the servers, never in onlineIds(), and
//   alone it makes the app signed in; remove() drops it with its vault entry and progress file.
// Usage: node tools/checks/files-store-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { buildFilesFixture } from '../mock-server/files-fixture.mjs';
import { startMockWebdav } from '../mock-server/mock-webdav.mjs';
import { bundleFiles, fakeHost, identity } from './files-bundle.mjs';

const F = await bundleFiles();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-files-store-'));
const tree = buildFilesFixture(path.join(tmp, 'tree'), { video: false }).dir;
let passed = 0;
const ok = (c, m) => (assert.ok(c, m), passed++);

// The main-process log goes to a file here; it and the console are grepped at the end.
const logDir = path.join(tmp, 'logs');
F.logger.init(logDir);
const logs = [];
for (const k of ['log', 'warn', 'error', 'info', 'debug']) console[k] = (...a) => logs.push(a.map(String).join(' '));
const report = (...a) => process.stdout.write(`${a.join(' ')}\n`);

const plain = await startMockWebdav({ root: tree, port: 0 });
const digest = await startMockWebdav({ root: tree, port: 0, env: { MOCK_DAV_DIGEST: '1' } });
const secure = await startMockWebdav({ root: tree, port: 0, env: { MOCK_DAV_TLS: '1' } });

const dataDir = path.join(tmp, 'files');
const vaultFile = path.join(tmp, 'vault.bin');
let vault = await F.CredentialVault.open(vaultFile);
let host = fakeHost();
let files = new F.FileSources(dataDir, vault, identity, host, 'win32');
files.start();

// ---- test() codes ----
const dav = (url, extra = {}) => ({ protocol: 'webdav', url, user: 'demo', pass: 'demo', ...extra });
ok((await files.test(dav(plain.base))).code === 'insecure', 'plain http needs the acknowledgement');
const good = await files.test(dav(plain.base, { insecure: true }));
ok(good.code === 'ok' && good.count >= 2, `ok with demo/demo (${good.count} entries)`);
ok((await files.test(dav(plain.base, { pass: 'wrong', insecure: true }))).code === 'auth', 'wrong password: auth');
ok((await files.test(dav(digest.base, { insecure: true }))).code === 'digestOnly', 'Digest-only server: digestOnly');
const untrusted = await files.test(dav(secure.base));
ok(untrusted.code === 'certUntrusted' && /^[0-9A-F:]{95}$/.test(untrusted.cert?.sha256 ?? ''), 'self-signed TLS: certUntrusted with the fingerprint');
ok((await files.test(dav(secure.base, { pin: 'AA:'.repeat(31) + 'AA' }))).code === 'invalid', 'a pin never shown is refused');
ok((await files.test(dav(secure.base, { pin: untrusted.cert.sha256 }))).code === 'ok', 'the shown pin passes');
ok((await files.test({ protocol: 'local', url: tree })).code === 'invalid', 'a typed local path is refused');
files.rememberPicked(tree);
ok((await files.test({ protocol: 'local', url: tree })).code === 'ok', 'a picked folder passes');
ok((await files.test({ protocol: 'smb', url: '\\\\STORAGE\\media', user: 'u', pass: 'p' })).code === 'unsupported', 'SMB with credentials: unsupported (no gateway yet)');
ok((await new F.FileSources(path.join(tmp, 'linux'), vault, identity, fakeHost(), 'linux').test({ protocol: 'smb', url: 'smb://STORAGE/media' })).code === 'unsupported', 'SMB on Linux: unsupported');

// ---- add, restart, list ----
const added = await files.add({ ...dav(plain.base, { insecure: true }), name: 'Example DAV' });
const pinned = await files.add({ ...dav(secure.base, { pin: untrusted.cert.sha256 }), name: 'Pinned DAV' });
const local = await files.add({ protocol: 'local', url: tree });
ok(added.hasCredentials && added.tls === 'insecure-http' && pinned.tls === 'pin' && local.protocol === 'local', 'three sources added');
ok(host.sessions.get(added.id)?.status === 'signed-in' && host.sessions.get(added.id).info.kind === 'files', 'a signed-in files session each');
ok(!JSON.stringify(added).includes('demo') && !JSON.stringify(host.sessions.get(added.id).info).includes('demo'), 'no credential in FileSourceInfo or ServerInfo');
await vault.flush();
files.shutdown();

vault = await F.CredentialVault.open(vaultFile);
host = fakeHost();
files = new F.FileSources(dataDir, vault, identity, host, 'win32');
files.start();
const listed = files.list();
ok(listed.length === 3 && listed.some((s) => s.id === added.id && s.name === 'Example DAV'), 'after a restart the sources are back');
const sourcesJson = fs.readFileSync(path.join(dataDir, 'sources.json'), 'utf8');
ok(!sourcesJson.includes('demo'), 'sources.json holds no credential (0 hits for "demo")');
ok(fs.readFileSync(vaultFile).toString('latin1').indexOf('demo') < 0, 'the vault blob is not plain text');
ok(vault.get(`files:${added.id}`)?.token === 'demo', 'the password is in the vault under files:<id>');
await new Promise((r) => setTimeout(r, 300));
plain.state.calls.length = 0;
const c = files.client(added.id);
const views = await c.request('GET', '/Users/local/Views');
ok(views.Items[0].Id === 'p.' && (await c.request('GET', '/Users/local/Items', { ParentId: 'p.' })).TotalRecordCount >= 2, 'the restored session lists the root');
ok(plain.state.calls.every((x) => x.auth), 'with the stored credentials');

// ---- export ----
const exported = files.exportable();
ok(exported.length === 2 && exported.every((e) => e.protocol === 'webdav'), 'export: the WebDAV sources, no local folder');
ok(!JSON.stringify(exported).includes('demo') && !JSON.stringify(exported).includes(tree.replace(/\\/g, '\\\\')), 'export: no password, no local path');
const otherHost = fakeHost();
const other = new F.FileSources(path.join(tmp, 'import'), vault, identity, otherHost, 'win32');
plain.state.calls.length = secure.state.calls.length = 0;
const hostile = [...exported, { name: 'Share', protocol: 'smb', url: 'smb://192.0.2.10/media' }].map((e) => (e.tls?.mode === 'pin' ? { ...e, tls: { ...e.tls, sha256: 'AB:'.repeat(31) + 'AB' } } : e));
ok(other.importSources(hostile) === 3 && other.list().every((s) => !s.hasCredentials && s.status === 'pending'), 'import: the remote sources come back without credentials, pending');
ok(other.importSources(exported) === 0, 'import: a known source is not duplicated');
other.start();
await new Promise((r) => setTimeout(r, 300));
ok(otherHost.sessions.size === 0 && plain.state.calls.length === 0 && secure.state.calls.length === 0, 'import and start: no session and no request until the user connects (no silent SMB logon)');
ok(other.list().every((s) => s.tls !== 'pin'), 'import: a pin from the file is not trusted (verify instead)');
const imported = other.list().find((s) => s.display.includes(String(plain.server.address().port)));
ok(imported.http === true && imported.tls === undefined, 'import: an http address is flagged and not acknowledged by the file');
ok((await other.setCredentials(imported.id, 'demo', 'demo')).code === 'insecure' && plain.state.calls.length === 0, 'Connect of an imported http address without the tick: insecure, no request (no cleartext password)');
ok((await other.setCredentials(imported.id, 'demo', 'demo', undefined, true)).code === 'ok' && other.list().find((s) => s.id === imported.id).tls === 'insecure-http' && other.list().find((s) => s.id === imported.id).status === 'signed-in' && otherHost.sessions.has(imported.id), 'Connect (setCredentials) tests, then starts the session');
const selfSigned = other.list().find((s) => s.tls === 'verify');
const seen = await other.setCredentials(selfSigned.id, 'demo', 'demo');
ok(seen.code === 'certUntrusted' && seen.cert?.sha256 === untrusted.cert.sha256, 'the imported self-signed source asks for the pin flow again');
assert.throws(() => other.trustCert(selfSigned.id, 'AB:'.repeat(31) + 'AB'), (e) => e.code === 'invalid', 'trustCert: a fingerprint never shown is refused');
ok(other.trustCert(selfSigned.id, seen.cert.sha256).tls === 'pin', 'trustCert pins the certificate the test showed');
ok((await other.setCredentials(selfSigned.id, 'demo', 'demo')).code === 'ok' && other.list().find((s) => s.id === selfSigned.id).status === 'signed-in', 'then Connect passes with the pin');
other.shutdown();

// ---- hostile progress keys: names that are Object.prototype members ----
const ps = new F.ProgressStore(path.join(tmp, 'progress-proto.json'));
for (const rel of ['__proto__', 'constructor', 'toString', 'Films/__proto__']) {
  ok(ps.get(rel) === undefined, `progress: no inherited record for ${rel}`);
  ps.patch(rel, (r) => ((r.hidden = true), (r.played = true)), { size: 1, mtimeMs: 1000 });
  ps.patch(rel, (r) => void (r.title = 'x'));
}
ok(({}).hidden === undefined && ({}).played === undefined && ({}).title === undefined, 'progress: Object.prototype untouched');
ps.flush();
const reread = new F.ProgressStore(path.join(tmp, 'progress-proto.json'));
ok(reread.get('__proto__')?.hidden === true && reread.get('constructor')?.title === 'x' && Object.keys(reread.doc.records).length === 4, 'progress: those names are ordinary records, kept across a restart');
reread.drop('__proto__');
ok(reread.get('__proto__') === undefined && Object.getPrototypeOf(reread.doc.records) === Object.prototype, 'progress: drop of __proto__ removes the record only');

// ---- ConnectionManager sessions ----
const cm = new F.ConnectionManager(path.join(tmp, 'servers.json'), vault, identity);
const sources2 = new F.FileSources(path.join(tmp, 'cm'), vault, identity, cm, 'win32');
sources2.rememberPicked(tree);
const lone = await sources2.add({ protocol: 'local', url: tree, name: 'Local' });
const st = cm.session;
ok(st.status === 'signed-in' && st.sessions.length === 1 && st.sessions[0].server.kind === 'files' && st.sessions[0].user.id === 'local', 'alone, a file source signs the app in');
ok(cm.onlineIds().length === 0 && cm.clientOf(lone.id) === sources2.client(lone.id), 'not in onlineIds(), but its client answers by id');
cm.disconnect();
ok(cm.session.sessions.length === 1, 'disconnect() of every server keeps the file sources');
await sources2.remove(lone.id);
ok(cm.session.status === 'no-server' && !fs.existsSync(path.join(tmp, 'cm', `progress-${lone.id}.json`)), 'remove() drops the session and its progress');

// ---- a pinned source whose certificate changed: no dead end ----
await new Promise((resolve, reject) => https.request(`${secure.origin}/Mock/RotateCert`, { method: 'POST', rejectUnauthorized: false }, (r) => (r.resume(), resolve())).on('error', reject).end());
const rotated = await files.setCredentials(pinned.id, '', '');
ok(rotated.code === 'certChanged' && rotated.cert?.pinned === untrusted.cert.sha256 && rotated.cert.sha256 !== untrusted.cert.sha256, 'Save of a pinned source after a rotation: certChanged with both fingerprints');
ok(files.trustCert(pinned.id, rotated.cert.sha256).tls === 'pin', 'Trust the new one pins the rotated certificate');
ok((await files.setCredentials(pinned.id, '', '')).code === 'ok' && files.list().find((s) => s.id === pinned.id).hasCredentials && vault.get(`files:${pinned.id}`)?.token === 'demo', 'then Save passes, the stored credentials kept');

// ---- remove ----
await files.remove(added.id);
await vault.flush();
ok(!vault.get(`files:${added.id}`) && files.list().length === 2 && !host.sessions.has(added.id), 'remove(): vault entry and session gone');

files.shutdown();
sources2.shutdown();
await Promise.all([plain.close(), digest.close(), secure.close()]);
await new Promise((r) => setTimeout(r, 200));
for (const f of fs.readdirSync(logDir)) logs.push(...fs.readFileSync(path.join(logDir, f), 'utf8').split('\n').filter(Boolean));
const leaked = logs.filter((l) => /demo/.test(l));
assert.equal(leaked.length, 0, `log lines naming the credentials:\n${leaked.join('\n')}`);
passed++;
if (process.env.SHOW_LOGS) report(logs.join('\n'));
report(`files-store-check: ok (${passed} checks, ${logs.length} log lines, none with a credential)`);
