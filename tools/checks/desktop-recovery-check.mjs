// Desktop network recovery (package R-B; plezy-triage WP9, WP2 desktop half, WP5 desktop half).
//   1  StreamRecovery (main/playback/stream-recovery.ts) with a fake host: stall, early EOF and stream errors
//      reopen at the position with backoff; Retry after the delay; give up; one transcode retry per item when
//      direct play fails to open while the server answers; reset on stop.
//   2  ConnectionManager.recheck() on a fake network: the LAN address goes away, the session moves to the
//      vouched https remote address with its token; a network change brings it back to the LAN; a server
//      unreachable at startup is selected once it answers; an address the token is not bound to is never used.
//   3  Against tools/mock-server/mock-emby.mjs (loopback only) and its failure toggles: /Mock/Stream/Fail
//      (503, drop mid-stream) and /Mock/Down. A fake player reads the stream through the real ApiClient: a cut
//      stream is reopened at its byte position, a 503 at open falls back to the transcode URL, a server that
//      is down holds the recovery until it is back.
// Usage: node tools/checks/desktop-recovery-check.mjs [--verbose]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import netMod from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const VERBOSE = process.argv.includes('--verbose');
const repo = path.resolve(import.meta.dirname, '..', '..');
const desktop = path.join(repo, 'apps', 'desktop', 'src', 'main');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-recovery-'));
const fwd = (p) => p.replace(/\\/g, '/');
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `export { StreamRecovery } from '${fwd(path.join(desktop, 'playback/stream-recovery.ts'))}';
export { ConnectionManager } from '${fwd(path.join(desktop, 'connection/connection-manager.ts'))}';
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
const { StreamRecovery, ConnectionManager } = await import(pathToFileURL(out).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000, what = 'condition') {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    if (VERBOSE) console.log(`ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL ${name}: ${err.stack ?? err}`);
  }
}

// ---------------------------------------------------------------- 1. StreamRecovery, fake host
// Short timings: the logic is the same, the run takes a second.
Object.assign(StreamRecovery, { backoffMs: [20, 40], retryAfterMs: 150, giveUpMs: 400, stallMs: 100, maxOpenFailures: 3 });

function fakeHost({ up = true, direct = true, reload } = {}) {
  const h = {
    up,
    target: { id: 'item-1', direct },
    active: true,
    reloads: [],
    fails: [],
    notices: [],
    publishes: 0,
    rec: null,
  };
  h.rec = new StreamRecovery({
    target: () => (h.active ? h.target : null),
    itemId: (t) => t.id,
    direct: (t) => t.direct,
    reachable: async () => h.up,
    reload: async (t) => {
      h.reloads.push({ transcode: h.rec.transcodes(t.id) });
      h.rec.onLoad(t.id, 60_000);
      if (reload) await reload(h);
    },
    fail: (m) => {
      h.fails.push(m);
      h.active = false;
      h.rec.reset();
    },
    publish: () => h.publishes++,
    notice: (k) => h.notices.push(k),
    log: (m) => VERBOSE && console.log(`    [recovery] ${m}`),
  });
  h.rec.onLoad('item-1', 0);
  return h;
}

await check('a stall reopens at the position and the banner clears once frames flow', async () => {
  const h = fakeHost();
  h.rec.onStarted();
  const t0 = Date.now();
  h.rec.onTime({ positionMs: 60_000, buffering: true, cacheBytes: 100 });
  h.rec.tick(true, t0 + 50);
  assert.equal(h.reloads.length, 0, 'no reload before stallMs');
  h.rec.tick(true, t0 + 200);
  await until(() => h.reloads.length === 1, 1000, 'reload after a stall');
  assert.ok(h.rec.state, 'reconnecting while the reload is pending');
  assert.equal(h.reloads[0].transcode, false, 'a stall never switches to a transcode');
  h.rec.onTime({ positionMs: 61_000, buffering: false });
  assert.equal(h.rec.state, undefined, 'the banner clears on progress');
  assert.deepEqual(h.fails, []);
});

await check('cache still moving is not a stall', async () => {
  const h = fakeHost();
  h.rec.onStarted();
  for (let i = 0; i < 5; i++) {
    h.rec.onTime({ positionMs: 60_000, buffering: true, cacheBytes: 100 + i });
    h.rec.tick(true);
    await sleep(40);
  }
  assert.equal(h.reloads.length, 0);
});

await check('direct play that fails to open while the server answers: one transcode retry, then a failure', async () => {
  const h = fakeHost();
  await h.rec.onFailure('loading failed', 'error');
  assert.deepEqual(h.reloads, [{ transcode: true }]);
  assert.deepEqual(h.notices, ['player.notice.transcodeFallback']);
  assert.equal(h.rec.state, undefined, 'a fallback is not a reconnection');
  await h.rec.onFailure('loading failed', 'error');
  assert.equal(h.reloads.length, 1, 'only one fallback per item');
  assert.deepEqual(h.fails, ['loading failed']);
});

await check('a decode failure after start also falls back once; a transcode that fails to open fails', async () => {
  const h = fakeHost();
  h.rec.onStarted();
  await h.rec.onFailure('audio output initialization failed', 'decode');
  assert.deepEqual(h.reloads, [{ transcode: true }]);
  const t = fakeHost({ direct: false });
  await t.rec.onFailure('loading failed', 'error');
  assert.equal(t.reloads.length, 0);
  assert.deepEqual(t.fails, ['loading failed']);
});

await check('the fallback is per item: another item plays directly again', async () => {
  const h = fakeHost();
  await h.rec.onFailure('loading failed', 'error');
  assert.ok(h.rec.transcodes('item-1'));
  h.rec.onLoad('item-2', 0);
  assert.equal(h.rec.transcodes('item-1'), false);
  assert.equal(h.rec.transcodes('item-2'), false);
});

await check('server down mid-stream: backoff, Retry after the delay, then give up', async () => {
  const h = fakeHost({ up: false });
  h.rec.onStarted();
  await h.rec.onFailure('', 'early-eof');
  assert.ok(h.rec.state && !h.rec.state.retry, 'reconnecting, no Retry yet');
  await sleep(200);
  assert.equal(h.rec.state?.retry, true, 'Retry offered after retryAfterMs');
  assert.ok(h.publishes >= 2, 'the Retry flag was published');
  assert.equal(h.reloads.length, 0, 'never reloads while the server is unreachable');
  await until(() => h.fails.length === 1, 1500, 'give up');
  assert.equal(h.rec.state, undefined);
});

await check('server back: the reload happens and Retry forces an attempt now', async () => {
  const h = fakeHost({ up: false });
  h.rec.onStarted();
  await h.rec.onFailure('', 'stall');
  await sleep(60);
  h.up = true;
  h.rec.retry();
  await until(() => h.reloads.length === 1, 500, 'reload after Retry');
  h.rec.onStarted();
  assert.equal(h.rec.state, undefined);
  assert.deepEqual(h.fails, []);
});

await check('a reopen that keeps failing while the server answers stops after maxOpenFailures', async () => {
  const h = fakeHost({ reload: async () => Promise.reject(new Error('PlaybackInfo 500')) });
  h.rec.onStarted();
  await h.rec.onFailure('', 'early-eof');
  await until(() => h.fails.length === 1, 1500, 'failure');
  assert.equal(h.reloads.length, 3);
  assert.deepEqual(h.fails, ['PlaybackInfo 500']);
});

await check('stop (reset) during a reconnection cancels it', async () => {
  const h = fakeHost({ up: false });
  h.rec.onStarted();
  await h.rec.onFailure('', 'stall');
  h.active = false;
  h.rec.reset();
  h.up = true;
  await sleep(150);
  assert.equal(h.reloads.length, 0);
  assert.equal(h.rec.state, undefined);
  assert.deepEqual(h.fails, []);
});

await check('nothing to recover (live, local file, idle): the failure is final', async () => {
  const h = fakeHost();
  h.active = false;
  await h.rec.onFailure('mpv error', 'error');
  assert.deepEqual(h.fails, ['mpv error']);
  assert.equal(h.reloads.length, 0);
});

await check('a file that fails again right after every reopen (truncated, corrupt) ends after maxOpenFailures relapses', async () => {
  // Each reopen plays a moment then hits the early EOF again: without a cap this cycles forever.
  const h = fakeHost({ reload: async (x) => (x.rec.onStarted(), setTimeout(() => void x.rec.onFailure('', 'early-eof'), 5)) });
  h.rec.onStarted();
  await h.rec.onFailure('', 'early-eof');
  await until(() => h.fails.length === 1, 2000, 'give up on the relapsing file');
  await sleep(200);
  assert.equal(h.reloads.length, 3, 'bounded reopens');
  assert.equal(h.fails.length, 1);
});

await check('a loss long after the stream came back is a fresh recovery, not a relapse', async () => {
  const saved = StreamRecovery.relapseMs;
  StreamRecovery.relapseMs = 30;
  try {
    const h = fakeHost();
    h.rec.onStarted();
    for (let i = 0; i < 4; i++) {
      await h.rec.onFailure('', 'early-eof');
      await until(() => h.reloads.length === i + 1, 500, `reload ${i + 1}`);
      h.rec.onStarted();
      await sleep(50);
    }
    assert.deepEqual(h.fails, []);
  } finally {
    StreamRecovery.relapseMs = saved;
  }
});

await check('a slow first frame (server transcode warming up) is not a stall', async () => {
  const h = fakeHost();
  const t0 = Date.now();
  for (let i = 1; i <= 5; i++) h.rec.tick(true, t0 + i * 200);
  await sleep(50);
  assert.equal(h.reloads.length, 0);
  assert.equal(h.rec.state, undefined);
  // Started, then stuck: that one is a stall.
  h.rec.onStarted();
  h.rec.tick(true, t0 + 1200);
  h.rec.tick(true, t0 + 1400);
  await until(() => h.reloads.length === 1, 1000, 'reload after a real stall');
  // The reopen itself waiting on the server is not counted against it either.
  for (let i = 1; i <= 5; i++) h.rec.tick(true, t0 + 1400 + i * 200);
  await sleep(50);
  assert.equal(h.reloads.length, 1);
  assert.deepEqual(h.fails, []);
});

// ---------------------------------------------------------------- 2. ConnectionManager.recheck, fake network
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
// Sockets: a stand-in that never connects (part 3 swaps in Node's own).
const NodeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class {
  static OPEN = 1;
  readyState = 0;
  addEventListener() {}
  send() {}
  close() {}
};

const fakeNet = new Map();
const seen = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fakeFetch = async (url, init = {}) => {
  const u = new URL(url);
  const token = (init.headers ?? {})['X-Emby-Token'];
  seen.push({ origin: u.origin, path: u.pathname, token });
  const host = fakeNet.get(u.origin);
  if (!host) throw new TypeError('fetch failed');
  if (host.delay) await sleep(host.delay);
  const p = u.pathname;
  if (p === '/emby/System/Info/Public') return json({ Id: host.id, ServerName: 'Home', Version: '4.9', ProductName: 'Emby Server', LocalAddress: host.local, WanAddress: host.wan });
  if (p.startsWith('/emby/Users/')) return host.tokens.includes(token) ? json({ Id: 'u1', Name: 'me' }) : json({}, 401);
  if (p === '/emby/Sessions/Capabilities/Full') return new Response(null, { status: 204 });
  return json({}, 404);
};
globalThis.__fakeFetch = fakeFetch;

const LAN = 'http://192.0.2.10:8096';
const WAN = 'https://home.example.test';
const STRANGER = 'http://198.51.100.7:8096';
const TOKEN = 'tok-1';

function managerFor(doc, cred) {
  const file = path.join(tmp, `servers-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ tokenBinding: 1, ...doc }));
  const vault = new FakeVault();
  vault.entries['server:X'] = cred;
  return new ConnectionManager(file, vault, identity);
}
const sessionOf = (m) => m.session.sessions.find((s) => s.server.id === 'X');

