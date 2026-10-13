#!/usr/bin/env node
// zap.json end to end through the desktop OSD (livetv-spec-final.md §18 D-5, §17 S11).
//
// Replays every digitScenario and zapScenario case of fixtures/livetv/zap.json in the running app: trusted
// key events (CDP Input.dispatchKeyEvent) reach Osd.svelte → LiveOverlay → main's ZapController, and the
// harness compares what the OSD shows (digit buffer, preview, toast) and what main publishes (LiveState:
// banner target, tuning, current and last channel) with each case's `out`. Not part of run-all: it needs
// Electron, mpv (vendor/mpv) and .dev/pbux-silent.mkv (silent video; nothing makes a sound).
//
//   node tools/checks/livetv-zap-cdp.mjs [--only=<name substring>[|<another>…]] [--keep]
//
// How a case's lineup is mapped onto the mock (MOCK_LIVETV=iptv, MOCK_LIVE_MODE=normal):
//   - fixture channel k → mock channel ltc-(101+k), playable; a fixture id that must fail to tune → ltc-150
//     (MOCK_LIVE_FAIL);
//   - zapScenario: the list goes to main as PlayRequest.live.entries {id: mock id, number, name: fixture id},
//     hidden channels left out as the renderer's lens pipeline does (applyLens: hidden out);
//   - digitScenario: the OSD window's guide store gets the lineup as its channel rows (mock rows with the
//     fixture number, name = fixture id) and hidden flags through setHidden, through the DEV hook
//     window.__wicabyLive.storeFor that scenario scripts use.
// Each case starts from a fresh live play of its initial channel (stop, play, adopted), so last = null.
//
// Timing: real clocks. An event fires at its `at` (ms after the first event). A tick that expects nothing
// new is sampled 150 ms before its `at`; one that expects a commit or a tune is polled from `at` and must
// match within 300 ms (the OSD's digit timer ticks every 100 ms; mpv and the mock tune after that).
// Events that the desktop cannot produce are skipped with a reason: key-up / held-key repeat (TV only,
// §2 table "Held CH keys on TV", T) and the guide's jump mode (the 1,200 ms timeout, guide only).
//
// Ports: ZAPCDP_MOCK_PORT (8851), ZAPCDP_DEV_PORT (5591), ZAPCDP_CDP_PORT (9751). Exit 1 on any mismatch.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const VIDEO = path.join(ROOT, '.dev', 'pbux-silent.mkv');
const FIXTURE = path.join(ROOT, 'tools', 'checks', 'fixtures', 'livetv', 'zap.json');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const MOCK_PORT = Number(process.env.ZAPCDP_MOCK_PORT) || 8851;
const DEV_PORT = Number(process.env.ZAPCDP_DEV_PORT) || 5591;
const CDP_PORT = Number(process.env.ZAPCDP_CDP_PORT) || 9751;
const SERVER_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // the mock's default SystemId
const FAIL_ID = 'ltc-150';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-zapcdp-'));
const EARLY_MS = 150;
const LATE_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[zap-cdp]', ...m);
const js = (v) => JSON.stringify(v);

// ---------------------------------------------------------------- processes (same pattern as tools/screenshots/desktop.mjs)

