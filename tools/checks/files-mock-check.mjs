// The WebDAV mock and the file tree fixture (file-sources-spec FS-02), mock only: Basic auth demo/demo (a bad
// password is a 401), PROPFIND Depth 0/1 (infinity refused and tagged), GET with Range (206, the right bytes),
// OPTIONS, the EVIL hrefs (tagged HREF-ESCAPE), Digest-only, MOCK_DAV_ENTRIES, TLS with /Mock/RotateCert, and a
// loopback-only listener. Usage: node tools/checks/files-mock-check.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { buildFilesFixture } from '../mock-server/files-fixture.mjs';
import { startMockWebdav } from '../mock-server/mock-webdav.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-files-mock-'));
const fx = buildFilesFixture(root);
const AUTH = `Basic ${Buffer.from('demo:demo').toString('base64')}`;
let passed = 0;
const ok = (c, m) => (assert.ok(c, m), passed++);

function req(base, method, p, headers = {}, body) {
  const u = new URL(p, base);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const r = lib.request(u, { method, headers, rejectUnauthorized: false, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), socket: r.socket }));
    });
    r.on('error', reject);
    r.end(body);
  });
}
const enc = (rel) => `/media/${rel.split('/').map(encodeURIComponent).join('/')}`;

// ---- plain http ----
let m = await startMockWebdav({ root, port: 0, env: { MOCK_DAV_EVIL: '1', MOCK_DAV_ENTRIES: '25' } });
ok(m.server.address().address === '127.0.0.1', 'listens on 127.0.0.1 only');
ok((await req(m.base, 'PROPFIND', '/media/', { Depth: '1' })).status === 401, 'no auth: 401');
ok(m.state.tags.includes('NO-AUTH'), 'NO-AUTH tagged');
ok((await req(m.base, 'PROPFIND', '/media/', { Depth: '1', Authorization: `Basic ${Buffer.from('demo:wrong').toString('base64')}` })).status === 401, 'bad password: 401');
const opt = await req(m.base, 'OPTIONS', '/media/', { Authorization: AUTH });
ok(opt.status === 200 && opt.headers.dav === '1', 'OPTIONS: DAV 1');
const list = await req(m.base, 'PROPFIND', '/media/', { Depth: '1', Authorization: AUTH });
const xml = list.body.toString();
ok(list.status === 207 && xml.includes('<D:href>/media/Films/</D:href>') && xml.includes('/media/Shows/'), 'PROPFIND Depth 1 lists the root');
ok(xml.includes('http://evil.example/media/Other.mkv') && m.state.tags.includes('HREF-ESCAPE'), 'EVIL hrefs served and tagged');
ok((await req(m.base, 'PROPFIND', '/media/', { Depth: 'infinity', Authorization: AUTH })).status === 403 && m.state.tags.includes('DEPTH-INFINITY'), 'Depth infinity refused');
const self = await req(m.base, 'PROPFIND', enc('Shows/Example Show'), { Depth: '0', Authorization: AUTH });
ok(self.status === 207 && (self.body.toString().match(/<D:response>/g) ?? []).length === 1, 'Depth 0: the folder only');
const many = await req(m.base, 'PROPFIND', '/media/Many/', { Depth: '1', Authorization: AUTH });
ok((many.body.toString().match(/<D:response>/g) ?? []).length === 26, 'MOCK_DAV_ENTRIES: 25 entries plus the folder');
const file = fs.readFileSync(path.join(root, ...fx.film.split('/')));
// 10-19 fits both the encoded clip and the 30-byte stub written when no mpv is around (CI, a clean clone).
const range = await req(m.base, 'GET', enc(fx.film), { Range: 'bytes=10-19', Authorization: AUTH });
ok(range.status === 206 && range.body.equals(file.subarray(10, 20)) && range.headers['content-range'] === `bytes 10-19/${file.length}`, 'Range: 206 with the right bytes');
ok(m.state.ranges.some((r) => r.status === 206 && r.start === 10), 'ranges[] records it');
const full = await req(m.base, 'GET', enc(fx.film), { Authorization: AUTH });
ok(full.status === 200 && full.body.equals(file), 'GET: the whole file');
ok((await req(m.base, 'HEAD', enc(fx.film), { Authorization: AUTH })).headers['content-length'] === String(file.length), 'HEAD: the size');
ok((await req(m.base, 'GET', '/media/..%2F..%2Fetc', { Authorization: AUTH })).status >= 400, 'a path out of the tree is refused');
const state = JSON.stringify(m.state);
ok(m.state.authSeen && !state.includes('demo:demo') && !state.includes(AUTH.slice(6)), '/Mock/State never holds the credentials');
ok(!m.state.tags.includes('AUTH-IN-URL'), 'no AUTH-IN-URL so far');
await req(m.base, 'GET', '/media/x?password=y', { Authorization: AUTH });
ok(m.state.tags.includes('AUTH-IN-URL'), 'credentials in a URL are tagged');
await m.close();

// ---- Digest only ----
m = await startMockWebdav({ root, port: 0, env: { MOCK_DAV_DIGEST: '1' } });
const dig = await req(m.base, 'PROPFIND', '/media/', { Depth: '1', Authorization: AUTH });
ok(dig.status === 401 && /^Digest/.test(dig.headers['www-authenticate']) && !/Basic/i.test(dig.headers['www-authenticate']), 'MOCK_DAV_DIGEST: Digest only');
await m.close();

// ---- TLS and rotation ----
m = await startMockWebdav({ root, port: 0, env: { MOCK_DAV_TLS: '1' } });
const fingerprint = () =>
  new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port: m.server.address().port, rejectUnauthorized: false }, () => {
      resolve(s.getPeerCertificate().fingerprint256);
      s.destroy();
    });
    s.on('error', reject);
  });
const before = await fingerprint();
const pem = (n) => new crypto.X509Certificate(fs.readFileSync(path.join(import.meta.dirname, '..', 'mock-server', 'fixtures', 'webdav-tls', `cert${n}.pem`))).fingerprint256;
ok(before === pem(1), 'TLS: the first TEST ONLY pair');
ok((await req(m.base, 'PROPFIND', '/media/', { Depth: '0', Authorization: AUTH })).status === 207, 'TLS: PROPFIND over https');
ok((await req(m.origin, 'POST', '/Mock/RotateCert')).status === 204, 'RotateCert');
ok((await fingerprint()) === pem(2), 'TLS: the second pair after rotation');
await m.close();

console.log(`files-mock-check: ok (${passed} checks, fixture ${fx.playable ? 'with a playable clip' : 'stubs only (no mpv)'})`);
