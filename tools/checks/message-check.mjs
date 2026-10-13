// Admin messages (Dashboard "Envoyer un message", POST /Sessions/{id}/Message) reach a Wicaby session in every state.
//
//   1  server side, both mocks: the Dashboard's request (MessageCommand in the query and the body) reaches the
//      receiver's socket while it is idle and while it plays; Jellyfin reads the body only (a query-only send is a 400);
//   2  desktop receiver (playback/remote-commands.ts handleRemote): DisplayMessage is left to index.ts, which shows
//      it, idle or playing, with "Autoriser le contrôle à distance" on or off; DisplayContent stays dropped while off;
//   3  desktop display: the OSD window mounts the toasts (main is hidden while mpv plays), and index.ts keeps the
//      sender's TimeoutMs;
//   4  Android: no "player only" or "remote control off" gate drops DisplayMessage (RemoteControl.kt; the behaviour
//      itself is RemoteControlTest), and the capabilities still list it with remote control off (Emby.kt).
// The on-screen proof through Electron is message-cdp.mjs (not in run-all: needs mpv and a video).
// Loopback only. Usage: node tools/checks/message-check.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(import.meta.dirname, '..', '..');
const LOOPBACK = '127.0.0.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

// ---- 1. Server side, both mocks.
const BOOT = `data:text/javascript,${encodeURIComponent(
  "import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'&&(a.length===1||typeof a[1]==='function'))a.splice(1,0,'127.0.0.1');return l.apply(this,a)};",
)}`;
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, LOOPBACK, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const children = new Set();
process.on('exit', () => children.forEach((c) => c.kill()));

async function startMock(kind) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', BOOT, path.join(repo, 'tools/mock-server', `mock-${kind}.mjs`), String(port)], {
    cwd: repo,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MOCK_'))),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${kind}: not listening after 10 s`)), 10_000);
    child.stdout.on('data', (d) => /^Mock (Emby|Jellyfin)/m.test(String(d)) && (clearTimeout(timer), resolve()));
    child.once('exit', (code) => (clearTimeout(timer), reject(new Error(`${kind}: exited with ${code}`))));
  });
  return { kind, port, base: `http://${LOOPBACK}:${port}${kind === 'emby' ? '/emby' : ''}` };
}

async function call(url, { method = 'GET', headers = {}, query, body } = {}) {
  const u = new URL(url);
  assert.equal(u.hostname, LOOPBACK);
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
  const res = await fetch(u, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null };
}

async function signIn(m, deviceId) {
  const fields = `Client="Wicaby checks", Device="${deviceId}", DeviceId="${deviceId}", Version="1.0.0"`;
  const auth = m.kind === 'emby' ? { 'X-Emby-Authorization': `Emby ${fields}` } : { Authorization: `MediaBrowser ${fields}` };
  const r = await call(`${m.base}/Users/AuthenticateByName`, { method: 'POST', headers: auth, body: { Username: 'Wika', Pw: 'wicaby' } });
  assert.equal(r.status, 200, `${m.kind}: sign-in`);
  const token = r.json.AccessToken;
  const headers = m.kind === 'emby' ? { ...auth, 'X-Emby-Token': token } : { Authorization: `MediaBrowser ${fields}, Token="${token}"` };
  return { token, deviceId, req: (method, p, o = {}) => call(`${m.base}${p}`, { method, headers, ...o }) };
}

for (const kind of ['emby', 'jellyfin']) {
  const m = await startMock(kind);
  const admin = await signIn(m, 'msg-admin');
  const rx = await signIn(m, 'msg-receiver');
  // As the apps do: capabilities (Wicaby's list with remote control off), then the socket.
  assert.equal((await rx.req('POST', '/Sessions/Capabilities/Full', { body: { PlayableMediaTypes: ['Audio', 'Video'], SupportedCommands: ['DisplayMessage'], SupportsMediaControl: false } })).status, 204);
  const ws = new WebSocket(`ws://${LOOPBACK}:${m.port}/${kind === 'emby' ? 'embywebsocket?api_key' : 'socket?ApiKey'}=${rx.token}&deviceId=${rx.deviceId}`);
  const frames = [];
  ws.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data))));
  await new Promise((res, rej) => (ws.addEventListener('open', res), ws.addEventListener('error', () => rej(new Error(`${kind}: socket`)))));
  const id = (await admin.req('GET', '/Sessions', { query: { DeviceId: rx.deviceId } })).json.find((s) => s.DeviceId === rx.deviceId)?.Id;
  assert.ok(id, `${kind}: the receiver is listed`);
  // Dashboard.svelte sendMessage: the same MessageCommand in the query (Emby) and the body (Jellyfin).
  const sendMessage = async (Text, { query = true, body = true } = {}) => {
    const cmd = { Header: 'Admin', Text, TimeoutMs: 10000 };
    const r = await admin.req('POST', `/Sessions/${id}/Message`, { query: query ? cmd : undefined, body: body ? cmd : undefined });
    for (let i = 0; i < 50 && !frames.some((f) => f.Data?.Arguments?.Text === Text); i++) await sleep(20);
    return { status: r.status, frame: frames.find((f) => f.Data?.Arguments?.Text === Text) };
  };
  const idle = await sendMessage('idle');
  assert.equal(idle.status, 204, `${kind}: idle send`);
  assert.equal(idle.frame?.MessageType, 'GeneralCommand', `${kind}: an idle session gets the message`);
  assert.equal(idle.frame.Data.Name, 'DisplayMessage');
  assert.equal(idle.frame.Data.Arguments.Header, 'Admin');
  await rx.req('POST', '/Sessions/Playing', { body: { ItemId: 'movie-1', MediaSourceId: 'movie-1', PlaySessionId: 'ps-msg', PlayMethod: 'DirectPlay' } });
  assert.ok((await sendMessage('playing')).frame, `${kind}: a playing session gets the message`);
  const queryOnly = await sendMessage('query only', { body: false });
  if (kind === 'jellyfin') assert.equal(queryOnly.status, 400, 'jellyfin reads the MessageCommand from the body only');
  else assert.ok(queryOnly.frame, 'emby reads the query');
  ws.close();
}

