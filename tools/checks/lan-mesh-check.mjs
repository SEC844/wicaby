// LAN services through the embedded mesh (src/main/connection/api-client.ts ensureRoute/routed): the mock
// qBittorrent and the mock WebDAV are reached directly when they answer, and through a fake mesh forwarder when
// they do not and their host is in a NetBird routed network. The forwarder behaves like packages/mesh's: one
// /<token> prefix per upstream, the request's Host set to the upstream (httputil SetURL), a same-origin Location
// rewritten onto itself, 502 "mesh: …" when the upstream is down. Loopback only: 127.0.0.0/8 stands in for the LAN.
// Usage: node tools/checks/lan-mesh-check.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startMockWebdav } from '../mock-server/mock-webdav.mjs';

const root = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-lan-mesh-'));
const out = path.join(tmp, 'lan.mjs');
await build({
  stdin: {
    contents: `export { EmbeddedMesh } from './src/main/vpn/embedded-mesh'; export { QbitClient } from './src/main/torrents/qbittorrent'; export { WebDavBackend } from './src/main/files/backend-webdav'; export { ensureRoute, routed } from './src/main/connection/api-client';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  plugins: [
    {
      name: 'no-electron',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export const net = {}, safeStorage = {}; export const app = { isReady: () => false, isPackaged: true, getLocale: () => 'en' };` }));
      },
    },
  ],
  logLevel: 'error',
});
const { EmbeddedMesh, QbitClient, WebDavBackend, ensureRoute, routed } = await import(pathToFileURL(out).href);

const freePort = async () => {
  const s = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
};

// ---- The fake mesh forwarder (what wicaby-mesh opens on 127.0.0.1) ----
const upstreams = new Map(); // token -> { logical origin, actual host:port }
const fwd = http.createServer((req, res) => {
  const [, tok, ...rest] = req.url.split('/');
  const up = upstreams.get(tok);
  if (!up) return res.writeHead(404).end();
  const [host, port] = up.actual.split(':');
  const headers = { ...req.headers, host: new URL(up.logical).host };
  const p = http.request({ host, port, method: req.method, path: `/${rest.join('/')}`, headers }, (r) => {
    const h = { ...r.headers };
    if (h.location?.startsWith(up.logical)) h.location = `http://127.0.0.1:${fwd.address().port}/${tok}${h.location.slice(up.logical.length)}`;
    else if (h.location?.startsWith('/')) h.location = `http://127.0.0.1:${fwd.address().port}/${tok}${h.location}`;
    res.writeHead(r.statusCode, h);
    r.pipe(res);
  });
  p.on('error', (e) => res.writeHead(502).end(`mesh: ${e.message}`));
  req.pipe(p);
});
await new Promise((r) => fwd.listen(0, '127.0.0.1', r));

// ---- The embedded node, its helper played by hand ----
const mesh = new EmbeddedMesh({ exe: null, dataDir: tmp, vault: { get: () => undefined, set() {}, delete() {} }, deviceName: 'pc' });
const forwards = [];
let behind = {}; // logical origin -> actual host:port the routing peer reaches
mesh.proc = {
  stdin: {
    write(line) {
      const m = JSON.parse(line);
      if (m.cmd !== 'forward') return;
      forwards.push(m.upstream);
      const actual = behind[m.upstream];
      const tok = String(forwards.length).padStart(32, '0');
      if (actual) upstreams.set(tok, { logical: m.upstream, actual });
      setTimeout(() => mesh.onLine(JSON.stringify({ type: 'forward', id: m.id, ...(actual ? { base: `http://127.0.0.1:${fwd.address().port}/${tok}` } : { error: 'destination is not a peer of this mesh' }) })), 5);
    },
  },
};
const status = (state, routes) => mesh.onLine(JSON.stringify({ type: 'status', state, ips: ['100.64.0.9'], peers: [{ name: 'home', ips: ['100.64.0.2'], online: true }], routes }));

// ---- Mock qBittorrent ----
const qbitPort = await freePort();
const qbit = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'mock-server', 'mock-qbittorrent.mjs'), String(qbitPort)], { stdio: ['ignore', 'pipe', 'inherit'] });
const qbitLog = [];
await new Promise((resolve, reject) => {
  qbit.once('exit', (c) => reject(new Error(`mock qBittorrent exited (${c})`)));
  qbit.stdout.on('data', (d) => {
    qbitLog.push(...String(d).split('\n').filter(Boolean));
    if (/mock qBittorrent/.test(String(d))) resolve();
  });
});

const fetcher = (url, init) => fetch(url, init);
const connect = async (base) => {
  const c = new QbitClient(base, 'admin', 'adminadmin', fetcher, 4000);
  try {
    await c.connect();
    return { ok: true, client: c };
  } catch (err) {
    return { ok: false, client: c, err };
  }
};

