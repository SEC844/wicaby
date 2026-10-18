#!/usr/bin/env node
// D-8 end to end through the desktop app (livetv-spec-final.md §18 D-8, §17 S28 / S29, §21.3, §21.4).
//
//   - Settings: the "TV en direct" rows turn on live.reminderAutoTune (S29 depends on it, default off).
//   - S28 picture-in-guide: mpv margins, keepaspect and hidden subtitles while open; tune in place; reset.
//   - Guide bell: B on a future cell sets a reminder through the renderer path; the cell shows the bell.
//   - PiP toggles the mini window and back.
//   - S29: a reminder 1 min ahead notifies (with the "Regarder" button), counts down 10 s and tunes;
//     "Rester ici" cancels. With the mock clock at +10 and −10 min (POST /Mock/LiveTv/Clock), the
//     reminder fires within seconds of (server start − lead) on the client clock.
//   - Sleep: the main process is frozen past a reminder's due time (its timer cannot run), then
//     powerMonitor 'resume' fires it once.
//   - Restart: reminders survive; one due while closed fires at the next start; wicaby://live?channel=12
//     tunes channel 12 from a cold start; the notification's "Regarder" button tunes.
//
// Not part of run-all: it needs Electron, mpv (vendor/mpv) and .dev/pbux-silent.mkv (nothing makes a
// sound). Notifications go to a file, never to the desktop; nothing leaves loopback.
//
//   node tools/checks/livetv-d8-cdp.mjs
//
// Ports: D8CDP_MOCK_PORT (8861), D8CDP_DEV_PORT (5601), D8CDP_CDP_PORT (9761). Exit 1 on any failure.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const VIDEO = path.join(ROOT, '.dev', 'pbux-silent.mkv');
const MOCK_PORT = Number(process.env.D8CDP_MOCK_PORT ?? 8861);
const DEV_PORT = Number(process.env.D8CDP_DEV_PORT ?? 5601);
const CDP_PORT = Number(process.env.D8CDP_CDP_PORT ?? 9761);
const SERVER_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-d8-'));
const TOASTS = path.join(PROFILE, 'toasts.log');
const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[d8]', ...m);
const js = JSON.stringify;
const results = [];
const ok = (name, cond, detail = '') => (results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`), log(results.at(-1)));

const children = [];
function start(cmd, argv, opts) {
  const c = spawn(cmd, argv, { stdio: process.env.D8_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
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

// Preloaded into main (NODE_OPTIONS): loopback-only UDP, windows that never take focus, notifications
// to a file, and file triggers for a frozen sleep + resume and for the notification's button.
const GUARD = String.raw`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dgram = require('node:dgram');
const send = dgram.Socket.prototype.send;
const loopback = (a) => a === 'localhost' || a === '::1' || /^127\./.test(a);
dgram.Socket.prototype.send = function (msg, ...rest) {
  const address = rest.find((a) => typeof a === 'string');
  const cb = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null;
  if (address !== undefined && !loopback(address)) { if (cb) process.nextTick(cb, null, 0); return; }
  return send.call(this, msg, ...rest);
};
const PROFILE = ${JSON.stringify(PROFILE)};
const note = (line) => fs.appendFileSync(path.join(PROFILE, 'toasts.log'), line + '\n');
if (process.versions.electron) {
  const Module = require('node:module');
  const load = Module._load;
  let hooked = false;
  let last = null;
  Module._load = function (request, ...rest) {
    const m = load.call(this, request, ...rest);
    if (!hooked && request === 'electron' && m && m.app) {
      hooked = true;
      // A dead proxy: Chromium and net.fetch reach loopback only (the update check, map tiles…).
      m.app.commandLine.appendSwitch('proxy-server', 'http://127.0.0.1:9');
      m.app.on('browser-window-created', (_e, win) => { win.show = () => win.showInactive(); win.setFocusable(false); win.setIgnoreMouseEvents(true); });
      m.Notification.prototype.show = function () { last = this; note(this.title + ' | ' + this.body + ' | ' + JSON.stringify((this.actions || []).map((a) => a.text))); };
      m.app.whenReady().then(() => setInterval(() => {
        const sleepFile = path.join(PROFILE, 'sleep.trigger');
        if (fs.existsSync(sleepFile)) {
          const ms = Number(fs.readFileSync(sleepFile, 'utf8')) || 0;
          fs.rmSync(sleepFile);
          // Asleep: the event loop is frozen, so no timer runs; 'resume' comes first on wake.
          const end = Date.now() + ms;
          while (Date.now() < end) {}
          note('RESUME');
          m.powerMonitor.emit('resume');
        }
        const actionFile = path.join(PROFILE, 'action.trigger');
        if (fs.existsSync(actionFile)) { fs.rmSync(actionFile); if (last) last.emit('action', { actionIndex: 0 }, 0); }
      }, 200));
    }
    return m;
  };
}
`;

function seedProfile() {
  const address = `http://127.0.0.1:${MOCK_PORT}`;
  fs.writeFileSync(path.join(PROFILE, 'servers.json'), js({ servers: [{ id: SERVER_ID, name: 'Mock', kind: 'emby', version: '4.9.1.0', manualAddress: address, lastAddress: address }], activeId: SERVER_ID, tokenBinding: 1 }));
  // Auto-tune stays at its default (off): the Settings step turns it on.
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), js({ ui: { language: 'fr', reduceMotion: true, heroAutoplay: false }, windows: { trayHintShown: true }, playback: { player: 'mpv' }, live: { reminderLeadMin: 1 } }));
  const guard = path.join(PROFILE, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  return guard;
}

