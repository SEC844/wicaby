#!/usr/bin/env node
// Music wave 5 on the desktop over CDP (music-spec MU-10, MU-13), against mock-emby's music library and its LRCLIB
// stand-in. Not part of run-all: it needs Electron (the dev build, scripts/dev.mjs) and Windows. Music plays in the
// built-in player (no mpv needed); never audible: WICABY_TEST_SILENT=1 mutes Chromium and the mock serves silence.
// Windows open inactive, unfocusable and click-through (the guard of music-ui-cdp.mjs); nothing leaves loopback.
//
//   MU-13 lyrics: with LRCLIB off a track without server lyrics shows "none" and the stub sees no request; turned on,
//         the next such track shows the stub's synced lyrics with the "LRCLIB" caption, asked with a Wicaby User-Agent.
//   MU-10 mini player: opens at 360 × 96 with the playing track, its next button drives the queue, closing it brings
//         the main window back and saves its place, and it opens there again.
//
//   node tools/checks/music-wave5-cdp.mjs [--shots=<dir>]
// Ports: WAVE5_MOCK_PORT (8891), WAVE5_DEV_PORT (5631), WAVE5_CDP_PORT (9791).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const MOCK_PORT = Number(process.env.WAVE5_MOCK_PORT) || 8891;
const DEV_PORT = Number(process.env.WAVE5_DEV_PORT) || 5631;
const CDP_PORT = Number(process.env.WAVE5_CDP_PORT) || 9791;
const SHOTS = typeof args.shots === 'string' ? path.resolve(args.shots) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[wave5]', ...m);
const js = (v) => JSON.stringify(v);

const children = [];
const start = (cmd, argv, opts) => {
  const child = spawn(cmd, argv, { stdio: process.env.WAVE5_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
  children.push(child);
  return child;
};
const stopAll = () => {
  for (const c of children.splice(0)) if (c.exitCode === null) spawnSync('taskkill', ['/T', '/F', '/PID', String(c.pid)], { stdio: 'ignore' });
};
process.on('SIGINT', () => (stopAll(), process.exit(130)));

async function until(what, fn, timeoutMs = 30000, everyMs = 150) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}
const portFree = (port) => new Promise((resolve) => net.connect({ port, host: '127.0.0.1' }).once('connect', function () { this.destroy(); resolve(false); }).once('error', () => resolve(true)));

// Same guard as music-ui-cdp.mjs: loopback UDP only, windows never take the focus or the mouse.
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

async function attach(pick) {
  const page = await until('a Wicaby page', async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === 'page' && pick(t)), 90000, 300);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => (ws.addEventListener('open', resolve, { once: true }), ws.addEventListener('error', reject, { once: true })));
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
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };
  return { call, evaluate, shot, close: () => ws.close() };
}
const isApp = (t) => /^(app:|http:\/\/localhost)/.test(t.url);

const failures = [];
const check = (ok, what) => (ok ? log(`  ok  ${what}`) : (failures.push(what), log(`  FAIL ${what}`)));

