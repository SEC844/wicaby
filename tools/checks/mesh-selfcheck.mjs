// Self-check for the embedded mesh URL routing (src/main/vpn/embedded-mesh.ts)
// without the helper: helper messages are fed in by hand. The helper's own
// allow-list is tested by `go test ./mesh/` in packages/mesh.
// Usage: node tools/checks/mesh-selfcheck.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// The desktop app's sources live in apps/desktop.
const root = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-mesh-'));
const out = path.join(tmp, 'mesh.mjs');
const FAKE_HELPER = `import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
export function spawn(exe, args) {
  (globalThis.spawned ??= []).push(args);
  const p = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill() {} });
  const i = args.indexOf('--control-url');
  const authUrl = 'https://login.example/' + encodeURIComponent(i < 0 ? 'hosted' : args[i + 1]);
  p.stdin.on('data', () => p.stdout.write(JSON.stringify({ type: 'status', state: 'needs-login', authUrl, ips: [], peers: [] }) + '\\n'));
  p.stdin.on('finish', () => ((p.exitCode = 0), p.emit('exit', 0)));
  return p;
}`;
await build({
  stdin: {
    contents: `export { EmbeddedMesh, dropForeignNetbirdConfig, locateMeshHelper } from './src/main/vpn/embedded-mesh'; export { pendingMatches } from './src/renderer/lib/vpn'; export { routed, resolveServerUrl } from './src/main/connection/api-client';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  // Only net.fetch is referenced, and never called here.
  plugins: [
    {
      name: 'no-electron',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export const net = {}, safeStorage = {}; export const app = { isReady: () => false, isPackaged: true, getLocale: () => 'fr' };` }));
      },
    },
    {
      // A fake wicaby-mesh: records its arguments and asks for a browser sign-in on the server it was given.
      name: 'fake-helper',
      setup(b) {
        b.onResolve({ filter: /^(node:)?child_process$/ }, () => ({ path: 'child_process', namespace: 'fake' }));
        b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ resolveDir: root, contents: FAKE_HELPER }));
      },
    },
  ],
  logLevel: 'error',
});
const { EmbeddedMesh, dropForeignNetbirdConfig, locateMeshHelper, pendingMatches, routed, resolveServerUrl } = await import(pathToFileURL(out).href);

const vault = { get: () => undefined, set() {}, delete() {} };
const mesh = new EmbeddedMesh({ exe: null, dataDir: tmp, vault, deviceName: 'DESKTOP-ÉTÉ 01' });
const sent = [];
mesh.proc = { stdin: { write: (l) => sent.push(JSON.parse(l)) } }; // stands in for the helper's stdin

assert.equal((await mesh.status()).state, 'not-installed');
assert.equal(mesh.hostname, 'wicaby-desktop-t-01');

const status = (state) =>
  mesh.onLine(
    JSON.stringify({
      type: 'status',
      state,
      ips: ['100.64.0.9'],
      selfDnsName: 'wicaby-desktop.tail1.ts.net',
      peers: [
        { name: 'nas', dnsName: 'nas.tail1.ts.net', ips: ['100.64.0.7', 'fd7a:115c:a1e0::7'], online: true },
        { name: 'tv', ips: ['100.77.1.2'], online: false },
      ],
    }),
  );

// Not connected yet: nothing is routed, nothing is asked of the helper.
status('connecting');
await mesh.ensureRoute('http://100.64.0.7:8096');
assert.equal(sent.length, 0);

status('connected');
const base = 'http://127.0.0.1:50123/0123456789abcdef0123456789abcdef';
const reply = (b, error) => {
  const id = sent.at(-1).id;
  setTimeout(() => mesh.onLine(JSON.stringify({ type: 'forward', id, base: b, error })), 5);
};

let p = mesh.ensureRoute('http://100.64.0.7:8096/emby');
assert.deepEqual(sent.at(-1), { cmd: 'forward', id: sent.at(-1).id, upstream: 'http://100.64.0.7:8096' });
reply(base);
await p;

p = mesh.ensureRoute('https://NAS.tail1.ts.net');
assert.equal(sent.at(-1).upstream, 'https://nas.tail1.ts.net');
reply(`${base.slice(0, -1)}e`);
await p;

// Not a peer of this mesh (LAN server, another overlay, the internet): left alone.
for (const a of ['http://192.0.2.10:8096', 'http://100.64.0.8:8096', 'http://8.8.8.8', 'http://nas.tail1.ts.net.evil.com']) {
  const before = sent.length;
  await mesh.ensureRoute(a);
  assert.equal(sent.length, before, a);
  assert.equal(routed(`${a}/x`), `${a}/x`);
}

