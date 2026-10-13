// Self-check for the disposable Jellyfin token per cast (docs/specs/cast-spec.md CA-11), desktop side.
// Against mock Jellyfin (Quick Connect on), a second mock Jellyfin with MOCK_QC=0, mock-dlna (generic) and mock-cast on
// loopback, with the real ConnectionManager, CastManager and EphemeralTokens, the devices found through the dev seeds
// (never SSDP or mDNS), and a fake local player (no mpv, nothing audible):
//   AC 1  no renderer request carries the user token: DLNA with the relay off gets a Quick Connect token in its URL
//         (minted as "Wicaby Cast" with the renderer's name), the Jellyfin receiver gets one as accessToken; through
//         the relay nothing is minted at all;
//   AC 2  Quick Connect off: the user token (§2.6.3), no error, nothing kept;
//   AC 3  a sender token is revoked when its cast stops (a later use gets 401); one left by a crash (the process dies
//         mid-cast) is revoked by the next start's cleanup; a receiver token survives a sender quit while its session
//         is listed, and is revoked at the first cleanup after the session is gone; Stop revokes it at once.
// Nothing leaves 127.0.0.1: outgoing TCP and UDP to a non-loopback address throw, the electron stub's fetch and
// request refuse any other host, and SSDP and mDNS ask on no interface.
// Usage: node tools/checks/cast-token-check.mjs [--verbose]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const T0 = Date.now();
const repo = path.resolve(import.meta.dirname, '..', '..');
const VERBOSE = process.argv.includes('--verbose');
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|localhost)$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Loopback guards (this process) ----
{
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...a) {
    let o = a[0];
    if (Array.isArray(o)) o = o[0];
    const h = o && typeof o === 'object' ? (o.path ? undefined : o.host) : a[1];
    if (h !== undefined && !LOOPBACK.test(String(h).replace(/^\[|\]$/g, ''))) throw new Error(`GUARD: non-loopback connect to ${h}`);
    return connect.apply(this, a);
  };
  const send = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (msg, ...a) {
    const host = a.find((x) => typeof x === 'string');
    if (host && !LOOPBACK.test(host)) throw new Error(`GUARD: UDP to ${host}`);
    return send.call(this, msg, ...a);
  };
}
function loopbackUrl(url) {
  const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK.test(h)) throw new Error(`GUARD: refusing ${url}`);
}
globalThis.__castNet = {
  fetch(url, init = {}) {
    loopbackUrl(url);
    return fetch(url, init);
  },
  // fetchServer's net.request (the relay), over node:http.
  request(opts) {
    loopbackUrl(opts.url);
    const ee = new EventEmitter();
    const headers = {};
    let req;
    ee.setHeader = (k, v) => (headers[k] = v);
    ee.followRedirect = () => {
      throw new Error('no redirect in this check');
    };
    ee.abort = () => {
      req?.destroy();
      ee.emit('abort');
    };
    ee.end = () => {
      req = http.request(opts.url, { method: opts.method, headers }, (res) => ee.emit('response', res));
      req.on('error', (e) => ee.emit('error', e));
      req.end();
    };
    return ee;
  },
};