await check('LAN gone: the session moves to the vouched remote address, token included', async () => {
  fakeNet.clear();
  fakeNet.set(LAN, { id: 'X', tokens: [TOKEN], local: LAN, wan: WAN });
  fakeNet.set(WAN, { id: 'X', tokens: [TOKEN], delay: 30 });
  const m = managerFor(
    { servers: [{ id: 'X', name: 'Home', kind: 'emby', version: '4.9', lastAddress: LAN, remoteAddress: WAN }], activeId: 'X', activeIds: ['X'] },
    { userId: 'u1', userName: 'me', token: TOKEN, origins: [LAN], vouched: [WAN] },
  );
  await m.select('X');
  assert.equal(sessionOf(m).status, 'signed-in');
  assert.equal(m.apiFor('X').address, LAN);
  assert.equal(await m.recheck('X'), true, 'LAN answers');
  fakeNet.delete(LAN);
  assert.equal(await m.recheck('X'), true, 'reachable through WAN');
  assert.equal(m.apiFor('X').address, WAN);
  assert.equal(sessionOf(m).status, 'signed-in');
  assert.equal(sessionOf(m).address, WAN);
  assert.equal(m.list()[0].lastAddress, WAN);
  // Home again: a network change (moved) re-races and the LAN wins (WAN is slower).
  fakeNet.set(LAN, { id: 'X', tokens: [TOKEN] });
  await m.recheckAll(true);
  assert.equal(m.apiFor('X').address, LAN);
  // Without a network change, a healthy session is not even probed.
  seen.length = 0;
  await m.recheckAll(false);
  assert.equal(seen.length, 0);
  m.disconnect();
});