// A helper answer that is not a loopback base is ignored.
p = mesh.ensureRoute('http://100.64.0.7:8920');
reply('http://evil.example/abc');
await p;
assert.equal(routed('http://100.64.0.7:8920/x'), 'http://100.64.0.7:8920/x');

assert.equal(routed('http://100.64.0.7:8096/emby/Items?ParentId=1&x=%2F'), `${base}/emby/Items?ParentId=1&x=%2F`);
assert.equal(routed('http://100.64.0.7:8096'), base);
assert.equal(routed('http://100.64.0.7:8096?x=1'), `${base}/?x=1`);
assert.equal(routed('HTTP://100.64.0.7:8096/a'), `${base}/a`);
assert.equal(routed('http://100.64.0.7:80960/a'), 'http://100.64.0.7:80960/a');
assert.equal(routed('https://nas.tail1.ts.net/web'), `${base.slice(0, -1)}e/web`);
assert.equal(routed('wicaby-media://api/x'), 'wicaby-media://api/x');
assert.equal(resolveServerUrl({ address: 'http://100.64.0.7:8096', prefix: '/emby' }, '/videos/1/stream'), `${base}/emby/videos/1/stream`);
assert.equal(resolveServerUrl({ address: 'http://100.64.0.7:8096', prefix: '/emby' }, '/emby/videos/1/stream'), `${base}/emby/videos/1/stream`);

// NetBird network routes: a server in a routed network (the home LAN behind a routing peer) goes through the
// mesh only when it does not answer directly; a default route (exit node) never routes anything. Loopback
// stands in for the LAN: a listening port answers directly, a closed one does not.
{
  const net = await import('node:net');
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const open = srv.address().port;
  const closedSrv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => closedSrv.once('listening', r));
  const closed = closedSrv.address().port;
  await new Promise((r) => closedSrv.close(r));
  mesh.onLine(JSON.stringify({ type: 'status', state: 'connected', ips: ['100.64.0.9'], peers: mesh.helper.peers, routes: ['127.0.0.0/8', '0.0.0.0/0'] }));
  let before = sent.length;
  await mesh.ensureRoute(`http://127.0.0.1:${open}`);
  assert.equal(sent.length, before, 'reachable directly: no forwarder');
  await mesh.ensureRoute('http://8.8.8.8:8096');
  assert.equal(sent.length, before, 'a default route routes nothing');
  p = mesh.ensureRoute(`http://127.0.0.1:${closed}/emby`);
  await new Promise((r) => {
    const t = setInterval(() => sent.length > before && (clearInterval(t), r()), 20);
  });
  assert.equal(sent.at(-1).upstream, `http://127.0.0.1:${closed}`, 'not answering directly: through the mesh');
  reply(`${base.slice(0, -1)}c`);
  await p;
  assert.equal(routed(`http://127.0.0.1:${closed}/x`), `${base.slice(0, -1)}c/x`);
  srv.close();
}

const s = await mesh.status();
assert.equal(s.kind, 'embedded');
assert.equal(s.provider, 'tailscale');
const peers = await mesh.peers();
assert.deepEqual(peers.map((x) => [x.kind, x.name, x.servers.length]), [['embedded', 'nas', 0], ['embedded', 'tv', 0]]);

