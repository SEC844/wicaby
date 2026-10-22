#!/usr/bin/env node
// Desktop music UI (music-spec MU-03 to MU-06), driven over CDP against the mocks' music library. Not part of run-all:
// it needs Electron (the dev build, scripts/dev.mjs), mpv (vendor/mpv) and Windows. Never audible: WICABY_TEST_SILENT=1
// gives mpv --ao=null and Chromium mute-audio, and the mock serves silence. Windows open inactive, unfocusable and
// click-through (the guard below); nothing leaves loopback.
//
// MU-03 library views: AC1 tab counts, AC2 album-artists toggle, AC3 disc headers and order, AC4 1,000 songs windowed
//       and smooth, AC5 the track menu, AC6 tab / sort / view restored, AC7 arrow keys reach every control.
// MU-04 bar and queue: AC1 bar, AC2 next from the bar and SMTC, AC3 drag / Delete / clear / save as playlist, AC4 shuffle
//       and repeat, AC5 full-screen player (opaque with reduced transparency), AC6 shortcuts, AC7 paused restore;
//       Stop from the bar (Stopped reported, bar gone, saved queue cleared).
// MU-05 lyrics: AC1 current line at 5 positions, AC2 click seeks, AC3 Emby .lrc stream, AC4 plain / none / 500, AC5
//       reduced motion.
// MU-06 mix and favourites: AC1 /Items/{id}/InstantMix from 5 kinds, AC2 radio top-up, AC3 hearts.
// Feishin spec part (c) (music-feishin-navidrome.md): C3 multi-select (aria-selected, Space, Escape, drop on the queue
//       at the drop row), C6 the active tab hides the full-screen player's panel.
//
//   node tools/checks/music-ui-cdp.mjs [--only=emby|jellyfin] [--shots=<dir>] [--keep]
// Ports: MUSICUI_MOCK_PORT (8881, Jellyfin +1), MUSICUI_DEV_PORT (5621), MUSICUI_CDP_PORT (9781).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const MOCK_PORT = Number(process.env.MUSICUI_MOCK_PORT) || 8881;
const DEV_PORT = Number(process.env.MUSICUI_DEV_PORT) || 5621;
const CDP_PORT = Number(process.env.MUSICUI_CDP_PORT) || 9781;
const SHOTS = typeof args.shots === 'string' ? path.resolve(args.shots) : null;
// A track with lyrics (HasLyrics: the Jellyfin client asks), whose lyrics the mock answers with a 500.
const FAIL_LYRICS = 'track-3-0-2';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[music-ui]', ...m);
const js = (v) => JSON.stringify(v);

// Expected counts from the fixture itself (MOCK_MUSIC_SCALE=big adds one album of 1,000 songs and its artist).
const { MUSIC } = await import(pathToFileURL(path.join(ROOT, 'tools', 'mock-server', 'music-fixture.mjs')).href);
const albumArtists = new Set(MUSIC.map((a) => a.artist));
const everyone = new Set([...albumArtists, ...MUSIC.flatMap((a) => a.albums.flatMap((al) => al.guests ?? []))]);
const EXPECT = {
  albums: MUSIC.reduce((n, a) => n + a.albums.length, 0) + 1,
  artists: albumArtists.size + 1,
  allArtists: everyone.size + 1,
  songs: MUSIC.reduce((n, a) => n + a.albums.reduce((m, al) => m + al.tracks.length, 0), 0) + 1000,
  genres: new Set(MUSIC.map((a) => a.genre)).size,
  playlists: 1,
};
EXPECT.folders = EXPECT.albums;
const fr = (ns) => JSON.parse(fs.readFileSync(path.join(DESKTOP, 'src', 'renderer', 'locales', 'fr', `${ns}.json`), 'utf8'));
const FR_YEAR = fr('browse').library.sort.year;

const children = [];
function start(cmd, argv, opts, capture) {
  const child = spawn(cmd, argv, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : process.env.MUSICUI_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
  if (capture) {
    child.stdout.setEncoding('utf8').on('data', (d) => capture.push(...d.split('\n')));
    child.stderr.resume();
  }
  children.push(child);
  return child;
}
function stopAll() {
  for (const c of children.splice(0)) {
    if (c.exitCode !== null) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(c.pid)], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
}
process.on('SIGINT', () => (stopAll(), process.exit(130)));

const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(false)));
    s.once('error', () => resolve(true));
  });

async function until(what, fn, timeoutMs = 30000, everyMs = 100) {
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
const soon = (what, fn, ms = 8000) => until(what, fn, ms).catch(() => null);

// Loopback UDP only, and windows that never take the focus or the mouse (same guard as music-engine-check.mjs).
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
      m.app.on('browser-window-created', (_e, win) => {
        win.show = () => win.showInactive(); win.setFocusable(false); win.setIgnoreMouseEvents(true);
        // Thumbar: keep the last buttons; the page logs "__thumbar:<index>" to click one, as Windows would.
        let thumb = [];
        const set = win.setThumbarButtons.bind(win);
        win.setThumbarButtons = (b) => ((thumb = b), set(b));
        win.webContents.on('console-message', (e, _level, text) => { const k = /^__thumbar:(\d)$/.exec(text ?? e.message ?? ''); if (k) thumb[Number(k[1])]?.click?.(); });
      });
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
  return { call, evaluate, close: () => ws.close() };
}
const isApp = (t) => /^(app:|http:\/\/localhost)/.test(t.url);