try {
  // No node connected: the direct path only.
  let r = await connect(`http://127.0.0.1:${qbitPort}`);
  assert.ok(r.ok, 'direct, no mesh');
  assert.equal(r.client.path, 'off');
  assert.equal(r.client.version, 'v5.0.4');

  // Connected, 127.0.0.0/8 routed by a peer. qBittorrent answers directly (at home): no forwarder.
  status('connected', ['127.0.0.0/8']);
  r = await connect(`http://127.0.0.1:${qbitPort}`);
  assert.ok(r.ok, 'direct inside a routed network');
  assert.equal(r.client.path, 'direct');
  assert.equal(forwards.length, 0, 'answering directly: no forwarder opened');

  // Away: the address does not answer directly; the routing peer reaches qBittorrent. Login (cookie), the CSRF
  // check (Origin/Referer against Host) and a POST all pass through the forwarder.
  const away = `http://127.0.0.1:${await freePort()}`;
  behind = { [away]: `127.0.0.1:${qbitPort}` };
  qbitLog.length = 0;
  r = await connect(away);
  assert.ok(r.ok, `through the mesh: ${r.err?.message}`);
  assert.equal(r.client.path, 'mesh');
  assert.deepEqual(forwards, [away]);
  assert.ok(routed(`${away}/api/v2/app/version`).startsWith(`http://127.0.0.1:${fwd.address().port}/`), 'the address is rewritten onto the forwarder');
  const md = await r.client.maindata(0);
  assert.equal(md.full_update, true, 'sync/maindata with the SID cookie through the forwarder');
  await r.client.toggleAltSpeed();
  assert.ok(qbitLog.some((l) => l.startsWith('POST /api/v2/transfer/toggleSpeedLimitsMode') && l.includes(`origin=${away}`) && l.includes('sid=yes')), 'POST carries the real Origin and the cookie');
  assert.ok(!qbitLog.some((l) => /auth\/login.*origin=http:\/\/127\.0\.0\.1:\d+\/0/.test(l)), 'no forwarder URL in Origin');
  // The URL never carries the credentials.
  assert.ok(!qbitLog.some((l) => /adminadmin/.test(l)));

  // The routing peer cannot reach qBittorrent: the forwarder's 502 is "unreachable", not "wrong password".
  const down = `http://127.0.0.1:${await freePort()}`;
  behind[down] = `127.0.0.1:${await freePort()}`;
  r = await connect(down);
  assert.equal(r.ok, false);
  assert.equal(r.client.path, 'mesh');
  assert.equal(r.err.kind, 'offline', 'a 502 from the forwarder is offline');

  // The helper refuses (not reachable through any peer): the direct attempt fails, path 'failed'.
  const refused = `http://127.0.0.1:${await freePort()}`;
  r = await connect(refused);
  assert.equal(r.ok, false);
  assert.equal(r.client.path, 'failed');
  assert.equal(r.err.kind, 'offline');

  // Outside every route (192.0.2.0/24 is TEST-NET, never contacted: ensureRoute decides without I/O).
  assert.equal(await ensureRoute('http://192.0.2.15:8080'), 'outside');
  status('connecting', ['127.0.0.0/8']);
  assert.equal(await ensureRoute('http://127.0.0.1:1'), 'off', 'node not connected');
  status('connected', ['127.0.0.0/8']);

  // ---- WebDAV: listing and a ranged read (what the playback relay serves) through the forwarder ----
  const dav = await startMockWebdav({ port: 0 });
  try {
    const davAway = `http://127.0.0.1:${await freePort()}`;
    behind[davAway] = `127.0.0.1:${dav.server.address().port}`;
    const b = new WebDavBackend(`${davAway}/media`, { user: 'demo', pass: 'demo' }, undefined);
    const entries = await b.list('');
    assert.ok(entries.length > 0, 'PROPFIND through the mesh');
    let rel = entries.find((e) => !e.dir)?.name;
    for (const d of entries.filter((e) => e.dir)) {
      if (rel) break;
      const f = (await b.list(d.name)).find((e) => !e.dir);
      if (f) rel = `${d.name}/${f.name}`;
    }
    const o = await b.open(rel, 'bytes=0-3');
    assert.equal(o.status, 206, 'ranged GET through the mesh');
    o.body.resume();
    assert.ok(forwards.includes(davAway));
    assert.ok(!dav.state.tags.includes('AUTH-IN-URL') && dav.state.authSeen, 'Basic auth as a header, never in the URL');
    b.close();

    // Direct when it answers: no forwarder for it.
    const n = forwards.length;
    const direct = new WebDavBackend(dav.base, { user: 'demo', pass: 'demo' }, undefined);
    assert.ok((await direct.list('')).length > 0);
    assert.equal(forwards.length, n, 'WebDAV answering directly: no forwarder');
    direct.close();
  } finally {
    await dav.close();
  }
} finally {
  qbit.kill();
  fwd.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('LAN via mesh check: OK');
