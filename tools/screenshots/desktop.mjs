#!/usr/bin/env node
// Desktop screenshots for the README (docs/screenshots/desktop-*.png).
//
//   node tools/screenshots/desktop.mjs                 every shot
//   node tools/screenshots/desktop.mjs --only=home,item --raw
//   node tools/screenshots/desktop.mjs --frames        the README demo (docs/screenshots/demo.webp)
//
// What it does, start to finish:
//  1. starts the mock Emby server with the demo dataset (MOCK_DATASET=demo, French titles first) and the
//     IPTV-scale Live TV (MOCK_LIVETV=iptv: 300 channels, 7 days);
//  2. seeds a throwaway profile in .dev/ud-shots (the mock server, French UI, solid graphite background:
//     CDP captures Mica as white, so ui.reduceTransparency is on);
//  3. runs the dev app (apps/desktop/scripts/dev.mjs) with --remote-debugging-port, signs in as Wika / wicaby;
//  4. drives the renderer over CDP the way apps/desktop/scripts/cdp.mjs does, with the viewport pinned to
//     1600x1000 at 1x, and captures each page;
//  5. restarts the mock in English and captures the English home (desktop-home-en.png);
//     (The reader shot opens a CBZ cut from the demo artwork, put in the reader cache: see seedComic.)
//  6. quantizes every capture to a 256-colour PNG (no native dependency) and writes it to docs/screenshots/.
//
// Safety: the app only talks to the local mock. A small guard loaded through NODE_OPTIONS drops UDP sent
// anywhere but loopback (the Servers page's LAN discovery, Wake-on-LAN), and keeps the window from taking
// focus or mouse input, so a stray click or key cannot start anything. The mock serves no video, and the
// player shot is a fake PlaybackState pushed into the renderer: nothing plays, nothing makes a sound
// (the mock is started without a video file, so even a real play request would fail to open).
//
// Options: --only=<names>  (home, item, player, settings, admin, livetv, livetv-guide, livetv-player, reader, home-en)
//          --out=<dir>     (default docs/screenshots)
//          --raw           also keep the untouched captures next to the output, as <name>.raw.png
//          --frames[=dir]  demo mode: home, item, player and Live TV guide captured untouched into <dir>
//                          (default .dev/demo-frames), then joined by the bundled mpv into <out>/demo.webp
//          --keep          keep the app and the mock running after the shots, until Ctrl+C (to poke at them
//                          with CDP_PORT=9700 node apps/desktop/scripts/cdp.mjs)
// Ports: SHOTS_MOCK_PORT (8900), SHOTS_DEV_PORT (5580), SHOTS_CDP_PORT (9700).
// Clock: the mock, the app's main process and the renderer all start at SHOTS_CLOCK (local time, default
// 2026-10-09T20:30:00) and run at real speed from there, so the shots never show when they were taken.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const PROFILE = path.join(ROOT, '.dev', 'ud-shots');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const OUT = path.resolve(ROOT, typeof args.out === 'string' ? args.out : 'docs/screenshots');
const FRAMES = args.frames ? path.resolve(ROOT, typeof args.frames === 'string' ? args.frames : '.dev/demo-frames') : null;
const ONLY = FRAMES ? new Set(['home', 'item', 'player', 'livetv-guide']) : typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const HOLD = 3; // frames per scene in the demo: 2 s each at 1.5 fps
const MOCK_PORT = Number(process.env.SHOTS_MOCK_PORT) || 8900;
const DEV_PORT = Number(process.env.SHOTS_DEV_PORT) || 5580;
const CDP_PORT = Number(process.env.SHOTS_CDP_PORT) || 9700;
const WIDTH = 1600;
const HEIGHT = 1000;
const SERVER_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // the mock's default SystemId
// One name for both languages: the app keeps the name it stored when the mock restarts in English.
const SERVER_NAME = 'Home Cinema';
const ITEM_FILM = 'movie-4'; // Spring (2019): 4K Dolby Vision 8.1
const PLAYER_FILM = 'movie-0'; // Big Buck Bunny (2008)
const COMIC = 'comic-1';
const CLOCK_SHIFT = new Date(process.env.SHOTS_CLOCK ?? '2026-10-09T20:30:00').getTime() - Date.now();
// Runs first in every process that shows or serves a time (Node and the renderer alike).
const CLOCK = `(() => {
  const RealDate = Date;
  const now = () => RealDate.now() + ${CLOCK_SHIFT};
  class ShotDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(now()); }
    static now() { return now(); }
  }
  globalThis.Date = ShotDate;
  // Node stamps the HTTP Date header from its own clock, and the app measures server skew from it.
  if (typeof require === 'function' && typeof process === 'object') {
    const res = require('node:http').ServerResponse.prototype;
    const writeHead = res.writeHead;
    res.writeHead = function (...a) {
      if (!this.headersSent && !this.hasHeader('date')) this.setHeader('Date', new ShotDate().toUTCString());
      return writeHead.apply(this, a);
    };
  }
})();
`;
const CLOCK_FILE = path.join(ROOT, '.dev', 'shots-clock.cjs');