function seedProfile(profile, kind, port) {
  const address = `http://127.0.0.1:${port}`;
  const id = kind === 'emby' ? 'a1b2c3d4e5f60718293a4b5c6d7e8f90' : '7e1f0c2a9b8d4e6fa1c3b5d7e9f02468';
  fs.writeFileSync(path.join(profile, 'servers.json'), js({ servers: [{ id, name: 'Mock', kind, version: kind === 'emby' ? '4.9.1.0' : '12.2.0', manualAddress: address, lastAddress: address }], activeId: id, tokenBinding: 1 }));
  fs.writeFileSync(path.join(profile, 'settings.json'), js({ ui: { language: 'fr', heroAutoplay: false, reduceTransparency: true, reduceMotion: true }, windows: { trayHintShown: true }, window: { bounds: { x: 80, y: 60, width: 1366, height: 860 } }, playback: { player: 'mpv' } }));
  const guard = path.join(profile, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  return { guard, serverId: id };
}

async function pass(kind) {
  const port = kind === 'emby' ? MOCK_PORT : MOCK_PORT + 1;
  const base = `http://127.0.0.1:${port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `wicaby-music-ui-${kind}-`));
  const failures = [];
  const check = (ok, what) => (ok ? log(`  ok  ${what}`) : (failures.push(what), log(`  FAIL ${what}`)));
  const mockLines = [];
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', kind === 'emby' ? 'mock-emby.mjs' : 'mock-jellyfin.mjs'), String(port)], { cwd: ROOT, env: { ...process.env, MOCK_MUSIC: '1', MOCK_MUSIC_SCALE: 'big', MOCK_LYRICS_FAIL: FAIL_LYRICS, NODE_OPTIONS: '' } }, mockLines);
  await until('the mock server', async () => (await fetch(`${base}${kind === 'emby' ? '/emby' : ''}/System/Info/Public`)).ok);
  const mockState = async () => (await (await fetch(`${base}/Mock/State`)).json()).music;
  const { guard, serverId } = seedProfile(profile, kind, port);
  let app = null;
  let main = null;
  const launch = async (login) => {
    app = start(process.execPath, [path.join(DESKTOP, 'scripts', 'dev.mjs'), `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], {
      cwd: DESKTOP,
      env: { ...process.env, WICABY_DEV_PORT: String(DEV_PORT), WICABY_TEST_SILENT: '1', NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
    });
    main = await attach((t) => isApp(t) && !t.url.includes('osd=1'));
    await until('the session', () => main.evaluate(`window.wicaby?.session.get().then((s) => s.status !== 'no-server' && s.status !== 'connecting')`), 60000, 500);
    if (login) {
      const status = await main.evaluate(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
      if (status !== 'signed-in') throw new Error(`${kind}: sign-in failed (${status})`);
    }
    await until('the app shell', () => main.evaluate(`!!document.getElementById('main-scroller')`), 30000, 200);
    // SMTC: keep the handlers the page installs, to call them as Windows would.
    await main.evaluate(`(() => { const ms = navigator.mediaSession; const set = ms.setActionHandler.bind(ms); window.__smtc = {}; ms.setActionHandler = (a, h) => ((window.__smtc[a] = h), set(a, h)); return true; })()`);
  };
  const quitApp = async () => {
    main.close();
    spawnSync('taskkill', ['/T', '/F', '/PID', String(app.pid)], { stdio: 'ignore' });
    await until('the dev server gone', () => portFree(DEV_PORT), 15000, 200);
  };
  await launch(true);
  const ev = (expr) => main.evaluate(expr);
  const state = () => ev('wicaby.playback.getState()');
  const command = (c) => ev(`wicaby.playback.command(${js(c)}).then(() => true)`);
  const play = (req) => ev(`wicaby.playback.play(${js({ serverId, ...req })}).then(() => true)`);
  const go = async (hash, ready) => {
    await ev(`(location.hash = ${js(hash)}, true)`);
    if (ready) await until(`${hash} ${ready}`, () => ev(`!!document.querySelector(${js(ready)})`), 20000);
  };
  const count = (sel) => ev(`document.querySelectorAll(${js(sel)}).length`);
  const click = (sel) => ev(`(() => { const el = document.querySelector(${js(sel)}); if (!el) throw new Error('no ' + ${js(sel)}); el.click(); return true; })()`);
  // A key press with nothing focused (the music shortcuts' normal case), or on [target].
  const key = (k, mods = {}, target = null) =>
    ev(`(() => { ${target ? '' : 'document.activeElement?.blur?.();'} const t = ${target ? `document.querySelector(${js(target)})` : 'document.body'}; t.dispatchEvent(new KeyboardEvent('keydown', { key: ${js(k)}, bubbles: true, cancelable: true, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift}, altKey: ${!!mods.alt} })); return true; })()`);
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const { data } = await main.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${kind}-${name}.png`), Buffer.from(data, 'base64'));
  };
  const userId = await ev(`wicaby.session.get().then((s) => (s.sessions?.find((x) => x.server.id === ${js(serverId)}) ?? s).user?.id)`);
  const userQ = kind === 'jellyfin' ? { userId } : { UserId: userId };
  const userItem = (id) => ev(`wicaby.api.get(${js(kind === 'jellyfin' ? `/Items/${id}` : `/Users/${userId}/Items/${id}`)}, ${js(kind === 'jellyfin' ? { userId } : {})})`);
  const lib = `#/library/${serverId}/lib-music`;
  // Paused for good: a pause sent while the file opens can be overtaken by the load.
  const pauseNow = async () => {
    await until('paused', async () => {
      const st = await state();
      if (st.paused && st.positionMs >= 0) return true;
      await command({ type: 'pause' });
      return false;
    }, 8000, 300);
    await sleep(400);
  };
  const stopPlayback = async () => {
    await command({ type: 'stop' }).catch(() => null);
    await soon('stopped', async () => !(await state()).active, 10000);
  };

  // MUSICUI_SKIP=mu03,mu04: start later (debugging one section).
  const skip = (section) => (process.env.MUSICUI_SKIP ?? '').split(',').includes(section);
  const quartz = Array.from({ length: 12 }, (_, i) => `track-4-0-${i}`);
  const marée = ['track-0-0-0', 'track-0-0-1', 'track-0-0-2'];
  // ======== MU-03 ========
  if (!skip('mu03')) {
  await go(lib, '[data-tab-panel="albums"]');
  check((await ev(`document.querySelector('[data-tab="albums"]').getAttribute('aria-selected')`)) === 'true', 'MU-03 AC1 the library opens on the Albums tab');
  const tabCount = { albums: '.tab .cell', artists: '.tab .cell', genres: '.genre', playlists: '.tab .cell', folders: '.rows .line' };
  for (const tab of ['albums', 'artists', 'songs', 'genres', 'playlists', 'folders']) {
    await click(`[data-tab="${tab}"]`);
    const got = await soon(`the ${tab} tab`, async () => {
      const n = tab === 'songs' ? Number(await ev(`document.querySelector('.tab [data-total]')?.dataset.total ?? -1`)) : await count(tabCount[tab]);
      return n === EXPECT[tab] ? n : null;
    });
    const n = tab === 'songs' ? Number(await ev(`document.querySelector('.tab [data-total]')?.dataset.total ?? -1`)) : await count(tabCount[tab]);
    check(got !== null, `MU-03 AC1 ${tab}: ${n} (fixture ${EXPECT[tab]})`);
    if (tab === 'songs') {
      // AC4: 1,000+ songs, only the rows near the viewport in the DOM, ≥ 55 fps while scrolling.
      const rows0 = await count('.tab [data-total] .row');
      const idle = await ev(`(async () => { let f = 0; const t0 = performance.now(); await new Promise((res) => { const step = () => (f++, performance.now() - t0 < 1000 ? requestAnimationFrame(step) : res()); requestAnimationFrame(step); }); return Math.round((f * 1000) / (performance.now() - t0)); })()`);
      log(`  (idle frame rate ${idle} fps)`);
      // One second of warm-up (code paths compiled, the first pages in), then 2.5 s further down through pages not yet fetched.
      const perf = await ev(`(async () => { const sc = document.getElementById('main-scroller'); await new Promise((res) => { const t = performance.now(); const step = () => { sc.scrollTop += 36; if (performance.now() - t < 1000) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); }); await new Promise((r) => setTimeout(r, 300)); let frames = 0; const t0 = performance.now(); const gaps = []; let last = t0; await new Promise((res) => { const step = (t) => { frames++; gaps.push(t - last); last = t; sc.scrollTop += 36; if (performance.now() - t0 < 2500) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); }); const elapsed = performance.now() - t0; await new Promise((r) => setTimeout(r, 300)); gaps.sort((a, b) => b - a); return { worst: gaps.slice(1, 6).map(Math.round).join('/'), fps: Math.round((frames * 1000) / elapsed), rows: document.querySelectorAll('.tab [data-total] .row').length, filled: document.querySelectorAll('.tab [data-total] .row .main').length, top: Math.round(sc.scrollTop) }; })()`);
      check(rows0 <= 60 && perf.rows <= 60 && perf.rows >= 15, `MU-03 AC4 windowed: ${rows0} then ${perf.rows} rows in the DOM of ${n}`);
      check(perf.fps >= 55, `MU-03 AC4 scrolling at ${perf.fps} fps (worst frames ${perf.worst} ms, scrolled to ${perf.top} px, ${perf.filled} rows loaded)`);
      await shot('songs');
      await ev(`(document.getElementById('main-scroller').scrollTop = 0, true)`);
    }
    if (tab === 'artists') {
      // AC2: "Album artists only" off adds the featured-only artists.
      await click('.toolbar [role="switch"]');
      const all = await soon('every artist', async () => ((await count('.tab .cell')) === EXPECT.allArtists ? true : null));
      check(all && (await ev(`document.querySelector('.tab').textContent.includes('Kaolin')`)), `MU-03 AC2 toggle off: ${await count('.tab .cell')} artists (fixture ${EXPECT.allArtists}), featured-only artist listed`);
      await shot('artists-all');
      await click('.toolbar [role="switch"]');
      await soon('album artists', async () => (await count('.tab .cell')) === EXPECT.artists);
    }
    if (tab === 'genres' || tab === 'albums') await shot(`tab-${tab}`);
  }

  // AC7: from the first tab, the arrow keys reach every control of the page (spatial navigation, lib/spatial.ts).
  await click('[data-tab="albums"]');
  await soon('albums', async () => (await count('.tab .cell')) === EXPECT.albums);
  const reach = await ev(`(async () => {
    const root = document.querySelector('.music');
    const all = [...root.querySelectorAll('button, a[href], input')].filter((e) => e.tabIndex >= 0 && !e.disabled && e.getClientRects().length);
    const seen = new Set([all[0]]);
    const queue = [all[0]];
    let steps = 0;
    while (queue.length && steps < 3000) {
      const el = queue.shift();
      for (const k of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
        steps++;
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 0));
        const a = document.activeElement;
        if (a && root.contains(a) && !seen.has(a)) { seen.add(a); queue.push(a); }
      }
    }
    document.activeElement?.blur();
    return { total: all.length, missing: all.filter((e) => !seen.has(e)).map((e) => e.outerHTML.slice(0, 90)) };
  })()`);
  check(reach.total > 10 && reach.missing.length === 0, `MU-03 AC7 arrows reach ${reach.total - reach.missing.length}/${reach.total} controls ${reach.missing.length ? js(reach.missing.slice(0, 3)) : ''}`);

  // AC6: sort (year) and view (list) survive a trip to an album and back; so does the Artists tab.
  await ev(`(() => { const t = [...document.querySelectorAll('.toolbar .btn.trigger')].find((b) => b.textContent.trim() === ${js(fr('browse').library.sort.name)}); t.click(); return true; })()`);
  await sleep(200);
  await ev(`(() => { [...document.querySelectorAll('[role="menuitemradio"]')].find((o) => o.textContent.trim() === ${js(FR_YEAR)}).click(); return true; })()`);
  await click('[data-view="list"]');
  await soon('the list view', async () => (await count('.rows a.line')) === EXPECT.albums);
  await click('.rows a.line');
  await until('an album page', () => ev(`location.hash.startsWith('#/item/')`), 10000);
  await sleep(600);
  await ev('(history.back(), true)');
  await until('the library again', () => ev(`!!document.querySelector('[data-tab-panel="albums"]')`), 10000);
  await sleep(500);
  const restored = await ev(`({ view: document.querySelector('[data-view="list"]')?.getAttribute('aria-pressed'), sort: [...document.querySelectorAll('.toolbar .btn.trigger')].some((b) => b.textContent.trim() === ${js(FR_YEAR)}), tab: document.querySelector('[data-tab="albums"]')?.getAttribute('aria-selected') })`);
  check(restored.view === 'true' && restored.sort && restored.tab === 'true', `MU-03 AC6 sort and view restored ${js(restored)}`);
  await shot('albums-list');
  await click('[data-view="grid"]');
  await click('[data-tab="artists"]');
  await soon('artists', async () => (await count('.tab .cell')) === EXPECT.artists);
  await click('.tab .cell a.cover');
  await until('an artist page', () => ev(`location.hash.startsWith('#/item/')`), 10000);
  await sleep(600);
  await ev('(history.back(), true)');
  await until('the library again', () => ev(`!!document.querySelector('[data-tab-panel]')`), 10000);
  check((await ev(`document.querySelector('[data-tab="artists"]')?.getAttribute('aria-selected')`)) === 'true', 'MU-03 AC6 the Artists tab is restored');
  await click('[data-tab="albums"]');

  // AC3: the 2-disc album (12 tracks): two disc headers, tracks by disc then number.
  await go(`#/item/${serverId}/album-4-0`, 'section.tracks button.track');
  await soon('12 tracks', async () => (await count('section.tracks button.track')) === 12);
  const order = await ev(`[...document.querySelectorAll('section.tracks button.track')].map((b) => b.dataset.id)`);
  check((await count('section.tracks h3[data-disc]')) === 2 && js(order) === js(quartz), `MU-03 AC3 two disc headers, order ${order.map((x) => x.slice(-2)).join(',')}`);
  await shot('album-discs');

  // AC5 (with a queue playing): play next and add to queue go to main as PlayNext / PlayLast; the playlist entry opens the sheet.
  await click('section.tracks button.track');
  await until('the first track', async () => (await state()).item?.id === quartz[0], 15000);
  await pauseNow();
  const menuRun = async (row, action) => {
    await ev(`(() => { document.querySelectorAll('section.tracks .row')[${row}].querySelector('.more').click(); return true; })()`);
    await until('the track menu', () => ev(`!!document.querySelector('[data-track-menu]')`), 5000);
    await click(`[data-track-menu] [data-action="${action}"]`);
  };
  await menuRun(7, 'next');
  const afterNext = await soon('play next', async () => ((s) => (s.music?.queue.ids[s.music.queue.index + 1] === quartz[7] && s.music.queue.ids.length === 13 ? s : null))(await state()));
  check(Boolean(afterNext), 'MU-03 AC5 "Lire ensuite" puts the track after the current one (PlayNext)');
  await menuRun(2, 'last');
  const afterLast = await soon('add to queue', async () => ((s) => (s.music?.queue.ids.at(-1) === quartz[2] && s.music.queue.ids.length === 14 ? s : null))(await state()));
  check(Boolean(afterLast), 'MU-03 AC5 "Ajouter à la file" appends the track (PlayLast)');
  await menuRun(3, 'playlist');
  const sheet = await soon('the playlist sheet', () => ev(`!!document.querySelector('[role="dialog"] form.new')`), 5000);
  check(Boolean(sheet), 'MU-03 AC5 "Ajouter à une playlist…" opens the sheet');
  await shot('add-to-playlist');
  await key('Escape');
  await sleep(300);

  }
  // ======== MU-04 ========
  if (!skip('mu04')) {
  // AC1: the bar shows the track; the route stays the album page.
  const bar = await until('the bar', () => ev(`(() => { const b = document.querySelector('[data-now-playing-bar]'); return b && { title: b.querySelector('[data-title]')?.textContent.trim(), artist: b.querySelector('[data-artist]')?.textContent.trim(), art: b.querySelector('.art img')?.src ?? '' }; })()`), 10000);
  check(bar.title === 'Prélude' && bar.artist === 'Ensemble Quartz' && bar.art.includes('album-4-0') && (await ev('location.hash')).includes('album-4-0'), `MU-04 AC1 bar ${js({ ...bar, art: bar.art.slice(0, 50) })}, route kept`);
  await shot('bar');

  // AC3: a fresh 12-track queue, paused: drag row 5 to 2, then next / next play in the new order.
  await play({ itemIds: quartz, startIndex: 0 });
  await until('a fresh queue', async () => ((s) => s.item?.id === quartz[0] && s.music?.queue.ids.length === 12)(await state()), 10000);
  await pauseNow();
  await click('[data-now-playing-bar] [data-queue]');
  await until('the queue panel', async () => (await count('[data-queue-panel] .row')) === 12, 5000);
  await shot('queue-panel');
  await ev(`(async () => {
    const g = document.querySelector('[data-queue-panel] .row[data-index="5"] .grip');
    const r = g.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const o = { bubbles: true, cancelable: true, pointerId: 7, button: 0, buttons: 1, isPrimary: true, clientX: x };
    g.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientY: y }));
    for (let k = 1; k <= 6; k++) { window.dispatchEvent(new PointerEvent('pointermove', { ...o, clientY: y - k * 26 })); await new Promise((r) => requestAnimationFrame(r)); }
    window.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0, clientY: y - 156 }));
    return true;
  })()`);
  const moved = [quartz[0], quartz[1], quartz[5], quartz[2], quartz[3], quartz[4], ...quartz.slice(6)];
  const afterMove = await soon('the move', async () => ((s) => js(s.music?.queue.ids) === js(moved))(await state()));
  const panelOrder = await ev(`[...document.querySelectorAll('[data-queue-panel] .row')].map((r) => r.dataset.id)`);
  check(Boolean(afterMove) && js(panelOrder) === js(moved), `MU-04 AC3 drag 5 → 2: state and panel ${panelOrder.map((x) => x.slice(-2)).join(',')}`);
  let mark = (await mockState()).reports.length;
  await click('[data-now-playing-bar] [data-ctl="next"]');
  await soon('next (bar)', async () => (await state()).item?.id === moved[1]);
  // AC2: SMTC "next track", as the Windows flyout sends it.
  await ev(`(window.__smtc.nexttrack?.(), true)`);
  await soon('next (SMTC)', async () => (await state()).item?.id === moved[2]);
  // AC2: the taskbar thumbar's next, then previous (buttons 2 and 0), as Explorer clicks them.
  await ev(`(console.log('__thumbar:2'), true)`);
  const thumbNext = await soon('next (thumbar)', async () => (await state()).item?.id === moved[3]);
  await pauseNow();
  await ev(`(console.log('__thumbar:0'), true)`);
  const thumbPrev = await soon('previous (thumbar)', async () => (await state()).item?.id === moved[2]);
  check(Boolean(thumbNext && thumbPrev), `MU-04 AC2 thumbar next then previous (${(await state()).item?.id})`);
  const starts = (await mockState()).reports.slice(mark).filter((r) => r.kind === 'start').map((r) => r.ItemId);
  check(js(starts.slice(0, 2)) === js([moved[1], moved[2]]), `MU-04 AC2/AC3 bar next then SMTC next play the panel's order (${starts.map((x) => x.slice(-2)).join(',')})`);
  await pauseNow();
  // Delete on a focused row removes it.
  const before = (await state()).music.queue.ids;
  await ev(`(document.querySelector('[data-queue-panel] .row[data-index="4"] .main').focus(), true)`);
  await key('Delete', {}, '[data-queue-panel] .row[data-index="4"] .main');
  const afterDelete = await soon('the removal', async () => ((s) => (s.music?.queue.ids.length === before.length - 1 ? s : null))(await state()));
  check(afterDelete && !afterDelete.music.queue.ids.includes(before[4]), 'MU-04 AC3 Delete removes the focused row');
  // Save as playlist: an audio playlist with the queue's ids in order.
  const queueIds = (await state()).music.queue.ids;
  await click('[data-queue-panel] [data-save-queue]');
  await ev(`(() => { const i = document.querySelector('[data-queue-panel] form.name input'); i.value = 'File de contrôle'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await click('[data-queue-panel] [data-save-playlist]');
  await sleep(800);
  const toastText = await ev(`[...document.querySelectorAll('.toasts .toast')].map((t) => t.className + ': ' + t.textContent.trim()).join(' | ')`);
  const saved = await soon('the saved playlist', async () => {
    const lists = await ev(`wicaby.api.get(${js(kind === 'jellyfin' ? '/Items' : `/Users/${userId}/Items`)}, ${js({ ...(kind === 'jellyfin' ? { userId } : {}), IncludeItemTypes: 'Playlist', Recursive: true })})`);
    const p = lists.Items.find((x) => x.Name === 'File de contrôle');
    if (!p) return null;
    const entries = await ev(`wicaby.api.get('/Playlists/${p.Id}/Items', ${js(userQ)})`);
    return { media: p.MediaType, ids: entries.Items.map((x) => x.Id) };
  });
  check(saved && js(saved.ids) === js(queueIds) && (!saved.media || saved.media === 'Audio'), `MU-04 AC3 saved as playlist: ${saved ? `${saved.ids.length} ids in order, ${saved.media ?? '?'}` : 'none'} (${toastText})`);
  // Clear upcoming leaves the current track only.
  await click('[data-queue-panel] [data-clear-upcoming]');
  const cleared = await soon('cleared', async () => ((s) => s.music?.queue.ids.length === s.music?.queue.index + 1)(await state()));
  check(Boolean(cleared), 'MU-04 AC3 "Effacer la suite" leaves only the current track');
  await click('[data-queue-panel] .top button');

  // AC4: shuffle and repeat buttons, state and aria-pressed in step.
  const pressed = (ctl) => ev(`document.querySelector('[data-now-playing-bar] [data-ctl="${ctl}"]').getAttribute('aria-pressed')`);
  await play({ itemIds: quartz, startIndex: 0 });
  await until('playing', async () => (await state()).music?.queue.ids.length === 12, 10000);
  await pauseNow();
  await click('[data-now-playing-bar] [data-ctl="shuffle"]');
  const sh = await soon('shuffle on', async () => (await state()).music?.shuffle && (await pressed('shuffle')) === 'true');
  await click('[data-now-playing-bar] [data-ctl="shuffle"]');
  const shOff = await soon('shuffle off', async () => !(await state()).music?.shuffle && (await pressed('shuffle')) === 'false');
  const cycle = [];
  for (let i = 0; i < 3; i++) {
    const want = ['all', 'one', 'off'][i];
    await click('[data-now-playing-bar] [data-ctl="repeat"]');
    await soon(`repeat ${want}`, async () => (await state()).music?.repeat === want);
    cycle.push(`${(await state()).music?.repeat}:${await pressed('repeat')}`);
  }
  check(sh && shOff && cycle.join(' ') === 'all:true one:true off:false', `MU-04 AC4 shuffle on/off, repeat ${cycle.join(' ')}`);

  // AC5: the full-screen player from the art, opaque under reduced transparency, Escape closes it.
  const hashBefore = await ev('location.hash');
  await click('[data-now-playing-bar] .art');
  await until('the full-screen player', () => ev(`!!document.querySelector('[data-now-playing]') && location.hash.startsWith('#/now-playing')`), 5000);
  await sleep(500);
  const scrim = await ev(`getComputedStyle(document.querySelector('[data-now-playing] .scrim')).backgroundColor`);
  const opaque = !/rgba\(.*,\s*0?\.\d+\)$/.test(scrim) && !scrim.includes('color-mix');
  check(opaque, `MU-04 AC5 full-screen player open, scrim opaque (${scrim})`);
  await shot('now-playing-queue-tab');
  // Arrows on a focused control move the focus (spatial nav), not the volume or the position.
  const npBefore = await state();
  await ev(`(document.querySelector('[data-now-playing] .close').focus(), true)`);
  await key('ArrowDown', {}, '[data-now-playing] .close');
  await key('ArrowRight', {}, '[data-now-playing] .close');
  await sleep(600);
  const npAfter = await state();
  const moves = await ev(`(() => { const a = document.activeElement; return !!a && a !== document.body && !a.classList.contains('close') && !!a.closest('[data-now-playing]'); })()`);
  check(moves && npAfter.volume === npBefore.volume && Math.abs(npAfter.positionMs - npBefore.positionMs) < 700 && (await ev(`!!document.querySelector('[data-now-playing]')`)), `MU-04 AC5 arrows move the focus in the full-screen player (volume ${npBefore.volume}→${npAfter.volume})`);
  await key('Escape');
  const closed = await soon('closed', async () => !(await ev(`!!document.querySelector('[data-now-playing]')`)) && (await ev('location.hash')) === hashBefore);
  check(Boolean(closed), 'MU-04 AC5 Escape closes it');
  // ↓ on the lowest control (nothing below) closes it too.
  await click('[data-now-playing-bar] .art');
  await until('the full-screen player again', () => ev(`!!document.querySelector('[data-now-playing]')`), 5000);
  await sleep(500);
  await ev(`(() => {
    const all = [...document.querySelectorAll('[data-now-playing] button:not([disabled]), [data-now-playing] a[href], [data-now-playing] [tabindex]:not([tabindex="-1"])')].filter((e) => e.getBoundingClientRect().height > 1 && !e.closest('[aria-hidden="true"]'));
    const low = all.reduce((a, b) => (b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2 > a.getBoundingClientRect().top + a.getBoundingClientRect().height / 2 ? b : a));
    low.setAttribute('data-lowest', ''); low.focus(); return true;
  })()`);
  await key('ArrowDown', {}, '[data-lowest]');
  const downClosed = await soon('↓ closed', async () => !(await ev(`!!document.querySelector('[data-now-playing]')`)) && (await ev('location.hash')) === hashBefore);
  check(Boolean(downClosed), 'MU-04 AC5 ↓ with nothing below closes it');

  // AC6: each music shortcut once, none while a text field has focus.
  await play({ itemIds: marée, startIndex: 1 });
  await until('Marée basse', async () => (await state()).item?.id === marée[1], 10000);
  await pauseNow();
  await command({ type: 'seek', positionMs: 10000 });
  await soon('at 10 s', async () => Math.abs((await state()).positionMs - 10000) < 400);
  const results = [];
  const expect = async (name, keyName, mods, test) => {
    const s0 = await state();
    await key(keyName, mods);
    const ok = await soon(name, async () => test(s0, await state()), 4000);
    // The page's store follows main a moment later: the next key reads it.
    await sleep(400);
    results.push(`${name}${ok ? '' : ' FAILED'}`);
    if (!ok) failures.push(`MU-04 AC6 ${name}`);
  };
  await expect('Space resumes', ' ', {}, (a, b) => a.paused && !b.paused);
  await expect('Space pauses', ' ', {}, (a, b) => !a.paused && b.paused);
  await expect('→ +5 s', 'ArrowRight', {}, (a, b) => Math.abs(b.positionMs - a.positionMs - 5000) < 700);
  await expect('← −5 s', 'ArrowLeft', {}, (a, b) => Math.abs(a.positionMs - b.positionMs - 5000) < 700);
  await expect('Shift+← −30 s', 'ArrowLeft', { shift: true }, (a, b) => b.positionMs < 700);
  await expect('↓ volume −5', 'ArrowDown', {}, (a, b) => b.volume === a.volume - 5);
  await expect('↑ volume +5', 'ArrowUp', {}, (a, b) => b.volume === a.volume + 5);
  await expect('M mutes', 'm', {}, (a, b) => b.muted === !a.muted);
  await expect('M unmutes', 'm', {}, (a, b) => b.muted === !a.muted);
  await expect('S shuffles', 's', {}, (a, b) => b.music.shuffle === !a.music.shuffle);
  await expect('S unshuffles', 's', {}, (a, b) => b.music.shuffle === !a.music.shuffle);
  await expect('R repeats', 'r', {}, (a, b) => b.music.repeat === 'all' && a.music.repeat === 'off');
  await command({ type: 'repeat', mode: 'off' });
  await expect('Ctrl+→ next', 'ArrowRight', { ctrl: true }, (a, b) => b.item?.id === marée[2]);
  await pauseNow();
  await expect('Ctrl+← previous', 'ArrowLeft', { ctrl: true }, (a, b) => b.item?.id === marée[1]);
  await pauseNow();
  await expect('Shift+→ +30 s', 'ArrowRight', { shift: true }, (a, b) => b.item?.id !== a.item?.id || b.positionMs > a.positionMs + 15000);
  await stopPlayback();
  await play({ itemIds: marée, startIndex: 0 });
  await until('Marée basse', async () => (await state()).item?.id === marée[0], 10000);
  await pauseNow();
  await key('q');
  const q1 = await soon('Q opens the queue', () => ev(`!!document.querySelector('[data-queue-panel]')`), 3000);
  await key('q');
  const q2 = await soon('Q closes it', async () => !(await ev(`!!document.querySelector('[data-queue-panel]')`)), 3000);
  results.push(`Q${q1 && q2 ? '' : ' FAILED'}`);
  if (!(q1 && q2)) failures.push('MU-04 AC6 Q toggles the queue');
  await key('l');
  const l1 = await soon('L opens the lyrics', () => ev(`location.hash.startsWith('#/now-playing') && !!document.querySelector('[data-lyrics]')`), 4000);
  await key('Escape');
  const l2 = await soon('Escape closes', async () => !(await ev(`location.hash.startsWith('#/now-playing')`)), 4000);
  results.push(`L/Escape${l1 && l2 ? '' : ' FAILED'}`);
  if (!(l1 && l2)) failures.push('MU-04 AC6 L / Escape');
  const favBefore = Boolean((await userItem(marée[0])).UserData?.IsFavorite);
  await soon('the bar heart', () => ev(`!!document.querySelector('[data-now-playing-bar] [data-fav]')`), 4000);
  await key('f');
  const fav = await soon('F favourite', async () => Boolean((await userItem(marée[0])).UserData?.IsFavorite) !== favBefore, 4000);
  results.push(`F${fav ? '' : ' FAILED'}`);
  if (!fav) failures.push('MU-04 AC6 F favourite');
  // A focused control that handles a key itself (the guide's F/R/Ctrl+→, the photo grid's F/S) keeps it: one
  // command, never a second music one. A plain focused button still gets the shortcut.
  await ev(`(() => { const b = document.createElement('button'); b.id = '__own'; b.addEventListener('keydown', (e) => /^[fsr]$/i.test(e.key) || e.ctrlKey ? e.preventDefault() : 0); document.body.append(b); b.focus(); return true; })()`);
  const o0 = await state();
  const fav0 = Boolean((await userItem(marée[0])).UserData?.IsFavorite);
  for (const [k, m] of [['f', {}], ['s', {}], ['r', {}], ['ArrowRight', { ctrl: true }]]) await key(k, m, '#__own');
  await sleep(800);
  const o1 = await state();
  const own = o1.music.shuffle === o0.music.shuffle && o1.music.repeat === o0.music.repeat && o1.item?.id === o0.item?.id && Boolean((await userItem(marée[0])).UserData?.IsFavorite) === fav0;
  check(own, `MU-04 AC6 keys a focused control handles stay its own ${own ? '' : js({ o0: [o0.music.shuffle, o0.music.repeat, o0.item?.id], o1: [o1.music.shuffle, o1.music.repeat, o1.item?.id] })}`);
  await ev(`(() => { const b = document.createElement('button'); b.id = '__plain'; document.body.append(b); b.focus(); return true; })()`);
  await key('s', {}, '#__plain');
  const plain = await soon('S on a plain button', async () => (await state()).music.shuffle === !o0.music.shuffle, 3000);
  await command({ type: 'shuffle', value: o0.music.shuffle });
  await ev(`(document.getElementById('__own').remove(), document.getElementById('__plain').remove(), true)`);
  check(Boolean(plain), 'MU-04 AC6 S still fires with a plain button focused');
  // In a text field: nothing.
  const s0 = await state();
  await ev(`(() => { const i = document.createElement('input'); i.id = '__typing'; document.body.append(i); i.focus(); return true; })()`);
  for (const k of ['m', ' ', 's', 'ArrowUp']) await key(k, {}, '#__typing');
  await sleep(800);
  const s1 = await state();
  const quiet = s1.muted === s0.muted && s1.paused === s0.paused && s1.music.shuffle === s0.music.shuffle && s1.volume === s0.volume;
  await ev(`(document.getElementById('__typing').remove(), true)`);
  check(quiet, `MU-04 AC6 no shortcut fires while a text field has focus ${quiet ? '' : js({ s0: [s0.muted, s0.paused, s0.music.shuffle, s0.volume], s1: [s1.muted, s1.paused, s1.music.shuffle, s1.volume] })}`);
  check(!results.some((r) => r.endsWith('FAILED')), `MU-04 AC6 shortcuts: ${results.join(', ')}`);
  await stopPlayback();

  }
  // ======== MU-05 ========
  if (!skip('mu05')) {
  const lyricAlbum = ['track-3-0-0', 'track-3-0-1', 'track-3-0-2'];
  const openLyrics = async (ids) => {
    await play({ itemIds: ids, startIndex: 0 });
    await until('the track', async () => (await state()).item?.id === ids[0], 10000);
    await pauseNow();
    await go('#/now-playing?tab=lyrics', '[data-lyrics]');
    return until('the lyrics', () => ev(`(() => { const d = document.querySelector('[data-lyrics]')?.dataset.lyrics; return d && d !== 'loading' && d; })()`), 10000).catch(async (err) => {
      log('  lyrics debug', js(await ev(`(async () => ({ state: document.querySelector('[data-lyrics]')?.dataset.lyrics, hash: location.hash, lrc: await wicaby.api.get('/Videos/${ids[0]}/${ids[0]}/Subtitles/1/Stream.lrc').then((v) => typeof v + ':' + String(v).slice(0, 40), (e) => 'ERR ' + e.message), item: await wicaby.api.get(${js(kind === 'jellyfin' ? `/Items/` : `/Users/${userId}/Items/`)} + '${ids[0]}', ${js(kind === 'jellyfin' ? { userId } : {})}).then((v) => (v.MediaSources?.[0]?.MediaStreams ?? []).map((x) => x.Type + '/' + x.Codec).join(','), (e) => 'ERR ' + e.message) }))()`)));
      throw err;
    });
  };
  const closeNp = async () => {
    await ev('(history.back(), true)');
    await soon('closed', async () => !(await ev(`location.hash.startsWith('#/now-playing')`)), 4000);
  };
  if (kind === 'emby') {
    // AC3: the lrc subtitle stream of the audio item (§3.5, unverified on a real Emby).
    const shown = await openLyrics(lyricAlbum);
    check(shown === 'synced' && mockLines.some((l) => /\/Videos\/track-3-0-0\/[^/]+\/Subtitles\/1\/Stream\.lrc/.test(l)), `MU-05 AC3 Emby: ${shown} lyrics from Subtitles/1/Stream.lrc`);
    await shot('lyrics-emby');
    await closeNp();
    await stopPlayback();
  } else {
    const shown = await openLyrics(lyricAlbum);
    check(shown === 'synced', 'MU-05 AC1 Jellyfin: synced lyrics from /Audio/{id}/Lyrics');
    // AC1: at 5 positions the current line is the last one with start ≤ t (+ offset 0). Line i starts at i s (+0.5 s when odd).
    const starts = Array.from({ length: 11 }, (_, i) => i * 1000 + (i % 2 ? 500 : 0));
    const lines = [];
    for (const t of [200, 1700, 4200, 6600, 9900]) {
      await command({ type: 'seek', positionMs: t });
      await soon(`at ${t}`, async () => Math.abs((await state()).positionMs - t) < 300, 4000);
      await sleep(300);
      const at = (await state()).positionMs;
      const want = starts.reduce((c, s, i) => (s <= at ? i : c), -1);
      const got = Number(await ev(`document.querySelector('ol.lines')?.dataset.current`));
      lines.push(`${t}:${got}/${want}`);
    }
    check(lines.every((x) => ((a) => a[0] === a[1])(x.split(':')[1].split('/'))), `MU-05 AC1 current line ${lines.join(' ')}`);
    await shot('lyrics-jellyfin');
    // AC2: a click on line 7 seeks to its start.
    await ev(`(document.querySelectorAll('ol.lines button')[7].click(), true)`);
    const seeked = await soon('the seek', async () => Math.abs((await state()).positionMs - starts[7]) <= 200, 4000);
    check(Boolean(seeked), `MU-05 AC2 clicking line 8 seeks to ${starts[7]} ms (${Math.round((await state()).positionMs)} ms)`);
    // AC5: reduced motion: no transition on the scroll.
    const dur = await ev(`getComputedStyle(document.querySelector('ol.lines')).transitionDuration`);
    check(dur === '0s', `MU-05 AC5 reduced motion: transition-duration ${dur}`);
    await closeNp();
    await stopPlayback();
    // AC4: plain lyrics as paragraphs; none; a 500 shows "none" and no toast.
    const plain = await openLyrics(['track-3-1-0']);
    const paras = await count('[data-lyrics="plain"] p.title-3');
    check(plain === 'plain' && paras >= 3, `MU-05 AC4 plain lyrics as ${paras} paragraphs`);
    await shot('lyrics-plain');
    await closeNp();
    await stopPlayback();
    const none = await openLyrics(['track-0-0-0']);
    check(none === 'none', `MU-05 AC4 no lyrics: ${none}`);
    await closeNp();
    await stopPlayback();
    const toastsBefore = await count('.toasts .toast.error');
    const failed = await openLyrics([FAIL_LYRICS]);
    await sleep(500);
    check(failed === 'none' && (await count('.toasts .toast.error')) === toastsBefore && mockLines.some((l) => l.includes(`/Audio/${FAIL_LYRICS}/Lyrics`)), `MU-05 AC4 a 500: ${failed}, no toast`);
    await closeNp();
    await stopPlayback();
  }

  }
  // ======== MU-06 ========
  if (!skip('mu06')) {
  // AC1: Mix from a track, an album, an artist, a genre and a playlist: /Items/{id}/InstantMix, never a per-type route.
  const mixFrom = async (what, id, run) => {
    const n = (await mockState()).instantMix.length;
    await run();
    const call = await soon(`the ${what} mix`, async () => (await mockState()).instantMix.slice(n).find((c) => c.id === id), 8000);
    const playing = await soon('the mix playing', async () => (await state()).active && (await state()).music, 8000);
    check(call?.route === `/Items/${id}/InstantMix` && playing, `MU-06 AC1 ${what}: ${call?.route ?? 'no call'}${playing ? ', playing' : ''}`);
    await pauseNow();
  };
  await go(`#/item/${serverId}/album-1-0`, 'section.tracks button.track');
  await mixFrom('track', 'track-1-0-1', async () => {
    await ev(`(document.querySelectorAll('section.tracks .row')[1].querySelector('.more').click(), true)`);
    await until('the track menu', () => ev(`!!document.querySelector('[data-track-menu]')`), 5000);
    await click('[data-track-menu] [data-action="mix"]');
  });
  await mixFrom('album', 'album-1-0', () => click('[data-mix]'));
  await go(`#/item/${serverId}/artist-1`, '.artist-actions');
  await mixFrom('artist', 'artist-1', () => ev(`(document.querySelectorAll('.artist-actions button')[1].click(), true)`));
  await shot('artist');
  await go(lib, '[data-tab-panel]');
  await click('[data-tab="genres"]');
  await soon('genres', async () => (await count('.genre')) === EXPECT.genres);
  await ev(`([...document.querySelectorAll('.genre')].find((g) => g.textContent.includes('Électro')).click(), true)`);
  await until('the genre filter', () => ev(`!!document.querySelector('[data-genre-mix]')`), 5000);
  await shot('genre-albums');
  await mixFrom('genre', 'genre-electro', () => click('[data-genre-mix]'));
  await go(`#/item/${serverId}/playlist-music`, '[data-mix]');
  await mixFrom('playlist', 'playlist-music', () => click('[data-mix]'));
  check((await mockState()).instantMix.every((c) => c.route.startsWith('/Items/')), 'MU-06 AC1 no per-type InstantMix route was called');
  await stopPlayback();

  // AC2: radio on with ≤ 3 upcoming: one more InstantMix call, ≤ 20 new ids, none repeated.
  await play({ itemIds: ['track-0-1-0', 'track-0-1-1'], startIndex: 0 });
  await until('Brume', async () => (await state()).item?.id === 'track-0-1-0', 10000);
  await pauseNow();
  const mixes = (await mockState()).instantMix.length;
  await click('[data-now-playing-bar] [data-queue]');
  await until('the queue panel', () => ev(`!!document.querySelector('[data-queue-panel] [data-radio]')`), 5000);
  await click('[data-queue-panel] [data-radio]');
  const grown = await soon('the top-up', async () => ((s) => (s.music?.queue.ids.length > 2 ? s : null))(await state()), 8000);
  const ids = grown?.music.queue.ids ?? [];
  const calls = (await mockState()).instantMix.length - mixes;
  check(grown && grown.music.radio && calls === 1 && ids.length - 2 <= 20 && new Set(ids).size === ids.length, `MU-06 AC2 radio: ${calls} InstantMix call, +${ids.length - 2} ids, ${new Set(ids).size === ids.length ? 'no repeat' : 'REPEATS'}`);
  await shot('queue-radio');
  await click('[data-queue-panel] .top button');
  await stopPlayback();

  // AC3: the heart on a row and on the bar.
  await go(`#/item/${serverId}/album-2-0`, 'section.tracks button.track');
  const t0 = 'track-2-0-0';
  const fav0 = Boolean((await userItem(t0)).UserData?.IsFavorite);
  const lines0 = mockLines.length;
  await ev(`(document.querySelector('section.tracks .row .fav').click(), true)`);
  const rowFav = await soon('the row heart', async () => Boolean((await userItem(t0)).UserData?.IsFavorite) !== fav0, 5000);
  const route = kind === 'jellyfin' ? `/UserFavoriteItems/${t0}` : `/FavoriteItems/${t0}`;
  check(rowFav && mockLines.slice(lines0).some((l) => l.includes(route)), `MU-06 AC3 row heart toggles IsFavorite through ${route}`);
  await click('section.tracks button.track');
  await until('playing', async () => (await state()).item?.id === t0, 10000);
  await pauseNow();
  await until('the bar heart', () => ev(`!!document.querySelector('[data-now-playing-bar] [data-fav]')`), 5000);
  const fav1 = Boolean((await userItem(t0)).UserData?.IsFavorite);
  await click('[data-now-playing-bar] [data-fav]');
  const barFav = await soon('the bar heart', async () => Boolean((await userItem(t0)).UserData?.IsFavorite) !== fav1, 5000);
  check(Boolean(barFav), 'MU-06 AC3 bar heart toggles IsFavorite');

  }
  // ======== Feishin spec C3 / C6 ========
  if (!skip('fe')) {
    await stopPlayback();
    // C4 "More from {artist}": the artist's other albums only (Emby: ArtistIds + ArtistType, never AlbumArtistIds).
    const lines4 = mockLines.length;
    await go(`#/item/${serverId}/album-0-0`, 'section.tracks button.track');
    const moreTitle = fr('music').albumPage.moreFrom.replace('{name}', 'Les Ondes Calmes');
    const more = await soon('the More from row', () => ev(`(() => { const h = [...document.querySelectorAll('section.row h2')].find((x) => x.textContent.trim() === ${js(moreTitle)}); return h && [...h.closest('section.row').querySelectorAll('.card')].map((c) => c.textContent.trim()); })()`), 8000);
    const asked = mockLines.slice(lines4).filter((l) => /IncludeItemTypes=MusicAlbum/.test(l) && /ArtistIds=/.test(l));
    const filterOk = kind === 'emby' ? asked.some((l) => /[?&]ArtistIds=/.test(l) && /ArtistType=AlbumArtist/.test(l)) && !asked.some((l) => /AlbumArtistIds=/.test(l)) : asked.some((l) => /AlbumArtistIds=/.test(l));
    check(more?.length === 1 && more[0].includes('Brume') && filterOk, `C4 "${moreTitle}" lists ${js(more)}, filter ${filterOk ? 'ok' : js(asked.slice(0, 2))}`);
    await go(`#/item/${serverId}/album-4-0`, 'section.tracks button.track');
    await soon('12 tracks', async () => (await count('section.tracks button.track')) === 12);
    const selected = () => ev(`[...document.querySelectorAll('section.tracks .row[aria-selected="true"]')].map((r) => r.querySelector('button.track').dataset.id)`);
    // Ctrl-click 3 rows: those rows aria-selected, the bar counts 3, nothing plays.
    for (const i of [0, 2, 4]) await ev(`(document.querySelectorAll('section.tracks button.track')[${i}].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })), true)`);
    const three = await selected();
    const barCount = await ev(`document.querySelector('[data-selection-bar] [data-count]')?.dataset.count`);
    check(js(three) === js([quartz[0], quartz[2], quartz[4]]) && barCount === '3' && (await count('section.tracks .row[aria-selected="false"]')) === 9, `C3 Ctrl-click 3 rows: aria-selected ${three.length}, bar ${barCount}`);
    // Space (a real key, so a button would activate) toggles the focused row and plays nothing.
    const space = async (i) => {
      await ev(`(document.querySelectorAll('section.tracks button.track')[${i}].focus(), true)`);
      for (const type of ['keyDown', 'keyUp']) await main.call('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, ...(type === 'keyDown' ? { text: ' ' } : {}) });
      await sleep(150);
    };
    await space(6);
    const four = await selected();
    await space(6);
    const back3 = await selected();
    await sleep(500);
    check(four.length === 4 && four.includes(quartz[6]) && js(back3) === js(three) && !(await state()).active, `C3 Space toggles the focused row (${four.length} then ${back3.length}), nothing plays`);
    await key('Escape');
    check((await soon('cleared', async () => (await selected()).length === 0 && !(await ev(`!!document.querySelector('[data-selection-bar]')`)), 3000)) !== null, 'C3 Escape clears the selection');
    // A drop on the queue panel's row 3 (upper half) inserts before it.
    await play({ itemIds: quartz, startIndex: 0 });
    await until('a fresh queue', async () => ((st) => st.item?.id === quartz[0] && st.music?.queue.ids.length === 12)(await state()), 10000);
    await pauseNow();
    await click('[data-now-playing-bar] [data-queue]');
    await until('the queue panel', async () => (await count('[data-queue-panel] .row')) === 12, 5000);
    await ev(`(() => {
      const dt = new DataTransfer();
      dt.setData('application/x-wicaby-tracks', ${js(js({ ids: marée.slice(0, 2), serverId }))});
      const row = document.querySelector('[data-queue-panel] .row[data-index="3"] .main');
      const r = row.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.top + 4 };
      row.dispatchEvent(new DragEvent('dragover', o));
      row.dispatchEvent(new DragEvent('drop', o));
      return true;
    })()`);
    const want = [...quartz.slice(0, 3), ...marée.slice(0, 2), ...quartz.slice(3)];
    const dropped = await soon('the drop', async () => ((st) => js(st.music?.queue.ids) === js(want))(await state()), 8000);
    check(Boolean(dropped), `C3 a drop on queue row 3 inserts there (${((await state()).music?.queue.ids ?? []).map((x) => x.slice(-5)).join(',')})`);
    await click('[data-queue-panel] .top button');
    // C6: clicking the active tab closes the panel (data-panel=closed), clicking it again opens it.
    await click('[data-now-playing-bar] .art');
    await until('the full-screen player', () => ev(`!!document.querySelector('[data-now-playing] .body')`), 5000);
    const activeTab = '[data-now-playing] .right [role="radio"][aria-checked="true"]';
    const panel = () => ev(`(() => { const b = document.querySelector('[data-now-playing] .body'); return b.dataset.panel + ':' + (b.querySelector('.pane-body').hidden ? 'hidden' : 'shown'); })()`);
    const open0 = await panel();
    await click(activeTab);
    const closedP = await soon('panel closed', async () => ((v) => (v === 'closed:hidden' ? v : null))(await panel()), 3000);
    await shot('np-panel-closed');
    await click(activeTab);
    const reopened = await soon('panel open', async () => ((v) => (v === 'open:shown' ? v : null))(await panel()), 3000);
    check(open0 === 'open:shown' && Boolean(closedP) && Boolean(reopened), `C6 the active tab toggles data-panel (${open0} → ${closedP} → ${reopened})`);
    await key('Escape');
    await soon('closed', async () => !(await ev(`!!document.querySelector('[data-now-playing]')`)));
    await stopPlayback();
  }
  // ======== Stop ======== paused, then the bar's Stop: Stopped reported, the bar gone, no queue to restore.
  if (kind === 'emby') {
    await play({ itemIds: marée, startIndex: 0 });
    await until('track 1 playing', async () => ((st) => st.item?.id === marée[0] && st.positionMs > 300)(await state()), 10000);
    await click('[data-now-playing-bar] [data-ctl="play"]');
    await until('paused', async () => (await state()).paused, 5000);
    const at = (await mockState()).reports.length;
    await click('[data-now-playing-bar] [data-ctl="stop"]');
    const gone = await soon('the bar gone', async () => !(await state()).active && !(await ev(`!!document.querySelector('[data-now-playing-bar]')`)), 10000);
    const stopped = await soon('Stopped', async () => (await mockState()).reports.slice(at).some((r) => r.kind === 'stopped' && r.ItemId === marée[0]), 5000);
    // The store writes after a short debounce.
    const cleared = await soon('the saved queue cleared', () => JSON.parse(fs.readFileSync(path.join(profile, 'music-queue.json'), 'utf8')) === null, 5000);
    check(Boolean(gone) && Boolean(stopped) && Boolean(cleared), `Stop from the bar: bar gone ${Boolean(gone)}, Stopped reported ${Boolean(stopped)}, saved queue cleared ${Boolean(cleared)}`);
  }
  // ======== MU-04 AC7 ======== restart with resumeQueue on: the bar is back, paused, nothing plays.
  if (kind === 'emby') {
    await play({ itemIds: marée, startIndex: 1 });
    await until('track 2 playing', async () => ((st) => st.item?.id === marée[1] && st.positionMs > 300)(await state()), 10000);
    await command({ type: 'seek', positionMs: 6000 });
    await sleep(6500);
    await quitApp();
    const savedAt = JSON.parse(fs.readFileSync(path.join(profile, 'music-queue.json'), 'utf8')).positionMs;
    await launch(false);
    const back = await soon('the restored bar', () => ev(`document.querySelector('[data-now-playing-bar] [data-title]')?.textContent.trim()`), 30000);
    await sleep(1500);
    const s = await state();
    const label = await ev(`document.querySelector('[data-now-playing-bar] [data-ctl="play"]')?.getAttribute('aria-label')`);
    check(back === 'Phare' && s.paused && s.item?.id === marée[1] && Math.abs(s.positionMs - savedAt) < 1500 && label === fr('music').bar.play, `MU-04 AC7 restored paused on "${back}" at ${Math.round(s.positionMs)} ms (saved ${savedAt}), button ${label}`);
    await shot('restored');
    await stopPlayback();
  }

  main.close();
  stopAll();
  await sleep(800);
  try {
    if (process.env.MUSICUI_DEBUG) log('  profile kept:', profile);
    else fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    // Electron may still hold a file for a moment.
  }
  return failures;
}

async function run() {
  if (process.platform !== 'win32') throw new Error('Windows only (mpv named pipes)');
  for (const p of [MOCK_PORT, MOCK_PORT + 1, DEV_PORT, CDP_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is busy`);
  const failures = [];
  for (const kind of ['emby', 'jellyfin']) {
    if (args.only && args.only !== kind) continue;
    log(`== ${kind}`);
    failures.push(...(await pass(kind)).map((f) => `${kind}: ${f}`));
  }
  log(failures.length ? `${failures.length} problem(s):\n  ${failures.join('\n  ')}` : 'ok: library views, bar, queue, full-screen player, shortcuts, lyrics, mix and favourites, Feishin C3/C4/C6');
  return failures.length ? 1 : 0;
}

let code = 1;
try {
  code = await run();
} catch (err) {
  console.error('[music-ui]', err.stack ?? err.message);
}
if (args.keep) {
  log(`kept running: CDP ${CDP_PORT}; Ctrl+C stops`);
  await new Promise(() => undefined);
}
stopAll();
process.exit(code);