const base = `http://127.0.0.1:${MOCK_PORT}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-wave5-'));
try {
  if (!(await portFree(MOCK_PORT)) || !(await portFree(DEV_PORT))) throw new Error(`port ${MOCK_PORT} or ${DEV_PORT} is taken`);
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT)], { cwd: ROOT, env: { ...process.env, MOCK_MUSIC: '1', NODE_OPTIONS: '' } });
  await until('the mock server', async () => (await fetch(`${base}/emby/System/Info/Public`)).ok);
  const lrclibLog = async () => (await (await fetch(`${base}/Mock/State`)).json()).music.lrclib;

  const serverId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  fs.writeFileSync(path.join(profile, 'servers.json'), js({ servers: [{ id: serverId, name: 'Mock', kind: 'emby', version: '4.9.1.0', manualAddress: base, lastAddress: base }], activeId: serverId, tokenBinding: 1 }));
  fs.writeFileSync(
    path.join(profile, 'settings.json'),
    js({ ui: { language: 'fr', heroAutoplay: false, reduceMotion: true }, windows: { trayHintShown: true, closeToTray: true }, window: { bounds: { x: 80, y: 60, width: 1366, height: 860 } }, playback: { player: 'html' } }),
  );
  const guard = path.join(profile, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);

  start(process.execPath, [path.join(DESKTOP, 'scripts', 'dev.mjs'), `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_PORT: String(DEV_PORT), WICABY_TEST_SILENT: '1', LRCLIB_BASE: `${base}/mock/lrclib`, NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
  const main = await attach((t) => isApp(t) && !t.url.includes('osd=1') && !t.url.includes('mini=1'));
  await until('the session', () => main.evaluate(`window.wicaby?.session.get().then((s) => s.status !== 'no-server' && s.status !== 'connecting')`), 60000, 500);
  const status = await main.evaluate(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
  if (status !== 'signed-in') throw new Error(`sign-in failed (${status})`);
  await until('the app shell', () => main.evaluate(`!!document.getElementById('main-scroller')`), 30000, 200);
  const ev = (e) => main.evaluate(e);
  const state = () => ev('wicaby.playback.getState()');

  // Les Ondes Calmes, "Marée basse": no server lyrics.
  const ids = ['track-0-0-0', 'track-0-0-1', 'track-0-0-2'];
  await ev(`wicaby.playback.play(${js({ serverId, itemIds: ids, startIndex: 0 })}).then(() => true)`);
  await until('track 1 playing', async () => (await state()).item?.id === ids[0], 20000);

  log('MU-13 LRCLIB lyrics');
  await ev(`(location.hash = '#/now-playing?tab=lyrics', true)`);
  await until('lyrics pane settled', () => ev(`document.querySelector('[data-lyrics]')?.dataset.lyrics === 'none'`), 15000);
  check((await lrclibLog()).length === 0, 'off: no request to the LRCLIB stub, "no lyrics" shown');
  await ev(`wicaby.settings.update({ music: { lyricsProvider: 'server+lrclib' } }).then(() => true)`);
  await ev(`wicaby.playback.command({ type: 'next' }).then(() => true)`);
  await until('track 2 playing', async () => (await state()).item?.id === ids[1], 20000);
  const synced = await until('LRCLIB lyrics', () => ev(`document.querySelector('[data-lyrics]')?.dataset.lyrics === 'synced' && document.querySelector('[data-source="lrclib"]')?.textContent`), 15000).catch(() => null);
  check(Boolean(synced), `on: the stub's synced lyrics with the caption (${synced})`);
  const asked = (await lrclibLog()).at(-1);
  check(asked?.title === 'Phare' && asked.artist === 'Les Ondes Calmes' && /^Wicaby\//.test(asked.ua), `asked once for the playing track with a Wicaby User-Agent (${asked?.title}, ${asked?.ua})`);
  await main.shot('wave5-lyrics-lrclib');
  await ev(`(history.back(), true)`);

  log('MU-10 mini player');
  await ev(`wicaby.window.mini('open').then(() => true)`);
  let mini = await attach((t) => isApp(t) && t.url.includes('mini=1'));
  await until('the mini player', () => mini.evaluate(`document.querySelector('[data-mini] [data-title]')?.textContent === 'Phare'`), 20000);
  const size = await mini.evaluate(`[innerWidth, innerHeight]`);
  check(size[0] === 360 && size[1] === 96, `360 × 96 (${size.join(' × ')})`);
  check(await mini.evaluate(`document.querySelector('[data-mini] [data-artist]')?.textContent === 'Les Ondes Calmes'`), 'shows the track and its artist');
  check(await soonTrue(() => ev(`document.visibilityState === 'hidden'`)), 'the main window went to the tray ("Réduire dans la barre" on)');
  await mini.shot('wave5-mini');
  await mini.evaluate(`(document.querySelector('[data-ctl="next"]').click(), true)`);
  check(Boolean(await until('next from the mini player', async () => (await state()).item?.id === ids[2], 15000).catch(() => null)), 'its next button drives the queue');
  await until('the mini player follows', () => mini.evaluate(`document.querySelector('[data-mini] [data-title]')?.textContent === 'Sable mouillé'`), 10000);
  const where = await mini.evaluate(`[screenX, screenY]`);
  await mini.evaluate(`(document.querySelector('[data-mini-close]').click(), true)`).catch(() => true);
  mini.close();
  await until('the mini player closed', async () => !(await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).some((t) => t.url.includes('mini=1')), 10000);
  check(await soonTrue(() => ev(`document.visibilityState === 'visible'`)), 'closing it brings the main window back');
  const saved = await until('its place saved', () => {
    const s = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
    return s.window?.mini;
  }, 5000).catch(() => null);
  // The window's bounds (saved) include the invisible resize border Windows adds; screenX/screenY do not.
  check(saved && Math.abs(saved.x - where[0]) <= 16 && Math.abs(saved.y - where[1]) <= 16, `its place is saved (${js(saved)} for ${js(where)})`);
  await ev(`wicaby.window.mini('open').then(() => true)`);
  mini = await attach((t) => isApp(t) && t.url.includes('mini=1'));
  const again = await until('the mini player again', () => mini.evaluate(`document.readyState === 'complete' && [screenX, screenY]`), 15000);
  check(again[0] === where[0] && again[1] === where[1], `it opens there again (${js(again)})`);
  await mini.evaluate(`wicaby.window.mini('close').then(() => true)`).catch(() => true);
  await ev(`wicaby.playback.command({ type: 'stop' }).then(() => true)`).catch(() => true);
} catch (err) {
  failures.push(String(err?.message ?? err));
  log(`  FAIL ${err?.stack ?? err}`);
} finally {
  stopAll();
}

async function soonTrue(fn, ms = 6000) {
  return Boolean(await until('condition', fn, ms).catch(() => false));
}

console.log(failures.length ? `music-wave5-cdp: ${failures.length} failure(s)` : 'music-wave5-cdp: OK');
process.exit(failures.length ? 1 : 0);
