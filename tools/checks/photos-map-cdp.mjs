#!/usr/bin/env node
// Photos PH-08 (memories) and PH-09 (map, opt-in) acceptance run through the built desktop app, against the generated
// mock photos (fake EXIF and positions around public landmarks; never a real server or real photos) and a fake tile
// server on 127.0.0.1 (no Internet). A logging proxy in front of the mock counts the memories queries.
//
//   node tools/checks/photos-map-cdp.mjs [--shots=<dir>]
//
// Not part of run-all: it needs Electron and a build (npm run build). Ports: PMCDP_MOCK_PORT (8895), PMCDP_PROXY_PORT
// (8896), PMCDP_TILE_PORT (8897), PMCDP_CDP_PORT (9795). Exit 1 on any failure.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { png } from '../mock-server/cbz-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const SHOTS = args.shots ? path.resolve(String(args.shots)) : null;
const MOCK_PORT = Number(process.env.PMCDP_MOCK_PORT ?? 8895);
const PROXY_PORT = Number(process.env.PMCDP_PROXY_PORT ?? 8896);
const TILE_PORT = Number(process.env.PMCDP_TILE_PORT ?? 8897);
const CDP_PORT = Number(process.env.PMCDP_CDP_PORT ?? 9795);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-pmcdp-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[photos-map-cdp]', ...m);
const js = JSON.stringify;
const results = [];
const ok = (name, cond, detail = '') => (results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`), log(results.at(-1)));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const children = [];
function start(cmd, argv, opts) {
  const c = spawn(cmd, argv, { stdio: process.env.PMCDP_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
  children.push(c);
  return c;
}
function kill(c) {
  if (c.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(c.pid)], { stdio: 'ignore' });
  else c.kill('SIGTERM');
}
async function until(what, fn, timeoutMs = 30000, every = 100) {
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

// ---- Logging proxy in front of the mock.
const requests = [];
const proxy = http.createServer((req, res) => {
  requests.push(req.url);
  const up = http.request({ host: '127.0.0.1', port: MOCK_PORT, method: req.method, path: req.url, headers: req.headers }, (r) => {
    if (/\/System\/Info/i.test(req.url)) {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const body = Buffer.from(Buffer.concat(chunks).toString('utf8').replaceAll(`127.0.0.1:${MOCK_PORT}`, `127.0.0.1:${PROXY_PORT}`));
        res.writeHead(r.statusCode ?? 502, { ...r.headers, 'content-length': body.length });
        res.end(body);
      });
      return;
    }
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => (res.writeHead(502), res.end()));
  req.pipe(up);
});

// ---- Fake tile server: a plain grid tile for any z/x/y, every request recorded.
const TILE = png(256, 256, (x, y) => (x % 64 === 0 || y % 64 === 0 ? [120, 130, 140] : [196, 204, 210]));
const tileHits = [];
const tiles = http.createServer((req, res) => {
  const m = /^\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(req.url);
  tileHits.push({ url: req.url, z: m ? Number(m[1]) : -1, x: m ? Number(m[2]) : -1, y: m ? Number(m[3]) : -1, ua: req.headers['user-agent'] });
  if (!m) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': TILE.length, 'Cache-Control': 'max-age=60' }).end(TILE);
});

// Windows that never take focus or the mouse (the run never moves the user's pointer or keyboard focus).
const GUARD = String.raw`'use strict';
const Module = require('node:module');
const load = Module._load;
let hooked = false;
Module._load = function (request, ...rest) {
  const m = load.call(this, request, ...rest);
  if (!hooked && request === 'electron' && m && m.app) {
    hooked = true;
    m.app.on('browser-window-created', (_e, win) => { win.show = () => win.showInactive(); win.setFocusable(false); win.setIgnoreMouseEvents(true); });
    // The slideshow keeps the display awake and goes full screen: neither is needed to check it.
    const handle = m.ipcMain.handle.bind(m.ipcMain);
    m.ipcMain.handle = (ch, fn) => handle(ch, (e, ...a) => (ch === 'photos:keep-awake' || ch === 'window:toggle-fullscreen' ? undefined : fn(e, ...a)));
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
  return { call, evaluate, close: () => ws.close() };
}
async function shot(page, name) {
  if (!SHOTS) return;
  const { data } = await page.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
  log(`screenshot ${name}`);
}
async function drag(page, x0, y0, dx, dy) {
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
  for (let k = 1; k <= 10; k++) await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (dx * k) / 10, y: y0 + (dy * k) / 10, button: 'left', buttons: 1 }), await sleep(16);
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + dx, y: y0 + dy, button: 'left', clickCount: 1 });
}
async function key(page, k, vk, text) {
  await page.call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk });
  await sleep(80);
}
async function click(page, x, y) {
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function run() {
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT)], { cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '', MOCK_PHOTOS: '600' } });
  await until('mock', async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/emby/System/Info/Public`)).ok, 60000, 200);
  await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
  await new Promise((r) => tiles.listen(TILE_PORT, '127.0.0.1', r));
  fs.writeFileSync(
    path.join(PROFILE, 'settings.json'),
    js({ ui: { language: 'fr', heroAutoplay: false, onboarded: true }, windows: { trayHintShown: true }, photos: { map: { enabled: false, tileUrl: `http://127.0.0.1:${TILE_PORT}/{z}/{x}/{y}.png` } } }),
  );
  const guard = path.join(PROFILE, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  start(createRequire(path.join(DESKTOP, 'package.json'))('electron'), ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_URL: '', NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
  const main = await attach((t) => /^(app:|http:\/\/localhost)/.test(t.url) && !t.url.includes('osd=1'));
  const ev = main.evaluate;
  await until('bridge', () => ev(`!!window.wicaby`), 60000, 300);
  await ev(`wicaby.servers.add(${js(`http://127.0.0.1:${PROXY_PORT}`)}).then((s) => wicaby.servers.select(s.id)).then(() => true)`);
  await until('server selected', () => ev(`wicaby.session.get().then((s) => s.status === 'server-selected' || s.status === 'signed-in')`), 30000, 300);
  const status = await ev(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
  if (status !== 'signed-in') throw new Error(`sign-in ${status}`);

  // ---------------- PH-08: "Ce jour-là" on Home ----------------
  await ev(`location.hash = '#/home'`);
  const titles = await until('memories row', () => ev(`(() => { const b = [...document.querySelectorAll('.memory .name')].map((n) => n.textContent.trim()); return b.length ? b : null; })()`), 30000, 200).catch(() => null);
  ok('PH-08 AC1 desktop home: "Ce jour-là" with 1, 3 and 7 years ago, in that order', js(titles) === js(['Il y a 1 an', 'Il y a 3 ans', 'Il y a 7 ans']), js(titles));
  const rowTitle = await ev(`[...document.querySelectorAll('.row h2')].map((h) => h.textContent.trim()).find((t) => t === 'Ce jour-là') ?? null`);
  ok('PH-08 row titled "Ce jour-là"', rowTitle === 'Ce jour-là');
  await ev(`(document.querySelector('.memory').scrollIntoView({ block: 'center' }), true)`);
  await sleep(1200);
  await shot(main, 'home-memories.png');
  const years = () => requests.filter((u) => /\/Years\?/.test(u) && /IncludeItemTypes=Photo(&|$)/.test(u) && !/ParentId=/.test(u)).length;
  const ranges = () => requests.filter((u) => /MinPremiereDate=/.test(u)).length;
  const first = { years: years(), ranges: ranges() };
  ok('PH-08 AC3 one /Years call and at most 10 ranges', first.years === 1 && first.ranges > 0 && first.ranges <= 10, js(first));
  await ev(`location.hash = '#/favorites'`);
  await sleep(800);
  await ev(`location.hash = '#/home'`);
  await until('memories again', () => ev(`document.querySelectorAll('.memory').length === 3`), 15000, 200);
  ok('PH-08 AC3 cached until the date changes (no new query on return)', years() === first.years && ranges() === first.ranges, js({ years: years(), ranges: ranges() }));

  // The story: the slideshow on a title card.
  await ev(`(document.querySelector('.memory').click(), true)`);
  const intro = await until('story title card', () => ev(`document.querySelector('.show .intro h2')?.textContent.trim() ?? null`), 15000, 100).catch(() => null);
  ok('PH-08 a card opens the story with its title card', intro === 'Il y a 1 an', String(intro));
  await sleep(700);
  await shot(main, 'memory-story.png');
  await key(main, 'Escape', 27);
  await until('story closed', () => ev(`!document.querySelector('.show[role="dialog"]')`), 5000, 100);

  // AC4: hidden in the home layout, the row and its queries go.
  const before = years();
  const userKey = await ev(`wicaby.session.get().then((s) => s.server.id + '/' + s.user.id)`);
  await ev(`wicaby.settings.update({ ui: { homeRows: [{ user: ${js(userKey)}, order: [], hidden: ['memories'] }] } }).then(() => true)`);
  await sleep(1500);
  ok('PH-08 AC4 the row can be hidden like the others', (await ev(`document.querySelectorAll('.memory').length`)) === 0 && years() === before);
  await ev(`wicaby.settings.update({ ui: { homeRows: [] } }).then(() => true)`);

  // ---------------- PH-09 AC1: map off ----------------
  await ev(`location.hash = '#/library/lib-photos'`);
  await until('photo grid', () => ev(`document.querySelectorAll('.grid .tile').length > 0`), 30000, 200);
  const tabsOff = await ev(`[...document.querySelectorAll('.toolbar .seg button')].map((b) => b.textContent.trim())`);
  ok('PH-09 AC1 map off: no Map tab', tabsOff.length > 0 && !tabsOff.includes('Carte'), js(tabsOff));
  // The info panel of a geotagged photo: coordinates, no map.
  const geoId = await ev(`(async () => { const s = await wicaby.session.get(); const r = await wicaby.api.get('/Users/' + s.user.id + '/Items', { ParentId: 'lib-photos', Recursive: true, IncludeItemTypes: 'Photo', Limit: 200 }); return r.Items.find((x) => x.Latitude != null)?.Id ?? null; })()`);
  await ev(`(document.querySelector('.grid .tile').focus(), true)`);
  await key(main, 'Enter', 13, '\r');
  await sleep(800);
  ok('PH-09 AC1 map off: no map anywhere, zero tile requests', (await ev(`!document.querySelector('.leaflet-container')`)) && tileHits.length === 0, `${tileHits.length} tile requests, geotagged sample ${geoId ? 'found' : 'missing'}`);
  await key(main, 'Escape', 27);
  await sleep(500);

  // ---------------- PH-09: the setting ----------------
  await ev(`location.hash = '#/settings?pane=privacy'`);
  await until('privacy pane', () => ev(`!!document.querySelector('.group.map')`), 15000, 200);
  await ev(`(document.querySelector('.group.map').scrollIntoView({ block: 'center' }), true)`);
  await sleep(400);
  await shot(main, 'settings-map-off.png');
  await ev(`wicaby.settings.update({ photos: { map: { enabled: true } } }).then(() => true)`);
  await until('tile url field', () => ev(`!!document.querySelector('.group.map input')`), 5000, 100);
  await sleep(300);
  await shot(main, 'settings-map-on.png');

  // ---------------- PH-09: the map ----------------
  await ev(`location.hash = '#/library/lib-photos'`);
  await until('map tab', () => ev(`[...document.querySelectorAll('.toolbar .seg button')].some((b) => b.textContent.trim() === 'Carte')`), 30000, 200);
  await ev(`([...document.querySelectorAll('.toolbar .seg button')].find((b) => b.textContent.trim() === 'Carte').click(), true)`);
  await until('tiles shown', () => ev(`document.querySelectorAll('.leaflet-tile-loaded').length > 0 && document.querySelectorAll('.pm-marker').length > 0`), 30000, 200);
  await sleep(1500);
  await shot(main, 'photos-map.png');
  const zoomOf = () => ev(`(() => { const t = document.querySelector('.leaflet-tile-loaded'); return t ? Number(/tile\\/(\\d+)\\//.exec(t.src)[1]) : -1; })()`);
  const z0 = await zoomOf();
  ok('PH-09 AC2 upstream User-Agent identifies Wicaby', tileHits.length > 0 && tileHits.every((h) => /^Wicaby\/\d+\.\d+\.\d+ \(\+https:\/\//.test(h.ua ?? '')), tileHits[0]?.ua);
  const attr = await ev(`(() => { const a = document.querySelector('.leaflet-control-attribution'); if (!a) return null; const r = a.getBoundingClientRect(); const s = getComputedStyle(a); return { text: a.textContent.trim(), visible: r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 }; })()`);
  ok('PH-09 AC6 attribution in the DOM and visible', attr?.visible && attr.text.includes('OpenStreetMap'), js(attr));

  // AC4: a pan asks only for tiles at the zoom shown (none at z±1), within the viewport before and after.
  const box = await ev(`(() => { const r = document.querySelector('.leaflet-container').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const n0 = tileHits.length;
  await drag(main, box.x + box.w / 2, box.y + box.h / 2, -300, -120);
  await sleep(1500);
  const after = tileHits.slice(n0);
  const zs = [...new Set(tileHits.map((h) => h.z))];
  const perView = (Math.ceil(box.w / 256) + 1) * (Math.ceil(box.h / 256) + 1);
  ok('PH-09 AC4 pan: only the zoom shown, no z±1 prefetch', zs.length === 1 && zs[0] === z0, `zooms ${js(zs)}, map at ${z0}`);
  ok('PH-09 AC4 pan: only tiles in view', after.length > 0 && after.length <= perView, `${after.length} new tiles, at most ${perView} per view`);

  // Markers: a click zooms in, the deepest group opens the viewer.
  const markers = await ev(`[...document.querySelectorAll('.pm-marker')].map((m) => Number(m.querySelector('span')?.textContent ?? 1))`);
  log(`markers at zoom ${z0}: ${js(markers)}`);
  let opened = false;
  for (let k = 0; k < 8 && !opened; k++) {
    const m = await ev(`(() => { const c = document.querySelector('.leaflet-container').getBoundingClientRect(); const m = [...document.querySelectorAll('.pm-marker')].map((e) => e.getBoundingClientRect()).find((r) => r.left > c.left && r.right < c.right && r.top > c.top && r.bottom < c.bottom); return m ? { x: m.left + m.width / 2, y: m.top + m.height / 2 } : null; })()`);
    if (!m) break;
    await click(main, m.x, m.y);
    await sleep(900);
    opened = await ev(`!!document.querySelector('.viewer, [role="dialog"] img')`);
  }
  const z1 = await zoomOf();
  ok('PH-09 a group click zooms in, the deepest opens the viewer', opened && z1 > z0, `zoom ${z0} → ${z1}, viewer ${opened}`);
  if (opened) await shot(main, 'photos-map-viewer.png');

  // AC8: no coordinates in the main log.
  const logs = fs.readdirSync(path.join(PROFILE, 'logs')).map((f) => fs.readFileSync(path.join(PROFILE, 'logs', f), 'utf8')).join('\n');
  const marks = ['48.85', '2.294', '45.76', '4.822', '38.69', '-9.21', '64.14', '-21.92', '34.99', '135.7', '45.83', '6.865', 'tile/'];
  const leaked = marks.filter((m) => logs.includes(m));
  ok('PH-09 AC8 no coordinates or tile addresses in the main log', leaked.length === 0 && logs.length > 0, leaked.length ? js(leaked) : `${logs.length} bytes read`);

  // Off again: the tab goes and the tile cache is forgotten.
  await ev(`wicaby.settings.update({ photos: { map: { enabled: false } } }).then(() => true)`);
  await sleep(800);
  const tabsAgain = await ev(`[...document.querySelectorAll('.toolbar .seg button')].map((b) => b.textContent.trim())`);
  ok('PH-09 map turned off: Map tab gone, tile cache deleted', !tabsAgain.includes('Carte') && !fs.existsSync(path.join(PROFILE, 'tiles')), js(tabsAgain));
  const n1 = tileHits.length;
  await ev(`fetch('wicaby-media://tile/3/4/2').then((r) => r.status).catch(() => 0)`);
  ok('PH-09 AC1 map off: the proxy asks nothing upstream', tileHits.length === n1);
  main.close();
}

let failed = false;
try {
  await run();
} catch (e) {
  failed = true;
  log('ERROR', e.stack ?? e.message);
} finally {
  for (const c of children.reverse()) kill(c);
  proxy.close();
  tiles.close();
  await sleep(500);
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    // Windows may keep the profile locked a little longer.
  }
}
console.log('\n' + results.join('\n'));
const bad = failed || results.some((r) => r.startsWith('FAIL'));
console.log(bad ? '\nphotos-map-cdp: FAILED' : `\nphotos-map-cdp: ${results.length} checks passed`);
process.exit(bad ? 1 : 0);
