#!/usr/bin/env node
// Plex on the desktop through the built app (plex-spec PX-04, PX-06, PX-07), against tools/mock-server/mock-plex.mjs
// (a fake PMS and a fake plex.tv) and mock-emby, on loopback only: never plex.tv, never a real server. A main-process
// guard answers playback.play itself (no player starts, nothing makes a sound) and keeps UDP on loopback.
//
//   node tools/checks/plex-cdp.mjs [--shots=<dir>]
//
// Checked: link with a code (the code and a QR code), D-3 (a plain-http LAN address waits for the user), who is
// watching (a wrong PIN is refused), Home shows the promoted hubs and Continue Watching, the Films library lists 12
// films with posters loaded, the flattened show lists its episodes without season tabs, the film with two editions
// offers both, search finds a single shared film, the heart is the watchlist and Favorites lists it (D-6), no
// Administration, Live TV or "Play on" rows for the Plex owner, while mock-emby in the same session keeps
// Administration and its heart; the hide toggle hides a shared server (D-10); /Mock/State has no UNMAPPED,
// TOKEN-IN-URL or ACCOUNT-TOKEN-ON-PMS. Screenshots are of the app page only (Page.captureScreenshot).
// Not part of run-all: it needs Electron and a build (npm run build). Ports: PXCDP_EMBY_PORT (8897), PXCDP_CDP_PORT
// (9797). Exit 1 on any failure.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MACHINE_ID, SECOND_ID, startMockPlex } from '../mock-server/mock-plex.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const SHOTS = args.shots ? path.resolve(String(args.shots)) : null;
const EMBY_PORT = Number(process.env.PXCDP_EMBY_PORT ?? 8897);
const CDP_PORT = Number(process.env.PXCDP_CDP_PORT ?? 9797);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-pxcdp-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[plex-cdp]', ...m);
const js = JSON.stringify;
const results = [];
const pageErrors = [];
const ok = (name, cond, detail = '') => (results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`), log(results.at(-1)));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const children = [];
function start(cmd, argv, opts) {
  const c = spawn(cmd, argv, { stdio: process.env.PXCDP_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
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

// Main-process guard: loopback-only UDP, windows that never take focus or the mouse, no player.
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
    // A dead proxy: Chromium and net.fetch reach loopback only (the update check, map tiles…).
    m.app.commandLine.appendSwitch('proxy-server', 'http://127.0.0.1:9');
    m.app.on('browser-window-created', (_e, win) => { win.show = () => win.showInactive(); win.setFocusable(false); win.setIgnoreMouseEvents(true); });
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

// The app page only (Page.captureScreenshot): never the desktop.
async function shot(page, name) {
  if (!SHOTS) return;
  await sleep(700);
  const { data } = await page.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
  log(`screenshot ${name}`);
}

async function run() {
  const plex = await startMockPlex({ port: 0, tvPort: 0, relayPort: 0, secondPort: 0, env: { MOCK_PLEX_SECOND: '1', MOCK_PLEX_TLS: '0' } });
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(EMBY_PORT)], { cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '', MOCK_PHOTOS: '0' } });
  await until('mock-emby', async () => (await fetch(`http://127.0.0.1:${EMBY_PORT}/emby/System/Info/Public`)).ok, 60000, 200);
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), js({ ui: { language: 'en', reduceMotion: true, heroAutoplay: false, heroEnabled: false, onboarded: true }, windows: { trayHintShown: true } }));
  const guard = path.join(PROFILE, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  const app = start(createRequire(path.join(DESKTOP, 'package.json'))('electron'), ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_URL: '', WICABY_TEST_SILENT: '1', WICABY_PLEXTV_BASE: plex.plextv, NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
  const main = await attach((t) => /^(app:|http:\/\/localhost)/.test(t.url) && !t.url.includes('osd=1'));
  const ev = main.evaluate;
  await main.call('Runtime.enable');
  await main.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await until('bridge', () => ev(`!!window.wicaby`), 60000, 300);
  const click = (sel, text) => ev(`(() => { const b = [...document.querySelectorAll(${js(sel)})].find((x) => ${text ? `x.textContent.includes(${js(text)})` : 'true'}); if (!b) return false; b.click(); return true; })()`);

  // ---- Link with a code ----
  await ev(`location.hash = '#/servers'`);
  // The empty Sources page lists the types inline; Plex opens the add sheet on its step, which asks for the code.
  await until('servers page', () => click('[data-type="plex"]'), 20000);
  const code = await until('the code', () => ev(`document.querySelector('.plex-link .code')?.textContent.trim() ?? null`), 15000);
  const qr = await ev(`(() => { const p = document.querySelector('.plex-link svg.qr path'); return p ? p.getAttribute('d').length : 0; })()`);
  ok('link with a code: the code and its QR code', /^[A-Z0-9]{4}$/.test(code) && qr > 500, `${code}, QR path ${qr} chars`);
  await ev(`document.querySelector('.plex-link').scrollIntoView({ block: 'center' })`);
  await shot(main, 'plex-link-code.png');
  await fetch(`${plex.plextv}/Mock/Pin/Link?code=${code}`, { method: 'POST' });

  // ---- D-3, then who is watching ----
  await until('login route', () => ev(`location.hash.startsWith('#/login/')`), 20000);
  const confirmText = await until('D-3 question', () => ev(`document.querySelector('[aria-labelledby="plex-confirm-title"]')?.textContent ?? null`), 15000);
  ok('D-3: the plain-http LAN address waits for the user', confirmText.includes(plex.pms) && plex.state.tokens.pms.length === 0, plex.pms);
  await shot(main, 'plex-confirm.png');
  await click('[aria-labelledby="plex-confirm-title"] button');
  await until('profiles', () => ev(`document.querySelectorAll('.profile[data-user]').length === 3`), 15000);
  ok('who is watching: the 3 Home users, no "other user"', await ev(`document.querySelectorAll('.profile').length === 3 && !!document.querySelector('.profile[data-user="b2c3d4e5f6071829"] .badge')`));
  await shot(main, 'plex-who.png');
  await click('.profile[data-user="b2c3d4e5f6071829"]');
  await until('PIN sheet', () => ev(`!!document.querySelector('.sheet input[type=password]')`), 5000);
  await ev(`(() => { const i = document.querySelector('.sheet input[type=password]'); i.value = '0000'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.sheet button[type=submit]').click(); return true; })()`);
  const wrong = await until('PIN error', () => ev(`document.querySelector('.sheet .error')?.textContent.trim() ?? null`), 10000);
  ok('a wrong PIN is refused with a clear message', /PIN/.test(wrong), wrong);
  await shot(main, 'plex-pin-wrong.png');
  await click('.sheet button.ghost');
  await sleep(400);
  await click('.profile[data-user="a1b2c3d4e5f60718"]');
  await until('home', () => ev(`location.hash.startsWith('#/home')`), 20000);
  const sid = MACHINE_ID;
  const uid = await ev(`wicaby.session.get().then((s) => s.sessions.find((x) => x.server.id === ${js(sid)}).user.id)`);

  // ---- Home: hubs and Continue Watching ----
  const titles = await until('home rows', () => ev(`(() => { const t = [...document.querySelectorAll('.home h2, .home .row-title, .home header h2')].map((h) => h.textContent.trim()); return t.includes('Sagas') && t.includes('Recently Added TV') ? t : null; })()`), 30000).catch(() => null);
  ok('Home shows the promoted hubs (Recently Added TV, Sagas)', !!titles, (titles ?? []).join(' | '));
  ok('Home: Continue Watching', (titles ?? []).some((x) => /Continue/i.test(x)));
  await shot(main, 'plex-home.png');

  // ---- Library: 12 films with posters ----
  await ev(`location.hash = ${js(`#/library/${sid}/section-1`)}`);
  const posters = await until('12 posters loaded', () => ev(`(() => { const imgs = [...document.querySelectorAll('.card img')]; const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0).length; return document.querySelectorAll('.card').length >= 12 && loaded >= 12 ? { cards: document.querySelectorAll('.card').length, loaded } : null; })()`), 30000).catch(() => null);
  ok('the Films library lists 12 films with their posters', posters?.cards === 12 && posters.loaded >= 12, js(posters));
  await shot(main, 'plex-library.png');

  // ---- The flattened show: episodes, no seasons ----
  await ev(`location.hash = ${js(`#/item/${sid}/2100`)}`);
  const flat = await until('flattened show episodes', () => ev(`document.querySelectorAll('.ep').length === 4 ? { eps: 4, tabs: document.querySelectorAll('.season').length } : null`), 20000).catch(() => null);
  ok('the flattened show lists its 4 episodes without season tabs', flat?.eps === 4 && flat.tabs === 0, js(flat));
  await shot(main, 'plex-flattened.png');

  // ---- Editions and a missing part ----
  await ev(`location.hash = ${js(`#/item/${sid}/1000`)}`);
  await until('item 1000', () => ev(`!!document.querySelector('.actions') && document.body.textContent.includes('Theatrical')`), 20000).catch(() => null);
  const versions = await ev(`wicaby.api.get('/Users/${uid}/Items/1000', undefined, ${js(sid)}).then((i) => i.MediaSources.map((m) => m.Name))`);
  ok('the film with two editions offers both versions', versions.join() === "Theatrical,Director's Cut" && (await ev(`document.body.textContent.includes('Theatrical')`)), versions.join(', '));
  await shot(main, 'plex-item-editions.png');
  const missing = await ev(`wicaby.api.get('/Users/${uid}/Items/1001', undefined, ${js(sid)}).then((i) => i.MediaSources.length)`);
  ok('the version whose file is missing is hidden', missing === 1, String(missing));

  // ---- Search: a single shared film ----
  await ev(`location.hash = '#/search?q=Agent%20327'`);
  const hit = await until('search result', () => ev(`[...document.querySelectorAll('.card')].some((c) => c.textContent.includes('Agent 327')) || null`), 20000).catch(() => null);
  ok('search finds the single shared film', !!hit);
  await shot(main, 'plex-search.png');

  // ---- Degradation (PX-07) and the watchlist (D-6) ----
  await ev(`location.hash = ${js(`#/item/${sid}/1003`)}`);
  await until('item 1003', () => ev(`!!document.querySelector('.actions')`), 20000);
  await sleep(600);
  const heart = await ev(`[...document.querySelectorAll('.actions button')].find((b) => /Favorites/.test(b.title))?.title ?? null`);
  ok('the heart is shown (the watchlist, D-6)', heart === 'Add to Favorites', heart ?? 'none');
  await ev(`[...document.querySelectorAll('.actions button')].find((b) => /Favorites/.test(b.title)).click()`);
  await until('watchlisted', () => (plex.state.watchlist['a1b2c3d4e5f60718'] ?? []).length === 1, 10000).catch(() => null);
  ok('the heart adds to the plex.tv watchlist', (plex.state.watchlist['a1b2c3d4e5f60718'] ?? []).join() === 'plex://movie/mock1003');
  const sidebar = await ev(`[...document.querySelectorAll('nav.sidebar :is(.link .label, .gname)')].map((l) => l.textContent.trim())`);
  ok('no Administration and no Live TV for the Plex owner', !sidebar.includes('Administration') && !sidebar.some((x) => /Live TV/i.test(x)), sidebar.join(', '));
  const targets = await ev(`wicaby.cast.targets('1003', ${js(sid)}).then((t) => t.filter((x) => x.section === 'apps').length)`);
  ok('no "Play on" rows from the Plex server (caps.sessionsRemote)', targets === 0, String(targets));
  await shot(main, 'plex-item.png');
  await ev(`location.hash = '#/favorites'`);
  const fav = await until('favorites', () => ev(`[...document.querySelectorAll('.card')].some((c) => c.textContent.includes('Big Buck') || c.querySelector('a')?.getAttribute('href')?.includes('/1003')) || null`), 20000).catch(() => null);
  ok('Favorites lists the watchlisted film', !!fav);
  await shot(main, 'plex-favorites.png');

  // ---- The same session with mock-emby keeps Administration and its heart ----
  await ev(`wicaby.servers.add(${js(`http://127.0.0.1:${EMBY_PORT}`)}).then((s) => wicaby.servers.select(s.id)).then(() => true)`);
  const embyId = await until('emby selected', () => ev(`wicaby.session.get().then((s) => s.sessions.find((x) => x.server.kind === 'emby' && x.status === 'server-selected')?.server.id ?? null)`), 30000);
  await ev(`wicaby.session.login('Wika', 'wicaby', ${js(embyId)}).then((s) => s.status)`);
  const movie = await ev(`wicaby.session.get().then((s) => s.sessions.find((x) => x.server.id === ${js(embyId)}).user.id).then((u) => wicaby.api.get('/Users/' + u + '/Items', { Recursive: true, IncludeItemTypes: 'Movie', Limit: 1 }, ${js(embyId)})).then((r) => r.Items[0].Id)`);
  await ev(`location.hash = ${js(`#/item/${embyId}/${movie}`)}`);
  await until('emby item', () => ev(`!!document.querySelector('.actions') && location.hash.includes(${js(movie)})`), 20000);
  await sleep(800);
  const embyHeart = await ev(`[...document.querySelectorAll('.actions button')].some((b) => /Favorites/.test(b.title))`);
  const embySidebar = await ev(`[...document.querySelectorAll('nav.sidebar .link .label')].map((l) => l.textContent.trim())`);
  ok('mock-emby in the same session keeps Administration and its heart', embyHeart && embySidebar.includes('Administration'), embySidebar.join(', '));

  // ---- Servers: the Plex card, the hide toggle (D-10) ----
  await ev(`location.hash = '#/servers'`);
  // A Plex server row's menu opens its account's sheet (the servers and their Show toggles).
  await until('plex row menu', () => ev(`(() => { const li = [...document.querySelectorAll('.sources > li')].find((l) => l.querySelector('.kind')?.textContent.trim() === 'Plex'); li?.querySelector('.more')?.click(); return !!li; })()`), 15000);
  await until('plex account item', () => click('.menu [role="menuitem"]', 'Plex Account'), 5000);
  await until('plex card', () => ev(`document.querySelectorAll('[data-plex-server]').length === 2`), 15000);
  await ev(`document.querySelector('.sheet').scrollIntoView({ block: 'center' })`);
  await shot(main, 'plex-servers.png');
  await ev(`document.querySelector('[data-plex-server="${SECOND_ID}"] .toggle').click()`);
  const hidden = await until('hidden', () => ev(`wicaby.servers.list().then((l) => l.find((s) => s.id === ${js(SECOND_ID)})?.plex?.hidden === true)`), 10000).catch(() => false);
  ok('the shared server can be hidden', hidden);
  await ev(`document.querySelector('.sheet').scrollIntoView({ block: 'center' })`);
  await shot(main, 'plex-servers-hidden.png');

  const bad = plex.state.tags.filter((t) => ['UNMAPPED', 'TOKEN-IN-URL', 'ACCOUNT-TOKEN-ON-PMS', 'NO-CLIENT-ID'].includes(t));
  ok('/Mock/State: no UNMAPPED, TOKEN-IN-URL, ACCOUNT-TOKEN-ON-PMS or NO-CLIENT-ID', bad.length === 0, bad.join(', '));
  const logs = fs.readdirSync(PROFILE, { recursive: true }).filter((f) => /\.log$/.test(f)).map((f) => fs.readFileSync(path.join(PROFILE, f), 'utf8')).join('\n');
  ok('no Plex token in the logs', !/mock-account-token|mock-pms-|mock-user-/.test(logs), `${logs.length} bytes`);
  const unmapped = [...new Set(logs.match(/PLEX-UNMAPPED [^\n]*/g) ?? [])];
  log(`info: PLEX-UNMAPPED in the log (the UI fallbacks): ${unmapped.join(' | ') || 'none'}`);
  if (pageErrors.length) log(`info: page errors: ${pageErrors.slice(0, 5).join(' | ')}`);
  main.close();
  kill(app);
  await plex.close();
}

let code = 1;
try {
  await run();
  code = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
} catch (e) {
  console.error('[plex-cdp] error', e.stack ?? e.message);
}
console.log(results.join('\n'));
for (const c of children) kill(c);
await sleep(800);
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
} catch {}
process.exit(code);