const wanted = (name) => !ONLY || ONLY.has(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[shots]', ...m);

// ---------------------------------------------------------------- processes

const children = [];

// SHOTS_VERBOSE=1 shows the mock's and the app's output.
function start(cmd, argv, opts) {
  const child = spawn(cmd, argv, { stdio: process.env.SHOTS_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
  children.push(child);
  return child;
}

// The dev script spawns Electron, which spawns its helpers: stop the whole tree.
function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

function stopAll() {
  for (const c of children.splice(0)) stop(c);
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(false)));
    s.once('error', () => resolve(true));
  });
}

async function until(what, fn, timeoutMs = 30000, everyMs = 250) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      if (err.fatal) throw err;
      last = err;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

let mock = null;
async function startMock(lang) {
  stop(mock);
  if (mock) await until('the mock port to close', () => portFree(MOCK_PORT), 10000);
  mock = start(process.execPath, ['--require', CLOCK_FILE, path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT)], {
    cwd: ROOT,
    env: { ...process.env, MOCK_DATASET: 'demo', MOCK_LIVETV: 'iptv', MOCK_DEMO_LANG: lang, MOCK_NAME: SERVER_NAME, NODE_OPTIONS: '' },
  });
  await until('the mock server', async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/emby/System/Info/Public`)).ok);
}

// Loaded into the dev app's Node and Electron main processes through NODE_OPTIONS.
const GUARD = String.raw`// Written by tools/screenshots/desktop.mjs for its own run; safe to delete.
'use strict';
const dgram = require('node:dgram');
const send = dgram.Socket.prototype.send;
const loopback = (a) => a === 'localhost' || a === '::1' || /^127\./.test(a);
dgram.Socket.prototype.send = function (msg, ...rest) {
  const address = rest.find((a) => typeof a === 'string');
  const cb = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null;
  if (address !== undefined && !loopback(address)) {
    if (cb) process.nextTick(cb, null, 0);
    return;
  }
  return send.call(this, msg, ...rest);
};
// The electron module only exists once the app's main script runs: hook its first require.
if (process.versions.electron) {
  const Module = require('node:module');
  const load = Module._load;
  let hooked = false;
  Module._load = function (request, ...rest) {
    const m = load.call(this, request, ...rest);
    if (!hooked && request === 'electron' && m && m.app) {
      hooked = true;
      m.app.commandLine.appendSwitch('mute-audio');
      m.app.on('browser-window-created', (_e, win) => {
        win.show = () => win.showInactive();
        win.setFocusable(false);
        win.setIgnoreMouseEvents(true);
      });
    }
    return m;
  };
}
`;

function seedProfile(lang) {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const address = `http://127.0.0.1:${MOCK_PORT}`;
  fs.writeFileSync(
    path.join(PROFILE, 'servers.json'),
    JSON.stringify({ servers: [{ id: SERVER_ID, name: SERVER_NAME, kind: 'emby', version: '4.9.1.0', manualAddress: address, lastAddress: address }], activeId: SERVER_ID, tokenBinding: 1 }),
  );
  fs.writeFileSync(
    path.join(PROFILE, 'settings.json'),
    JSON.stringify({
      ui: { language: lang, reduceTransparency: true, reduceMotion: true, heroAutoplay: false },
      // The default download folder is under the user's profile: keep the account name out of the shots.
      downloads: { folder: 'D:\\Vidéos\\Wicaby' },
      window: { bounds: { x: 40, y: 30, width: WIDTH, height: HEIGHT } },
      windows: { trayHintShown: true },
    }),
  );
  const guard = path.join(PROFILE, 'shots-guard.cjs');
  fs.writeFileSync(guard, CLOCK + GUARD);
  return guard;
}

// ---------------------------------------------------------------- CDP (same target choice as apps/desktop/scripts/cdp.mjs)

let appExited = null;

async function connect() {
  const page = await until('the Wicaby window', async () => {
    if (appExited !== null) throw Object.assign(new Error(`the dev app exited (${appExited}); run with SHOTS_VERBOSE=1`), { fatal: true });
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    return targets.find((t) => t.type === 'page' && !t.url.includes('osd=1') && /^(app:|http:\/\/localhost)/.test(t.url));
  }, 90000, 500);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
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
  const pin = async () => {
    await call('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await call('Emulation.setDefaultBackgroundColorOverride', { color: { r: 11, g: 11, b: 13, a: 1 } });
  };
  // The page loaded before CDP attached: reload it with the shifted clock.
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK });
  await call('Page.reload', { ignoreCache: false });
  await until('the reloaded window', () => evaluate(`!!window.wicaby && Math.abs(Date.now() - ${Date.now() + CLOCK_SHIFT}) < 60000`), 30000, 250);
  await pin();
  return { call, evaluate, pin, close: () => ws.close() };
}

// ---------------------------------------------------------------- page helpers

let cdp;

const js = (v) => JSON.stringify(v);

async function go(hash) {
  await cdp.evaluate(`location.hash = ${js(hash)}`);
  await sleep(300);
}