const children = [];
function start(cmd, argv, opts) {
  const child = spawn(cmd, argv, { stdio: process.env.ZAPCDP_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
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

// Drops UDP sent off loopback and keeps the windows from taking focus or the mouse (from desktop.mjs).
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

function seedProfile() {
  const address = `http://127.0.0.1:${MOCK_PORT}`;
  fs.writeFileSync(path.join(PROFILE, 'servers.json'), js({ servers: [{ id: SERVER_ID, name: 'Mock', kind: 'emby', version: '4.9.1.0', manualAddress: address, lastAddress: address }], activeId: SERVER_ID, tokenBinding: 1 }));
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), js({ ui: { language: 'fr', reduceMotion: true, heroAutoplay: false }, windows: { trayHintShown: true }, playback: { player: 'mpv' } }));
  const guard = path.join(PROFILE, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  return guard;
}

// ---------------------------------------------------------------- CDP

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
  ws.addEventListener('close', () => {
    for (const done of pending.values()) done({ error: { message: 'the page went away' } });
    pending.clear();
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => pending.has(i) && (pending.delete(i), reject(new Error(`${method}: no answer in 30 s`))), 30000);
      pending.set(i, (m) => (clearTimeout(timer), m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { url: page.url, call, evaluate, close: () => ws.close() };
}

const isApp = (t) => /^(app:|http:\/\/localhost)/.test(t.url);
const mainPage = () => attach((t) => isApp(t) && !t.url.includes('osd=1'));
const osdPage = () => attach((t) => isApp(t) && t.url.includes('osd=1'));

// Trusted keys: what a keyboard sends (keyDown with text for printable keys, then keyUp).
const KEYS = {
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  '.': { key: '.', code: 'Period', vk: 190, text: '.' },
  ...Object.fromEntries([...'0123456789'].map((d) => [d, { key: d, code: `Digit${d}`, vk: 48 + Number(d), text: d }])),
};
async function press(osd, name) {
  const k = KEYS[name];
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  await osd.call('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
  await osd.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// ---------------------------------------------------------------- observation

// OSD window: digit buffer, preview, toast, and the last LiveState main published (installed once per page).
const OBSERVE = `(() => {
  if (!window.__zapObs) {
    window.__zapObs = { live: null, keys: 0 };
    addEventListener('keydown', () => window.__zapObs.keys++, true);
    window.wicaby.playback.getState().then((s) => (window.__zapObs.live ??= s?.live ?? null));
    window.wicaby.playback.onState((s) => (window.__zapObs.live = s?.live ?? null));
  }
  const d = document.querySelector('.digits');
  const p = d?.querySelector('.preview');
  const nm = p?.querySelector('.nm')?.textContent?.trim() ?? '';
  const lv = window.__zapObs.live;
  return {
    buf: d ? d.querySelector('.buf').textContent.replace(/\\s+/g, '').replace(/_$/, '') : null,
    preview: p ? { kind: p.dataset.kind ?? null, id: nm ? nm.split(/\\s+/).pop() : null, dupes: Number(p.querySelector('.dupes')?.textContent?.match(/\\d+/)?.[0] ?? 0) } : null,
    say: document.querySelector('.say')?.textContent?.trim() ?? '',
    keys: window.__zapObs.keys,
    live: lv && { channel: lv.channel.id, pending: lv.pending?.id ?? null, tuning: lv.tuning, last: lv.lastChannelId ?? null, count: lv.count },
  };
})()`;
const observe = (osd) => osd.evaluate(OBSERVE);

// ---------------------------------------------------------------- mapping and setup

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const ltc = (n) => `ltc-${String(n).padStart(3, '0')}`;
function mapping(lineup, failIds = []) {
  const toMock = new Map();
  lineup.forEach((c, k) => toMock.set(c.id, failIds.includes(c.id) ? FAIL_ID : ltc(101 + k)));
  const toFix = new Map([...toMock].map(([a, b]) => [b, a]));
  return { m: (id) => (id == null ? null : toMock.get(id) ?? `?${id}`), f: (id) => (id == null ? null : toFix.get(id) ?? id) };
}

let main;
let osd;

async function playFresh(mockId, entries) {
  await main.evaluate(`wicaby.playback.command({ type: 'stop' }).then(() => true)`);
  await until('playback to stop', () => main.evaluate(`wicaby.playback.getState().then((s) => !s.active)`), 15000);
  await main.evaluate(`wicaby.playback.play(${js({ itemIds: [mockId], serverId: SERVER_ID, live: { lens: { kind: 'all' }, lensLabel: 'Toutes', entries } })}).then(() => true)`);
  await until(`${mockId} adopted`, () => main.evaluate(`wicaby.playback.getState().then((s) => s.live && !s.live.tuning && s.live.channel.id === ${js(mockId)} && s.live.count === ${entries.length})`), 30000, 150);
  if (!osd || !(await osd.evaluate('!!document.querySelector(".osd-root")').catch(() => false))) {
    osd?.close();
    osd = await osdPage();
  }
  await osd.evaluate(OBSERVE);
  await until('the OSD to see the channel', async () => (await observe(osd)).live?.channel === mockId, 10000);
  // Keys only reach a shown OSD: wait for its page to be visible with the controls mounted.
  await until('the OSD to show', () => osd.evaluate(`document.visibilityState === 'visible' && !!document.querySelector('.osd')`), 15000);
  await sleep(300);
}

// The OSD window's guide store shows the case's lineup: mock rows renamed to the fixture numbers.
async function injectLineup(lineup, map) {
  const rows = lineup.map((c) => ({ mock: map.m(c.id), number: c.number, name: c.id, hidden: !!c.hidden }));
  return osd.evaluate(`(async () => {
    const rows = ${js(rows)};
    const storeFor = window.__wicabyLive?.storeFor ?? (await import('/lib/livetv/store.svelte.ts')).storeFor;
    let s = null;
    // The OSD window's session arrives a moment after the window opens.
    for (let i = 0; i < 100 && !(s = storeFor(${js(SERVER_ID)})); i++) await new Promise((r) => setTimeout(r, 100));
    if (!s) return 'no guide store in the OSD window';
    await s.open();
    await new Promise((r) => { const t = setInterval(() => s.channelsState === 'ready' && (clearInterval(t), r()), 50); });
    const byId = new Map(s.channels.map((r) => [r.id, r]));
    const missing = rows.filter((r) => !byId.has(r.mock)).map((r) => r.mock);
    if (missing.length) return 'missing mock channels ' + missing.join(', ');
    for (const r of s.prefs.hidden) s.setHidden(r, false);
    for (const r of rows) if (r.hidden) s.setHidden(r.mock, true);
    s.channelsUpdatedAt = Date.now() + 864e5; // no reload over the injected rows during the case
    s.channels = rows.map((r) => ({ ...byId.get(r.mock), number: r.number, name: r.name }));
    await new Promise((r) => setTimeout(r, 200));
    return s.prefs.hidden.length === rows.filter((r) => r.hidden).length ? 'ok' : 'hidden prefs not applied';
  })()`);
}

// ---------------------------------------------------------------- cases

const SAY_HIDDEN = 'Chaîne masquée';
const sayFail = (n) => `Aucune chaîne ${n}`;

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function runDigit(c, failures) {
  const [lineup, events, timeoutMs] = c.args;
  if (timeoutMs && timeoutMs !== 1800) return `skipped: the ${timeoutMs} ms timeout is the guide's jump mode (Guide.svelte), not the player`;
  const map = mapping(lineup);
  const plain = lineup.filter((x) => !x.hidden);
  // Played from a channel outside the lineup: the preview of the playing channel shows its server name.
  const initial = ltc(100);
  await playFresh(initial, plain.map((x) => ({ id: map.m(x.id), number: x.number, name: x.id })));
  const inj = await injectLineup(lineup, map);
  if (inj !== 'ok') return failures.push(`${c.name}: ${inj}`), 'setup failed';
  const t0 = performance.now();
  let prevAt = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const exp = c.out[i];
    const fires = exp.result !== null;
    let obs;
    if (ev.type === 'tick') {
      if (!fires) {
        await sleep(t0 + Math.max(prevAt, ev.at - EARLY_MS) - performance.now());
        obs = await observe(osd);
      } else {
        await sleep(t0 + ev.at - performance.now());
        obs = await pollDigit(exp, map, LATE_MS);
      }
    } else {
      await sleep(t0 + ev.at - performance.now());
      await press(osd, { digit: ev.d, separator: '.', backspace: 'Backspace', enter: 'Enter', escape: 'Escape', pick: ev.delta < 0 ? 'ArrowUp' : 'ArrowDown' }[ev.type]);
      obs = await pollDigit(exp, map, 200);
    }
    const bad = digitMismatch(exp, obs, map);
    if (bad) failures.push(`${c.name} #${i} ${ev.type}@${ev.at}: ${bad} (observed ${js({ buf: obs.buf, preview: obs.preview, say: obs.say, live: obs.live })})`);
    prevAt = ev.at;
  }
  // A cancel, a failure or Backspace to an unknown last channel tunes nothing.
  if (!c.out.some((o) => o.result?.type === 'commit')) {
    await sleep(400);
    const o = await observe(osd);
    if (o.live?.channel !== initial || o.live?.pending) failures.push(`${c.name}: something tuned (${js(o.live)})`);
  }
  return 'ran';
}

async function pollDigit(exp, map, windowMs) {
  const end = performance.now() + windowMs;
  let obs;
  do {
    obs = await observe(osd);
    if (!digitMismatch(exp, obs, map)) return obs;
    await sleep(15);
  } while (performance.now() < end);
  return obs;
}

function digitMismatch(exp, obs, map) {
  if ((exp.buf ?? null) !== obs.buf) return `buf ${js(obs.buf)} ≠ ${js(exp.buf)}`;
  if (exp.buf !== null && exp.preview) {
    const p = exp.preview;
    const id = p.kind === 'none' ? null : p.kind === 'exact' ? p.ids[p.pick] : p.id;
    const want = { kind: p.kind, id, dupes: p.kind === 'exact' && p.ids.length > 1 ? p.ids.length : 0 };
    if (!sameJson(want, obs.preview)) return `preview ${js(obs.preview)} ≠ ${js(want)}`;
  }
  const r = exp.result;
  if (r?.type === 'commit') {
    const target = obs.live?.pending ?? obs.live?.channel;
    if (target !== map.m(r.id)) return `tune target ${map.f(target)} ≠ ${r.id}`;
    if (r.hidden && obs.say !== SAY_HIDDEN) return `toast ${js(obs.say)} ≠ ${js(SAY_HIDDEN)}`;
  } else if (r?.type === 'fail') {
    if (obs.say !== sayFail(r.number)) return `toast ${js(obs.say)} ≠ ${js(sayFail(r.number))}`;
  }
  return '';
}

async function runZap(c, failures) {
  const [list, current, events, hidden = []] = c.args;
  if (events.some((e) => e.repeat || e.type === 'key-up')) return 'skipped: held-key preview with tune on key-up is TV only (§2, T)';
  const failIds = events.filter((e) => e.type === 'failed').map((e) => e.id);
  const map = mapping(list, failIds);
  const entries = list.filter((x) => !hidden.includes(x.id)).map((x) => ({ id: map.m(x.id), number: x.number, name: x.id }));
  await playFresh(map.m(current), entries);
  const t0 = performance.now();
  let prevAt = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const exp = c.out[i];
    const fires = exp.effects.some((e) => e.type === 'tune');
    const at = ev.at ?? prevAt;
    let obs;
    if (ev.type === 'tick') {
      if (!fires) {
        await sleep(t0 + Math.max(prevAt, at - EARLY_MS) - performance.now());
        obs = await observe(osd);
      } else {
        await sleep(t0 + at - performance.now());
        obs = await pollZap(exp, map, LATE_MS);
      }
    } else if (ev.type === 'adopted' || ev.type === 'failed') {
      // Not an input: the tune settling. Wait for it (the mock answers in about 300 ms, mpv opens after).
      obs = await pollZap(exp, map, 20000);
    } else {
      await sleep(t0 + at - performance.now());
      if (ev.type === 'press') await press(osd, ev.delta > 0 ? 'PageUp' : 'PageDown');
      else if (ev.type === 'last-channel') await press(osd, 'Backspace');
      // A tune from the guide or the mini-guide: the command they send.
      else if (ev.type === 'tune') await osd.evaluate(`wicaby.playback.command(${js({ type: 'tune', channelId: map.m(ev.id), reason: 'miniguide' })}).then(() => true)`);
      obs = await pollZap(exp, map, 250);
    }
    const bad = zapMismatch(exp, obs, map);
    if (bad) failures.push(`${c.name} #${i} ${ev.type}@${at}: ${bad} (observed ${js(obs.live)}, keys ${obs.keys})`);
    if (ev.at !== undefined) prevAt = ev.at;
    else prevAt = performance.now() - t0;
  }
  return 'ran';
}

async function pollZap(exp, map, windowMs) {
  const end = performance.now() + windowMs;
  let obs;
  do {
    obs = await observe(osd);
    if (!zapMismatch(exp, obs, map)) return obs;
    await sleep(15);
  } while (performance.now() < end);
  return obs;
}

// LiveState carries the zap state as: banner target = pending ?? channel (pending is z.pending ?? z.tuning
// when it differs from the channel), tuning, lastChannelId; channel = z.current while nothing tunes.
function zapMismatch(exp, obs, map) {
  const lv = obs.live;
  if (!lv) return 'no live state';
  const shown = lv.pending ?? lv.channel;
  const want = map.m(exp.pending ?? exp.tuning ?? exp.current);
  if (shown !== want) return `banner ${map.f(shown)} ≠ ${map.f(want)}`;
  if (lv.tuning !== (exp.tuning !== null)) return `tuning ${lv.tuning} ≠ ${exp.tuning !== null}`;
  if (exp.tuning === null && lv.channel !== map.m(exp.current)) return `current ${map.f(lv.channel)} ≠ ${exp.current}`;
  if ((lv.last ?? null) !== map.m(exp.last)) return `last ${map.f(lv.last)} ≠ ${exp.last}`;
  return '';
}

// ---------------------------------------------------------------- main

async function run() {
  if (!fs.existsSync(VIDEO)) throw new Error(`${VIDEO} is missing (silent test video)`);
  for (const p of [MOCK_PORT, DEV_PORT, CDP_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is busy`);
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT), VIDEO], {
    cwd: ROOT,
    env: { ...process.env, MOCK_LIVETV: 'iptv', MOCK_LIVE_MODE: 'normal', MOCK_TUNERS: '4', MOCK_LIVE_FAIL: FAIL_ID, NODE_OPTIONS: '' },
  });
  await until('the mock server', async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/emby/System/Info/Public`)).ok);
  const guard = seedProfile();
  const app = start(process.execPath, [path.join(DESKTOP, 'scripts', 'dev.mjs'), `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_PORT: String(DEV_PORT), NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
  app.on('exit', (code) => log(`dev app exited (${code})`));
  main = await mainPage();
  await until('the session', () => main.evaluate(`window.wicaby?.session.get().then((s) => s.status !== 'no-server' && s.status !== 'connecting')`), 60000, 500);
  const status = await main.evaluate(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
  if (status !== 'signed-in') throw new Error(`sign-in failed (${status})`);

  const failures = [];
  const summary = [];
  for (const c of fixture.cases) {
    if (c.fn !== 'digitScenario' && c.fn !== 'zapScenario') continue;
    if (typeof args.only === 'string' && !args.only.split('|').some((o) => c.name.includes(o))) continue;
    const before = failures.length;
    let outcome;
    try {
      outcome = await (c.fn === 'digitScenario' ? runDigit : runZap)(c, failures);
    } catch (err) {
      failures.push(`${c.name}: ${err.message}`);
      outcome = 'error';
    }
    const line = `${failures.length > before ? 'FAIL' : outcome.startsWith('skipped') ? 'SKIP' : 'ok  '} ${c.fn} | ${c.name}${outcome.startsWith('skipped') ? ` (${outcome})` : ''}`;
    summary.push(line);
    log(line);
  }
  await main.evaluate(`wicaby.playback.command({ type: 'stop' }).then(() => true)`).catch(() => undefined);
  const ran = summary.filter((l) => l.startsWith('ok') || l.startsWith('FAIL')).length;
  log(`${ran} case(s) replayed, ${summary.filter((l) => l.startsWith('SKIP')).length} skipped, ${failures.length} mismatch(es)`);
  for (const f of failures) log(`  ✗ ${f}`);
  return failures.length ? 1 : 0;
}

let code = 1;
try {
  code = await run();
} catch (err) {
  console.error('[zap-cdp]', err.message);
}
if (args.keep) {
  log(`kept running: CDP ${CDP_PORT}, mock ${MOCK_PORT}; Ctrl+C stops`);
  await new Promise(() => undefined);
}
osd?.close();
main?.close();
stopAll();
await sleep(500);
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
} catch {
  // Electron's helpers may still hold the profile for a moment; it is a temp dir.
}
process.exit(code);
