#!/usr/bin/env node
// X-04 end to end through the desktop app (feature-specs.md §4 acceptance 1, 4, 5, 5b, 6, 7).
//
//   - Merged seek: four → within 800 ms send one `seek` of +40 s and show "+40 s"; near the end "+5 s".
//   - Ends at: stable while playing, follows the clock while paused, reflects ×1.5.
//   - Sleep timer: a short timer prompts "Vous regardez toujours ?" then pauses 30 s later; "Fin de cette
//     vidéo" on an episode with autoplay stays at the end and does not start the next one.
//   - Live (S39): "Fin de ce programme" prompts at the programme boundary and, with no input, stops the
//     stream: /Mock/LiveTv/state openStreams drops to 0. Main's clock is moved forward (guard) so the
//     boundary comes within seconds.
//   - Shortcut editor: Info on M is refused ("Déjà utilisé par « Couper le son »") and saves nothing;
//     Mute on U works in the player; an exported file imported back reproduces the bindings; an invalid
//     file changes nothing. Ctrl+= still nudges the audio delay.
//
// Not part of run-all: it needs Electron, mpv (vendor/mpv) and .dev/pbux-silent.mkv (nothing makes a
// sound). Nothing leaves loopback.
//
//   node tools/checks/x04-cdp.mjs
//
// Ports: X04_MOCK_PORT (8871), X04_DEV_PORT (5611), X04_CDP_PORT (9771). Exit 1 on any failure.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const VIDEO = path.join(ROOT, '.dev', 'pbux-silent.mkv');
const MOCK_PORT = Number(process.env.X04_MOCK_PORT ?? 8871);
const DEV_PORT = Number(process.env.X04_DEV_PORT ?? 5611);
const CDP_PORT = Number(process.env.X04_CDP_PORT ?? 9771);
const SERVER_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-x04-'));
const CMDS = path.join(PROFILE, 'commands.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[x04]', ...m);
const js = JSON.stringify;
const NB = ' ';
const results = [];
const ok = (name, cond, detail = '') => (results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`), log(results.at(-1)));

const children = [];
function start(cmd, argv, opts) {
  const c = spawn(cmd, argv, { stdio: process.env.X04_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
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

// Preloaded into main: loopback-only UDP, windows that never take focus, every playback command
// logged, and a clock offset (clock.offset, ms) for the live programme boundary.
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
let offset = 0;
const realNow = Date.now;
Date.now = () => realNow() + offset;
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
      m.app.on('browser-window-created', (_e, win) => { win.show = () => win.showInactive(); win.setFocusable(false); win.setIgnoreMouseEvents(true); });
      const handle = m.ipcMain.handle.bind(m.ipcMain);
      m.ipcMain.handle = (ch, fn) => handle(ch, (e, ...a) => {
        if (a[0] && typeof a[0] === 'object' && typeof a[0].type === 'string') fs.appendFileSync(path.join(PROFILE, 'commands.log'), JSON.stringify(a[0]) + '\n');
        return fn(e, ...a);
      });
      m.app.whenReady().then(() => setInterval(() => {
        const f = path.join(PROFILE, 'clock.offset');
        if (fs.existsSync(f)) { offset = Number(fs.readFileSync(f, 'utf8')) || 0; fs.rmSync(f); }
      }, 100));
    }
    return m;
  };
}
`;

function seedProfile() {
  const address = `http://127.0.0.1:${MOCK_PORT}`;
  fs.writeFileSync(path.join(PROFILE, 'servers.json'), js({ servers: [{ id: SERVER_ID, name: 'Mock', kind: 'emby', version: '4.9.1.0', manualAddress: address, lastAddress: address }], activeId: SERVER_ID, tokenBinding: 1 }));
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), js({ ui: { language: 'fr', reduceMotion: true, heroAutoplay: false }, windows: { trayHintShown: true }, playback: { player: 'mpv', resume: 'start', startFullscreen: false } }));
  const guard = path.join(PROFILE, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  return guard;
}

