#!/usr/bin/env node
// Desktop music engine (music-spec MU-02 AC1 to AC7), driven over CDP against the mocks' music library. Not part
// of run-all: it needs Electron (the dev build, scripts/dev.mjs), mpv (vendor/mpv) and Windows (named pipes).
// Never audible: WICABY_TEST_SILENT=1 gives mpv --ao=null and Chromium mute-audio, and the mock serves silence.
// Windows open inactive, unfocusable and click-through (the guard below); nothing leaves loopback.
//
//   AC1 an album played from its page starts mpv with no window: no OSD page, the route stays the album's.
//   AC2 gapless over a 3-track album: mpv holds 2 entries before each transition, Stopped(n) at ≥ 99 % then
//       Playing(n+1) within 500 ms, and no loadfile replace between the tracks (the app log).
//   AC3 queue edits while the next track is prefetched (move, remove, play next): mpv's entry 1 is the new next.
//   AC4 repeat one plays track 1 three times; repeat all wraps from the last track to the first; shuffle off
//       restores the order.
//   AC5 loudness: tagged FLAC → replaygain=album, source tags; Emby untagged → replaygain-fallback = fallbackDb;
//       Jellyfin untagged → replaygain-fallback = the album's NormalizationGain (read from mpv over its pipe).
//   AC6 the built-in fallback (playerByType.music = html): tracks in order, reports sent, no player route.
//   AC7 SMTC metadata of the main window = title, artists, album, the album's art.
//
//   node tools/checks/music-engine-check.mjs [--only=emby|jellyfin] [--shots=<dir>] [--keep]
// Ports: MUSICCDP_MOCK_PORT (8871, Jellyfin +1), MUSICCDP_DEV_PORT (5611), MUSICCDP_CDP_PORT (9771).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const MOCK_PORT = Number(process.env.MUSICCDP_MOCK_PORT) || 8871;
const DEV_PORT = Number(process.env.MUSICCDP_DEV_PORT) || 5611;
const CDP_PORT = Number(process.env.MUSICCDP_CDP_PORT) || 9771;
const SHOTS = typeof args.shots === 'string' ? path.resolve(args.shots) : null;
const TICKS_PER_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[music-cdp]', ...m);
const js = (v) => JSON.stringify(v);

const children = [];
function start(cmd, argv, opts) {
  const child = spawn(cmd, argv, { stdio: process.env.MUSICCDP_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
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

// Loopback UDP only, and windows that never take the focus or the mouse (same guard as player-exit-cdp.mjs).
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
  const consoleLines = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
    if (m.method === 'Runtime.consoleAPICalled') consoleLines.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
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
  if (process.env.MUSICCDP_DEBUG) await call('Runtime.enable');
  return { call, evaluate, consoleLines, close: () => ws.close() };
}
const isApp = (t) => /^(app:|http:\/\/localhost)/.test(t.url);

// mpv's own JSON IPC, as a second client of the pipe Wicaby opened (read-only use: get_property).
const PIPES = '\\\\.\\pipe\\';
const mpvPipes = () => new Set(fs.readdirSync(PIPES).filter((n) => n.startsWith('wicaby-mpv-')));
async function mpvClient(before) {
  const name = await until('the mpv pipe', () => [...mpvPipes()].find((n) => !before.has(n)), 20000, 200);
  const sock = net.connect(PIPES + name);
  await new Promise((resolve, reject) => (sock.once('connect', resolve), sock.once('error', reject)));
  sock.setEncoding('utf8');
  let buf = '';
  let id = 1000;
  const pending = new Map();
  sock.on('data', (d) => {
    buf += d;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const m = JSON.parse(line);
        if (pending.has(m.request_id)) (pending.get(m.request_id)(m), pending.delete(m.request_id));
      } catch {
        // not JSON
      }
    }
  });
  sock.on('error', () => undefined);
  const get = (prop) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, (m) => resolve(m.error === 'success' ? m.data : undefined));
      sock.write(JSON.stringify({ command: ['get_property', prop], request_id: i }) + '\n');
      setTimeout(() => pending.has(i) && (pending.delete(i), resolve(undefined)), 2000);
    });
  return { get, close: () => sock.destroy() };
}

