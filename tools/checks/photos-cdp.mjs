#!/usr/bin/env node
// Photos PH-02..PH-04 acceptance run through the built desktop app (photos spec §5), against the generated mock
// photos only (never a real server or real photos). A logging proxy in front of the mock records every request
// (image sizes, /Items/{id}/Download, never /File); a main-process guard records playback.play and
// photos.keepAwake calls, and answers playback.play itself so no player starts (nothing makes a sound).
//
//   node tools/checks/photos-cdp.mjs [--flavour=jellyfin] [--only=orient] [--no-download] [--shots=<dir>]
//
// Default: mock Emby with MOCK_PHOTOS=20000 and the whole list. --flavour=jellyfin (with MOCK_PHOTO_ROTATE=client or
// server in the environment) checks the orientation rule there. --no-download runs the mock with MOCK_NO_DOWNLOAD=1.
// Not part of run-all: it needs Electron and a build (npm run build). Ports: PHCDP_MOCK_PORT (8893), PHCDP_PROXY_PORT
// (8894), PHCDP_CDP_PORT (9793). Exit 1 on any failure.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const JELLYFIN = args.flavour === 'jellyfin';
const ONLY = args.only ? String(args.only) : '';
const NO_DOWNLOAD = Boolean(args['no-download']);
const SHOTS = args.shots ? path.resolve(String(args.shots)) : null;
const MOCK_PORT = Number(process.env.PHCDP_MOCK_PORT ?? 8893);
const PROXY_PORT = Number(process.env.PHCDP_PROXY_PORT ?? 8894);
const CDP_PORT = Number(process.env.PHCDP_CDP_PORT ?? 9793);
const PHOTOS = Number(process.env.MOCK_PHOTOS ?? (ONLY ? 600 : 20000));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-phcdp-'));
const SPY = path.join(PROFILE, 'spy.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[photos-cdp]', ...m);
const js = JSON.stringify;
const results = [];
const ok = (name, cond, detail = '') => (results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`), log(results.at(-1)));
const want = (part) => !ONLY || ONLY.split('|').includes(part);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const children = [];
function start(cmd, argv, opts) {
  const c = spawn(cmd, argv, { stdio: process.env.PHCDP_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
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

// ---- Logging proxy: every request the app makes to the mock, with the time its answer ended.
const requests = [];
const proxy = http.createServer((req, res) => {
  const entry = { method: req.method, url: req.url, at: 0 };
  requests.push(entry);
  const up = http.request({ host: '127.0.0.1', port: MOCK_PORT, method: req.method, path: req.url, headers: req.headers }, (r) => {
    // The mock advertises its own LocalAddress: point it at the proxy so every request stays in the log.
    if (/\/System\/Info/i.test(req.url)) {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const body = Buffer.from(Buffer.concat(chunks).toString('utf8').replaceAll(`127.0.0.1:${MOCK_PORT}`, `127.0.0.1:${PROXY_PORT}`));
        res.writeHead(r.statusCode ?? 502, { ...r.headers, 'content-length': body.length });
        res.end(body);
        entry.at = Date.now();
      });
      return;
    }
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
    r.on('end', () => (entry.at = Date.now()));
  });
  up.on('error', () => (res.writeHead(502), res.end()));
  req.pipe(up);
});
proxy.on('upgrade', (req, socket, head) => {
  const up = net.connect(MOCK_PORT, '127.0.0.1', () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    up.write(head);
    up.pipe(socket).pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

// ---- Main-process guard: loopback-only UDP, windows that never take focus or the mouse, and the IPC spy.
const GUARD = String.raw`'use strict';
const fs = require('node:fs');
const dgram = require('node:dgram');
const send = dgram.Socket.prototype.send;
const loopback = (a) => a === 'localhost' || a === '::1' || /^127\./.test(a);
dgram.Socket.prototype.send = function (msg, ...rest) {
  const address = rest.find((a) => typeof a === 'string');
  const cb = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null;
  if (address !== undefined && !loopback(address)) { if (cb) process.nextTick(cb, null, 0); return; }
  return send.call(this, msg, ...rest);
};
const SPY = ${js(SPY)};
const Module = require('node:module');
const load = Module._load;
let hooked = false;
Module._load = function (request, ...rest) {
  const m = load.call(this, request, ...rest);
  if (!hooked && request === 'electron' && m && m.app) {
    hooked = true;
    m.app.on('browser-window-created', (_e, win) => { win.show = () => win.showInactive(); win.setFocusable(false); win.setIgnoreMouseEvents(true); });
    const handle = m.ipcMain.handle.bind(m.ipcMain);
    m.ipcMain.handle = (ch, fn) => handle(ch, (e, ...a) => {
      if (ch === 'playback:play' || ch === 'photos:keep-awake') fs.appendFileSync(SPY, JSON.stringify({ ch, a, at: Date.now() }) + '\n');
      if (ch === 'playback:play') return undefined;
      return fn(e, ...a);
    });
  }
  return m;
};
`;
// The mock's own PNGs: 8-bit RGB, filter 0 on every row (as photos-mock-check.mjs reads them).
function decodePng(buf) {
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const idat = [];
  for (let o = 8; o < buf.length; o += 12 + buf.readUInt32BE(o)) if (buf.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + buf.readUInt32BE(o)));
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return { w, h, at: (x, y) => [...raw.subarray(y * (w * 3 + 1) + 1 + x * 3, y * (w * 3 + 1) + 4 + x * 3)] };
}

const spy = () => (fs.existsSync(SPY) ? fs.readFileSync(SPY, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function seedProfile() {
  fs.mkdirSync(path.join(PROFILE, 'dl'), { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), js({ ui: { language: 'fr', reduceMotion: false, heroAutoplay: false, onboarded: true }, windows: { trayHintShown: true }, downloads: { folder: path.join(PROFILE, 'dl') } }));
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

const VK = { ArrowRight: 39, ArrowLeft: 37, ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27, ' ': 32, Backspace: 8, '+': 187, '0': 48, '-': 189, i: 73, f: 70, s: 83 };
async function key(page, k, modifiers = 0) {
  const text = k.length === 1 ? k : k === 'Enter' ? '\r' : undefined;
  const code = k.length === 1 ? (k === ' ' ? 'Space' : /\d/.test(k) ? `Digit${k}` : /[a-z]/.test(k) ? `Key${k.toUpperCase()}` : 'Equal') : k;
  const base = { key: k, code, windowsVirtualKeyCode: VK[k] ?? 0, modifiers };
  await page.call('Input.dispatchKeyEvent', { type: text && !modifiers ? 'keyDown' : 'rawKeyDown', ...base, ...(text && !modifiers ? { text } : {}) });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(60);
}
const frames = (page, n = 2) => page.evaluate(`new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r(true)); requestAnimationFrame(f); })`);
async function shot(page, name) {
  if (!SHOTS) return;
  const { data } = await page.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
  log(`screenshot ${name}`);
}

// In-page helpers.
const PAGE_JS = String.raw`
window.__ph = {
  s: () => document.getElementById('main-scroller'),
  tiles: () => [...document.querySelectorAll('.grid .tile')],
  loaded: () => Number(document.querySelector('.grid')?.dataset.loaded ?? -1),
  // The month header showing under the toolbar: the section that spans the toolbar's bottom edge.
  header: () => {
    const y = __ph.s().getBoundingClientRect().top + 57;
    const sec = [...document.querySelectorAll('.grid .month')].find((m) => { const r = m.getBoundingClientRect(); return r.top <= y && r.bottom > y; });
    return sec?.querySelector('.mhead')?.textContent.trim() ?? null;
  },
  firstVisible: () => {
    const top = __ph.s().getBoundingClientRect().top + 56;
    return __ph.tiles().map((t) => ({ t, r: t.getBoundingClientRect() })).filter((x) => x.r.top >= top).sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)[0]?.t ?? null;
  },
  scale: (sel) => Number(/scale\(([\d.]+)\)/.exec(document.querySelector(sel)?.style.transform ?? '')?.[1] ?? NaN),
  segment: (scope, label) => [...document.querySelectorAll(scope + ' .seg button')].find((b) => b.textContent.trim() === label),
};
true`;

async function run() {
  const mockEnv = { ...process.env, NODE_OPTIONS: '', MOCK_PHOTOS: String(PHOTOS), ...(NO_DOWNLOAD ? { MOCK_NO_DOWNLOAD: '1' } : {}) };
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', JELLYFIN ? 'mock-jellyfin.mjs' : 'mock-emby.mjs'), String(MOCK_PORT)], { cwd: ROOT, env: mockEnv });
  await until('mock', async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}${JELLYFIN ? '' : '/emby'}/System/Info/Public`)).ok, 60000, 200);
  await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
  const guard = seedProfile();
  const app = start(createRequire(path.join(DESKTOP, 'package.json'))('electron'), ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], {
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
  await ev(PAGE_JS);
  const uid = await ev(`wicaby.session.get().then((s) => s.sessions?.[0]?.user?.id ?? s.user?.id)`);
  const userItems = (q) => (JELLYFIN ? ev(`wicaby.api.get('/Items', ${js({ ...q, userId: uid })})`) : ev(`wicaby.api.get(${js(`/Users/${uid}/Items`)}, ${js(q)})`));
  await ev(`location.hash = '#/home'`);
  await sleep(1500);

  // ---------------- PH-02: the page ----------------
  const t0 = Date.now();
  await ev(`location.hash = '#/library/lib-photos'`);
  await until('first tile shown', () => ev(`__ph.tiles().some((t) => t.querySelector('img')?.complete && t.querySelector('img').naturalWidth > 0)`), 30000, 20);
  const tShown = Date.now();
  const firstItems = requests.find((r) => /\/Items\?/.test(r.url) && /IncludeItemTypes=Photo%2CVideo/.test(r.url) && /StartIndex=0\b/.test(r.url));
  const year = new Date().getFullYear();
  const wantYears = Array.from({ length: year - 2014 + 1 }, (_, i) => String(2014 + i));
  const early = await until('year ticks', () => ev(`(() => { const ys = [...document.querySelectorAll('.rail .tick')].map((t) => t.dataset.year); return ${js(wantYears)}.every((y) => ys.includes(y)) ? { loaded: __ph.loaded(), ys: ys.length } : null; })()`), 5000, 20).catch(() => null);
  if (want('page')) {
    ok('PH-02 AC1 tiles under 800 ms after the first /Items answer', firstItems?.at && tShown - firstItems.at < 800, `${firstItems?.at ? tShown - firstItems.at : '?'} ms after it, ${tShown - t0} ms after navigation`);
    ok('PH-02 AC1 scrubber year ticks 2014-today before the skeleton is in', Boolean(early) && early.loaded < PHOTOS, early ? `${early.ys} ticks with ${early.loaded}/${PHOTOS} loaded` : 'missing');
  }
  await until('skeleton', async () => (await ev(`__ph.loaded()`)) >= PHOTOS, 60000, 200);
  log(`skeleton ${PHOTOS} in ${Date.now() - t0} ms`);
  await shot(main, 'photos-timeline.png');
  const sizes = [...new Set(requests.filter((r) => /\/Items\/photo-\d+\/Images\/Primary/.test(r.url)).map((r) => new URL(r.url, 'http://x').searchParams.get('maxHeight')).filter(Boolean))];
  log(`grid thumbnail maxHeight values: ${sizes.join(', ')}; AutoOrient: ${requests.some((r) => /AutoOrient=true/.test(r.url))}`);

  if (want('page')) {
    // AC2: a 10-screen scroll and a scrubber drag to 2015.
    await ev(`(window.__lt = [], new PerformanceObserver((l) => __lt.push(...l.getEntries().map((e) => e.duration))).observe({ type: 'longtask' }), true)`);
    let most = 0;
    for (let i = 0; i < 10; i++) {
      await ev(`(__ph.s().scrollTop += __ph.s().clientHeight, true)`);
      await frames(main, 3);
      most = Math.max(most, await ev(`__ph.tiles().length`));
    }
    const rail = await ev(`(() => { const r = document.querySelector('.rail').getBoundingClientRect(); const t = document.querySelector('.rail .tick[data-year="2015"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y0: r.top + 4, y: t.top + t.height / 2 }; })()`);
    await main.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rail.x, y: rail.y0 });
    await main.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rail.x, y: rail.y0, button: 'left', clickCount: 1 });
    for (let k = 1; k <= 8; k++) {
      await main.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rail.x, y: rail.y0 + ((rail.y - rail.y0) * k) / 8, button: 'left', buttons: 1 });
      await frames(main, 1);
      most = Math.max(most, await ev(`__ph.tiles().length`));
    }
    await shot(main, 'photos-scrubber.png');
    await main.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rail.x, y: rail.y, button: 'left', clickCount: 1 });
    await frames(main, 3);
    const long = await ev(`__lt.filter((d) => d > 50)`);
    const head = await ev(`__ph.header()`);
    const valuetext = await ev(`document.querySelector('.rail').getAttribute('aria-valuetext')`);
    ok('PH-02 AC2 under 400 tiles in the DOM', most > 0 && most < 400, `max ${most}`);
    ok('PH-02 AC2 no long task over 50 ms', long.length === 0, long.length ? `${long.map((d) => Math.round(d)).join(', ')} ms` : 'none');
    ok('PH-02 AC2 scrubber to 2015: the header reads that month', Boolean(head) && head.includes('2015') && head === valuetext, `header "${head}", scrubber "${valuetext}"`);

    // AC3: density change keeps the anchor in the top third.
    const anchor = await ev(`__ph.firstVisible()?.dataset.id`);
    await ev(`(document.querySelector('.sizes button:last-child').click(), true)`);
    await frames(main, 4);
    const where = await ev(`(() => { const t = document.querySelector('.grid .tile[data-id="${anchor}"]'); if (!t) return null; const s = __ph.s().getBoundingClientRect(); const r = t.getBoundingClientRect(); return { top: r.top - s.top, third: s.height / 3 }; })()`);
    ok('PH-02 AC3 density change keeps the anchor in the top third', Boolean(where) && where.top >= 0 && where.top <= where.third, where ? `${anchor} at ${Math.round(where.top)} px (third ${Math.round(where.third)})` : `${anchor} gone`);
    await shot(main, 'photos-larger.png');
    await ev(`(document.querySelector('.sizes button:first-child').click(), true)`);
    await frames(main, 4);

    // AC4: arrows move by geometry; focus survives a 5-screen round trip.
    await ev(`(__ph.s().scrollTop = 0, true)`);
    await frames(main, 3);
    await ev(`(__ph.tiles().find((t) => t.dataset.index === '0').focus(), true)`);
    const pos = () => ev(`(() => { const a = document.activeElement; const r = a.getBoundingClientRect(); return { i: a.dataset.index, id: a.dataset.id, x: r.left, y: r.top }; })()`);
    const p0 = await pos();
    await key(main, 'ArrowRight');
    const p1 = await pos();
    await key(main, 'ArrowDown');
    const p2 = await pos();
    ok('PH-02 AC4 ArrowRight / ArrowDown move by geometry', p1.i === '1' && p1.x > p0.x && Math.abs(p1.y - p0.y) < 2 && p2.y > p1.y, `${p0.i} → ${p1.i} → ${p2.i}`);
    await ev(`(__ph.s().scrollTop += 5 * __ph.s().clientHeight, true)`);
    await frames(main, 4);
    const away = await ev(`document.activeElement?.dataset.id === ${js(p2.id)} && document.activeElement.isConnected`);
    await ev(`(__ph.s().scrollTop -= 5 * __ph.s().clientHeight, true)`);
    await frames(main, 4);
    const back = await ev(`document.activeElement?.dataset.id === ${js(p2.id)}`);
    ok('PH-02 AC4 focus survives scrolling 5 screens away and back', away && back);

    // AC5: labels (the axe run is not wired here: no axe dependency in the repo).
    const a11y = await ev(`(() => { const ts = __ph.tiles(); return { n: ts.length, unlabelled: ts.filter((t) => !t.getAttribute('aria-label')).length, sample: ts[0]?.getAttribute('aria-label'), rail: document.querySelector('.rail')?.getAttribute('aria-label') }; })()`);
    ok('PH-02 AC5 every tile has an aria-label', a11y.n > 0 && a11y.unlabelled === 0 && Boolean(a11y.rail), `${a11y.n} tiles, e.g. "${a11y.sample}"`);

    // AC6: the legacy "photos" collection type opens the same page.
    await ev(`location.hash = '#/library/lib-photos-legacy'`);
    const legacy = await until('legacy tiles', () => ev(`__ph.loaded() > 0 && __ph.loaded() !== ${PHOTOS} ? __ph.loaded() : 0`), 15000).catch(() => 0);
    ok('PH-02 AC6 lib-photos-legacy opens the Photos page', legacy === 40, `${legacy} assets`);
    await ev(`location.hash = '#/library/lib-photos'`);
    await until('timeline back', () => ev(`__ph.loaded() >= ${PHOTOS} && __ph.tiles().length > 0`), 15000);
  }

  // ---------------- PH-03: the viewer ----------------
  const openAt = async (sel) => {
    await ev(`(document.querySelector(${js(sel)}).focus(), true)`);
    await key(main, 'Enter');
    await until('viewer image', () => ev(`!!document.querySelector('.viewer .pic[data-id]')`), 10000, 30);
  };
  const shownId = () => ev(`document.querySelector('.viewer .pic[data-id]')?.dataset.id ?? null`);
  if (want('viewer')) {
    await ev(`(__ph.s().scrollTop = 0, true)`);
    await frames(main, 3);
    await openAt('.grid .tile[data-index="0"]');
    await shot(main, 'photos-viewer.png');
    await key(main, 'Escape');
    await frames(main, 3);
    ok('PH-03 AC1 Enter opens the viewer, Esc returns focus to the same tile', await ev(`!document.querySelector('.viewer') && document.activeElement?.dataset.index === '0'`));

    const order = await ev(`Array.from({ length: 21 }, (_, i) => document.querySelector('.grid .tile[data-index="' + i + '"]')?.dataset.id)`);
    await openAt('.grid .tile[data-index="0"]');
    const seen = [];
    let imgs = 0;
    for (let i = 0; i < 20; i++) {
      const before = await shownId();
      await key(main, 'ArrowRight');
      seen.push(await until('next image', async () => ((await shownId()) !== before ? shownId() : null), 8000, 20));
      imgs = Math.max(imgs, await ev(`document.querySelectorAll('.viewer img').length`));
    }
    ok('PH-03 AC2 → ×20 shows 20 different assets in timeline order, ≤ 3 img elements', new Set(seen).size === 20 && seen.every((id, i) => id === order[i + 1]) && imgs <= 3, `${new Set(seen).size} distinct, max ${imgs} img`);

    for (let i = 0; i < 4; i++) await key(main, '+');
    const zoomed = await ev(`__ph.scale('.viewer .layer')`);
    await key(main, '0');
    const fitted = await ev(`__ph.scale('.viewer .layer')`);
    const pt = await ev(`(() => { const r = document.querySelector('.viewer .layer').getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.4, l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
    await main.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: -120, modifiers: 2 });
    await frames(main, 3);
    const after = await ev(`(() => { const r = document.querySelector('.viewer .layer').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
    const fx = (pt.x - pt.l) / pt.w;
    const fy = (pt.y - pt.t) / pt.h;
    const drift = Math.hypot(after.l + fx * after.w - pt.x, after.t + fy * after.h - pt.y);
    ok('PH-03 AC3 + ×4 zooms, 0 fits, ctrl+wheel zooms around the cursor', zoomed > 2 && fitted === 1 && after.w > pt.w && drift < 2, `×${zoomed.toFixed(2)} → ×${fitted}, drift ${drift.toFixed(2)} px`);
    await key(main, '0');

    while (await ev(`!!document.querySelector('.viewer .play')`)) {
      const at = await shownId();
      await key(main, 'ArrowRight');
      await until('next image', async () => ((await shownId()) !== at ? true : null), 8000, 20);
    }
    await key(main, 'i');
    const info = await until('info panel', () => ev(`(() => { const dl = document.querySelector('.viewer .info dl'); return dl && dl.querySelectorAll('dt').length > 2 ? { dt: [...dl.querySelectorAll('dt')].map((d) => d.textContent.trim()), text: dl.textContent } : null; })()`), 8000);
    await shot(main, 'photos-viewer-info.png');
    const need = ['Appareil', 'Exposition', 'Focale', 'Sensibilité', 'Dimensions'];
    ok('PH-03 AC5 info panel lists the EXIF fields, no aperture (G2), no "—"', need.every((n) => info.dt.includes(n)) && !info.dt.includes('Ouverture') && !info.text.includes('—'), info.dt.join(' / '));
    await key(main, 'i');
    await key(main, 'Escape');
    await frames(main, 3);

    // AC6: a clip's play button calls playback.play with that one id.
    const clip = await until('a clip tile', async () => {
      const id = await ev(`__ph.tiles().find((t) => t.querySelector('.badge'))?.dataset.index ?? null`);
      if (id === null) await ev(`(__ph.s().scrollTop += __ph.s().clientHeight, true)`);
      return id;
    }, 20000, 150);
    await openAt(`.grid .tile[data-index="${clip}"]`);
    const clipId = await shownId();
    const before = spy().length;
    await ev(`(document.querySelector('.viewer .play').click(), true)`);
    const call = await until('playback.play', () => spy().slice(before).find((c) => c.ch === 'playback:play'), 5000).catch(() => null);
    ok('PH-03 AC6 a clip plays through playback.play with that one id', Boolean(call) && js(call.a[0]?.itemIds) === js([clipId]), call ? js(call.a[0]) : 'no call');
    await key(main, 'Escape');
    await ev(`(__ph.s().scrollTop = 0, true)`);
    await frames(main, 3);
  }

  if (want('orient') || want('viewer')) {
    // AC4: a quarter-turn asset shows upright: its marker row is on top in a canvas read-back of what is shown.
    const all = await userItems({ ParentId: 'lib-photos', Recursive: true, IncludeItemTypes: 'Photo', Limit: 400, SortBy: 'DateCreated,SortName', SortOrder: 'Descending', Fields: 'Width,Height' });
    const turned = new Set(all.Items.filter((x) => ['RightTop', 'LeftBottom'].includes(x.ImageOrientation)).map((x) => x.Id));
    const tile = await until('a quarter-turn tile', async () => {
      const i = await ev(`__ph.tiles().find((t) => ${js([...turned])}.includes(t.dataset.id) && t.querySelector('img')?.complete)?.dataset.index ?? null`);
      if (i === null) await ev(`(__ph.s().scrollTop += __ph.s().clientHeight, true)`);
      return i;
    }, 30000, 200);
    const gridTurn = await ev(`!!document.querySelector('.grid .tile[data-index="${tile}"] img.turned')`);
    await openAt(`.grid .tile[data-index="${tile}"]`);
    // What the viewer shows: the very image it decoded (re-read from the mock), turned as its CSS turns it.
    const pic = await ev(`(() => { const p = document.querySelector('.viewer .pic[data-id]'); return { src: p.src, turn: Number(p.dataset.turn) }; })()`);
    const png = decodePng(Buffer.from(await (await fetch(pic.src.replace(/^wicaby-media:\/\/api(\/[0-9a-f]{32})?/, `http://127.0.0.1:${MOCK_PORT}${JELLYFIN ? '' : '/emby'}`))).arrayBuffer()));
    const edge = (fn, n) => Array.from({ length: n }, (_, k) => fn(k)).filter(([r, g, b]) => r === 255 && g === 0 && b === 255).length / n;
    // A clockwise quarter turn puts the stored left column on top; a counter-clockwise one the right column.
    const top = pic.turn === 90 ? edge((y) => png.at(0, y), png.h) : pic.turn === 270 ? edge((y) => png.at(png.w - 1, y), png.h) : edge((x) => png.at(x, 0), png.w);
    const left = pic.turn === 90 ? edge((x) => png.at(x, png.h - 1), png.w) : pic.turn === 270 ? edge((x) => png.at(x, 0), png.w) : edge((y) => png.at(0, y), png.h);
    const read = { turn: pic.turn, top, left, w: pic.turn % 180 ? png.h : png.w, h: pic.turn % 180 ? png.w : png.h };
    await shot(main, `photos-orient-${JELLYFIN ? `jellyfin-${process.env.MOCK_PHOTO_ROTATE ?? 'client'}` : 'emby'}.png`);
    ok(`PH-03 AC4 quarter-turn asset upright (${JELLYFIN ? `Jellyfin, MOCK_PHOTO_ROTATE=${process.env.MOCK_PHOTO_ROTATE ?? 'client'}` : 'Emby AutoOrient'})`, read.top > 0.9 && read.left < 0.2 && read.h > read.w, `turn ${read.turn}°, marker on top ${Math.round(read.top * 100)} %, grid tile turned ${gridTurn}`);
    await key(main, 'Escape');
  }

  // ---------------- PH-04: albums, favourites, slideshow, save original ----------------
  if (want('albums')) {
    await ev(`(__ph.segment('.photos', 'Albums').click(), true)`);
    const albums = await until('albums', () => ev(`(() => { const a = [...document.querySelectorAll('.album')]; return a.length && a.every((x) => x.querySelector('img')?.complete) ? a.map((x) => x.querySelector('.name').textContent.trim()) : null; })()`), 10000);
    await shot(main, 'photos-albums.png');
    const api = await userItems({ ParentId: 'lib-photos', IncludeItemTypes: 'PhotoAlbum', Recursive: false, SortBy: 'SortName' });
    ok('PH-04 AC1 the Albums tab lists the 6 albums with covers', albums.length === 6 && api.Items.length === 6, albums.join(', '));
    const first = api.Items.find((x) => x.Name === albums[0]);
    await ev(`(document.querySelector('.album').click(), true)`);
    const n = await until('album timeline', async () => {
      const v = await ev(`__ph.loaded()`);
      return v > 0 && v === (await ev(`__ph.loaded()`)) && (await ev(`!!document.querySelector('.grid .tile')`)) ? v : 0;
    }, 15000, 300);
    const inAlbum = await userItems({ ParentId: first.Id, Recursive: true, IncludeItemTypes: 'Photo,Video', Limit: 0 });
    ok('PH-04 AC1 an album shows only its photos', n === inAlbum.TotalRecordCount && n === first.ChildCount, `${n} shown, ${inAlbum.TotalRecordCount} in the album, ChildCount ${first.ChildCount}`);

    await ev(`(__ph.segment('.photos', 'Favoris').click(), true)`);
    const favs = await userItems({ ParentId: 'lib-photos', Recursive: true, IncludeItemTypes: 'Photo,Video', Filters: 'IsFavorite', Limit: 0 });
    const nf = await until('favourites', async () => ((await ev(`__ph.loaded()`)) >= favs.TotalRecordCount ? ev(`__ph.loaded()`) : 0), 20000, 300);
    ok('PH-04 AC2 the Favourites tab equals Filters=IsFavorite', nf === favs.TotalRecordCount, `${nf} / ${favs.TotalRecordCount}`);
    await ev(`(__ph.segment('.photos', 'Chronologie').click(), true)`);
    await until('timeline', () => ev(`__ph.loaded() >= ${PHOTOS} && __ph.tiles().length > 0`), 20000);
    await openAt('.grid .tile[data-index="0"]');
    const fid = await shownId();
    const fav = async () => (await ev(`wicaby.api.get(${js(JELLYFIN ? `/Items/${fid}` : `/Users/${uid}/Items/${fid}`)}, ${js(JELLYFIN ? { userId: uid } : {})})`)).UserData?.IsFavorite === true;
    const was = await fav();
    await key(main, 'f');
    const flipped = await until('favourite flipped', async () => ((await fav()) !== was ? true : null), 5000).catch(() => false);
    await key(main, 'f');
    const restored = await until('favourite restored', async () => ((await fav()) === was ? true : null), 5000).catch(() => false);
    ok('PH-04 AC2 f in the viewer flips the favourite on the server', flipped && restored, `${was} → ${!was} → ${was}`);

    // AC4: save the original through /Items/{id}/Download.
    await ev(`(document.querySelector('.viewer .more button').click(), true)`);
    await frames(main, 2);
    await ev(`(document.querySelector('.viewer .menu button').click(), true)`);
    const toastText = await until('save toast', () => ev(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).find((x) => /Original enregistré|ne vous autorise pas/.test(x)) ?? null`), 20000, 200).catch(() => null);
    const dl = requests.filter((r) => r.url.includes(`/Items/${fid}/Download`));
    const file = requests.some((r) => /\/Items\/[^/]+\/File\b/.test(r.url));
    ok(`PH-04 AC4 save original ${NO_DOWNLOAD ? '(MOCK_NO_DOWNLOAD=1: error toast)' : ''}`, dl.length > 0 && !file && (NO_DOWNLOAD ? /ne vous autorise pas/.test(toastText ?? '') : /Original enregistré/.test(toastText ?? '')), `${dl.length} Download request(s), /File ${file ? 'CALLED' : 'never'}, toast "${toastText}"`);
    if (!NO_DOWNLOAD) log(`saved: ${fs.readdirSync(path.join(PROFILE, 'dl'), { recursive: true }).join(', ')}`);
    await key(main, 'Escape');
    await frames(main, 2);

    // AC3: slideshow at 3 s.
    await ev(`(document.querySelector('.toolbar .btn:not(.icon)').click(), true)`);
    await until('slideshow', () => ev(`Number(document.querySelector('.show')?.dataset.index ?? -1) >= 0`), 10000);
    await ev(`(document.querySelector('.show .seg button').click(), true)`);
    const ticks = async (ms) => {
      let last = await ev(`document.querySelector('.show').dataset.index`);
      let n = 0;
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await sleep(100);
        const v = await ev(`document.querySelector('.show').dataset.index`);
        if (v !== last) (n++, (last = v));
      }
      return n;
    };
    const advanced = await ticks(10000);
    await shot(main, 'photos-slideshow.png');
    await key(main, ' ');
    const whilePaused = await ticks(4000);
    await ev(`wicaby.settings.update({ ui: { reduceMotion: true } }).then(() => true)`);
    await sleep(500);
    await key(main, 'ArrowRight');
    await sleep(300);
    const cut = await ev(`parseFloat(getComputedStyle([...document.querySelectorAll('.show .slide')].at(-1)).animationDuration)`);
    await ev(`wicaby.settings.update({ ui: { reduceMotion: false } }).then(() => true)`);
    await key(main, 'Escape');
    await frames(main, 3);
    await sleep(500);
    const awake = spy().filter((c) => c.ch === 'photos:keep-awake').map((c) => c.a[0]);
    ok('PH-04 AC3 slideshow: 3 advances in 10 s at 3 s (±1)', advanced >= 2 && advanced <= 4, `${advanced}`);
    ok('PH-04 AC3 Space pauses', whilePaused === 0, `${whilePaused} advances while paused`);
    ok('PH-04 AC3 reduced motion: the transition is a cut', cut < 0.01, `${cut}s`);
    ok('PH-04 AC3 Esc exits and releases the wake lock', (await ev(`!document.querySelector('.show')`)) && js(awake.slice(-2)) === js([true, false]), `keepAwake calls ${js(awake)}`);
  }

  // ---------------- PH-03 AC7: the comic reader after the zoom extraction ----------------
  if (want('reader')) {
    await ev(`location.hash = '#/read/comic-1'`);
    await until('reader page', () => ev(`!!document.querySelector('.folio')`), 20000, 200);
    await sleep(800);
    const page0 = await ev(`document.querySelector('.folio').textContent`);
    for (let i = 0; i < 3; i++) await key(main, '+');
    const z = await ev(`/\\d+\\s?%/.test(document.querySelector('.t2').textContent) ? document.querySelector('.t2').textContent : ''`);
    await key(main, '0');
    await key(main, 'ArrowRight');
    const page1 = await until('page turn', async () => ((await ev(`document.querySelector('.folio').textContent`)) !== page0 ? ev(`document.querySelector('.folio').textContent`) : null), 5000).catch(() => page0);
    ok('PH-03 AC7 comic reader opens, zooms and turns pages', Boolean(z) && page1 !== page0, `zoom "${z.split('·').pop()?.trim()}", page ${page0.trim()} → ${page1.trim()}`);
    await key(main, 'Escape');
  }

  // Privacy: no coordinates in the app's log (spec §6.1).
  const logs = fs.readdirSync(PROFILE, { recursive: true }).filter((f) => /\.log$/.test(f)).map((f) => fs.readFileSync(path.join(PROFILE, f), 'utf8')).join('\n');
  const coords = /(48\.8|45\.76|38\.69|64\.14|34\.99|45\.83|2\.29|4\.82|-9\.21|-21\.92|135\.78|6\.86)\d\d/.exec(logs);
  ok('privacy: no landmark coordinates in the main log', !coords, coords ? coords[0] : `${logs.length} bytes of log`);
  main.close();
  kill(app);
}

let code = 1;
try {
  await run();
  code = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
} catch (e) {
  console.error('[photos-cdp] error', e.stack ?? e.message);
}
console.log(results.join('\n'));
for (const c of children) kill(c);
proxy.close();
await sleep(800);
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
} catch {}
process.exit(code);