// Fonts loaded, every image in the viewport decoded, then a short pause for fades.
async function settle(extraMs = 900) {
  await until(
    'the page to settle',
    () =>
      cdp.evaluate(`(async () => {
        await document.fonts.ready;
        const inView = [...document.images].filter((i) => { const r = i.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; });
        return inView.every((i) => i.complete);
      })()`),
    20000,
    200,
  );
  await sleep(extraMs);
}

async function signIn() {
  await until('the session', () => cdp.evaluate(`window.wicaby?.session.get().then((s) => s.status !== 'no-server' && s.status !== 'connecting')`), 60000, 500);
  const status = await cdp.evaluate(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
  if (status !== 'signed-in') throw new Error(`sign-in failed (${status})`);
}

async function setSettings(patch) {
  await cdp.evaluate(`import('/lib/stores.svelte.ts').then((m) => m.updateSettings(${js(patch)})).then(() => true)`);
}

async function capture(name) {
  const r = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const raw = Buffer.from(r.data, 'base64');
  if (FRAMES) {
    for (let i = 0; i < HOLD; i++) fs.writeFileSync(path.join(FRAMES, `frame-${String(frameNo++).padStart(3, '0')}.png`), raw);
    log(`${name}: demo frame`);
    return;
  }
  if (args.raw) fs.writeFileSync(path.join(OUT, `${name}.raw.png`), raw);
  const png = optimize(raw);
  fs.writeFileSync(path.join(OUT, `${name}.png`), png);
  log(`${name}.png  ${(png.length / 1024).toFixed(0)} KB (capture ${(raw.length / 1024).toFixed(0)} KB)`);
  written.push(path.join(OUT, `${name}.png`));
}
const written = [];
let frameNo = 0;

// Joins the demo frames into an endlessly looping animated WebP with the bundled mpv (no audio track).
function assembleDemo() {
  const mpv = path.join(ROOT, 'vendor', 'mpv', 'mpv.exe');
  const out = path.join(OUT, 'demo.webp');
  const r = spawnSync(mpv, [`mf://${FRAMES.replaceAll('\\', '/')}/*.png`, '--mf-fps=1.5', '--vf=scale=1200:-2', '--of=webp', '--ofopts=loop=0', '--ovc=libwebp_anim', '--ovcopts=quality=80', '--no-audio', `--o=${out}`], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`mpv could not write ${out} (exit ${r.status ?? r.error?.message})`);
  log(`demo.webp  ${(fs.statSync(out).size / 1024).toFixed(0)} KB from ${frameNo} frames`);
  written.push(out);
}

// ---------------------------------------------------------------- shots

async function shotHome(name) {
  await go('/home');
  await cdp.evaluate(`document.getElementById('main-scroller')?.scrollTo(0, 0), true`);
  await settle(1500);
  await capture(name);
}

async function shotItem() {
  await go(`/item/${ITEM_FILM}`);
  await settle(1500);
  await capture('desktop-item');
}

// The player page with the OSD over a still of the film: a fake PlaybackState pushed into the renderer's
// store (main never plays anything), and the backdrop as the <video> poster.
async function shotPlayer() {
  const ok = await cdp.evaluate(`(async () => {
    const [{ playback }, { imageUrl }, w] = [await import('/lib/stores.svelte.ts'), await import('/lib/images.ts'), window.wicaby];
    const s = await w.session.get();
    const uid = s.user.id;
    const it = await w.api.get('/Users/' + uid + '/Items/${PLAYER_FILM}');
    const src = it.MediaSources?.[0] ?? {};
    const streams = src.MediaStreams ?? it.MediaStreams ?? [];
    const track = (st) => ({ index: st.Index, label: st.DisplayTitle ?? st.Title ?? st.Language ?? '', language: st.Language, codec: st.Codec, isDefault: !!st.IsDefault, isForced: !!st.IsForced, isExternal: !!st.IsExternal });
    const audio = streams.filter((st) => st.Type === 'Audio').map(track);
    const subs = streams.filter((st) => st.Type === 'Subtitle').map(track);
    const durationMs = Math.round((it.RunTimeTicks ?? 0) / 1e4) || 596000;
    // As main builds it (playback-service.ts): real chapters only, the intro/credits markers left out.
    const chapters = (it.Chapters ?? [])
      .map((c, i) => ({ c, index: c.ChapterIndex ?? i }))
      .filter(({ c }) => !c.MarkerType || c.MarkerType === 'Chapter')
      .map(({ c, index }, n) => ({ name: c.Name || 'Chapitre ' + (n + 1), startMs: c.StartPositionTicks / 1e4, index, imageTag: c.ImageTag }));
    location.hash = '#/player';
    await new Promise((r) => setTimeout(r, 400));
    window.__shotsState = {
      active: true, player: 'html',
      item: { id: it.Id, serverId: s.server.id, name: it.Name, type: it.Type, year: it.ProductionYear, imageItemId: it.Id, imageTag: it.ImageTags?.Primary, backdropItemId: it.Id, backdropTag: it.BackdropImageTags?.[0], chapters },
      positionMs: Math.round(durationMs * 0.38), durationMs, paused: true, buffering: false,
      volume: 80, muted: false, rate: 1,
      audioTracks: audio, subtitleTracks: subs, audioIndex: audio[0]?.index ?? null, subtitleIndex: null,
      playMethod: 'DirectPlay', queueIndex: 0, queueLength: 1, fullscreen: true, offline: false,
      stats: { container: 'mkv', videoCodec: 'hevc', audioCodec: 'eac3', resolution: '3840×2160', frameRate: 24, hdr: 'Dolby Vision 8.1', hdrOutput: 'passthrough', hwdec: 'd3d11va', bitrateKbps: 42000, droppedFrames: 0, displayFps: 60 },
      aspect: { mode: 'fit', zoom: 1 },
    };
    playback.value = window.__shotsState;
    const v = document.querySelector('.player video');
    if (!v) return false;
    v.poster = imageUrl(it.Id, 'Backdrop', { tag: it.BackdropImageTags?.[0], maxWidth: 1920 });
    await new Promise((resolve) => { const i = new Image(); i.onload = i.onerror = resolve; i.src = v.poster; });
    return true;
  })()`);
  if (!ok) throw new Error('player page did not mount');
  await settle(1200);
  // Check the OSD took the fake state before capturing it.
  await until('the OSD to show the fake state', () =>
    cdp.evaluate(`[...document.querySelectorAll('.osd .time')].some((e) => /[1-9]/.test(e.textContent))`),
  );
  await sleep(400);
  await capture('desktop-player');
  // Leave the player.
  await cdp.evaluate(`import('/lib/stores.svelte.ts').then((m) => { m.playback.value = { ...m.playback.value, active: false }; return true; })`);
  await go('/home');
}

async function shotSettings() {
  // The shots run with reduced motion and without hero autoplay; the settings page shows the defaults.
  await setSettings({ ui: { reduceMotion: false, heroAutoplay: true } });
  await go('/settings');
  await settle(1200);
  await capture('desktop-settings');
  await setSettings({ ui: { reduceMotion: true, heroAutoplay: false } });
}

async function shotAdmin() {
  await go('/admin');
  await settle(2000);
  await capture('desktop-admin');
}

// desktop-livetv: the En direct tab; desktop-livetv-guide: the guide grid.
async function shotLiveTv(tab, name) {
  await go(`/livetv?tab=${tab}`);
  await settle(3000);
  await capture(name);
}

const key = (k, code) => cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${js(k)}, code: ${js(code)}, bubbles: true })), true`);

// The player in live mode: a fake PlaybackState with state.live on a mock channel (nothing plays, the
// <video> poster is a demo still). Two captures: the channel banner, then the mini-guide (G), which
// hides the banner while open (LiveOverlay.svelte).
async function shotLivePlayer() {
  const ok = await cdp.evaluate(`(async () => {
    const [{ playback }, { imageUrl }, { storeFor }, w] = [await import('/lib/stores.svelte.ts'), await import('/lib/images.ts'), await import('/lib/livetv/store.svelte.ts'), window.wicaby];
    const s = await w.session.get();
    const store = storeFor(s.server.id);
    await store.open();
    for (let i = 0; i < 100 && store.channels.length < 12; i++) await new Promise((r) => setTimeout(r, 100));
    const rows = store.channels.slice(0, 40);
    const now = Date.now();
    await store.ensure(rows.map((r) => r.id), now - 3_600_000, now + 6 * 3_600_000, 3);
    const ch = rows[2];
    const [cur, nxt] = store.nowNext(ch.id, now);
    const nn = (p) => p ? { id: p.id, title: p.title ?? p.name, start: p.start, end: p.end, flags: p.flags ?? 0 } : undefined;
    const film = await w.api.get('/Users/' + s.user.id + '/Items/${PLAYER_FILM}');
    const entry = (r) => (r.logoTag ? { id: r.id, number: r.number, name: r.name, logoTag: r.logoTag } : { id: r.id, number: r.number, name: r.name });
    location.hash = '#/player';
    await new Promise((r) => setTimeout(r, 400));
    playback.value = {
      active: true, player: 'html',
      item: { id: ch.id, serverId: s.server.id, name: ch.name, type: 'TvChannel', imageItemId: ch.id, imageTag: ch.logoTag },
      positionMs: 0, durationMs: 0, paused: false, buffering: false, volume: 80, muted: false, rate: 1,
      audioTracks: [], subtitleTracks: [], audioIndex: null, subtitleIndex: null,
      playMethod: 'DirectStream', queueIndex: 0, queueLength: 1, fullscreen: true, offline: false,
      aspect: { mode: 'fit', zoom: 1 },
      live: {
        channel: { ...entry(ch), serverId: s.server.id }, index: 3, count: rows.length, lensLabel: 'Toutes', lens: { kind: 'all' },
        tuning: false, now: nn(cur), next: nn(nxt), policy: 'mbb',
      },
    };
    const v = document.querySelector('.player video');
    if (!v) return false;
    v.poster = imageUrl(film.Id, 'Backdrop', { tag: film.BackdropImageTags?.[0], maxWidth: 1920 });
    await new Promise((resolve) => { const i = new Image(); i.onload = i.onerror = resolve; i.src = v.poster; });
    return true;
  })()`);
  if (!ok) throw new Error('player page did not mount');
  await settle(1200);
  // The banner shows for 4 s after a tune: bring it back (I) right before the capture.
  const bannerUp = () => cdp.evaluate(`!!document.querySelector('.banner')`);
  if (!(await bannerUp())) await key('i', 'KeyI');
  await until('the live banner', bannerUp, 5000);
  await sleep(400);
  await capture('desktop-livetv-banner');
  await key('Escape', 'Escape');
  await key('g', 'KeyG');
  await settle(800);
  await capture('desktop-livetv-player');
  await key('Escape', 'Escape');
  await cdp.evaluate(`import('/lib/stores.svelte.ts').then((m) => { m.playback.value = { ...m.playback.value, active: false, live: undefined }; return true; })`);
  await go('/home');
}

// The mock's comic pages are flat generated test patterns. For the shot, the reader's cache gets a CBZ of
// comic-style pages cut from the demo artwork (CC BY, see tools/mock-server/demo/ATTRIBUTION.md), laid
// out on a canvas in the renderer. The reader opens a cached archive without asking the server.
const DEMO = path.join(ROOT, 'tools', 'mock-server', 'demo');
// Panels: [x, y, w, h] in a 12x18 grid, image, crop focus (0..1) and zoom.
const COMIC_PAGES = [
  { cover: 'caminandes/poster.jpg' },
  { panels: [[0, 0, 12, 7, 'sintel/backdrop.jpg', 0.5, 0.5, 1], [0, 7, 6, 5, 'sintel/backdrop.jpg', 0.83, 0.45, 2.4], [6, 7, 6, 5, 'sintel/backdrop.jpg', 0.28, 0.25, 2.2], [0, 12, 12, 6, 'sintel/poster.jpg', 0.5, 0.42, 1.2]] },
  { panels: [[0, 0, 7, 9, 'spring/poster.jpg', 0.5, 0.4, 1], [7, 0, 5, 9, 'spring/backdrop.jpg', 0.55, 0.4, 1.6], [0, 9, 12, 9, 'spring/backdrop.jpg', 0.5, 0.5, 1]] },
  { panels: [[0, 0, 12, 6, 'big-buck-bunny/backdrop.jpg', 0.5, 0.5, 1], [0, 6, 4, 6, 'big-buck-bunny/backdrop.jpg', 0.38, 0.38, 2.6], [4, 6, 4, 6, 'big-buck-bunny/backdrop.jpg', 0.66, 0.8, 2.6], [8, 6, 4, 6, 'big-buck-bunny/backdrop.jpg', 0.85, 0.55, 2.2], [0, 12, 12, 6, 'big-buck-bunny/poster.jpg', 0.5, 0.55, 1.1]] },
  { panels: [[0, 0, 12, 8, 'cosmos-laundromat/backdrop.jpg', 0.5, 0.5, 1], [0, 8, 5, 10, 'cosmos-laundromat/poster.jpg', 0.5, 0.5, 1], [5, 8, 7, 5, 'cosmos-laundromat/backdrop.jpg', 0.42, 0.42, 1.9], [5, 13, 7, 5, 'cosmos-laundromat/backdrop.jpg', 0.62, 0.55, 2.2]] },
  { panels: [[0, 0, 12, 7, 'caminandes/backdrop.jpg', 0.5, 0.5, 1], [0, 7, 6, 5, 'caminandes/backdrop.jpg', 0.62, 0.3, 3], [6, 7, 6, 5, 'caminandes/backdrop.jpg', 0.2, 0.4, 2.2], [0, 12, 12, 6, 'caminandes/poster.jpg', 0.5, 0.55, 1]] },
  { panels: [[0, 0, 7, 8, 'caminandes/ep3-llamigos.jpg', 0.3, 0.55, 1.4], [7, 0, 5, 8, 'caminandes/ep3-llamigos.jpg', 0.52, 0.6, 2.2], [0, 8, 12, 5, 'caminandes/ep3-llamigos.jpg', 0.5, 0.55, 1], [0, 13, 6, 5, 'caminandes/backdrop.jpg', 0.55, 0.6, 1.8], [6, 13, 6, 5, 'caminandes/poster.jpg', 0.5, 0.3, 1.2]] },
  { panels: [[0, 0, 12, 9, 'charge/backdrop.jpg', 0.5, 0.5, 1], [0, 9, 6, 9, 'charge/poster.jpg', 0.5, 0.45, 1], [6, 9, 6, 9, 'charge/backdrop.jpg', 0.62, 0.45, 2]] },
  { panels: [[0, 0, 12, 6, 'sprite-fright/backdrop.jpg', 0.5, 0.5, 1], [0, 6, 6, 6, 'sprite-fright/backdrop.jpg', 0.5, 0.42, 2.2], [6, 6, 6, 6, 'sprite-fright/backdrop.jpg', 0.3, 0.5, 2], [0, 12, 12, 6, 'sprite-fright/poster.jpg', 0.5, 0.5, 1.1]] },
  { panels: [[0, 0, 12, 8, 'wing-it/backdrop.jpg', 0.5, 0.5, 1], [0, 8, 7, 10, 'wing-it/poster.jpg', 0.5, 0.5, 1], [7, 8, 5, 5, 'wing-it/backdrop.jpg', 0.32, 0.5, 2], [7, 13, 5, 5, 'wing-it/backdrop.jpg', 0.68, 0.5, 2]] },
  { panels: [[0, 0, 12, 9, 'coffee-run/backdrop.jpg', 0.5, 0.5, 1], [0, 9, 12, 9, 'glass-half/backdrop.jpg', 0.5, 0.5, 1]] },
  { panels: [[0, 0, 6, 9, 'elephants-dream/poster.jpg', 0.5, 0.5, 1], [6, 0, 6, 9, 'hero/poster.jpg', 0.5, 0.5, 1], [0, 9, 12, 9, 'tears-of-steel/backdrop.jpg', 0.5, 0.5, 1]] },
];

async function seedComic() {
  const files = [...new Set(COMIC_PAGES.flatMap((p) => (p.cover ? [p.cover] : p.panels.map((q) => q[4]))))];
  const images = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(DEMO, f)).toString('base64')]));
  const pages = await cdp.evaluate(`(async () => {
    const images = ${js(images)};
    const pages = ${js(COMIC_PAGES)};
    const W = 1200, H = 1800, M = 54, G = 22, CELL_W = (W - 2 * M + G) / 12, CELL_H = (H - 2 * M + G) / 18;
    const bitmaps = {};
    for (const [k, b64] of Object.entries(images)) {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      bitmaps[k] = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    }
    // Cover-crop the image into the box around a focus point, zoomed.
    const draw = (ctx, img, x, y, w, h, fx, fy, zoom) => {
      const scale = Math.max(w / img.width, h / img.height) * zoom;
      const sw = w / scale, sh = h / scale;
      const sx = Math.min(img.width - sw, Math.max(0, fx * img.width - sw / 2));
      const sy = Math.min(img.height - sh, Math.max(0, fy * img.height - sh / 2));
      ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    };
    const out = [];
    for (const p of pages) {
      const c = new OffscreenCanvas(W, H);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      if (p.cover) draw(ctx, bitmaps[p.cover], 0, 0, W, H, 0.5, 0.5, 1);
      else {
        ctx.fillStyle = '#f3efe6';
        ctx.fillRect(0, 0, W, H);
        for (const [gx, gy, gw, gh, src, fx, fy, zoom] of p.panels) {
          const x = Math.round(M + gx * CELL_W), y = Math.round(M + gy * CELL_H);
          const w = Math.round(gw * CELL_W - G), h = Math.round(gh * CELL_H - G);
          draw(ctx, bitmaps[src], x, y, w, h, fx, fy, zoom);
          ctx.lineWidth = 5;
          ctx.strokeStyle = '#141414';
          ctx.strokeRect(x + 2.5, y + 2.5, w - 5, h - 5);
        }
      }
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      out.push(btoa(bin));
    }
    return out;
  })()`);
  const { zip } = await import('../mock-server/cbz-fixture.mjs');
  const entries = pages.map((b64, i) => ({ name: `${String(i + 1).padStart(2, '0')}.jpg`, data: Buffer.from(b64, 'base64'), store: true }));
  entries.push({ name: 'ComicInfo.xml', data: Buffer.from('<ComicInfo><Series>Les Cartographes</Series><Number>1</Number></ComicInfo>') });
  const dir = path.join(PROFILE, 'cache', 'comics');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SERVER_ID}-${COMIC}.cbz`), zip(entries));
}

