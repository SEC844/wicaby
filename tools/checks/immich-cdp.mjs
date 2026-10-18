#!/usr/bin/env node
// Photos spec PH-12 through the built desktop app, against mock-emby and mock-immich only (never a real server or real
// photos): Settings connects the Immich source, the sidebar lists it as its own library, its timeline, albums, people
// and memories show, the viewer opens, and the key never reaches the renderer (AC 1: no resource URL, no
// localStorage entry and no log line holds it). Windows never take focus; nothing plays.
//
//   node tools/checks/immich-cdp.mjs [--shots=<dir>]
//
// Not part of run-all: it needs Electron and a build (npm run build). Ports: IMCDP_MOCK_PORT (8895), IMCDP_IMMICH_PORT
// (8896), IMCDP_CDP_PORT (9795). Exit 1 on any failure.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const SHOTS = args.shots ? path.resolve(String(args.shots)) : null;
const MOCK_PORT = Number(process.env.IMCDP_MOCK_PORT ?? 8895);
const IMMICH_PORT = Number(process.env.IMCDP_IMMICH_PORT ?? 8896);
const CDP_PORT = Number(process.env.IMCDP_CDP_PORT ?? 9795);
const KEY = 'mock-immich-key';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-imcdp-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[immich-cdp]', ...m);
const js = JSON.stringify;
const results = [];
const ok = (name, cond, detail = '') => (results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`), log(results.at(-1)));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const children = [];
const start = (cmd, argv, opts) => {
  const c = spawn(cmd, argv, { stdio: process.env.IMCDP_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
  children.push(c);
  return c;
};
const kill = (c) => {
  if (c.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(c.pid)], { stdio: 'ignore' });
  else c.kill('SIGTERM');
};
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

// Windows never take focus or the mouse; outgoing UDP stays on loopback.
const GUARD = String.raw`'use strict';
const dgram = require('node:dgram');
const send = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (msg, ...rest) {
  const a = rest.find((x) => typeof x === 'string');
  const cb = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null;
  if (a !== undefined && !(a === 'localhost' || a === '::1' || /^127\./.test(a))) { if (cb) process.nextTick(cb, null, 0); return; }
  return send.call(this, msg, ...rest);
};
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
`;

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
  return { call, evaluate };
}
async function shot(page, name) {
  if (!SHOTS) return;
  const { data } = await page.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
  log(`screenshot ${name}`);
}
const loadedTiles = `[...document.querySelectorAll('.grid .tile img')].filter((i) => i.complete && i.naturalWidth > 0).length`;

async function run() {
  const env = { ...process.env, NODE_OPTIONS: '', MOCK_PHOTOS: '300' };
  start(process.execPath, [path.join(ROOT, 'tools/mock-server/mock-emby.mjs'), String(MOCK_PORT)], { cwd: ROOT, env });
  start(process.execPath, [path.join(ROOT, 'tools/mock-server/mock-immich.mjs'), String(IMMICH_PORT)], { cwd: ROOT, env });
  await until('mock-emby', async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/emby/System/Info/Public`)).ok, 60000, 200);
  await until('mock-immich', async () => (await fetch(`http://127.0.0.1:${IMMICH_PORT}/api/server/version`)).ok, 60000, 200);
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), js({ ui: { language: 'fr', reduceMotion: true, heroAutoplay: false, onboarded: true }, windows: { trayHintShown: true } }));
  const guard = path.join(PROFILE, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  start(createRequire(path.join(DESKTOP, 'package.json'))('electron'), ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_URL: '', NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
  const main = await attach((t) => /^(app:|http:\/\/localhost)/.test(t.url) && !t.url.includes('osd=1'));
  const ev = main.evaluate;
  await until('bridge', () => ev(`!!window.wicaby`), 60000, 300);
  await ev(`wicaby.servers.add(${js(`http://127.0.0.1:${MOCK_PORT}`)}).then((s) => wicaby.servers.select(s.id)).then(() => true)`);
  await until('server selected', () => ev(`wicaby.session.get().then((s) => s.status === 'server-selected' || s.status === 'signed-in')`), 30000, 300);
  const status = await ev(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
  if (status !== 'signed-in') throw new Error(`sign-in ${status}`);

  // Settings > Library: Test, then Connect, through the form (the key typed once).
  await ev(`location.hash = '#/settings'`);
  await sleep(1200);
  await ev(`[...document.querySelectorAll('button, [role=tab]')].find((b) => /Bibliothèque/.test(b.textContent))?.click(), true`);
  const form = await until('Immich form', () => ev(`!!document.querySelector('input[type=url][placeholder*="2283"]')`), 15000);
  ok('Settings shows the Immich source form', form);
  await ev(`(() => {
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.querySelector('input[type=url][placeholder*="2283"]'), ${js(`http://127.0.0.1:${IMMICH_PORT}`)});
    set(document.querySelector('input[type=url][placeholder*="2283"]').closest('.group').querySelector('input[type=password]'), ${js(KEY)});
    return true;
  })()`);
  await sleep(200);
  await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Tester').click(), true`);
  const tested = await until('test result', () => ev(`document.querySelector('[role=status]')?.textContent.trim()`), 15000);
  ok('Test reports the version', /Immich 3\.3\.0/.test(tested), tested);
  await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Connecter').click(), true`);
  const sid = await until('source added', () => ev(`wicaby.photos.immich.sources().then((l) => l[0]?.id)`), 15000);
  await shot(main, 'immich-settings.png');

  // The sidebar: its own library, under "Immich".
  const entry = await until('sidebar entry', () => ev(`!!document.querySelector('[data-immich] button')`), 10000);
  ok('AC 2: the Immich source is its own library in the sidebar', entry);
  await ev(`document.querySelector('[data-immich] button').click(), true`);
  const tiles = await until('Immich tiles', async () => ((n) => n > 5 && n)(await ev(loadedTiles)), 30000);
  ok('the Immich timeline shows thumbnails', tiles > 5, `${tiles} decoded`);
  const memories = await until('memories row', () => ev(`document.querySelectorAll('.memory').length`), 15000).catch(() => 0);
  ok('Immich memories above the timeline', memories > 0, `${memories} cards`);
  await shot(main, 'immich-timeline.png');

  const seg = (label) => ev(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent.trim() === ${js(label)})?.click(), true`);
  await seg('Albums');
  const albums = await until('albums', () => ev(`document.querySelectorAll('.album').length`), 15000);
  const shared = await ev(`[...document.querySelectorAll('.album .footnote')].some((f) => /Partagé/.test(f.textContent))`);
  ok('albums, one shared', albums === 6 && shared, `${albums} albums`);
  await shot(main, 'immich-albums.png');
  await ev(`document.querySelector('.album').click(), true`);
  ok('an album opens its timeline', (await until('album tiles', () => ev(loadedTiles), 20000)) > 0);
  await seg('Personnes');
  const people = await until('people', () => ev(`document.querySelectorAll('.person').length`), 15000);
  ok('people with their faces', people === 4, `${people} people`);
  await shot(main, 'immich-people.png');
  await ev(`document.querySelector('.person').click(), true`);
  ok('a person opens their timeline', (await until('person tiles', () => ev(loadedTiles), 20000)) > 0);

  // The viewer over an Immich photo, with its info panel (EXIF from /api/assets/{id}).
  await seg('Chronologie');
  await until('timeline again', () => ev(loadedTiles), 20000);
  await ev(`[...document.querySelectorAll('.grid .tile')].find((t) => !t.querySelector('.dur'))?.click(), true`);
  const shown = await until('viewer picture', () => ev(`(() => { const i = document.querySelector('.viewer .pic[data-id]'); return i && i.complete && i.naturalWidth > 0 ? i.naturalWidth : 0; })()`), 20000);
  ok('the viewer shows the preview', shown > 250, `${shown} px wide`);
  await main.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73, text: 'i' });
  await main.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73 });
  const exif = await until('info panel', async () => ((s) => /Wicaby Test/.test(s) && s)(await ev(`document.querySelector('.info dl')?.textContent ?? ''`)), 10000).catch(() => '');
  ok('the info panel lists the EXIF', /Wicaby Test/.test(exif));
  await shot(main, 'immich-viewer.png');

  // AC 1: the key never reaches the renderer.
  const urls = await ev(`performance.getEntries().map((e) => e.name).join('\\n')`);
  const storage = await ev(`JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })`);
  const logs = fs.readdirSync(path.join(PROFILE, 'logs')).map((f) => fs.readFileSync(path.join(PROFILE, 'logs', f), 'utf8')).join('\n');
  const immichUrls = urls.split('\n').filter((u) => u.startsWith('wicaby-media://immich/')).length;
  ok('AC 1: no URL, storage entry or log line holds the key', !urls.includes(KEY) && !storage.includes(KEY) && !logs.includes(KEY), `${immichUrls} wicaby-media://immich loads`);
  const state = await (await fetch(`http://127.0.0.1:${IMMICH_PORT}/Mock/State`)).json();
  // Every API call but the public version carries the key.
  const bare = state.calls.filter((c) => !c.key && c.path.startsWith('/api/') && c.path !== '/api/server/version');
  ok('mock-immich saw the key in the header only', !state.tags.some((t) => t.tag === 'KEY-IN-URL' || t.tag === 'NO-KEY') && bare.length === 0, `${state.calls.length} calls`);
}

let code = 0;
try {
  await run();
} catch (err) {
  log('ERROR', err.stack ?? err);
  code = 1;
} finally {
  for (const c of children) kill(c);
  await sleep(500);
  fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5 });
}
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(code || failed ? 1 : 0);
