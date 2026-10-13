// Self-check for server token binding (src/main/connection/connection-manager.ts):
// a stored token only goes to an origin where the user signed in (or a vouched
// https origin that proves to be the same server), never to whatever answers at
// a candidate address with the server's public Id. Runs against a fake network
// (net.fetch stub): no socket is opened.
// Usage: node tools/checks/token-binding-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-token-'));
const src = (p) => path.join(root, 'src/main/connection', p).replace(/\\/g, '/');
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `export { ConnectionManager } from '${src('connection-manager.ts')}';
export { credentialOrigin, tokenAllowed, setAddressRoute, redirectPolicy } from '${src('api-client.ts')}';
export { parseReply, hintAddress } from '${src('discovery.ts')}';
`,
);
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export const net = { fetch: (...a) => globalThis.__fakeFetch(...a) }; export const app = { isReady: () => false, isPackaged: true, getLocale: () => 'fr' }; export const safeStorage = {};`,
    }));
  },
};
const out = path.join(tmp, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [electronStub] });
const { ConnectionManager, credentialOrigin, tokenAllowed, setAddressRoute, parseReply, hintAddress, redirectPolicy } = await import(pathToFileURL(out).href);

// ---- Fake network: origin -> server behaviour; every request is recorded.
const SECRET = 'stored-secret-token';
const net = new Map();
const seen = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const CONNECT = 'https://connect.emby.media';
let connectServersList = [];
globalThis.__fakeFetch = async (url, init = {}) => {
  const u = new URL(url);
  const headers = init.headers ?? {};
  const token = headers['X-Emby-Token'];
  seen.push({ origin: u.origin, path: u.pathname, token });
  if (u.origin === CONNECT) {
    if (u.pathname.endsWith('/user/authenticate')) return json({ AccessToken: 'connect-user-token', User: { Id: 'cu1', Name: 'me' } });
    if (u.pathname.endsWith('/servers')) return json(connectServersList);
    return json({}, 404);
  }
  const host = net.get(u.origin);
  if (!host) throw new TypeError('fetch failed');
  if (host.delay) await new Promise((r) => setTimeout(r, host.delay));
  const p = u.pathname.replace(/^\/[0-9a-f]+(?=\/emby)/, ''); // mesh loopback base path
  // An open redirect on the host: followed with the same headers, as Chromium does for custom ones.
  if (host.redirectTo && p.startsWith('/emby/Users/')) {
    if (init.redirect === 'error') throw new TypeError('redirect refused');
    return globalThis.__fakeFetch(`${host.redirectTo}${u.pathname}`, init);
  }
  if (p === '/emby/Connect/Exchange') return json({ LocalUserId: 'u1', AccessToken: `exchanged-at-${u.host}` });
  if (p === '/emby/System/Info/Public')
    return json({ Id: host.id, ServerName: host.name ?? 'Home', Version: '4.9', ProductName: 'Emby Server', LocalAddress: host.local, WanAddress: host.wan });
  if (p === '/emby/Users/AuthenticateByName') return json({ AccessToken: `issued-by-${u.host}`, ServerId: host.id, User: { Id: 'u1', Name: 'me' } });
  if (p.startsWith('/emby/Users/')) return host.tokens?.includes(token) ? json({ Id: 'u1', Name: 'me' }) : json({}, 401);
  if (p === '/emby/Sessions/Capabilities/Full') return new Response(null, { status: 204 });
  return json({}, 404);
};
// ServerSocket opens a WebSocket once signed in: a no-op stand-in.
globalThis.WebSocket = class {
  static OPEN = 1;
  readyState = 0;
  addEventListener() {}
  send() {}
  close() {}
};
const tokensSentTo = (origin) => seen.filter((r) => r.origin === origin && r.token).map((r) => r.token);

class FakeVault {
  entries = {};
  get(id) {
    return this.entries[id];
  }
  set(id, c) {
    this.entries[id] = JSON.parse(JSON.stringify(c));
  }
  delete(id) {
    delete this.entries[id];
  }
}
const identity = { client: 'Wicaby', version: '0.1.0', deviceId: 'dev', deviceName: 'pc' };
const statusOf = (m, id) => m.session.sessions.find((s) => s.server.id === id)?.status;

// ---- Helpers
assert.equal(credentialOrigin('HTTP://Home.Test:80/emby/'), 'http://home.test');
assert.equal(credentialOrigin('https://home.test:443'), 'https://home.test');
assert.equal(credentialOrigin('file:///c:/x'), null);
assert.equal(credentialOrigin('not a url'), null);
assert.ok(tokenAllowed('https://home.test/emby', ['https://home.test']));
assert.ok(!tokenAllowed('http://home.test:8097', ['http://home.test:8096']));
assert.ok(!tokenAllowed('https://home.test:8096', ['http://home.test:8096']));
assert.ok(!tokenAllowed('http://home.test:8096', undefined));

// ---- Discovery replies are validated hints.
assert.deepEqual(parseReply('{"Id":"X","Name":"Home","Address":"http://192.0.2.1:8096/"}', 'emby'), { id: 'X', name: 'Home', address: 'http://192.0.2.1:8096', kind: 'emby' });
assert.equal(parseReply('{"Id":"X","Address":"javascript:alert(1)"}', 'emby'), null);
assert.equal(parseReply('{"Id":"X","Address":"http://u:p@192.0.2.1:8096"}', 'emby'), null);
assert.equal(parseReply('{"Id":7,"Address":"http://192.0.2.1:8096"}', 'emby'), null);
assert.equal(parseReply('not json', 'emby'), null);

// ---- Migration: an existing credential is bound to lastAddress/manualAddress, not to the probe-reported LocalAddress.
const HOME = 'http://home.test:8096';
const EVIL = 'http://evil.test:8096';
const file = path.join(tmp, 'servers.json');
fs.writeFileSync(
  file,
  JSON.stringify({ servers: [{ id: 'X', name: 'Home', kind: 'emby', version: '4.9', lastAddress: HOME, localAddress: EVIL }], activeId: 'X', activeIds: ['X'] }),
);
const vault = new FakeVault();
vault.entries.X = { userId: 'u1', userName: 'me', token: SECRET };
const m = new ConnectionManager(file, vault, identity);
assert.deepEqual(vault.get('server:X').origins, [HOME]);
assert.equal(vault.get('X'), undefined, 'legacy key left behind');
m.flush();
assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tokenBinding, 1);

// Home down, an impostor answers at the poisoned address with the same public Id: no token, sign-in asked.
net.set(EVIL, { id: 'X', tokens: [SECRET] });
await m.select('X');
assert.equal(statusOf(m, 'X'), 'server-selected');
assert.deepEqual(tokensSentTo(EVIL), [], 'token leaked to an address the user never signed in at');
m.disconnect('X');

// Home back (slower than the impostor): the bound address wins, the impostor is not even asked.
net.set(HOME, { id: 'X', tokens: [SECRET], delay: 30, local: 'http://lan2.test:8096', wan: 'https://remote.test' });
seen.length = 0;
await m.select('X');
assert.equal(statusOf(m, 'X'), 'signed-in');
assert.ok(tokensSentTo(HOME).includes(SECRET));
assert.equal(seen.filter((r) => r.origin === EVIL).length, 0);
// The trusted origin vouched for its https WanAddress only; its addresses stay its own.
assert.deepEqual(vault.get('server:X').vouched, ['https://remote.test']);
assert.equal(m.list()[0].localAddress, 'http://lan2.test:8096');
m.disconnect('X');

// add() of the impostor's address does not repoint the server nor its credential.
await m.add(EVIL);
const after = m.list().find((s) => s.id === 'X');
assert.equal(after.lastAddress, HOME);
assert.equal(after.manualAddress, undefined);
assert.equal(after.hasToken, true);
assert.deepEqual(vault.get('server:X').origins, [HOME]);

// Home down; an http LAN address it reported answers: still no token there.
net.delete(HOME);
net.delete(EVIL);
net.set('http://lan2.test:8096', { id: 'X', tokens: [SECRET] });
await m.select('X');
assert.equal(statusOf(m, 'X'), 'server-selected');
assert.deepEqual(tokensSentTo('http://lan2.test:8096'), []);
m.disconnect('X');

// The vouched https origin answers with the server's Id (TLS validated by net.fetch): token allowed, origin bound.
net.set('https://remote.test', { id: 'X', tokens: [SECRET] });
await m.select('X');
assert.equal(statusOf(m, 'X'), 'signed-in');
assert.ok(tokensSentTo('https://remote.test').includes(SECRET));
assert.deepEqual(vault.get('server:X').origins, [HOME, 'https://remote.test']);
m.disconnect('X');

// A vouched https origin answering with another Id is refused outright.
net.set('https://remote.test', { id: 'OTHER', tokens: [SECRET] });
net.delete('http://lan2.test:8096');
seen.length = 0;
await assert.rejects(m.select('X'));
assert.deepEqual(tokensSentTo('https://remote.test'), []);

// Re-confirming by signing in at a new address binds the new token there.
net.delete('https://remote.test');
net.set(EVIL, { id: 'X', tokens: [] });
await m.select('X');
assert.equal(statusOf(m, 'X'), 'server-selected');
await m.login('me', 'pw', 'X');
assert.equal(statusOf(m, 'X'), 'signed-in');
assert.ok(vault.get('server:X').origins.includes(EVIL));
assert.equal(vault.get('server:X').token, 'issued-by-evil.test:8096');
m.disconnect();

// Multi-server, one behind a mesh loopback forwarder: each token goes to its own server only.
const MESH = 'http://100.64.0.5:8096';
const LOOP = 'http://127.0.0.1:45678';
setAddressRoute({ ensure: async () => {}, rewrite: (u) => (u.startsWith(MESH) ? `${LOOP}/abcd${u.slice(MESH.length)}` : u) });
const file2 = path.join(tmp, 'servers2.json');
fs.writeFileSync(
  file2,
  JSON.stringify({
    servers: [
      { id: 'A', name: 'A', kind: 'emby', version: '4.9', lastAddress: 'http://a.test:8096' },
      { id: 'B', name: 'B', kind: 'emby', version: '4.9', lastAddress: MESH },
    ],
  }),
);
const vault2 = new FakeVault();
vault2.entries.A = { userId: 'u1', userName: 'me', token: 'tok-a' };
vault2.entries.B = { userId: 'u1', userName: 'me', token: 'tok-b' };
const m2 = new ConnectionManager(file2, vault2, identity);
net.set('http://a.test:8096', { id: 'A', tokens: ['tok-a'] });
net.set(LOOP, { id: 'B', tokens: ['tok-b'] });
seen.length = 0;
await Promise.all([m2.select('A'), m2.select('B')]);
assert.equal(statusOf(m2, 'A'), 'signed-in');
assert.equal(statusOf(m2, 'B'), 'signed-in');
assert.deepEqual([...new Set(tokensSentTo('http://a.test:8096'))], ['tok-a']);
assert.deepEqual([...new Set(tokensSentTo(LOOP))], ['tok-b']);
m2.disconnect();
setAddressRoute(null);

// ---- Helpers for the hardening below.
assert.equal(redirectPolicy('tok'), 'error');
assert.equal(redirectPolicy(undefined), 'follow');
assert.equal(hintAddress('file:///c:/x'), null);
assert.equal(hintAddress('wicaby-media://api/x'), null);
assert.equal(hintAddress('http://u:p@lan.test:8096'), null);
assert.equal(hintAddress('http://lan.test:8096/emby/?x=1#y'), 'http://lan.test:8096/emby');
const fresh = (name, doc) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, JSON.stringify(doc));
  return f;
};
net.clear();
seen.length = 0;

// ---- PoC (verifier): a server whose public Id is another subsystem's vault key, stored
// before token binding, must not pull the mesh auth key / qBittorrent password to its address.
{
  const v = new FakeVault();
  v.entries['mesh-auth-key'] = { userId: 'tailscale', userName: 'mesh-auth-key', token: 'tskey-auth-SECRET' };
  v.entries['torrents:qbittorrent'] = { userId: 'http://qb.test:8080', userName: 'admin', token: 'qb-SECRET' };
  const f = fresh('poc.json', {
    servers: [
      { id: 'mesh-auth-key', name: 'Evil', kind: 'emby', version: '4.9', lastAddress: EVIL, manualAddress: EVIL },
      { id: 'torrents:qbittorrent', name: 'Evil2', kind: 'emby', version: '4.9', lastAddress: EVIL },
    ],
    activeId: 'mesh-auth-key',
    activeIds: ['mesh-auth-key', 'torrents:qbittorrent'],
  });
  net.set(EVIL, { id: 'mesh-auth-key', tokens: [] });
  const mp = new ConnectionManager(f, v, identity);
  await mp.resumeLastSession();
  assert.deepEqual(tokensSentTo(EVIL), [], 'vault secret sent to a server named after its key');
  assert.deepEqual(mp.list(), [], 'server with a reserved Id kept');
  assert.equal(v.entries['mesh-auth-key'].token, 'tskey-auth-SECRET');
  assert.equal(v.entries['torrents:qbittorrent'].token, 'qb-SECRET');
  assert.equal(v.entries['mesh-auth-key'].origins, undefined);
  // Nor can one be added afterwards (discovery reply or typed address).
  await assert.rejects(mp.add(EVIL));
  assert.deepEqual(mp.list(), []);
  mp.flush();
}

// ---- Migration is one-shot: a credential without origins written after it is never bound to lastAddress.
{
  const v = new FakeVault();
  v.entries.Y = { userId: 'u1', userName: 'me', token: SECRET };
  v.entries['server:Z'] = { userId: 'u1', userName: 'me', token: SECRET };
  const f = fresh('migrated.json', {
    tokenBinding: 1,
    servers: [
      { id: 'Y', name: 'Y', kind: 'emby', version: '4.9', lastAddress: EVIL },
      { id: 'Z', name: 'Z', kind: 'emby', version: '4.9', lastAddress: EVIL },
    ],
  });
  net.set(EVIL, { id: 'Y', tokens: [SECRET] });
  const mo = new ConnectionManager(f, v, identity);
  assert.equal(v.entries['server:Y'], undefined);
  assert.equal(v.entries['server:Z'].origins, undefined);
  await mo.select('Y');
  net.set(EVIL, { id: 'Z', tokens: [SECRET] });
  await mo.select('Z');
  assert.deepEqual(tokensSentTo(EVIL), [], 'token sent to an unbound lastAddress after migration');
  assert.equal(statusOf(mo, 'Z'), 'server-selected');
  mo.disconnect();
  mo.flush();
}

// ---- Probe data: junk addresses reported by a trusted server are dropped; an untrusted answer
// can't plant a path under a trusted origin; a token-bearing request does not follow redirects.
{
  const v = new FakeVault();
  v.entries['server:P'] = { userId: 'u1', userName: 'me', token: SECRET, origins: [HOME] };
  const f = fresh('probe.json', { tokenBinding: 1, servers: [{ id: 'P', name: 'P', kind: 'emby', version: '4.9', lastAddress: HOME }] });
  net.clear();
  net.set(HOME, { id: 'P', tokens: [SECRET], local: 'file:///c:/x', wan: 'http://u:p@wan.test' });
  const mq = new ConnectionManager(f, v, identity);
  await mq.select('P');
  assert.equal(statusOf(mq, 'P'), 'signed-in');
  const ps = mq.list()[0];
  assert.equal(ps.localAddress, undefined);
  assert.equal(ps.remoteAddress, undefined);
  mq.disconnect();
  net.delete(HOME);
  net.set(EVIL, { id: 'P', tokens: [], local: `${HOME}/redirector` });
  await mq.add(EVIL);
  const raw = mq.store.value.servers[0];
  assert.ok((raw.extraAddresses ?? []).includes(EVIL));
  assert.ok(!(raw.extraAddresses ?? []).some((a) => a.startsWith(HOME)), 'path under a trusted origin planted');
  net.set(HOME, { id: 'P', tokens: [SECRET], redirectTo: EVIL });
  net.set(EVIL, { id: 'P', tokens: [SECRET] });
  seen.length = 0;
  await mq.select('P').catch(() => undefined);
  assert.ok(tokensSentTo(HOME).length > 0);
  assert.deepEqual(tokensSentTo(EVIL), [], 'token followed a redirect');
  mq.disconnect();
  mq.flush();
}

// ---- VPN: an overlay peer the VPN service lists, answering with the server's Id, gets the
// token (not bound for good); the same address once the VPN no longer lists it does not.
{
  const OVERLAY = 'http://100.64.0.9:8096';
  let peers = [OVERLAY];
  const vpn = { candidatesFor: async () => peers, networkOf: (a) => (a?.includes('100.64.') ? 'tailscale' : undefined) };
  const v = new FakeVault();
  v.entries['server:V'] = { userId: 'u1', userName: 'me', token: SECRET, origins: [HOME] };
  const f = fresh('vpn.json', { tokenBinding: 1, servers: [{ id: 'V', name: 'V', kind: 'emby', version: '4.9', lastAddress: HOME }] });
  net.clear();
  net.set(OVERLAY, { id: 'V', tokens: [SECRET] });
  seen.length = 0;
  const mv = new ConnectionManager(f, v, identity, vpn);
  await mv.select('V');
  assert.equal(statusOf(mv, 'V'), 'signed-in');
  assert.ok(tokensSentTo(OVERLAY).includes(SECRET));
  assert.deepEqual(v.entries['server:V'].origins, [HOME], 'overlay address bound for good');
  mv.disconnect();
  // Downloads' pickVpnServer: add() of the overlay address, then select().
  await mv.add(OVERLAY);
  await mv.select('V');
  assert.equal(statusOf(mv, 'V'), 'signed-in');
  mv.disconnect();
  // VPN down: whoever answers at that overlay IP is a stranger.
  peers = [];
  seen.length = 0;
  await mv.select('V');
  assert.equal(statusOf(mv, 'V'), 'server-selected');
  assert.deepEqual(tokensSentTo(OVERLAY), []);
  mv.disconnect();
  // A listed peer answering with another Id gets nothing.
  peers = [OVERLAY];
  net.set(OVERLAY, { id: 'OTHER', tokens: [SECRET] });
  seen.length = 0;
  await mv.select('V').catch(() => undefined);
  assert.deepEqual(tokensSentTo(OVERLAY), []);
  mv.disconnect();
  mv.flush();
}

// ---- Emby Connect: the access key is not exchanged at an http LAN address nobody signed in at.
{
  const LAN = 'http://192.168.77.50:8096';
  const WAN = 'http://203.0.113.9:8096';
  const exchangesAt = (origin) => seen.filter((r) => r.origin === origin && r.path === '/emby/Connect/Exchange');
  connectServersList = [{ SystemId: 'C', Name: 'Cloud', LocalAddress: LAN, Url: WAN, AccessKey: 'connect-access-key' }];
  const v = new FakeVault();
  const f = fresh('connect.json', { tokenBinding: 1, servers: [] });
  net.clear();
  net.set(LAN, { id: 'C', name: 'Cloud', tokens: [] }); // a stranger on this LAN, claiming the public SystemId
  seen.length = 0;
  const mc = new ConnectionManager(f, v, identity);
  await mc.embyConnect('me', 'pw');
  assert.deepEqual(exchangesAt(LAN), [], 'access key sent to an http LAN address');
  assert.equal(v.entries['server:C'], undefined);
  assert.equal(mc.list()[0].hasToken, false);
  // The registered remote URL answers: exchanged and bound there.
  net.set(WAN, { id: 'C', name: 'Cloud', tokens: [] });
  await mc.embyConnect('me', 'pw');
  assert.equal(exchangesAt(WAN).length, 1);
  assert.deepEqual(exchangesAt(LAN), []);
  assert.deepEqual(v.entries['server:C'].origins, [WAN]);
  // Re-confirmation: the user opened the server's sign-in at the LAN address, then signs in with Connect there.
  mc.dropCred('C');
  net.delete(WAN);
  await mc.select('C');
  assert.equal(statusOf(mc, 'C'), 'server-selected');
  await mc.embyConnect('me', 'pw');
  assert.equal(exchangesAt(LAN).length, 1);
  assert.ok(v.entries['server:C'].origins.includes(LAN));
  mc.disconnect();
  // A remote URL that is itself a private address: no automatic exchange either.
  connectServersList = [{ SystemId: 'D', Name: 'Lan only', Url: 'http://10.9.9.9:8096', AccessKey: 'k2' }];
  net.set('http://10.9.9.9:8096', { id: 'D', tokens: [] });
  seen.length = 0;
  await mc.embyConnect('me', 'pw');
  assert.deepEqual(exchangesAt('http://10.9.9.9:8096'), []);
  // https is fine (TLS validated by net.fetch).
  connectServersList = [{ SystemId: 'E', Name: 'Tls', LocalAddress: 'https://10.9.9.10:8920', AccessKey: 'k3' }];
  net.set('https://10.9.9.10:8920', { id: 'E', tokens: [] });
  await mc.embyConnect('me', 'pw');
  assert.equal(exchangesAt('https://10.9.9.10:8920').length, 1);
  assert.deepEqual(v.entries['server:E'].origins, ['https://10.9.9.10:8920']);
  mc.flush();
}

m.flush();
m2.flush();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('token-binding-check: ok');
process.exit(0);