async function shotReader() {
  await seedComic();
  await go(`/read/${COMIC}`);
  await settle(2500);
  // A mouse move brings up the reader's title bar and page strip (CDP input, not the OS pointer).
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: WIDTH / 2, y: HEIGHT / 2 });
  await sleep(600);
  await capture('desktop-reader');
  await go('/home');
}

// ---------------------------------------------------------------- PNG: decode, quantize, encode

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('only 8-bit non-interlaced PNG captures are supported');
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`unsupported PNG colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 3);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let p;
      if (f === 0) p = 0;
      else if (f === 1) p = a;
      else if (f === 2) p = b;
      else if (f === 3) p = (a + b) >> 1;
      else {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = (line[x] + p) & 255;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 3] = line[x * bpp];
      out[(y * width + x) * 3 + 1] = line[x * bpp + 1];
      out[(y * width + x) * 3 + 2] = line[x * bpp + 2];
    }
    prev = line;
  }
  return { width, height, rgb: out };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodeIndexed(width, height, palette, indices) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 3, 0, 0, 0], 8);
  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach((c, i) => plte.set(c, i * 3));
  // Filter per row: none or "up", whichever leaves the smaller sum (flat UI rows compress best with "up").
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const cur = indices.subarray(y * width, (y + 1) * width);
    const o = y * (width + 1);
    if (y > 0) {
      const up = indices.subarray((y - 1) * width, y * width);
      let zeros = 0;
      let same = 0;
      for (let x = 0; x < width; x++) {
        if (cur[x] === up[x]) same++;
        if (x && cur[x] === cur[x - 1]) zeros++;
      }
      if (same > zeros + width / 8) {
        rows[o] = 2;
        for (let x = 0; x < width; x++) rows[o + 1 + x] = (cur[x] - up[x]) & 255;
        continue;
      }
    }
    rows[o] = 0;
    rows.set(cur, o + 1);
  }
  const idat = zlib.deflateSync(rows, { level: 9, memLevel: 9 });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// Median cut on a 6-bit-per-channel histogram, splitting the box with the largest weighted error first,
// then a few k-means passes over the histogram. Good enough for UI with photographs in it.
function buildPalette(rgb, colors = 256) {
  const BITS = 6;
  const SH = 8 - BITS;
  const SIZE = 1 << (3 * BITS);
  const count = new Uint32Array(SIZE);
  const sr = new Float64Array(SIZE);
  const sg = new Float64Array(SIZE);
  const sb = new Float64Array(SIZE);
  for (let i = 0; i < rgb.length; i += 3) {
    const k = ((rgb[i] >> SH) << (2 * BITS)) | ((rgb[i + 1] >> SH) << BITS) | (rgb[i + 2] >> SH);
    count[k]++;
    sr[k] += rgb[i];
    sg[k] += rgb[i + 1];
    sb[k] += rgb[i + 2];
  }
  const bins = [];
  for (let k = 0; k < SIZE; k++) if (count[k]) bins.push({ n: count[k], r: sr[k] / count[k], g: sg[k] / count[k], b: sb[k] / count[k] });

  const stats = (list) => {
    let n = 0, r = 0, g = 0, b = 0;
    for (const p of list) (n += p.n), (r += p.r * p.n), (g += p.g * p.n), (b += p.b * p.n);
    r /= n; g /= n; b /= n;
    let vr = 0, vg = 0, vb = 0;
    for (const p of list) (vr += p.n * (p.r - r) ** 2), (vg += p.n * (p.g - g) ** 2), (vb += p.n * (p.b - b) ** 2);
    // Perceptual weights: green errors show most, blue least.
    return { list, n, mean: [r, g, b], err: 0.3 * vr + 0.59 * vg + 0.11 * vb, axis: vr * 0.3 >= vg * 0.59 && vr * 0.3 >= vb * 0.11 ? 'r' : vg * 0.59 >= vb * 0.11 ? 'g' : 'b' };
  };
  const SPARE = 8; // kept for small saturated UI marks (status dot, record badge) a photo's palette would swallow
  const boxes = [stats(bins)];
  while (boxes.length < colors - SPARE) {
    let best = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].list.length > 1 && (best < 0 || boxes[i].err > boxes[best].err)) best = i;
    if (best < 0) break;
    const box = boxes[best];
    const sorted = box.list.slice().sort((p, q) => p[box.axis] - q[box.axis]);
    let acc = 0;
    let cut = 1;
    for (; cut < sorted.length - 1; cut++) {
      acc += sorted[cut - 1].n;
      if (acc >= box.n / 2) break;
    }
    boxes.splice(best, 1, stats(sorted.slice(0, cut)), stats(sorted.slice(cut)));
  }
  let pal = boxes.map((b) => b.mean);
  for (let pass = 0; pass < 4; pass++) {
    const acc = pal.map(() => [0, 0, 0, 0]);
    for (const p of bins) {
      const i = nearest(pal, p.r, p.g, p.b);
      const a = acc[i];
      a[0] += p.r * p.n; a[1] += p.g * p.n; a[2] += p.b * p.n; a[3] += p.n;
    }
    pal = acc.map((a, i) => (a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : pal[i]));
  }
  // Farthest-point fill of the spare slots: the bins worst served by the palette so far (error × pixel count).
  for (let k = 0; k < SPARE; k++) {
    let worst = null;
    let wd = 0;
    for (const p of bins) {
      const c = pal[nearest(pal, p.r, p.g, p.b)];
      const dist = p.n * (3 * (c[0] - p.r) ** 2 + 4 * (c[1] - p.g) ** 2 + 2 * (c[2] - p.b) ** 2);
      if (dist > wd) (wd = dist), (worst = p);
    }
    if (!worst) break;
    pal.push([worst.r, worst.g, worst.b]);
  }
  return pal.map((c) => c.map((v) => Math.max(0, Math.min(255, Math.round(v)))));
}

function nearest(pal, r, g, b) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const c = pal[i];
    const d = 3 * (c[0] - r) ** 2 + 4 * (c[1] - g) ** 2 + 2 * (c[2] - b) ** 2;
    if (d < bd) (bd = d), (best = i);
  }
  return best;
}

// Map to the palette with a light Floyd–Steinberg error diffusion (serpentine), so photo gradients do
// not band; flat UI areas map exactly and stay flat.
function remap(width, height, rgb, pal, strength = 0.6) {
  const cache = new Int16Array(1 << 18).fill(-1);
  const lookup = (r, g, b) => {
    const k = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let i = cache[k];
    if (i < 0) i = cache[k] = nearest(pal, r, g, b);
    return i;
  };
  const out = new Uint8Array(width * height);
  let errCur = new Float32Array((width + 2) * 3);
  let errNext = new Float32Array((width + 2) * 3);
  for (let y = 0; y < height; y++) {
    const ltr = y % 2 === 0;
    for (let n = 0; n < width; n++) {
      const x = ltr ? n : width - 1 - n;
      const o = (y * width + x) * 3;
      const e = (x + 1) * 3;
      const r = Math.max(0, Math.min(255, rgb[o] + errCur[e]));
      const g = Math.max(0, Math.min(255, rgb[o + 1] + errCur[e + 1]));
      const b = Math.max(0, Math.min(255, rgb[o + 2] + errCur[e + 2]));
      const i = lookup(r | 0, g | 0, b | 0);
      out[y * width + x] = i;
      const c = pal[i];
      const dr = (r - c[0]) * strength;
      const dg = (g - c[1]) * strength;
      const db = (b - c[2]) * strength;
      const dir = ltr ? 3 : -3;
      for (let k = 0; k < 3; k++) {
        const d = k === 0 ? dr : k === 1 ? dg : db;
        errCur[e + dir + k] += (d * 7) / 16;
        errNext[e - dir + k] += (d * 3) / 16;
        errNext[e + k] += (d * 5) / 16;
        errNext[e + dir + k] += d / 16;
      }
    }
    [errCur, errNext] = [errNext, errCur];
    errNext.fill(0);
  }
  return out;
}

function optimize(png) {
  const { width, height, rgb } = decodePng(png);
  if (width !== WIDTH) log(`warning: capture is ${width}x${height}, expected ${WIDTH}x${HEIGHT}`);
  const pal = buildPalette(rgb);
  return encodeIndexed(width, height, pal, remap(width, height, rgb, pal));
}

// ---------------------------------------------------------------- main

async function main() {
  for (const [port, env] of [[MOCK_PORT, 'SHOTS_MOCK_PORT'], [DEV_PORT, 'SHOTS_DEV_PORT'], [CDP_PORT, 'SHOTS_CDP_PORT']]) {
    if (!(await portFree(port))) throw new Error(`port ${port} is in use (set ${env} to another port)`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.dirname(CLOCK_FILE), { recursive: true });
  fs.writeFileSync(CLOCK_FILE, CLOCK);
  if (FRAMES) {
    fs.rmSync(FRAMES, { recursive: true, force: true });
    fs.mkdirSync(FRAMES, { recursive: true });
  }

  log(`mock server (demo dataset, French) on ${MOCK_PORT}`);
  await startMock('fr');
  const guard = seedProfile('fr');

  log(`dev app (renderer ${DEV_PORT}, CDP ${CDP_PORT}), profile ${path.relative(ROOT, PROFILE)}`);
  start(process.execPath, [path.join('scripts', 'dev.mjs'), `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_PORT: String(DEV_PORT), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${guard.replaceAll('\\', '/')}"`.trim() },
  }).on('exit', (code) => (appExited = code ?? 'signal'));
  cdp = await connect();
  await signIn();
  log('signed in as Wika');
  await go('/home');
  await settle(1500);

  if (wanted('home')) await shotHome('desktop-home');
  if (wanted('item')) await shotItem();
  if (wanted('player')) await shotPlayer();
  if (wanted('settings')) await shotSettings();
  if (wanted('admin')) await shotAdmin();
  if (wanted('livetv')) await shotLiveTv('now', 'desktop-livetv');
  if (wanted('livetv-guide')) await shotLiveTv('guide', 'desktop-livetv-guide');
  if (wanted('livetv-player')) await shotLivePlayer();
  if (wanted('reader')) await shotReader();

  if (FRAMES) assembleDemo();

  if (wanted('home-en')) {
    log('switching to English (mock and UI)');
    // The mock keeps its tokens in memory: sign in again as soon as the English one is up, from a page
    // that makes no server calls meanwhile.
    await go('/settings');
    await startMock('en');
    await signIn();
    await setSettings({ ui: { language: 'en' } });
    // Reload the renderer so the library list and the pages fetch the English catalogue.
    await cdp.call('Page.reload', { ignoreCache: true });
    await sleep(1500);
    cdp.close();
    cdp = await connect();
    await signIn();
    await go('/home');
    await shotHome('desktop-home-en');
  }

  cdp.close();
  if (args.keep) {
    console.log(written.join('\n'));
    log(`--keep: app (CDP ${CDP_PORT}) and mock (${MOCK_PORT}) left running; Ctrl+C stops them`);
    await new Promise(() => {});
  }
  return written;
}

try {
  const files = await main();
  console.log(files.join('\n'));
} catch (err) {
  console.error('[shots] failed:', err.message);
  process.exitCode = 1;
} finally {
  stopAll();
  await sleep(500);
  fs.rmSync(path.join(PROFILE, 'shots-guard.cjs'), { force: true });
  fs.rmSync(CLOCK_FILE, { force: true });
}