await check('nothing answers: false, and the session keeps its state (no sign-out, no move)', async () => {
  fakeNet.clear();
  fakeNet.set(LAN, { id: 'X', tokens: [TOKEN] });
  const m = managerFor(
    { servers: [{ id: 'X', name: 'Home', kind: 'emby', version: '4.9', lastAddress: LAN, remoteAddress: WAN }], activeId: 'X', activeIds: ['X'] },
    { userId: 'u1', userName: 'me', token: TOKEN, origins: [LAN], vouched: [WAN] },
  );
  await m.select('X');
  fakeNet.clear();
  assert.equal(await m.recheck('X'), false);
  assert.equal(sessionOf(m).status, 'signed-in');
  assert.equal(m.apiFor('X').address, LAN);
  m.disconnect();
});

await check('the token never moves to an address it is not bound to', async () => {
  fakeNet.clear();
  fakeNet.set(LAN, { id: 'X', tokens: [TOKEN] });
  const m = managerFor(
    { servers: [{ id: 'X', name: 'Home', kind: 'emby', version: '4.9', lastAddress: LAN, extraAddresses: [STRANGER] }], activeId: 'X', activeIds: ['X'] },
    { userId: 'u1', userName: 'me', token: TOKEN, origins: [LAN] },
  );
  await m.select('X');
  fakeNet.delete(LAN);
  fakeNet.set(STRANGER, { id: 'X', tokens: [TOKEN] });
  seen.length = 0;
  assert.equal(await m.recheck('X'), false);
  assert.equal(m.apiFor('X').address, LAN);
  assert.deepEqual(seen.filter((r) => r.origin === STRANGER && r.token), [], 'token sent to an unbound address');
  m.disconnect();
});