// The helper is wicaby-mesh.exe on Windows and wicaby-mesh elsewhere, packaged copy first.
const res = path.join(tmp, 'res');
const appRoot = path.join(tmp, 'apps', 'desktop');
fs.mkdirSync(path.join(res, 'vpn-helper'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'vendor', 'vpn-helper'), { recursive: true });
assert.equal(locateMeshHelper(res, appRoot, 'win32'), null);
assert.equal(locateMeshHelper(res, appRoot, 'linux'), null);
fs.writeFileSync(path.join(tmp, 'vendor', 'vpn-helper', 'wicaby-mesh'), '');
assert.equal(locateMeshHelper(res, appRoot, 'win32'), null, 'Windows never runs the extensionless Linux helper');
assert.equal(locateMeshHelper(res, appRoot, 'linux'), path.join(tmp, 'vendor', 'vpn-helper', 'wicaby-mesh'));
fs.writeFileSync(path.join(res, 'vpn-helper', 'wicaby-mesh.exe'), '');
fs.writeFileSync(path.join(res, 'vpn-helper', 'wicaby-mesh'), '');
assert.equal(locateMeshHelper(res, appRoot, 'win32'), path.join(res, 'vpn-helper', 'wicaby-mesh.exe'));
assert.equal(locateMeshHelper(res, appRoot, 'linux'), path.join(res, 'vpn-helper', 'wicaby-mesh'));
// ---- NetBird management server (VpnPanel -> vpn:connect -> embedded node) ----
// A node first started on the hosted service (no URL), then pointed at a self-hosted one: the typed URL
// reaches the helper (--control-url), the node restarts, and the cloud registration is dropped.
{
  const dir = path.join(tmp, 'nb');
  const nb = new EmbeddedMesh({ exe: 'wicaby-mesh.exe', dataDir: dir, vault, deviceName: 'pc' });
  const cfg = path.join(dir, 'netbird', 'config.json');
  const saveCfg = (scheme, host) => {
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify({ PrivateKey: 'k', ManagementURL: { Scheme: scheme, Host: host } }));
  };
  const args = () => globalThis.spawned.at(-1);
  const controlUrl = () => (args().includes('--control-url') ? args()[args().indexOf('--control-url') + 1] : null);
  const prefs = () => nb.prefs.value; // what wicaby.json gets

  saveCfg('https', 'api.netbird.io:443');
  let r = await nb.connect({ provider: 'netbird' });
  assert.equal(controlUrl(), null);
  assert.equal(r.authUrl, 'https://login.example/hosted');
  // The panel (VpnPanel connect()): "Reopen page" only for the page of the server in the field and no setup key;
  // a URL typed (or changed) afterwards, or a key, makes the button connect anew with them.
  const pendingCloud = await nb.status();
  assert.equal(pendingMatches(pendingCloud, '', ''), true);
  assert.equal(pendingMatches(pendingCloud, 'https://netbird.example.com', ''), false);
  assert.equal(pendingMatches(pendingCloud, '', 'ABCDEFGH-1234'), false);
  assert.equal(pendingMatches({ ...pendingCloud, managementUrl: 'https://netbird.example.com' }, ' https://netbird.example.com ', ''), true);
  assert.ok(fs.existsSync(cfg), 'same server: the registration is kept');
  assert.equal((await nb.status()).managementUrl, undefined);

  const n = globalThis.spawned.length;
  r = await nb.connect({ provider: 'netbird', managementUrl: 'https://netbird.example.com' });
  assert.equal(globalThis.spawned.length, n + 1, 'a new URL restarts the node');
  assert.equal(controlUrl(), 'https://netbird.example.com');
  assert.equal(r.authUrl, `https://login.example/${encodeURIComponent('https://netbird.example.com')}`, 'the new server sign-in, not the stale cloud page');
  assert.equal(prefs().managementUrl, 'https://netbird.example.com');
  assert.equal((await nb.status()).managementUrl, 'https://netbird.example.com', 'the panel shows the saved URL');
  assert.ok(!fs.existsSync(cfg), 'the cloud peer key is dropped');

  // The same URL again keeps the running node (the panel offers "Reopen page" for it); a setup key restarts it.
  await nb.connect({ provider: 'netbird', managementUrl: 'https://netbird.example.com' });
  assert.equal(globalThis.spawned.length, n + 1);
  await nb.connect({ provider: 'netbird', managementUrl: 'https://netbird.example.com', authKey: 'ABCDEFGH-1234' });
  assert.equal(globalThis.spawned.length, n + 2);
  // '' = back to the hosted service.
  await nb.connect({ provider: 'netbird', managementUrl: '' });
  assert.equal(globalThis.spawned.length, n + 3);
  assert.equal(controlUrl(), null);
  assert.equal(prefs().managementUrl, undefined);
  nb.dispose();

  // The default port and a trailing slash name the same server.
  saveCfg('https', 'netbird.example.com:443');
  assert.equal(dropForeignNetbirdConfig(path.dirname(cfg), 'https://netbird.example.com/'), false);
  assert.equal(dropForeignNetbirdConfig(path.dirname(cfg), 'https://netbird.example.com:443'), false);
  assert.equal(dropForeignNetbirdConfig(path.dirname(cfg), 'https://other.example.com'), true);
  assert.ok(!fs.existsSync(cfg));
  assert.equal(dropForeignNetbirdConfig(path.dirname(cfg), undefined), false, 'nothing saved: nothing to drop');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('mesh routing self-check: OK');
