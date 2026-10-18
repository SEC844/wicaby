#!/usr/bin/env node
// Admin "Envoyer un message" end to end through the desktop app, as the receiving session.
//
// The message goes through POST /Sessions/{id}/Message exactly as admin/Dashboard.svelte sendMessage
// posts it (query + body), to the app's own session on mock Emby, then the script looks for it on screen:
//   1. idle on Home: a toast in a visible window;
//   2. during mpv playback (main window hidden, OSD on top): a toast in a visible window;
//   3. "Autoriser le contrôle à distance" off, idle: still shown (a notification, not remote control),
//      while DisplayContent stays dropped.
// The mock's /Mock/State remote[] proves the server side delivered each frame to the app's socket.
//
// Not part of run-all: it needs Electron, mpv (vendor/mpv) and a silent video, and mpv runs with
// ao=null and mute=yes (nothing makes a sound). Nothing leaves loopback.
//
//   node tools/checks/message-cdp.mjs [video]   (default .dev/pbux-silent.mkv, or MESSAGE_VIDEO)
//
// Runs the built app (npm run build in apps/desktop first). Ports: MSG_MOCK_PORT (8874), MSG_CDP_PORT (9774).
// Exit 1 on any failure.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const VIDEO = path.resolve(process.argv[2] ?? process.env.MESSAGE_VIDEO ?? path.join(ROOT, '.dev', 'pbux-silent.mkv'));
const MOCK_PORT = Number(process.env.MSG_MOCK_PORT ?? 8874);
const CDP_PORT = Number(process.env.MSG_CDP_PORT ?? 9774);
const SERVER_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-msg-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[msg]', ...m);
const js = JSON.stringify;
const results = [];
const ok = (name, cond, detail = '') => (results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`), log(results.at(-1)));

const children = [];
function start(cmd, argv, opts) {
  const c = spawn(cmd, argv, { stdio: process.env.MSG_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
  children.push(c);
  return c;
}
function kill(c) {
  if (c.exitCode === null) spawnSync('taskkill', ['/T', '/F', '/PID', String(c.pid)], { stdio: 'ignore' });
}
async function until(what, fn, timeoutMs = 30000, every = 150) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out: ${what}${last ? `: ${last.message}` : ''}`);
}

// Preloaded into main: loopback-only UDP, and windows that never take focus or the mouse.
const GUARD = String.raw`'use strict';
const dgram = require('node:dgram');
const send = dgram.Socket.prototype.send;
const loopback = (a) => a === 'localhost' || a === '::1' || /^127\./.test(a);
dgram.Socket.prototype.send = function (msg, ...rest) {
  const address = rest.find((a) => typeof a === 'string');
  const cb = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null;
  if (address !== undefined && !loopback(address)) { if (cb) process.nextTick(cb, null, 0); return; }
  return send.call(this, msg, ...rest);
};
if (process.versions.electron) {
  const Module = require('node:module');
  const load = Module._load;
  let hooked = false;
  Module._load = function (request, ...rest) {
    const m = load.call(this, request, ...rest);
    if (!hooked && request === 'electron' && m && m.app) {
      hooked = true;
      // A dead proxy: Chromium and net.fetch reach loopback only (the update check, map tiles…).
      m.app.commandLine.appendSwitch('proxy-server', 'http://127.0.0.1:9');
      m.app.on('browser-window-created', (_e, win) => { win.show = () => win.showInactive(); win.setFocusable(false); win.setIgnoreMouseEvents(true); });
    }
    return m;
  };
}
`;

function seedProfile() {
  const address = `http://127.0.0.1:${MOCK_PORT}`;
  fs.writeFileSync(path.join(PROFILE, 'servers.json'), js({ servers: [{ id: SERVER_ID, name: 'Mock', kind: 'emby', version: '4.9.1.0', manualAddress: address, lastAddress: address }], activeId: SERVER_ID, tokenBinding: 1 }));
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), js({ ui: { language: 'fr', reduceMotion: true, heroAutoplay: false }, windows: { trayHintShown: true }, playback: { player: 'mpv', resume: 'start', startFullscreen: false, useMpvConfig: true } }));
  // No audio device at all, and muted on top.
  fs.mkdirSync(path.join(PROFILE, 'mpv'), { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'mpv', 'mpv.conf'), 'ao=null\nmute=yes\nvolume=0\n');
  const guard = path.join(PROFILE, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  return guard;
}

async function attach(pick) {
  const page = await until('page', async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === 'page' && pick(t)), 90000, 300);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => (ws.addEventListener('open', res, { once: true }), ws.addEventListener('error', rej, { once: true })));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { call, evaluate, close: () => ws.close() };
}
const isApp = (t) => /^(app:|http:\/\/localhost)/.test(t.url);
const mainPage = () => attach((t) => isApp(t) && !t.url.includes('osd=1'));
const osdPage = () => attach((t) => isApp(t) && t.url.includes('osd=1'));