// ---- 2. Desktop receiver: handleRemote.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-msg-'));
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(entry, `export { handleRemote } from '${path.join(repo, 'apps/desktop/src/main/playback/remote-commands.ts').replace(/\\/g, '/')}';\n`);
const out = path.join(tmp, 'bundle.mjs');
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export const app = { isReady: () => false, isPackaged: true, getLocale: () => 'fr' }; export const net = {}; export const safeStorage = {};` }));
  },
};
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [electronStub] });
const { handleRemote } = await import(pathToFileURL(out).href);
fs.rmSync(tmp, { recursive: true, force: true });
const cmds = [];
const target = (active) => ({ play: async () => cmds.push('play'), command: async (c) => cmds.push(c.type), getState: () => ({ active, volume: 50, muted: false }) });
const general = (Name, Arguments) => ({ MessageType: 'GeneralCommand', Data: { Name, Arguments } });
for (const allowControl of [true, false]) {
  const settings = { value: { remote: { allowControl }, playback: { seekShortS: 10 } } };
  for (const active of [false, true]) {
    // false: not swallowed here, index.ts shows it.
    assert.equal(handleRemote(target(active), settings, general('DisplayMessage', { Header: 'Admin', Text: 'hi' }), 'srv'), false, `DisplayMessage swallowed (control ${allowControl}, playing ${active})`);
    assert.equal(handleRemote(target(active), settings, general('displaymessage', { Text: 'hi' }), 'srv'), false, 'names compare case-insensitively');
  }
  assert.equal(handleRemote(target(false), settings, general('DisplayContent', { ItemId: '12345' }), 'srv'), !allowControl, 'DisplayContent: index.ts only while remote control is on');
  assert.equal(handleRemote(target(false), settings, general('SetVolume', { Volume: '10' }), 'srv'), true);
}
assert.deepEqual(cmds, ['volume'], 'nothing but the one SetVolume (control on) reached the player');

// ---- 3. Desktop display.
const appSvelte = read('apps/desktop/src/renderer/App.svelte');
assert.match(appSvelte, /^<Toasts \/>$/m, 'App.svelte mounts <Toasts /> in every window, the OSD included');
assert.doesNotMatch(appSvelte, /\{#if !isOsd\}[^\n]*<Toasts/, 'the OSD must show toasts: main is hidden while mpv plays');
assert.match(read('apps/desktop/src/main/index.ts'), /case 'DisplayMessage':[\s\S]{0,600}args\.TimeoutMs/, 'index.ts keeps the sender TimeoutMs');

// ---- 4. Android.
const rc = read('apps/android/core/src/main/java/com/wika/wicaby/core/player/RemoteControl.kt');
assert.match(rc, /target == null && playerOnly && !c\.isMessage\) return/, 'mobile: DisplayMessage must not need a player');
assert.match(rc, /fun accepts\(c: RemoteCommand, enabled: Boolean\): Boolean = enabled \|\| c\.isMessage/, 'remote control off keeps DisplayMessage');
assert.match(rc, /parse\(m\)\?\.takeIf \{ accepts\(it, enabled\) \}/, 'handle() filters through accepts()');
assert.match(rc, /MessageBanner\.show\(/, 'messages go to the in-app banner');
assert.match(read('apps/android/core/src/main/java/com/wika/wicaby/core/data/Emby.kt'), /else listOf\("DisplayMessage"\)/, 'capabilities list DisplayMessage with remote control off');

console.log('message-check: OK (idle and playing delivery on both mocks, desktop routing and OSD toasts, Android gates)');
process.exit(0);