await check('unreachable at startup: selected once it answers', async () => {
  fakeNet.clear();
  const m = managerFor(
    { servers: [{ id: 'X', name: 'Home', kind: 'emby', version: '4.9', lastAddress: LAN }], activeId: 'X', activeIds: ['X'] },
    { userId: 'u1', userName: 'me', token: TOKEN, origins: [LAN] },
  );
  await m.resumeLastSession();
  assert.equal(sessionOf(m).status, 'offline');
  await m.recheckAll(false);
  assert.equal(sessionOf(m).status, 'offline', 'still down');
  fakeNet.set(LAN, { id: 'X', tokens: [TOKEN] });
  await m.recheckAll(false);
  assert.equal(sessionOf(m).status, 'signed-in');
  m.disconnect();
});

await check('a servers file reduced to {} or corrupt starts empty; a corrupt one is kept aside, a failed write does not throw', async () => {
  for (const text of ['{}', '{"servers": [', 'null']) {
    const file = path.join(tmp, `servers-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, text);
    const m = new ConnectionManager(file, new FakeVault(), identity);
    assert.deepEqual(m.session.sessions, [], text);
    const aside = fs.readdirSync(tmp).filter((f) => f.startsWith(`${path.basename(file)}.corrupt-`));
    assert.equal(aside.length, text === '{}' ? 0 : 1, `${text}: kept aside`);
    if (aside.length) assert.equal(fs.readFileSync(path.join(tmp, aside[0]), 'utf8'), text);
    m.flush();
    // A directory where the file goes: the write fails, logged and retried later, never thrown at the caller.
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
    fs.mkdirSync(path.join(file, 'x'));
    m.flush();
    fs.rmSync(file, { recursive: true });
  }
});

// ---------------------------------------------------------------- 3. Against mock-emby and its failure toggles
StreamRecovery.giveUpMs = 10_000;
const LOOPBACK = '127.0.0.1';
const loopbackOnly = (url) => {
  const host = new URL(url).hostname;
  if (host !== LOOPBACK) throw new Error(`refusing ${url}: this check only talks to ${LOOPBACK}`);
};
for (const bad of ['http://192.0.2.10:8096/', 'http://192.0.2.20/', 'http://localhost:1/']) assert.throws(() => loopbackOnly(bad));
const BOOT = `data:text/javascript,${encodeURIComponent(
  "import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'&&(a.length===1||typeof a[1]==='function'))a.splice(1,0,'127.0.0.1');return l.apply(this,a)};",
)}`;
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = netMod.createServer();
    s.once('error', reject);
    s.listen(0, LOOPBACK, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const video = path.join(tmp, 'video.mkv');
const VIDEO_BYTES = 512 * 1024;
fs.writeFileSync(video, crypto.randomBytes(VIDEO_BYTES));
const port = await freePort();
const child = spawn(process.execPath, ['--import', BOOT, path.join(repo, 'tools/mock-server/mock-emby.mjs'), String(port), video], {
  cwd: repo,
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MOCK_'))),
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
process.on('exit', () => child.kill());
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('mock-emby not listening after 10 s')), 10_000);
  const onData = (d) => {
    for (const line of String(d).split(/\r?\n/).filter(Boolean)) {
      if (VERBOSE) console.log(`  [mock] ${line}`);
      if (/^Mock Emby/.test(line)) (clearTimeout(timer), resolve());
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.once('exit', (code) => (clearTimeout(timer), reject(new Error(`mock-emby exited with ${code}`))));
});
const ROOT = `http://${LOOPBACK}:${port}`;
globalThis.__fakeFetch = (url, init) => {
  loopbackOnly(String(url));
  return fetch(url, init);
};
globalThis.WebSocket = NodeWebSocket;
const toggle = async (q) => {
  const r = await fetch(`${ROOT}/emby/Mock/${q}`);
  assert.equal(r.status, 200, q);
};

// A player stand-in: reads the stream from a byte offset, as mpv reopening at a position would.
class FakePlayer {
  received = 0;
  started = false;
  async play(api, transcode, rec) {
    const info = await api.post(`/Items/movie-1/PlaybackInfo`, { UserId: api.userId }, { EnableDirectPlay: !transcode, EnableDirectStream: !transcode, MaxStreamingBitrate: 1e9 });
    const ps = info.MediaSources[0];
    const url = ps.SupportsDirectPlay && !transcode ? api.url('/Videos/movie-1/stream', { Static: true, MediaSourceId: ps.Id }) : `${api.address}${api.prefix}${ps.TranscodingUrl}`;
    this.lastUrl = url;
    this.started = false;
    rec.onLoad('movie-1', this.received);
    void this.read(url, api, rec);
  }
  async read(url, api, rec) {
    const from = this.received;
    let res;
    try {
      res = await fetch(url, { headers: { 'X-Emby-Token': api.token, ...(from ? { Range: `bytes=${from}-` } : {}) } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for await (const chunk of res.body) {
        this.received += chunk.length;
        if (!this.started) (this.started = true), rec.onStarted();
      }
    } catch (err) {
      return void rec.onFailure(String(err.message ?? err), 'error');
    }
    // A cut that reads as a clean end: early EOF, as mpv reports a dropped HTTP stream.
    if (this.received < VIDEO_BYTES) return void rec.onFailure('', 'early-eof');
    this.done = true;
  }
}

async function mockSession() {
  const m = new ConnectionManager(path.join(tmp, `mock-${crypto.randomUUID()}.json`), new FakeVault(), identity);
  const info = await m.add(ROOT);
  await m.select(info.id);
  await m.login('wika', 'wicaby', info.id);
  assert.equal(m.session.status, 'signed-in');
  return { m, id: info.id };
}

function harness(m, id) {
  const player = new FakePlayer();
  const h = { fails: [], notices: [], reloads: 0 };
  h.rec = new StreamRecovery({
    target: () => (player.done || h.fails.length ? null : { id: 'movie-1', direct: !h.rec.transcodes('movie-1') }),
    itemId: (t) => t.id,
    direct: (t) => t.direct,
    reachable: () => m.recheck(id),
    reload: async () => {
      h.reloads++;
      await player.play(m.apiFor(id), h.rec.transcodes('movie-1'), h.rec);
    },
    fail: (msg) => h.fails.push(msg),
    publish: () => {},
    notice: (k) => h.notices.push(k),
    log: (msg) => VERBOSE && console.log(`    [recovery] ${msg}`),
  });
  h.player = player;
  return h;
}

await check('mock: a stream cut mid-way is reopened at its byte position and completes', async () => {
  const { m, id } = await mockSession();
  const h = harness(m, id);
  await toggle('Stream/Fail?mode=drop&count=1&after=131072');
  await h.player.play(m.apiFor(id), false, h.rec);
  await until(() => h.player.done || h.fails.length, 8000, 'stream complete');
  assert.deepEqual(h.fails, []);
  assert.equal(h.reloads, 1, 'one reopen');
  assert.equal(h.player.received, VIDEO_BYTES, 'every byte, no gap or overlap');
  assert.equal(h.rec.transcodes('movie-1'), false, 'a network cut keeps direct play');
  assert.equal(h.rec.state, undefined);
  m.disconnect();
});

await check('mock: 503 at open in direct play falls back to the transcode URL once', async () => {
  const { m, id } = await mockSession();
  const h = harness(m, id);
  await toggle('Stream/Fail?mode=503&count=1');
  await h.player.play(m.apiFor(id), false, h.rec);
  await until(() => h.player.done || h.fails.length, 8000, 'stream complete');
  assert.deepEqual(h.fails, []);
  assert.deepEqual(h.notices, ['player.notice.transcodeFallback']);
  assert.match(h.player.lastUrl, /VideoCodec=h264/, 'the reopen used the TranscodingUrl');
  m.disconnect();
});

await check('mock: server down mid-stream holds the reconnection until it is back', async () => {
  const { m, id } = await mockSession();
  const h = harness(m, id);
  // Cut at 64 KiB while the server is down (/Mock/Down answers 503 everywhere, /System/Info/Public included).
  h.rec.onLoad('movie-1', 0);
  h.player.received = 65536;
  h.player.started = true;
  h.rec.onStarted();
  await toggle('Down?on=1');
  await h.rec.onFailure('', 'early-eof');
  assert.ok(h.rec.state, 'reconnecting');
  await sleep(150);
  assert.equal(h.reloads, 0, 'no reopen while the server answers 503');
  assert.equal(await m.recheck(id), false, 'recheck sees the server down');
  await toggle('Down?on=0');
  await until(() => h.player.done || h.fails.length, 8000, 'stream complete after the server came back');
  assert.deepEqual(h.fails, []);
  assert.ok(h.reloads >= 1);
  assert.equal(h.player.received, VIDEO_BYTES);
  assert.equal(h.rec.state, undefined);
  m.disconnect();
});

// ---------------------------------------------------------------- 4. Wiring in the app
await check('wiring: players, service, OSD, network watch', async () => {
  const src = (p) => fs.readFileSync(path.join(repo, 'apps/desktop/src', p), 'utf8');
  const service = src('main/playback/playback-service.ts');
  assert.match(service, /player\.on\('failure', \(message: string, kind\?: 'stream' \| 'decode'\)[\s\S]*?this\.recovery\.onFailure\(message/, 'player failures go through recovery');
  assert.match(service, /'early-eof'/, 'early EOF in direct play is a lost stream');
  assert.match(service, /this\.recovery\.transcodes\(item\.Id\)/, 'startItem honours the transcode fallback');
  assert.match(service, /reconnect-retry'\) return this\.recovery\.retry\(\)/, 'Retry command');
  assert.match(service, /this\.recovery\.reset\(\);\s*this\.zap\.stop\(\)/, 'stop() cancels a reconnection');
  assert.match(service, /deps\.connection\.recheck\(/, 'reachability re-picks the address');
  assert.match(service, /player\.on\('decode-failure'[\s\S]{0,200}?c && !c\.live && !c\.offline && !c\.local && c\.playMethod !== 'Transcode'/, 'decode-failure leaves live TV and local files alone');
  const mpv = src('main/playback/mpv-player.ts');
  assert.match(mpv, /this\.emit\('failure', [^;]*, kind\)/, 'mpv end-file errors carry their kind');
  assert.match(mpv, /if \(!spdif\) return void this\.emit\('decode-failure'/, 'non-passthrough ao failure asks for the fallback');
  assert.doesNotMatch(mpv, /mpvExited'\), '?(stream|decode)/, 'mpv dying is not a stream failure');
  assert.match(src('main/playback/html-player.ts'), /this\.emit\('failure', ev\.message, 'stream'\)/);
  const osd = src('renderer/components/Osd.svelte');
  assert.match(osd, /s\?\.reconnecting && s\.active[\s\S]*?player\.reconnect\.title[\s\S]*?s\.reconnecting\.retry[\s\S]*?type: 'reconnect-retry'/, 'OSD banner and Retry');
  assert.match(src('main/index.ts'), /watchNetwork\(\(moved\) => void connection\.recheckAll\(moved\)\)/, 'network watch wired');
  assert.match(src('main/connection/network-watch.ts'), /powerMonitor\.on\('resume'/);
  assert.match(src('main/connection/connection-manager.ts'), /reportFailure\(server\.id\)\.then\(\(\) => this\.recheck\(server\.id\)\)/, 'socket drop re-picks the address');
  assert.match(src('renderer/lib/stores.svelte.ts'), /if \(back\) \{\s*librariesKey = '';\s*dataVersion\.userData\+\+;\s*dataVersion\.library\+\+;/, 'data refresh after a reconnect');
});

child.kill();
console.log(`desktop-recovery-check: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