const commands = () => (fs.existsSync(CMDS) ? fs.readFileSync(CMDS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

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

const MODS = { alt: 1, ctrl: 2, shift: 8 };
async function key(page, k, code, vk, mods = [], text, autoRepeat = false) {
  const modifiers = mods.reduce((n, m) => n | MODS[m], 0);
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat, ...base, ...(text ? { text, unmodifiedText: text } : {}) });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

const mock = async (p) => (await fetch(`http://127.0.0.1:${MOCK_PORT}${p}`)).json();
const openStreams = async () => (await mock('/Mock/LiveTv/state')).openStreams.length;
const state = (main) => main.evaluate(`wicaby.playback.getState()`);
const cmd = (main, c) => main.evaluate(`wicaby.playback.command(${js(c)}).then(() => true)`);

function launch(guard) {
  return start(process.execPath, [path.join(DESKTOP, 'scripts', 'dev.mjs'), `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_PORT: String(DEV_PORT), WICABY_TEST_SILENT: '1', NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
}

async function playVod(main, itemIds) {
  await main.evaluate(`wicaby.playback.play(${js({ itemIds, serverId: SERVER_ID })}).then(() => true)`);
  await until('playing', async () => {
    const s = await state(main);
    return s.active && !s.buffering && !s.paused && s.positionMs > 500 && s.item?.id === itemIds[0];
  }, 40000, 200);
}

async function run() {
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT), VIDEO], {
    cwd: ROOT,
    env: { ...process.env, MOCK_LIVETV: 'iptv', MOCK_LIVE_MODE: 'normal', MOCK_TUNERS: '4', MOCK_DURATION_S: '120', NODE_OPTIONS: '' },
  });
  await until('mock', async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/emby/System/Info/Public`)).ok);
  const guard = seedProfile();
  const app = launch(guard);
  const main = await mainPage();
  await until('session', () => main.evaluate(`window.wicaby?.session.get().then((s) => s.status !== 'no-server' && s.status !== 'connecting')`), 60000, 500);
  const status = await main.evaluate(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
  if (status !== 'signed-in') throw new Error(`sign-in ${status}`);

  // ---- Shortcut editor (Settings > Général) ----
  await main.evaluate(`location.hash = '#/settings'`);
  const recordBtn = (label) => `[...document.querySelectorAll('button[aria-pressed]')].find((b) => b.closest('.row')?.querySelector('.lbl')?.textContent.trim() === ${js(label)})`;
  await until('editor', () => main.evaluate(`!!(${recordBtn('Informations de lecture')})`), 20000);
  await main.evaluate(`(${recordBtn('Informations de lecture')}).click()`);
  await sleep(200);
  await key(main, 'm', 'KeyM', 77, [], 'm');
  const refused = await until('conflict text', () => main.evaluate(`document.querySelector('.err')?.textContent ?? ''`), 5000).catch(() => '');
  const after = await main.evaluate(`wicaby.settings.get().then((s) => s.ui.shortcuts)`);
  ok('Info on M is refused with the conflict and saves nothing', refused === `Déjà utilisé par «${NB}Couper le son${NB}»` && js(after) === '{}', `${refused} | ${js(after)}`);
  await main.evaluate(`(${recordBtn('Couper le son')}).click()`);
  await sleep(200);
  await key(main, 'u', 'KeyU', 85, [], 'u');
  const rebound = await until('mute on U', () => main.evaluate(`wicaby.settings.get().then((s) => s.ui.shortcuts['vod.mute']?.[0] === 'U' && s.ui.shortcuts)`), 5000).catch(() => null);
  ok('Mute recorded on U', Boolean(rebound), js(rebound));
  const announced = await main.evaluate(`[...document.querySelectorAll('[role=status]')].map((e) => e.textContent).join(' | ')`);
  ok('the captured combination is announced', announced.includes('Raccourci enregistré'), announced);

  // Export -> fresh bindings -> import through the file input reproduces them; an invalid file changes nothing.
  const exported = { 'vod.mute': ['U'], 'vod.sleep': null };
  await main.evaluate(`wicaby.settings.update({ ui: { shortcuts: ${js(exported)} } }).then(() => true)`);
  const file = path.join(PROFILE, 'shortcuts.json');
  fs.writeFileSync(file, js(exported));
  await main.evaluate(`wicaby.settings.update({ ui: { shortcuts: {} } }).then(() => true)`);
  const setFile = async (p) => {
    const { root } = await main.call('DOM.getDocument', { depth: -1 });
    const { nodeId } = await main.call('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
    await main.call('DOM.setFileInputFiles', { nodeId, files: [p] });
  };
  await setFile(file);
  const imported = await until('imported', () => main.evaluate(`wicaby.settings.get().then((s) => Object.keys(s.ui.shortcuts).length && s.ui.shortcuts)`), 5000).catch(() => null);
  ok('an exported file imported back reproduces the bindings', js(imported) === js(exported), js(imported));
  const bad = path.join(PROFILE, 'bad.json');
  fs.writeFileSync(bad, js({ 'vod.mute': ['U'], 'vod.info': ['F'] }));
  await setFile(bad);
  await sleep(800);
  const unchanged = await main.evaluate(`wicaby.settings.get().then((s) => s.ui.shortcuts)`);
  ok('an invalid file is rejected as a whole', js(unchanged) === js(exported), js(unchanged));
  await main.evaluate(`location.hash = '#/'`);

  // ---- VOD: merged seek, rebound Mute, audio delay, Ends at ----
  await playVod(main, ['movie-1']);
  const osd = await osdPage();
  await until('osd', () => osd.evaluate(`!!document.querySelector('.osd')`), 15000);
  await sleep(1500);
  const p0 = (await state(main)).positionMs;
  const n0 = commands().length;
  for (let i = 0; i < 4; i++) await key(osd, 'ArrowRight', 'ArrowRight', 39);
  const badge = await osd.evaluate(`document.querySelector('.seek-pill')?.textContent ?? ''`);
  await sleep(1500);
  const seeks = commands().slice(n0).filter((c) => c.type === 'seek' || c.type === 'seek-relative');
  ok('four → presses send one seek of +40 s', seeks.length === 1 && seeks[0].type === 'seek' && Math.abs(seeks[0].positionMs - p0 - 40000) < 1500, js(seeks) + ` from ${p0}`);
  ok('the badge shows +40 s', badge === `+40${NB}s`, js(badge));

  await cmd(main, { type: 'pause' });
  const dur = (await state(main)).durationMs;
  await cmd(main, { type: 'seek', positionMs: dur - 5000 });
  await sleep(800);
  for (let i = 0; i < 4; i++) await key(osd, 'ArrowRight', 'ArrowRight', 39);
  const nearEnd = await osd.evaluate(`document.querySelector('.seek-pill')?.textContent ?? ''`);
  await sleep(1200);
  ok('5 s from the end the badge shows +5 s', nearEnd === `+5${NB}s`, `${js(nearEnd)} duration ${dur}`);
  await cmd(main, { type: 'seek', positionMs: 20000 });

  // Ends at (paused): equals clock + remaining, and moves with the wall clock.
  const endsText = () => osd.evaluate(`document.querySelector('.ends')?.textContent ?? ''`);
  const expect = (s, rate = 1) => `Fin à ${new Intl.DateTimeFormat('fr', { hour: '2-digit', minute: '2-digit' }).format(Date.now() + (s.durationMs - s.positionMs) / rate)}`;
  await sleep(1500);
  const e1 = await endsText();
  const s1 = await state(main);
  ok('Ends at while paused = clock + remaining', e1 === expect(s1), `${e1} vs ${expect(s1)}`);
  log('waiting 62 s paused');
  await sleep(62000);
  const e2 = await endsText();
  ok('Ends at follows the wall clock while paused (+1 min)', e2 === expect(await state(main)) && e2 !== e1, `${e1} -> ${e2}`);
  // Playing at ×1.5: stable over time and reflecting the speed.
  await cmd(main, { type: 'rate', value: 1.5 });
  await cmd(main, { type: 'resume' });
  await sleep(2000);
  const e3 = await endsText();
  const s3 = await state(main);
  ok('Ends at at ×1.5 reflects the speed', e3 === expect(s3, 1.5), `${e3} vs ${expect(s3, 1.5)}`);
  // Stable over 60 s of playing (×1, so the file does not run out), sampled every second.
  await cmd(main, { type: 'rate', value: 1 });
  await sleep(1500);
  const samples = [];
  log('sampling Ends at for 60 s');
  for (let i = 0; i < 60; i++) (await sleep(1000), samples.push(await endsText()));
  const sEnd = await state(main);
  ok('Ends at stays stable over 60 s while playing', !sEnd.paused && new Set(samples).size === 1, `${[...new Set(samples)].join(',')} at ${sEnd.positionMs}/${sEnd.durationMs}`);

  // Space with the controls hidden: the disc alone, the OSD stays hidden while paused.
  await cmd(main, { type: 'seek', positionMs: 20000 }); // room left for the sleep timer below
  const hiddenBefore = await until('osd hidden', () => osd.evaluate(`document.querySelector('div.osd')?.classList.contains('hidden') || null`), 6000).catch(() => false);
  await key(osd, ' ', 'Space', 32, [], ' ');
  const quiet = await until('paused by Space', async () => (await state(main)).paused && 'yes', 3000).catch(() => 'no');
  await sleep(400);
  const stillHidden = await osd.evaluate(`document.querySelector('div.osd')?.classList.contains('hidden') ?? false`);
  ok('Space with the controls hidden pauses and keeps the OSD hidden', quiet === 'yes' && stillHidden === true, `hidden before ${hiddenBefore}, paused ${quiet}, hidden after ${stillHidden}`);
  await key(osd, ' ', 'Space', 32, ['shift'], ' ');
  const shiftSpace = await until('resumed by Shift+Space', async () => !(await state(main)).paused && 'yes', 3000).catch(() => 'no');
  ok('Shift+Space still toggles play/pause (old switch ignored modifiers)', shiftSpace === 'yes', shiftSpace);

  // Rebound Mute on U; M no longer mutes. Ctrl+= nudges the audio delay (unchanged default).
  const m0 = (await state(main)).muted;
  await key(osd, 'u', 'KeyU', 85, [], 'u');
  const m1 = await until('muted', async () => (await state(main)).muted !== m0 && 'yes', 3000).catch(() => 'no');
  await key(osd, 'm', 'KeyM', 77, [], 'm');
  await sleep(600);
  const m2 = (await state(main)).muted;
  ok('U mutes after the rebinding; M does nothing', m1 === 'yes' && m2 !== m0, `${m0} -> U -> ${m1} -> M -> ${m2}`);
  await key(osd, 'u', 'KeyU', 85, [], 'u');
  const n1 = commands().length;
  await key(osd, '=', 'Equal', 187, ['ctrl'], '=');
  await sleep(600);
  const delay = commands().slice(n1);
  ok('Ctrl+= still nudges the audio delay', delay.some((c) => c.type === 'audio-delay' && c.deltaMs === 100), js(delay));

  // ---- Sleep timer: prompt at the end of the time, pause 30 s later with no input ----
  const tSet = Date.now();
  await cmd(main, { type: 'sleep', minutes: 0.1 }); // 6 s, the 5 min path with a shorter fuse
  const shown = await until('prompt', () => osd.evaluate(`document.querySelector('.sleep-prompt .headline')?.textContent ?? ''`), 15000).catch(() => '');
  const tPrompt = Date.now() - tSet;
  ok('"Vous regardez toujours ?" at the end of the timer', shown === `Vous regardez toujours${NB}?` && tPrompt >= 5000 && tPrompt < 8000, `${js(shown)} after ${tPrompt} ms`);
  const focused = await osd.evaluate(`document.activeElement?.textContent?.trim() ?? ''`);
  ok('the prompt focuses Continue', focused === 'Continuer', focused);
  const paused = await until('paused', async () => (await state(main)).paused && Date.now(), 40000, 250).catch(() => 0);
  const pausedAfter = paused ? paused - tSet - tPrompt : -1;
  const sl = (await state(main)).sleep;
  ok('no input: paused 30 s after the prompt', paused && pausedAfter > 27000 && pausedAfter < 33000 && !sl, `${pausedAfter} ms, sleep ${js(sl)}`);

  // ---- "Fin de cette vidéo" on an episode with autoplay ----
  await cmd(main, { type: 'stop' });
  await sleep(1000);
  await playVod(main, ['ep-1-1', 'ep-1-2']);
  const osd2 = await osdPage();
  await cmd(main, { type: 'sleep', minutes: 'eov' });
  const d2 = (await state(main)).durationMs;
  await cmd(main, { type: 'seek', positionMs: d2 - 4000 });
  const eovPrompt = await until('eov prompt', () => osd2.evaluate(`!!document.querySelector('.sleep-prompt')`), 20000).catch(() => false);
  const sAt = await state(main);
  ok('"Fin de cette vidéo" prompts at the end instead of starting the next episode', eovPrompt && sAt.item?.id === 'ep-1-1' && !sAt.upNext?.auto, `${sAt.item?.id} upNext ${js(sAt.upNext)}`);
  await sleep(33000);
  const sAfter = await state(main);
  ok('no input: it stays on the episode, the next one never starts', sAfter.active && sAfter.item?.id === 'ep-1-1' && !sAfter.sleep, `${sAfter.item?.id} active ${sAfter.active}`);
  await cmd(main, { type: 'stop' });
  osd2.close();
  osd.close();
  await sleep(1000);

  // ---- S39: live, "Fin de ce programme" ----
  const chans = await main.evaluate(`wicaby.api.get('/LiveTv/Channels', { Limit: 5 }).then((r) => r.Items.map((c) => c.Id))`);
  await main.evaluate(`wicaby.playback.play(${js({ itemIds: [chans[0]], serverId: SERVER_ID })}).then(() => true)`);
  const liveNow = await until('adopted', async () => {
    const s = await state(main);
    return s.live && !s.live.tuning && s.live.now ? s.live.now : null;
  }, 40000, 300);
  ok('a channel streams', (await openStreams()) > 0, `open ${await openStreams()}`);
  const osd3 = await osdPage();
  await cmd(main, { type: 'sleep', minutes: 'eov' });
  const set = (await state(main)).sleep;
  ok('"Fin de ce programme" ends with the airing programme', set?.minutes === 'eov' && set.endsAt === liveNow.end, js(set));
  // Main's clock to 8 s before the programme's end.
  fs.writeFileSync(path.join(PROFILE, 'clock.offset'), String(liveNow.end - Date.now() - 8000));
  const tB = Date.now();
  const livePrompt = await until('live prompt', () => osd3.evaluate(`!!document.querySelector('.sleep-prompt')`), 20000).catch(() => false);
  ok('the prompt comes at the programme boundary', livePrompt && Date.now() - tB > 6000, `${Date.now() - tB} ms`);
  const label = await osd3.evaluate(`document.querySelector('.sleep-prompt .headline')?.textContent ?? ''`);
  ok('live prompt reads "Vous regardez toujours ?"', label === `Vous regardez toujours${NB}?`, label);
  const stopped = await until('stopped', async () => !(await state(main)).active && (await openStreams()) === 0, 45000, 500).catch(() => false);
  ok('no input: the stream stops and the tuner is released (openStreams 0)', stopped === true, `open ${await openStreams()}`);
  osd3.close();
  main.close();
  kill(app);
}

let code = 1;
try {
  await run();
  code = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
} catch (e) {
  console.error('[x04] error', e.message);
}
console.log(results.join('\n'));
for (const c of children) kill(c);
await sleep(800);
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
} catch {}
process.exit(code);