const mockState = async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/Mock/State`)).json();
const state = (main) => main.evaluate(`wicaby.playback.getState()`);

// Where the text shows: the windows whose document is visible and holds a toast with it.
const SEEN = (text) => `document.visibilityState === 'visible' && [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes(${js(text)}))`;
async function shownIn(pages, text, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const [name, p] of pages) if (await p.evaluate(SEEN(text)).catch(() => false)) return name;
    await sleep(150);
  }
  return null;
}

// Dashboard.svelte sendMessage: the MessageCommand in the query (Emby) and in the body (Jellyfin).
async function send(main, sessionId, text) {
  const cmd = { Header: 'Admin', Text: text, TimeoutMs: 10000 };
  const before = (await mockState()).remote.length;
  await main.evaluate(`wicaby.api.post(${js(`/Sessions/${sessionId}/Message`)}, ${js(cmd)}, ${js(cmd)}).then(() => true)`);
  const r = (await mockState()).remote.slice(before).find((x) => x.Data?.Arguments?.Text === text);
  return r?.sockets ?? 0;
}

async function run() {
  if (!fs.existsSync(VIDEO)) throw new Error(`no video at ${VIDEO}`);
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT), VIDEO], { cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '' } });
  await until('mock', async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/emby/System/Info/Public`)).ok);
  const guard = seedProfile();
  // The built app (npm run build), not the dev loop: a file saved elsewhere in the tree would restart it mid-run.
  const app = start(createRequire(path.join(DESKTOP, 'package.json'))('electron'), ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_URL: '', NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
  const main = await mainPage();
  await until('session', () => main.evaluate(`window.wicaby?.session.get().then((s) => s.status !== 'no-server' && s.status !== 'connecting')`), 60000, 500);
  const status = await main.evaluate(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
  if (status !== 'signed-in') throw new Error(`sign-in ${status}`);
  await until('socket', async () => (await mockState()).sockets.length > 0, 20000);
  const deviceId = await main.evaluate(`wicaby.app.info().then((i) => i.deviceId)`);
  const sessions = await main.evaluate(`wicaby.api.get('/Sessions', { DeviceId: ${js(deviceId)} })`);
  const me = sessions.find((s) => s.DeviceId === deviceId);
  if (!me) throw new Error('own session not listed');
  log(`session ${me.Id}, SupportsRemoteControl ${me.SupportsRemoteControl}, DisplayMessage listed ${me.SupportedCommands.includes('DisplayMessage')}`);

  // 1. Idle on Home.
  await main.evaluate(`location.hash = '#/home'`);
  await sleep(1500);
  let sockets = await send(main, me.Id, 'Bonjour (accueil)');
  let where = await shownIn([['main', main]], 'Bonjour (accueil)');
  ok('idle on Home: delivered and shown', sockets === 1 && where !== null, `sockets ${sockets}, shown in ${where}, main ${await main.evaluate("document.visibilityState + ' ' + [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('/')")}`);

  // 2. During mpv playback.
  await main.evaluate(`wicaby.playback.play(${js({ itemIds: ['movie-1'], serverId: SERVER_ID })}).then(() => true)`);
  await until('playing', async () => {
    const s = await state(main);
    return s.active && !s.buffering && s.positionMs > 500;
  }, 40000, 200);
  const osd = await osdPage();
  await until('osd', () => osd.evaluate(`!!document.querySelector('.osd')`), 15000);
  await sleep(1000);
  sockets = await send(main, me.Id, 'Bonjour (lecture)');
  where = await shownIn([['main', main], ['osd', osd]], 'Bonjour (lecture)');
  // MSG_SHOTS=<dir>: what the viewer sees over the video.
  if (process.env.MSG_SHOTS) fs.writeFileSync(path.join(process.env.MSG_SHOTS, 'osd-message.png'), Buffer.from((await osd.call('Page.captureScreenshot')).data, 'base64'));
  ok('during playback: delivered and shown',sockets === 1 && where !== null, `sockets ${sockets}, shown in ${where}, main ${await main.evaluate('document.visibilityState')}`);
  await main.evaluate(`wicaby.playback.command({ type: 'stop' }).then(() => true)`);
  await until('stopped', async () => !(await state(main)).active, 20000);
  osd.close();
  await until('main visible', () => main.evaluate(`document.visibilityState === 'visible'`), 10000).catch(() => false);

  // 3. Remote control off, idle: the message still shows, DisplayContent does not navigate.
  await main.evaluate(`wicaby.settings.update({ remote: { allowControl: false } }).then(() => true)`);
  await sleep(1000);
  await main.evaluate(`location.hash = '#/home'`);
  sockets = await send(main, me.Id, 'Bonjour (contrôle désactivé)');
  where = await shownIn([['main', main]], 'Bonjour (contrôle désactivé)');
  ok('remote control off: the message is still shown', sockets === 1 && where !== null, `sockets ${sockets}, shown in ${where}`);
  await main.evaluate(`wicaby.api.post(${js(`/Sessions/${me.Id}/Command`)}, undefined, { Name: 'DisplayContent', Arguments: { ItemId: 'movie-1', ItemType: 'Movie' } }).then(() => true)`);
  await sleep(1500);
  const hash = await main.evaluate('location.hash');
  ok('remote control off: DisplayContent is still dropped', !hash.includes('movie-1'), hash);

  main.close();
  kill(app);
}

let code = 1;
try {
  await run();
  code = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
} catch (e) {
  console.error('[msg] error', e.message);
}
console.log(results.join('\n'));
for (const c of children) kill(c);
await sleep(800);
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
} catch {}
process.exit(code);