function seedProfile(profile, kind, port) {
  const address = `http://127.0.0.1:${port}`;
  const id = kind === 'emby' ? 'a1b2c3d4e5f60718293a4b5c6d7e8f90' : '7e1f0c2a9b8d4e6fa1c3b5d7e9f02468';
  fs.writeFileSync(path.join(profile, 'servers.json'), js({ servers: [{ id, name: 'Mock', kind, version: kind === 'emby' ? '4.9.1.0' : '12.2.0', manualAddress: address, lastAddress: address }], activeId: id, tokenBinding: 1 }));
  fs.writeFileSync(path.join(profile, 'settings.json'), js({ ui: { language: 'fr', heroAutoplay: false, reduceTransparency: true, reduceMotion: true }, windows: { trayHintShown: true }, window: { bounds: { x: 80, y: 60, width: 1280, height: 800 } }, playback: { player: 'mpv' } }));
  const guard = path.join(profile, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  return { guard, serverId: id };
}

async function pass(kind) {
  const port = kind === 'emby' ? MOCK_PORT : MOCK_PORT + 1;
  const base = `http://127.0.0.1:${port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `wicaby-music-${kind}-`));
  const failures = [];
  const check = (ok, what) => (ok ? log(`  ok  ${what}`) : (failures.push(what), log(`  FAIL ${what}`)));
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', kind === 'emby' ? 'mock-emby.mjs' : 'mock-jellyfin.mjs'), String(port)], { cwd: ROOT, env: { ...process.env, MOCK_MUSIC: '1', NODE_OPTIONS: '' } });
  await until('the mock server', async () => (await fetch(`${base}${kind === 'emby' ? '/emby' : ''}/System/Info/Public`)).ok);
  const mockState = async () => (await (await fetch(`${base}/Mock/State`)).json()).music;
  const { guard, serverId } = seedProfile(profile, kind, port);
  const pipesBefore = mpvPipes();
  let app = null;
  let main = null;
  // The app on this profile; login: sign in (a relaunch is already signed in).
  const launch = async (login) => {
    app = start(process.execPath, [path.join(DESKTOP, 'scripts', 'dev.mjs'), `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`], {
      cwd: DESKTOP,
      env: { ...process.env, WICABY_DEV_PORT: String(DEV_PORT), WICABY_TEST_SILENT: '1', NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
    });
    main = await attach((t) => isApp(t) && !t.url.includes('osd=1'));
    await until('the session', () => main.evaluate(`window.wicaby?.session.get().then((s) => s.status !== 'no-server' && s.status !== 'connecting')`), 60000, 500);
    if (login) {
      const status = await main.evaluate(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
      if (status !== 'signed-in') throw new Error(`${kind}: sign-in failed (${status})`);
    }
    // The page up (its stores listen): a built-in player load sent before would be lost.
    await until('the app shell', () => main.evaluate(`!!document.getElementById('main-scroller')`), 30000, 200);
  };
  const quitApp = async () => {
    main.close();
    spawnSync('taskkill', ['/T', '/F', '/PID', String(app.pid)], { stdio: 'ignore' });
    await until('the dev server gone', () => portFree(DEV_PORT), 15000, 200);
  };
  await launch(true);
  const state = () => main.evaluate('wicaby.playback.getState()');
  const command = (c) => main.evaluate(`wicaby.playback.command(${js(c)}).then(() => true)`);
  const play = (req) => main.evaluate(`wicaby.playback.play(${js({ serverId, ...req })}).then(() => true)`);
  const reports = async () => (await mockState()).reports;
  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const { data } = await main.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${kind}-${name}.png`), Buffer.from(data, 'base64'));
  };
  const logText = () => fs.readdirSync(path.join(profile, 'logs')).map((f) => fs.readFileSync(path.join(profile, 'logs', f), 'utf8')).join('');
  const gain = ['track-5-0-0', 'track-5-0-1', 'track-5-0-2'];
  const lignes = ['track-3-0-0', 'track-3-0-1', 'track-3-0-2'];
  const runTicks = { 'track-5-0-0': 4e7, 'track-5-0-1': 4e7, 'track-5-0-2': 4e7, 'track-3-0-0': 12e7, 'track-3-0-1': 12e7, 'track-3-0-2': 12e7 };

  if (kind === 'emby') {
    // AC1 + AC2: the "Gain" album (3 × 4 s of tagged FLAC) from its page, first track row.
    const hash = `#/item/${serverId}/album-5-0`;
    await main.evaluate(`location.hash = '${hash}'`);
    await until('the album page', () => main.evaluate(`document.querySelectorAll('section.tracks button.track').length === 3`), 20000);
    await shot('album');
    const logBefore = logText().length;
    await main.evaluate(`document.querySelector('section.tracks button.track').click()`);
    const mpv = await mpvClient(pipesBefore);
    // Sample mpv's playlist every 50 ms through the album.
    const samples = [];
    const sampler = setInterval(async () => samples.push({ at: Date.now(), count: await mpv.get('playlist-count'), path: await mpv.get('path') }), 50);
    await until('the first track', async () => (await state()).item?.id === gain[0], 15000);
    await sleep(800);
    const targets = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter((t) => t.type === 'page');
    check(!targets.some((t) => t.url.includes('osd=1')) && targets.length === 1, 'AC1 no OSD or player page (only the main window)');
    check((await main.evaluate('location.hash')) === hash, 'AC1 the route stays the album page');
    await shot('playing-album');
    // AC5 (tags) and AC7 while the tagged FLAC plays.
    check((await mpv.get('replaygain')) === 'album', 'AC5 tagged FLAC: replaygain = album');
    check((await mpv.get('volume-gain')) === 0, 'AC5 tagged FLAC: volume-gain not set');
    await until('the gain readout', async () => (await state()).music?.gain, 5000);
    const g = (await state()).music.gain;
    check(g.source === 'tags' && g.db === -6.25, `AC5 tagged FLAC: gain from the tags (${js(g)})`);
    const meta = await main.evaluate(`(() => { const m = navigator.mediaSession.metadata; return m && { title: m.title, artist: m.artist, album: m.album, art: m.artwork[0]?.src ?? '' }; })()`);
    check(meta?.title === 'Niveau' && meta.artist === 'Les Graphites' && meta.album === 'Gain' && meta.art.includes('album-5-0'), `AC7 SMTC metadata ${js(meta)}`);
    await until('the end of the album', async () => !(await state()).active, 30000);
    clearInterval(sampler);
    const r = (await reports()).filter((x) => gain.includes(x.ItemId) && x.kind !== 'progress');
    const seq = r.map((x) => `${x.kind}:${x.ItemId.slice(-1)}`).join(' ');
    check(seq === 'start:0 stopped:0 start:1 stopped:1 start:2 stopped:2', `AC2 report order ${seq}`);
    for (let i = 0; i < 2; i++) {
      const stop = r.find((x) => x.kind === 'stopped' && x.ItemId === gain[i]);
      const next = r.find((x) => x.kind === 'start' && x.ItemId === gain[i + 1]);
      check(stop && next && stop.PositionTicks >= 0.99 * runTicks[gain[i]] && next.at - stop.at <= 500, `AC2 transition ${i}: Stopped at ${stop?.PositionTicks} ticks, Playing ${next && stop ? next.at - stop.at : '?'} ms later`);
    }
    const paths = samples.filter((s) => typeof s.path === 'string');
    const changes = paths.filter((s, i) => i > 0 && s.path !== paths[i - 1].path);
    check(changes.length >= 2 && changes.every((c) => paths.filter((s) => s.at < c.at && s.at > c.at - 3000).some((s) => s.count === 2)), `AC2 mpv held 2 entries before each of ${changes.length} transitions`);
    const appLog = logText().slice(logBefore);
    const replaces = (appLog.match(/loadfile replace/g) ?? []).length;
    const appends = (appLog.match(/loadfile append/g) ?? []).length;
    check(replaces === 1 && appends === 2, `AC2 one loadfile replace, then appends only (${replaces} replace, ${appends} append)`);
    mpv.close();

    // AC3: "Lignes claires" (3 × 12 s): prefetched at once; edits move mpv's entry 1.
    const before3 = mpvPipes();
    await play({ itemIds: lignes, startIndex: 0 });
    const mpv3 = await mpvClient(before3).catch(() => null);
    const entry1 = async () => (mpv3 ? ((await mpv3.get('playlist')) ?? [])[1]?.filename ?? '' : '');
    const nextIs = (id, what) => until(what, async () => (await entry1()).includes(`/Audio/${id}/`), 8000).then(() => check(true, what), async () => check(false, `${what} (entry 1: ${(await entry1()).replace(/\?.*/, '')})`));
    await nextIs(lignes[1], 'AC3 prefetched: entry 1 = track 2');
    await command({ type: 'queue-move', from: 2, to: 1 });
    await nextIs(lignes[2], 'AC3 after a move: entry 1 = the moved track');
    await command({ type: 'queue-remove', index: 1 });
    await nextIs(lignes[1], 'AC3 after a remove: entry 1 = the next one');
    await play({ itemIds: ['track-0-0-0'], command: 'PlayNext' });
    await nextIs('track-0-0-0', 'AC3 after play next: entry 1 = that track');
    // AC5 (Emby untagged WAV): the fallback.
    check(Number(await mpv3?.get('replaygain-fallback')) === -6, `AC5 Emby untagged: replaygain-fallback = -6 (${await mpv3?.get('replaygain-fallback')})`);
    check((await state()).music?.gain?.source === 'none', 'AC5 Emby untagged: gain source none');
    mpv3?.close();
    await command({ type: 'stop' });
    await until('stopped', async () => !(await state()).active, 10000);

    // AC4: repeat one, three times through track 1 of "Gain".
    let mark = (await reports()).length;
    await play({ itemIds: gain, startIndex: 0 });
    await until('playing', async () => (await state()).active, 10000);
    await command({ type: 'repeat', mode: 'one' });
    await until('three plays of track 1', async () => (await reports()).slice(mark).filter((x) => x.kind === 'stopped' && x.ItemId === gain[0]).length >= 3, 30000).catch(() => null);
    const rep = (await reports()).slice(mark).filter((x) => x.kind !== 'progress');
    const pairs = rep.filter((x) => x.ItemId === gain[0]).map((x) => x.kind).join(' ');
    check(rep.every((x) => x.ItemId === gain[0]) && /^start stopped start stopped start stopped/.test(pairs), `AC4 repeat one: ${pairs}`);
    // Repeat all: from the last track, back to the first.
    await command({ type: 'repeat', mode: 'all' });
    mark = (await reports()).length;
    await command({ type: 'queue-jump', index: 2 });
    const wrapped = await until('the wrap', async () => (await reports()).slice(mark).some((x) => x.kind === 'start' && x.ItemId === gain[0]), 15000).catch(() => false);
    check(wrapped, 'AC4 repeat all wraps from the last track to the first');
    // Shuffle on, then off: the order comes back.
    await command({ type: 'shuffle', value: true });
    const shuffled = (await state()).music;
    await command({ type: 'shuffle', value: false });
    const back = (await state()).music;
    check(shuffled.shuffle && shuffled.queue.ids[0] === (await state()).item?.id && !back.shuffle && js(back.queue.ids) === js(gain), `AC4 shuffle off restores ${js(back.queue.ids)}`);
    await command({ type: 'repeat', mode: 'off' });
    await command({ type: 'stop' });
    await until('stopped', async () => !(await state()).active, 10000);
  }

  if (kind === 'jellyfin') {
    // AC5 (Jellyfin untagged WAV): the album's NormalizationGain, album mode by default (D2).
    const before = mpvPipes();
    await play({ itemIds: lignes, startIndex: 0 });
    const mpv = await mpvClient(before);
    await until('playing', async () => (await state()).music?.gain, 10000);
    const fallback = Number(await mpv.get('replaygain-fallback'));
    const g = (await state()).music.gain;
    // music-fixture.mjs: album-3-0 has NormalizationGain -6.5 (the fallback is -6).
    check(g.source === 'server' && fallback === -6.5 && g.db === -6.5, `AC5 Jellyfin untagged: replaygain-fallback = the album's NormalizationGain (${fallback} dB, ${js(g)})`);
    mpv.close();
    // D8: the queue comes back, paused, at the next start (track 2, a few seconds in).
    await command({ type: 'queue-jump', index: 1 });
    await until('track 2 at 3 s', async () => ((s) => s.item?.id === lignes[1] && s.positionMs > 3000)(await state()), 15000);
    await sleep(6000);
    await quitApp();
    await launch(false);
    const back = await until('the restored queue', async () => ((s) => s.active && s.item?.id && s)(await state()), 30000).catch(() => null);
    await sleep(1500);
    const now = await state();
    check(back && now.paused && now.item.id === lignes[1] && js(now.music?.queue.ids) === js(lignes) && now.positionMs >= 0, `D8 the queue is back, paused, on track 2 (${now.item?.id}, paused ${now.paused}, ${Math.round(now.positionMs)} ms)`);
    await command({ type: 'stop' });
    await until('stopped', async () => !(await state()).active, 10000);
  }

  // AC6: the built-in engine for music.
  await main.evaluate(`wicaby.settings.update({ playback: { playerByType: { music: 'html' } } }).then(() => true)`);
  const mark6 = (await reports()).length;
  const hash6 = await main.evaluate('location.hash');
  await main.evaluate(`(window.__loads = [], window.__errs = [], wicaby.htmlPlayer.onLoad((l) => window.__loads.push(l)), addEventListener('error', (e) => __errs.push(String(e.message))), addEventListener('unhandledrejection', (e) => __errs.push(String(e.reason))), (() => { const ce = console.error; console.error = (...a) => (__errs.push(a.map(String).join(' ')), ce(...a)); const cw = console.warn; console.warn = (...a) => (__errs.push(a.map(String).join(' ')), cw(...a)); })(), true)`);
  await play({ itemIds: gain, startIndex: 0 });
  await until('the built-in player', async () => (await state()).player === 'html', 10000);
  await sleep(1000);
  check((await main.evaluate('location.hash')) === hash6, 'AC6 the player route is not opened');
  await shot('html-fallback');
  await until('the end of the album (built-in)', async () => !(await state()).active, 40000).catch(() => null);
  const r6 = (await reports()).slice(mark6).filter((x) => x.kind !== 'progress').map((x) => `${x.kind}:${x.ItemId.slice(-1)}`).join(' ');
  check(r6 === 'start:0 stopped:0 start:1 stopped:1 start:2 stopped:2', `AC6 tracks in order with reports: ${r6}`);
  if (process.env.MUSICCDP_DEBUG || !r6.endsWith('stopped:2')) {
    log('  state', js(await state()));
    log('  audio', js(await main.evaluate(`(() => { return [...document.querySelectorAll('audio')].map((a) => ({ src: a.src.slice(0, 60), paused: a.paused, t: a.currentTime, d: a.duration, err: a.error?.code, msg: a.error?.message, rs: a.readyState, ns: a.networkState })); })()`)));
    log('  streams', js((await mockState()).streams.slice(-4)));
    log('  loads', js(await main.evaluate('window.__loads')));
    log('  errors', js(await main.evaluate('window.__errs')));
    log('  console', main.consoleLines.join(' | '));
  }

  if (SHOTS) {
    await main.evaluate(`location.hash = '#/settings?pane=audio'`);
    await sleep(1500);
    await main.evaluate(`(() => { const h = [...document.querySelectorAll('h3')].find((x) => /Musique|Music/.test(x.textContent)); h?.scrollIntoView(); return true; })()`);
    await sleep(500);
    await shot('settings-audio-music');
  }
  main.close();
  stopAll();
  await sleep(800);
  try {
    if (process.env.MUSICCDP_DEBUG) log('  profile kept:', profile);
    else fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    // Electron may still hold a file for a moment.
  }
  return failures;
}

async function run() {
  if (process.platform !== 'win32') throw new Error('Windows only (named pipes)');
  for (const p of [MOCK_PORT, MOCK_PORT + 1, DEV_PORT, CDP_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is busy`);
  const failures = [];
  for (const kind of ['emby', 'jellyfin']) {
    if (args.only && args.only !== kind) continue;
    log(`== ${kind}`);
    failures.push(...(await pass(kind)).map((f) => `${kind}: ${f}`));
  }
  log(failures.length ? `${failures.length} problem(s):\n  ${failures.join('\n  ')}` : 'ok: windowless engine, gapless, queue edits, repeat and shuffle, loudness, fallback and SMTC');
  return failures.length ? 1 : 0;
}

let code = 1;
try {
  code = await run();
} catch (err) {
  console.error('[music-cdp]', err.stack ?? err.message);
}
if (args.keep) {
  log(`kept running: CDP ${CDP_PORT}; Ctrl+C stops`);
  await new Promise(() => undefined);
}
stopAll();
process.exit(code);