const toasts = () => (fs.existsSync(TOASTS) ? fs.readFileSync(TOASTS, 'utf8') : '');
const count = (re) => (toasts().match(re) ?? []).length;
// fire() logs every reminder, also those the notifier throttles (4 a minute).
function firedLines(title) {
  const dir = path.join(PROFILE, 'logs');
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).reduce((n, f) => n + (fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.includes(`reminder: ${title} on`)).length), 0);
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
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { call, evaluate, close: () => ws.close() };
}
const isApp = (t) => /^(app:|http:\/\/localhost)/.test(t.url);
const mainPage = () => attach((t) => isApp(t) && !t.url.includes('osd=1'));
const osdPage = () => attach((t) => isApp(t) && t.url.includes('osd=1'));

async function key(page, k, code, vk, modifiers = 0, text) {
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

const mock = async (p, method = 'GET') => (await fetch(`http://127.0.0.1:${MOCK_PORT}${p}`, { method })).json();
const openStreams = async () => (await mock('/Mock/LiveTv/state')).openStreams.length;

// mpv over its own JSON IPC pipe (a second client).
async function mpvGet(names) {
  const pipe = fs.readdirSync('\\\\.\\pipe\\').find((n) => n.startsWith('wicaby-mpv-'));
  if (!pipe) throw new Error('no mpv pipe');
  return new Promise((resolve, reject) => {
    const s = net.connect(`\\\\.\\pipe\\${pipe}`);
    const out = {};
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) {
        const m = JSON.parse(line);
        if (m.request_id && m.request_id <= names.length) out[names[m.request_id - 1]] = m.error === 'success' ? m.data : `ERR ${m.error}`;
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
      if (Object.keys(out).length === names.length) (s.end(), resolve(out));
    });
    s.on('error', reject);
    s.on('connect', () => names.forEach((n, i) => s.write(js({ command: ['get_property', n], request_id: i + 1 }) + '\n')));
  });
}

function launch(guard, extra = []) {
  return start(process.execPath, [path.join(DESKTOP, 'scripts', 'dev.mjs'), `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`, ...extra], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_PORT: String(DEV_PORT), WICABY_TEST_SILENT: '1', NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
}

const storedReminders = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROFILE, 'reminders.json'), 'utf8')).items ?? [];
  } catch {
    return [];
  }
};