// ---- Bundle (esbuild, electron stubbed) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-cast-token-'));
const src = (p) => path.join(repo, 'apps/desktop/src/main', p).replace(/\\/g, '/');
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `export { EphemeralTokens } from '${src('cast/ephemeral-token.ts')}';
export { CastManager } from '${src('cast/cast-manager.ts')}';
export { ConnectionManager } from '${src('connection/connection-manager.ts')}';
`,
);
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export const net = { fetch: (...a) => globalThis.__castNet.fetch(...a), request: (o) => globalThis.__castNet.request(o) };
export const app = { isReady: () => false, isPackaged: false, getLocale: () => 'fr', getPath: () => '.', on() {} };
export const powerSaveBlocker = { start: () => 1, stop: () => undefined, isStarted: () => true };
export const safeStorage = {}; export const protocol = {}; export const session = {};`,
    }));
  },
};
const out = path.join(tmp, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [electronStub] });
const C = await import(pathToFileURL(out).href);
C.CastManager.ssdpInterfaces = () => [];
C.CastManager.mdnsInterfaces = () => [];

class FakeVault {
  entries = {};
  get(id) {
    return this.entries[id];
  }
  async set(id, c) {
    this.entries[id] = JSON.parse(JSON.stringify(c));
  }
  async delete(id) {
    delete this.entries[id];
  }
}

// ---- Pure: the vault entry, Emby ----
{
  const v = new FakeVault();
  const tokens = new C.EphemeralTokens(v, '0.2.0');
  assert.deepEqual(tokens.list(), [], 'empty vault');
  v.entries[C.EphemeralTokens.vaultKey] = { userId: '', userName: 'cast', token: '[{"token":"t"},{"token":"a","deviceId":"d","kind":"sender","serverId":"s","name":"n"},"x"]' };
  assert.deepEqual(tokens.list().map((d) => d.token), ['a'], 'malformed entries are ignored');
  v.entries[C.EphemeralTokens.vaultKey].token = 'not json';
  assert.deepEqual(tokens.list(), []);
  let calls = 0;
  const emby = { kind: 'emby', token: 'u', address: 'http://127.0.0.1:1', get: () => calls++, post: () => calls++ };
  assert.equal(await tokens.mint(emby, 's', 'TV', 'sender'), null, 'Emby: no disposable token');
  assert.equal(calls, 0, 'Emby: Quick Connect is never asked');
}
console.log('ok pure: vault entries, Emby skipped');

// ---- Mocks (loopback only) ----
const children = new Set();
process.on('exit', () => children.forEach((c) => c.kill()));
const handedOut = new Set();
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      // Never the same port twice: a closed port can be handed out again before its mock binds it.
      s.close(() => (handedOut.has(port) ? freePort().then(resolve, reject) : (handedOut.add(port), resolve(port))));
    });
  });
}
// Binds the mocks to 127.0.0.1 and kills any non-loopback connect they try (as cast-mock-check does).
const BOOT = `data:text/javascript,${encodeURIComponent(
  "import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'&&(a.length===1||typeof a[1]==='function'))a.splice(1,0,'127.0.0.1');return l.apply(this,a)};const ok=(h)=>h===undefined||/^127\\./.test(h)||h==='::1'||h==='localhost';const c=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...a){let o=a[0];if(Array.isArray(o))o=o[0];const h=o&&typeof o==='object'?(o.path?undefined:o.host):a[1];if(!ok(h))throw new Error('GUARD: non-loopback connect to '+h);return c.apply(this,a)};",
)}`;
async function startMock(name, script, args, env, ready) {
  const child = spawn(process.execPath, ['--import', BOOT, path.join(repo, 'tools/mock-server', script), ...args], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MOCK_'))), MOCK_DURATION_S: '3600', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  const log = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: not listening after 10 s\n${log.join('\n')}`)), 10_000);
    const onData = (d) => {
      for (const line of String(d).split(/\r?\n/).filter(Boolean)) {
        log.push(line);
        if (VERBOSE) console.log(`  [${name}] ${line}`);
        if (ready.test(line)) (clearTimeout(timer), resolve());
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => (clearTimeout(timer), reject(new Error(`${name}: exited with ${code}\n${log.join('\n')}`))));
  });
  return { log };
}
const json = async (url, init) => (loopbackUrl(url), (await fetch(url, init)).json());
async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return Date.now() - t0;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms: ${what}`);
    await sleep(50);
  }
}

// PlaybackService as the cast manager sees it (nothing plays here).
class FakeLocal {
  castSnapshot() {
    return null;
  }
  async command() {}
  async stop() {}
  async play() {}
}

try {
  const video = path.join(tmp, 'video.mkv');
  fs.writeFileSync(video, Buffer.alloc(256 * 1024, 0x1a)); // only its bytes are fetched, never decoded
  const ports = { jf: await freePort(), noqc: await freePort(), dlna: await freePort(), cast: await freePort(), castState: await freePort() };
  const mocks = await Promise.all([
    startMock('jellyfin', 'mock-jellyfin.mjs', [String(ports.jf), video], {}, /^Mock Jellyfin/),
    startMock('jellyfin-noqc', 'mock-jellyfin.mjs', [String(ports.noqc), video], { MOCK_QC: '0', MOCK_SERVER_ID: '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c' }, /^Mock Jellyfin/),
    startMock('dlna', 'mock-dlna.mjs', [String(ports.dlna)], { MOCK_DLNA_PROFILE: 'generic' }, /^Mock DLNA renderer/),
    startMock('cast', 'mock-cast.mjs', [], { MOCK_CAST_PORT: String(ports.cast), MOCK_CAST_STATE_PORT: String(ports.castState) }, /^Mock Cast device/),
  ]);
  const root = (p) => `http://127.0.0.1:${ports[p]}`;
  process.env.WICABY_DLNA_SEED = `${root('dlna')}/desc.xml`;
  process.env.WICABY_CAST_SEED = `127.0.0.1:${ports.cast}`;
  const dlnaState = () => json(`${root('dlna')}/Mock/State`);
  const castState = () => json(`${root('castState')}/Mock/State`);
  // What a token gets from the server: 200 while valid, 401 once revoked.
  const status = async (server, token) => (loopbackUrl(root(server)), (await fetch(`${root(server)}/Users/Me?ApiKey=${encodeURIComponent(token)}`)).status);
  const minted = (server) => mocks[server === 'jf' ? 0 : 1].log.filter((l) => l.startsWith('QUICKCONNECT code')).length;

  // One app start: its own connection, signed in again; the token vault survives restarts (it is the OS vault).
  const tokenVault = new FakeVault();
  async function desktop(server, deviceId, relay) {
    const m = new C.ConnectionManager(path.join(tmp, `servers-${deviceId}.json`), new FakeVault(), { client: 'Wicaby', version: '0.2.0', deviceId, deviceName: 'pc-a' });
    const toasts = [];
    const tokens = new C.EphemeralTokens(tokenVault, '0.2.0');
    const cast = new C.CastManager({ connection: m, local: new FakeLocal(), deviceId, notify: (k, message) => toasts.push({ kind: k, message }), settings: { value: { cast: { discovery: true, relay } } }, tokens });
    // index.ts: a session change cleans up.
    m.on('session', () => void cast.cleanupTokens());
    const info = await m.add(root(server));
    await m.select(info.id);
    await m.login('Wika', 'wicaby', info.id);
    const user = m.onlineApi(info.id).token;
    const rows = async (kind) => (await cast.targets('movie-0', info.id)).find((r) => r.kind === kind)?.key;
    const quit = () => {
      cast.dispose();
      for (const c of m.conns.values()) c.socket?.close();
    };
    return { m, serverId: info.id, cast, toasts, tokens, user, rows, quit };
  }
  const noUserToken = async (user) => {
    const d = await dlnaState();
    assert.ok(!d.uri.includes(user) && !d.meta.includes(user), 'the renderer URL and DIDL never carry the user token');
    assert.equal(d.tokenHeaders, 0, 'no auth header to the renderer');
  };

  // ---- AC 1 + 3: DLNA, relay off: a disposable token in the URL, revoked on Stop ----
  {
    const A = await desktop('jf', 'desk-tok-a', false);
    const before = minted('jf');
    await A.cast.start(await A.rows('dlna'), { itemIds: ['movie-0'], msid: 'movie-0-1080' });
    assert.equal(A.cast.state?.status, 'playing', `casting (${JSON.stringify(A.toasts)})`);
    const d = await dlnaState();
    const tok = new URL(d.uri).searchParams.get('ApiKey');
    assert.ok(tok && tok !== A.user, 'AC 1: the stream URL carries a token that is not the user token');
    assert.equal(d.fetched.tokenInUrl, true);
    assert.ok([200, 206].includes(d.fetched.status), `the server accepted the disposable token (${d.fetched.status})`);
    await noUserToken(A.user);
    assert.equal(minted('jf'), before + 1, 'one Quick Connect code per cast');
    const kept = A.tokens.list();
    assert.deepEqual(kept.map((x) => [x.token, x.kind, x.name]), [[tok, 'sender', 'Mock Renderer']], 'kept in the vault while the cast lives');
    const dev = await json(`${root('jf')}/Sessions?DeviceId=${kept[0].deviceId}&ApiKey=${A.user}`);
    assert.deepEqual(dev.map((s) => [s.Client, s.DeviceName]), [['Wicaby Cast', 'Mock Renderer']], 'minted as "Wicaby Cast" with the renderer name and its own DeviceId');
    assert.notEqual(kept[0].deviceId, 'desk-tok-a');
    await A.cast.cleanupTokens();
    assert.equal(await status('jf', tok), 200, 'a cleanup leaves the live cast alone');
    await A.cast.stop();
    await until(async () => (await status('jf', tok)) === 401, 2000, 'the token is revoked on Stop');
    // The vault entry goes once the revoke call has returned, a moment after the server answers 401.
    await until(() => A.tokens.list().length === 0, 2000, 'and leaves the vault');
    assert.equal(await status('jf', A.user), 200, 'the user token is untouched');
    console.log('ok AC1/AC3 DLNA relay off: disposable token in the URL, revoked on Stop');

    // Through the relay the renderer gets no token at all: nothing is minted.
    const R = await desktop('jf', 'desk-tok-r', true);
    const n = minted('jf');
    await R.cast.start(await R.rows('dlna'), { itemIds: ['movie-0'], msid: 'movie-0-1080' });
    assert.equal(R.cast.state?.status, 'playing');
    assert.equal((await dlnaState()).fetched.tokenInUrl, false, 'relay: no token in the URL');
    await noUserToken(R.user);
    assert.equal(minted('jf'), n, 'relay: no Quick Connect');
    await R.cast.stop();
    R.quit();
    A.quit();
    console.log('ok relay on: nothing minted');
  }

  // ---- AC 3: a crash mid-cast; the next start revokes the leftover ----
  {
    const A = await desktop('jf', 'desk-tok-crash', false);
    await A.cast.start(await A.rows('dlna'), { itemIds: ['movie-0'], msid: 'movie-0-1080' });
    assert.equal(A.cast.state?.status, 'playing');
    const tok = new URL((await dlnaState()).uri).searchParams.get('ApiKey');
    // The process dies: its timers stop, nothing reaches the server.
    A.cast.direct.finish();
    for (const c of A.m.conns.values()) c.socket?.close();
    assert.equal(await status('jf', tok), 200, 'the leftover is still valid after the crash');
    assert.equal(A.tokens.list().length, 1, 'and still in the vault');
    const B = await desktop('jf', 'desk-tok-crash', false);
    await until(async () => (await status('jf', tok)) === 401, 3000, 'the next start revokes it');
    await until(() => B.tokens.list().length === 0, 2000, 'and drops it from the vault');
    B.quit();
    console.log('ok AC3 crash: the next start revokes the leftover sender token');
  }

  // ---- AC 1 + 3: the Jellyfin receiver ----
  {
    const J = await desktop('jf', 'desk-tok-rx', true);
    await J.cast.start(await J.rows('cast'), { itemIds: ['movie-0'] });
    assert.equal(J.cast.state?.status, 'playing', `casting to the receiver (${JSON.stringify(J.toasts)})`);
    const play = (await castState()).connectsdk.findLast((x) => x.command === 'PlayNow');
    const tok = play.accessToken;
    assert.ok(tok && tok !== J.user, 'AC 1: the receiver gets a disposable accessToken');
    assert.equal(await status('jf', tok), 200, 'which the server accepts');
    const [entry] = J.tokens.list();
    assert.equal(entry?.kind, 'receiver');
    // The sender quits: the receiver plays on with its token.
    J.quit();
    assert.equal(await status('jf', tok), 200, 'a sender quit keeps the receiver token');
    const B = await desktop('jf', 'desk-tok-rx', true);
    await B.cast.cleanupTokens();
    assert.equal(await status('jf', tok), 200, 'its session is listed: the cleanup keeps it');
    assert.equal(B.tokens.list().length, 1);
    // The receiver goes away; the first cleanup after that revokes it.
    assert.equal((await json(`${root('jf')}/Mock/Sessions/Drop?deviceId=${entry.deviceId}`, { method: 'POST' })).dropped, 1);
    await B.cast.cleanupTokens();
    assert.equal(await status('jf', tok), 401, 'session gone: revoked');
    assert.deepEqual(B.tokens.list(), []);
    // "Arrêter la diffusion" revokes at once.
    await B.cast.start(await B.rows('cast'), { itemIds: ['movie-0'] });
    assert.equal(B.cast.state?.status, 'playing');
    const tok2 = (await castState()).connectsdk.findLast((x) => x.command === 'PlayNow').accessToken;
    assert.ok(tok2 && tok2 !== tok && tok2 !== B.user);
    await B.cast.stop();
    await until(async () => (await status('jf', tok2)) === 401, 2000, 'Stop revokes the receiver token');
    await until(() => B.tokens.list().length === 0, 2000, 'and drops it from the vault');
    B.quit();
    console.log('ok AC1/AC3 Jellyfin receiver: disposable accessToken, kept over a sender quit, revoked once its session is gone or on Stop');
  }

  // ---- AC 2: Quick Connect off -> the user token, no error ----
  {
    const N = await desktop('noqc', 'desk-tok-noqc', false);
    await N.cast.start(await N.rows('dlna'), { itemIds: ['movie-0'], msid: 'movie-0-1080' });
    assert.equal(N.cast.state?.status, 'playing', `casting without Quick Connect (${JSON.stringify(N.toasts)})`);
    const d = await dlnaState();
    assert.equal(new URL(d.uri).searchParams.get('ApiKey'), N.user, 'AC 2: the user token as ApiKey (§2.6.3)');
    assert.ok([200, 206].includes(d.fetched.status));
    await N.cast.stop();
    await N.cast.start(await N.rows('cast'), { itemIds: ['movie-0'] });
    assert.equal(N.cast.state?.status, 'playing');
    assert.equal((await castState()).connectsdk.findLast((x) => x.command === 'PlayNow').accessToken, N.user, 'AC 2: the receiver gets the user token');
    await N.cast.stop();
    assert.ok(!N.toasts.some((x) => x.kind === 'error'), `no error (${JSON.stringify(N.toasts)})`);
    assert.deepEqual(N.tokens.list(), [], 'nothing kept');
    assert.equal(minted('noqc'), 0);
    N.quit();
    console.log('ok AC2 Quick Connect off: user token, no error');
  }
  assert.ok(!mocks.some((x) => x.log.some((l) => /GUARD|REFUSED/.test(l))), 'no mock tried to leave loopback');
} finally {
  for (const c of children) c.kill();
}

// Wiring: index.ts gives the manager the vault-backed tokens and cleans up on session changes.
{
  const index = fs.readFileSync(path.join(repo, 'apps/desktop/src/main/index.ts'), 'utf8');
  assert.match(index, /tokens: new EphemeralTokens\(vault, identity\.version\)/);
  assert.match(index, /connection\.on\('session', \(\) => void cast\.cleanupTokens\(\)\)/);
}
console.log(`cast-token-check: OK (${((Date.now() - T0) / 1000).toFixed(1)} s)`);
process.exit(0);
