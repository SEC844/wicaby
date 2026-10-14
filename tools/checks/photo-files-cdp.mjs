#!/usr/bin/env node
// Photo file sources through the built desktop app: Settings > Photo sources > "Folder on this computer" adds a temp
// folder of generated photos (photo-files-fixture.mjs, never real photos), its first scan shows in Settings, and the
// sidebar entry opens its timeline with real thumbnails (nativeImage), albums, the viewer's EXIF panel and "on this
// day" on Home. mock-emby only gets the app past sign-in; a main-process guard stands in for the OS folder picker
// and keeps the window from taking focus. Screenshots are the page only (Page.captureScreenshot).
//
//   node tools/checks/photo-files-cdp.mjs [--shots=<dir>]
//
// Not part of run-all: it needs Electron and a build (npm run build). Ports: PFCDP_MOCK_PORT (8897), PFCDP_CDP_PORT
// (9797). Exit 1 on any failure.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { buildPhotoTree } from '../mock-server/photo-files-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const SHOTS = args.shots ? path.resolve(String(args.shots)) : null;
const MOCK_PORT = Number(process.env.PFCDP_MOCK_PORT ?? 8897);
const CDP_PORT = Number(process.env.PFCDP_CDP_PORT ?? 9797);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-pfcdp-'));
const d = new Date();
const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TREE = buildPhotoTree(path.join(PROFILE, 'Photos de famille'), { today: TODAY, count: 40, scale: 8 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[photo-files-cdp]', ...m);
const js = JSON.stringify;
const results = [];
const pageErrors = [];
const ok = (name, cond, detail = '') => (results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`), log(results.at(-1)));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const children = [];
function start(cmd, argv, opts) {
  const c = spawn(cmd, argv, { stdio: process.env.PFCDP_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
  children.push(c);
  return c;
}
function kill(c) {
  if (c.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(c.pid)], { stdio: 'ignore' });
  else c.kill('SIGTERM');
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

// Main-process guard: loopback-only UDP (no mDNS out), windows that never take focus or the mouse, a fake picker.
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
const Module = require('node:module');
const load = Module._load;
let hooked = false;
Module._load = function (request, ...rest) {
  const m = load.call(this, request, ...rest);
  if (!hooked && request === 'electron' && m && m.app) {
    hooked = true;
    m.app.on('browser-window-created', (_e, win) => { win.show = () => win.showInactive(); win.setFocusable(false); win.setIgnoreMouseEvents(true); });
    m.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${js(TREE.dir)}] });
    const handle = m.ipcMain.handle.bind(m.ipcMain);
    m.ipcMain.handle = (ch, fn) => handle(ch, (e, ...a) => (ch === 'playback:play' ? undefined : fn(e, ...a)));
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
    else if (m.method === 'Runtime.exceptionThrown' || (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')) pageErrors.push(JSON.stringify(m.params).slice(0, 400));
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

// The page only (Page.captureScreenshot): never the desktop.
async function shot(page, name) {
  if (!SHOTS) return;
  await sleep(700);
  const { data } = await page.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
  log(`screenshot ${name}`);
}

async function run() {
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT)], { cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '', MOCK_PHOTOS: '0' } });
  await until('mock-emby', async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/emby/System/Info/Public`)).ok, 60000, 200);
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), js({ ui: { language: 'fr', reduceMotion: true, heroAutoplay: false, heroEnabled: false, onboarded: true }, windows: { trayHintShown: true } }));
  const guard = path.join(PROFILE, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  const app = start(createRequire(path.join(DESKTOP, 'package.json'))('electron'), ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_URL: '', NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
  const main = await attach((t) => /^(app:|http:\/\/localhost)/.test(t.url) && !t.url.includes('osd=1'));
  const ev = main.evaluate;
  await main.call('Runtime.enable');
  await main.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await until('bridge', () => ev(`!!window.wicaby`), 60000, 300);
  await ev(`wicaby.servers.add(${js(`http://127.0.0.1:${MOCK_PORT}`)}).then((s) => wicaby.servers.select(s.id)).then(() => true)`);
  await until('server selected', () => ev(`wicaby.session.get().then((s) => s.status === 'server-selected' || s.status === 'signed-in')`), 30000, 300);
  const status = await ev(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
  if (status !== 'signed-in') throw new Error(`sign-in ${status}`);

  // ---- Settings > Library > Photo sources: "Folder on this computer", the file sources' sheet ----
  await ev(`location.hash = '#/settings'`);
  await until('settings', () => ev(`!!document.querySelector('nav.cats')`), 15000);
  await ev(`[...document.querySelectorAll('nav.cats button')].find((b) => /biblioth/i.test(b.textContent)).click()`);
  await until('photo sources', () => ev(`!!document.querySelector('[data-photo-sources] [data-add="local"]')`), 10000);
  const adds = await ev(`[...document.querySelectorAll('[data-photo-sources] [data-add]')].map((b) => b.textContent.trim())`);
  ok('Photo sources offers a folder, an SMB share and WebDAV', adds.length === 3, adds.join(' | '));
  await ev(`(document.querySelector('[data-photo-sources] [data-add="local"]').click(), true)`);
  await until('add sheet', () => ev(`!!document.querySelector('.sheet .choices')`), 5000);
  const sheet = await ev(`({ title: document.querySelector('.sheet .title-3').textContent.trim(), on: document.querySelector('.sheet .choices button.on')?.textContent.trim() })`);
  ok('the sheet opens on the folder choice, titled for photos', /photos/i.test(sheet.title) && /dossier/i.test(sheet.on ?? ''), js(sheet));
  await ev(`([...document.querySelectorAll('.sheet .form .btn')].find((b) => b.querySelector('svg')).click(), true)`);
  await until('folder picked', () => ev(`document.querySelector('.sheet .path')?.textContent.includes('Photos de famille')`), 5000);
  await ev(`[...document.querySelectorAll('.sheet .actions .btn')].find((b) => /tester/i.test(b.textContent)).click()`);
  await until('test ok', () => ev(`!!document.querySelector('.sheet .result.ok')`), 10000);
  await ev(`document.querySelector('.sheet .actions .btn.primary').click()`);
  await until('sheet closed', () => ev(`!document.querySelector('.sheet .choices')`), 10000);
  const scan = await until('scan done', () => ev(`(() => { const r = [...document.querySelectorAll('[data-photo-sources] [data-scan]')][0]; return r?.dataset.scan === 'ready' ? r.textContent.trim() : null; })()`), 60000, 200);
  ok('Settings shows the scan status once indexed', /41/.test(scan), scan);
  const row = await ev(`[...document.querySelectorAll('[data-photo-sources] .row')][0].textContent`);
  ok('the row has Rescan and Remove', /Réanalyser/.test(row) && /Retirer/.test(row));
  await ev(`document.querySelector('[data-photo-sources]').scrollIntoView({ block: 'center' })`);
  await shot(main, 'photo-sources-settings.png');
  const listed = await ev(`wicaby.files.list()`);
  ok('it is a photo source, not a Files entry', listed.length === 1 && listed[0].photos?.state === 'ready' && !anyFilesEntry(listed), js(listed[0].photos));

  // ---- The sidebar entry opens its timeline ----
  await until('sidebar photo source', () => ev(`!!document.querySelector('[data-photo-source]')`), 10000);
  ok('no Files section for a photo source', await ev(`!document.querySelector('[data-files]')`));
  await ev(`document.querySelector('[data-photo-source]').click()`);
  await until('timeline tiles', () => ev(`document.querySelectorAll('.grid .tile').length >= 8`), 30000).catch(async (e) => {
    log(await ev(`JSON.stringify({ h: location.hash, tiles: document.querySelectorAll('.grid .tile').length, months: document.querySelectorAll('.grid .month').length, grid: document.querySelector('.grid')?.getBoundingClientRect().height, sc: document.getElementById('main-scroller')?.clientHeight, html: document.querySelector('.grid .month')?.outerHTML.slice(0, 400) })`));
    throw e;
  });
  const thumbs = await until('thumbnails decoded', () => ev(`(() => { const imgs = [...document.querySelectorAll('.grid .tile img')]; const done = imgs.filter((i) => i.complete && i.naturalWidth > 0); return done.length >= 5 ? { n: done.length, src: done[0].currentSrc.slice(0, 40), w: done[0].naturalWidth } : null; })()`), 30000).catch(async (e) => {
    log(await ev(`(async () => { const i = [...document.querySelectorAll('.grid .tile img')][3]; if (!i) return 'no img: ' + document.querySelector('.grid .tile')?.outerHTML.slice(0, 300); const r = await fetch(i.src); return document.querySelectorAll('.grid .tile img').length + ' ' + [...document.querySelectorAll('.grid .tile img')].filter((x) => x.complete && x.naturalWidth).length + ' ' + i.src + ' -> ' + r.status + ' ' + r.headers.get('content-type') + ' ' + (await r.arrayBuffer()).byteLength; })()`));
    throw e;
  });
  ok('the timeline shows thumbnails made in main', thumbs.n >= 5 && thumbs.w <= 1440, js(thumbs));
  const head = await ev(`({ title: document.querySelector('.photos .large-title')?.textContent.trim(), count: document.querySelector('.photos .count')?.textContent.trim(), months: document.querySelectorAll('.grid .month').length })`);
  ok('the library is named after the source, with its count and months', head.title === 'Photos de famille' && /41/.test(head.count ?? '') && head.months > 3, js(head));
  const memories = await ev(`document.querySelectorAll('.photos .memories .card, .photos [data-memory], .photos .memory').length`);
  ok('"On this day" above the timeline', memories > 0, `${memories}`);
  await ev(`document.getElementById('main-scroller').scrollTop = 0`);
  await shot(main, 'photo-source-timeline.png');

  // ---- The viewer and its EXIF panel ----
  await ev(`[...document.querySelectorAll('.grid .tile')][2].click()`);
  await until('viewer', () => ev(`!!document.querySelector('.viewer .pic[data-id]')`), 15000);
  await ev(`[...document.querySelectorAll('.viewer button')].find((b) => b.getAttribute('aria-pressed') !== null && /info/i.test(b.getAttribute('aria-label'))).click()`);
  const info = await until('info panel', () => ev(`(() => { const dl = document.querySelector('.viewer .info dl'); return dl && /ExampleCam/.test(dl.textContent) ? dl.textContent.replace(/\\s+/g, ' ').trim() : null; })()`), 10000).catch(() => null);
  ok('the info panel reads the EXIF camera; no location with the map off', Boolean(info) && !/48[,.]85|45[,.]76|64[,.]14/.test(info), info ?? 'missing');
  await shot(main, 'photo-source-viewer.png');
  await ev(`(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
  await until('viewer closed', () => ev(`!document.querySelector('.viewer')`), 5000).catch(() => undefined);

  // ---- Albums: the folders ----
  await ev(`[...document.querySelectorAll('.photos .toolbar button')].find((b) => /albums/i.test(b.textContent)).click()`);
  const albums = await until('albums', () => ev(`(() => { const a = [...document.querySelectorAll('.album')]; return a.length && a.every((x) => x.querySelector('img')?.complete) ? a.map((x) => x.querySelector('.name')?.textContent.trim()) : null; })()`), 15000);
  ok('Albums lists the folders', albums.join('|') === 'Famille › Anniversaires|Montagne|Vacances 2019', albums.join(', '));
  await shot(main, 'photo-source-albums.png');

  // ---- Home: "On this day" from the photo source ----
  await ev(`location.hash = '#/home'`);
  const home = await until('home memories', () => ev(`document.querySelectorAll('main .memory, main [data-memory], main .memories .card').length || null`), 20000).catch(() => null);
  ok('Home shows "On this day" from the photo source', Boolean(home), `${home}`);

  const logs = fs.readdirSync(PROFILE, { recursive: true }).filter((f) => /\.log$/.test(f)).map((f) => fs.readFileSync(path.join(PROFILE, f), 'utf8')).join('\n');
  ok('no coordinate or photo file name in the main log', !/48\.85|45\.76|64\.14|IMG_1/.test(logs), `${logs.length} bytes`);
  ok('no page error', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  main.close();
  kill(app);
}

// files.list() of a photo source must not make it a Files entry (fileSessions filters on ServerInfo.files.photos).
function anyFilesEntry(list) {
  return list.some((s) => !s.photos);
}

let code = 1;
try {
  await run();
  code = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
} catch (e) {
  console.error('[photo-files-cdp] error', e.stack ?? e.message);
}
console.log(results.join('\n'));
for (const c of children) kill(c);
await sleep(800);
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
} catch {}
process.exit(code);