async function run() {
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT), VIDEO], {
    cwd: ROOT,
    env: { ...process.env, MOCK_LIVETV: 'iptv', MOCK_LIVE_MODE: 'normal', MOCK_TUNERS: '4', NODE_OPTIONS: '' },
  });
  await until('mock', async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/emby/System/Info/Public`)).ok);
  const guard = seedProfile();
  let app = launch(guard);
  let main = await mainPage();
  await until('session', () => main.evaluate(`window.wicaby?.session.get().then((s) => s.status !== 'no-server' && s.status !== 'connecting')`), 60000, 500);
  const status = await main.evaluate(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
  if (status !== 'signed-in') throw new Error(`sign-in ${status}`);
  const chans = await main.evaluate(`wicaby.api.get('/LiveTv/Channels', { Limit: 50 }).then((r) => r.Items.map((c) => ({ id: c.Id, n: c.ChannelNumber ?? c.Number, name: c.Name })))`);
  const [a, b] = [chans[0], chans[1]];

  // ---- Settings: "TV en direct" turns auto-tune on ----
  await main.evaluate(`location.hash = '#/settings'`);
  await until('settings page', () => main.evaluate(`!!document.querySelector('input[aria-label="Rechercher un réglage"]')`), 15000);
  await main.evaluate(`(() => { const i = document.querySelector('input[aria-label="Rechercher un réglage"]'); i.value = 'rappel'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const sw = `[role=switch][aria-label="Changer de chaîne au rappel"]`;
  await until('auto-tune row', () => main.evaluate(`!!document.querySelector(${js(sw)}) && !!document.querySelector('[aria-label="Rappel avant le début"]')`), 5000).catch(async (e) => {
    log('settings page:', await main.evaluate(`location.hash + ' | ' + [...document.querySelectorAll('[role=switch]')].map((x) => x.getAttribute('aria-label')).join(', ')`));
    throw e;
  });
  await main.evaluate(`document.querySelector(${js(sw)}).click()`);
  const live = await until('auto-tune saved', () => main.evaluate(`wicaby.settings.get().then((s) => s.live.reminderAutoTune && s.live)`), 5000);
  ok('Settings: lead and auto-tune rows; the toggle turns auto-tune on', live.reminderAutoTune === true && live.reminderLeadMin === 1, js(live));
  await main.evaluate(`location.hash = '#/'`);

  // ---- S28: picture-in-guide ----
  await main.evaluate(`wicaby.playback.play(${js({ itemIds: [a.id], serverId: SERVER_ID })}).then(() => true)`);
  await until('adopted', () => main.evaluate(`wicaby.playback.getState().then((s) => s.live && !s.live.tuning && s.live.channel.id === ${js(a.id)})`), 30000);
  const osd = await osdPage();
  await until('osd visible', () => osd.evaluate(`document.visibilityState === 'visible' && !!document.querySelector('.osd')`), 15000);
  await sleep(1500);
  const openGuide = async () => {
    await key(osd, 'G', 'KeyG', 71, 8, 'G');
    await until('guide overlay', () => osd.evaluate(`!!document.querySelector('.pig .guide.overlay')`), 10000);
  };
  const closeGuide = async () => {
    await key(osd, 'Escape', 'Escape', 27);
    await until('overlay closed', () => osd.evaluate(`!document.querySelector('.pig')`), 5000);
  };
  await openGuide();
  await sleep(500);
  const open = await mpvGet(['video-margin-ratio-left', 'video-margin-ratio-bottom', 'keepaspect', 'sub-visibility']);
  ok('S28 margins set on open', open['video-margin-ratio-left'] === 0.68 && open['video-margin-ratio-bottom'] === 0.67 && open.keepaspect === true && open['sub-visibility'] === false, js(open));
  const focused = await osd.evaluate(`(() => { const el = [...document.querySelectorAll('.pig [data-ch=${js(b.id)}][data-kind=program]')].find((e) => Number(e.dataset.start) <= Date.now() && Number(e.dataset.end) > Date.now()); if (!el) return false; el.focus(); return true; })()`);
  if (!focused) log('could not focus an airing cell of', b.id);
  await key(osd, 'Enter', 'Enter', 13, 0, '\r');
  await until('tuned b', () => main.evaluate(`wicaby.playback.getState().then((s) => s.live && !s.live.tuning && s.live.channel.id === ${js(b.id)})`), 30000);
  await sleep(1500);
  const after = await mpvGet(['video-margin-ratio-left', 'keepaspect']);
  const still = await osd.evaluate(`!!document.querySelector('.pig .guide.overlay')`);
  const streams = await openStreams();
  ok('S28 tune in place keeps the tile', after['video-margin-ratio-left'] === 0.68 && still, js(after));
  ok('S28 openStreams = 1 after the in-place tune', streams === 1, `openStreams=${streams}`);
  await closeGuide();
  await sleep(500);
  const closed = await mpvGet(['video-margin-ratio-left', 'video-margin-ratio-bottom', 'keepaspect', 'sub-visibility']);
  ok('S28 margins reset on close', closed['video-margin-ratio-left'] === 0 && closed['video-margin-ratio-bottom'] === 0 && closed.keepaspect === true && closed['sub-visibility'] === true, js(closed));

  // ---- PiP ----
  await key(osd, 'P', 'KeyP', 80, 8, 'P');
  await sleep(800);
  const pipBounds = await osd.evaluate(`({ w: window.outerWidth, h: window.outerHeight })`);
  await key(osd, 'P', 'KeyP', 80, 8, 'P');
  await sleep(800);
  const back = await osd.evaluate(`({ w: window.outerWidth, h: window.outerHeight })`);
  ok('PiP toggles a mini window and back', pipBounds.w <= 480 && back.w > pipBounds.w, js({ pipBounds, back }));

  // ---- S29: reminder 1 min ahead with auto-tune, then "Rester ici" ----
  const rem = (ch, inMs, extra = {}) => ({ serverId: SERVER_ID, programId: `prog-${ch.id}-${Date.now()}`, channelId: ch.id, start: Date.now() + MIN + inMs, title: 'Test', channelName: ch.name, ...extra });
  const c = chans[2];
  ok('reminder set', (await main.evaluate(`wicaby.reminders.toggle(${js(rem(c, 3000))})`)) === true);
  await until('countdown shown', () => osd.evaluate(`!!document.querySelector('.remind')`), 15000, 100);
  const cdText = await osd.evaluate(`document.querySelector('.remind span').textContent`);
  ok('S29 notification with the "Regarder" button', /Test commence \| Sur .* à .* \| \["Regarder"\]/.test(toasts()), toasts().trim());
  const t0 = Date.now();
  await until('auto-tuned c', () => main.evaluate(`wicaby.playback.getState().then((s) => s.live?.channel.id === ${js(c.id)})`), 20000, 100);
  ok('S29 10 s countdown then tune', Date.now() - t0 > 8000, `${cdText}; tuned after ${Date.now() - t0} ms`);
  await until('adopted c', () => main.evaluate(`wicaby.playback.getState().then((s) => !s.live.tuning)`), 30000);
  await main.evaluate(`wicaby.reminders.toggle(${js(rem(chans[3], 2000))})`);
  await until('countdown 2', () => osd.evaluate(`!!document.querySelector('.remind')`), 15000, 100);
  await osd.evaluate(`document.querySelector('.remind button').click()`);
  await until('countdown gone', () => osd.evaluate(`!document.querySelector('.remind')`), 3000, 100);
  await sleep(11_000);
  const stayed = await main.evaluate(`wicaby.playback.getState().then((s) => s.live?.channel.id)`);
  ok('S29 "Rester ici" cancels', stayed === c.id, stayed);

  // ---- S29 with the server clock off by ±10 min (§21.4) ----
  for (const offsetMin of [10, -10]) {
    await mock(`/Mock/LiveTv/Clock?offsetMin=${offsetMin}`, 'POST');
    const want = offsetMin * MIN;
    // The OSD's guide store measures the skew from the Date header (3 answers in a row).
    const skew = await until(
      `skew ${offsetMin}`,
      () =>
        osd.evaluate(`(async () => {
          const s = window.__wicabyLive.storeFor(${js(SERVER_ID)});
          if (Math.abs(s.caps.clockSkewMs - ${want}) > 60000) { await s.loadChannels(); return null; }
          return s.caps.clockSkewMs;
        })()`),
      30000,
      300,
    ).catch(() => null);
    ok(`skew ${offsetMin > 0 ? '+' : ''}${offsetMin} min measured by the guide store`, skew !== null, String(skew));
    if (skew === null) continue;

    // The guide's B key (renderer path): the stored reminder carries the skew, and the cell shows the bell.
    await openGuide();
    await sleep(800);
    const pid = await osd.evaluate(`(() => {
      const now = window.__wicabyLive.storeFor(${js(SERVER_ID)}).now();
      const el = [...document.querySelectorAll('.pig [data-kind=program]')].find((e) => Number(e.dataset.start) > now + 20 * 60000);
      if (!el) return null;
      el.focus();
      return el.dataset.pid;
    })()`);
    if (pid) {
      await key(osd, 'b', 'KeyB', 66, 0, 'b');
      const bell = await until('bell', () => osd.evaluate(`!!document.querySelector('.pig [data-pid=${js(pid)}] .mark.bell') && document.querySelector('.pig [data-pid=${js(pid)}]').getAttribute('aria-label')`), 5000).catch(() => '');
      await sleep(1200); // the store's coalesced write
      const stored = storedReminders().find((r) => r.programId === pid);
      ok(`guide B sets a reminder with the bell and the skew (${offsetMin} min)`, /Rappel programmé/.test(bell) && Math.abs((stored?.skewMs ?? 0) - want) <= 60000, `${bell}; skewMs=${stored?.skewMs}`);
      await key(osd, 'b', 'KeyB', 66, 0, 'b');
      const gone = await until('bell gone', () => osd.evaluate(`!document.querySelector('.pig [data-pid=${js(pid)}] .mark.bell')`), 5000).catch(() => false);
      await sleep(1200);
      ok(`guide B again cancels it (${offsetMin} min)`, gone && !storedReminders().some((r) => r.programId === pid));
    } else ok(`guide B sets a reminder (${offsetMin} min)`, false, 'no future cell');
    await closeGuide();

    // On the current channel (no auto-tune): server start = server now + 1 min + 5 s → due 5 s from now.
    const playing = await main.evaluate(`wicaby.playback.getState().then((s) => ({ id: s.live.channel.id, name: s.live.channel.name ?? '' }))`);
    const title = `Skew${offsetMin > 0 ? 'Plus' : 'Minus'}`;
    const serverNow = Date.now() + skew;
    const r = { serverId: SERVER_ID, programId: `prog-skew-${offsetMin > 0 ? 'p' : 'm'}`, channelId: playing.id, start: serverNow + MIN + 5000, title, channelName: playing.name, skewMs: skew };
    const set = Date.now();
    await main.evaluate(`wicaby.reminders.toggle(${js(r)})`);
    const fired = await until(`${title} fired`, () => firedLines(title) > 0 && Date.now(), 20000, 100).catch(() => null);
    const after = fired ? fired - set : null;
    // Without the skew it would fire 10 min late (+10) or at once (−10).
    ok(`S29 clock offset ${offsetMin} min: fires at server start − lead`, after !== null && after >= 3500 && after <= 8000, `fired ${after} ms after set, due at 5000`);
  }
  await mock('/Mock/LiveTv/Clock?offsetMin=0', 'POST');

  await main.evaluate(`wicaby.playback.command({ type: 'stop' }).then(() => true)`);

  // ---- Restart: reminders survive, a missed one fires at start, the deep link and "Regarder" tune ----
  const far = { ...rem(chans[4], 3_600_000), programId: 'prog-far' };
  await main.evaluate(`wicaby.reminders.toggle(${js(far)})`);
  const missed = chans[5];
  await main.evaluate(`wicaby.reminders.toggle(${js({ ...rem(missed, 6000), programId: 'prog-missed', title: 'Missed' })})`);
  fs.rmSync(TOASTS, { force: true });
  await sleep(1000); // the store's coalesced write
  osd.close();
  main.close();
  kill(app);
  await sleep(8000);

  const twelve = chans.find((x) => x.n === '12');
  app = launch(guard, ['wicaby://live?channel=12']);
  main = await mainPage();
  const t1 = Date.now();
  const tuned = await until('deep link tuned', () => main.evaluate(`wicaby.playback.getState().then((s) => s.live && !s.live.tuning && s.live.channel.number === '12' ? s.live.channel.id : null)`), 40000, 300).catch((e) => e.message);
  ok('wicaby://live?channel=12 tunes channel 12 from a cold start', tuned === twelve?.id, `${tuned} after ${Date.now() - t1} ms`);
  const list = await until('list after restart', () => main.evaluate(`wicaby.reminders.list().then((l) => l.length ? l : null)`), 20000, 500).catch(() => []);
  ok('reminders survive an app restart', list.some((r) => r.programId === 'prog-far'), js(list.map((r) => r.programId)));
  ok('a reminder due while closed fires at the next start', /Missed commence/.test(toasts()), toasts().trim());
  fs.writeFileSync(path.join(PROFILE, 'action.trigger'), '');
  const viaAction = await until('Regarder tuned', () => main.evaluate(`wicaby.playback.getState().then((s) => s.live?.channel.id === ${js(missed.id)})`), 30000, 300).catch(() => false);
  ok('the notification\'s "Regarder" button tunes the channel', viaAction === true);

  // ---- Sleep (after the restart: the notifier's 4-a-minute throttle starts afresh). The event loop is
  // frozen past the reminder's due time, so its timer cannot run; resume must fire it, once ----
  await main.evaluate(`wicaby.playback.command({ type: 'stop' }).then(() => true)`);
  await sleep(1000);
  fs.rmSync(TOASTS, { force: true });
  await main.evaluate(`wicaby.reminders.toggle(${js({ ...rem(chans[6], 3000), programId: 'prog-asleep', title: 'Asleep' })})`);
  fs.writeFileSync(path.join(PROFILE, 'sleep.trigger'), '7000');
  await until('resumed', () => /RESUME/.test(toasts()), 15000, 200);
  await sleep(4000);
  const slept = toasts();
  const before = slept.slice(0, slept.indexOf('RESUME'));
  ok('a reminder due during a sleep fires once on resume', !/Asleep/.test(before) && count(/Asleep commence/g) === 1 && firedLines('Asleep') === 1, slept.trim().replaceAll('\n', ' / '));
  main.close();
  kill(app);
}

let code = 1;
try {
  await run();
  code = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
} catch (e) {
  console.error('[d8] error', e.message);
}
console.log(results.join('\n'));
for (const c of children) kill(c);
await sleep(800);
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
} catch {}
process.exit(code);
