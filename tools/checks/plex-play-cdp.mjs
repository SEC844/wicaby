#!/usr/bin/env node
// Plex playback through the built desktop app (plex-spec PX-08, PX-09), against tools/mock-server/mock-plex.mjs on
// loopback only (never plex.tv or a real Plex server). The app links the mock plex.tv with a code
// (WICABY_PLEXTV_BASE), signs in as the owner, agrees to the http LAN address (D-3) and plays show A's second episode
// in mpv, forced to --ao=null --no-audio --vo=null (nothing visible or audible outside the app window).
//
//   node tools/checks/plex-play-cdp.mjs [--shots=<dir>]
//
// Checked: the episode direct plays from the server's resume point; the skip-intro pill shows in the intro (a Plex
// marker); trickplay is the part's BIF; pause, seek and stop give timelines playing…paused…playing…stopped with one
// stopped; an audio change sends one PUT /library/parts; /Mock/Terminate stops the player through the PMS socket's
// 'playing' notification and shows the reason;
// no UNMAPPED, TOKEN-IN-URL, NO-CLIENT-ID, DUP-STOPPED or DUP-SCROBBLE in the mock's log. Screenshots: the app's
// pages only (Page.captureScreenshot). Not part of run-all: it needs Electron and a build (npm run build).
// Ports: PXCDP_PMS_PORT (8941), PXCDP_TV_PORT (8942), PXCDP_RELAY_PORT (8943), PXCDP_CDP_PORT (9797).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFilesFixture } from '../mock-server/files-fixture.mjs';
import { MACHINE_ID, startMockPlex } from '../mock-server/mock-plex.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const SHOTS = args.shots ? path.resolve(String(args.shots)) : null;
const CDP_PORT = Number(process.env.PXCDP_CDP_PORT ?? 9797);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-pxcdp-'));
const FIXTURE = buildFilesFixture(path.join(PROFILE, 'tree'));
const CLIP = FIXTURE.playable ? path.join(FIXTURE.dir, ...FIXTURE.film.split('/')) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[plex-play-cdp]', ...m);
const js = JSON.stringify;
const results = [];
const ok = (name, cond, detail = '') => (results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`), log(results.at(-1)));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const children = [];
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

// Main-process guard: mpv silent and windowless, windows that never take focus or the mouse, loopback-only UDP.
const GUARD = String.raw`'use strict';
const cp = require('node:child_process');
const spawn0 = cp.spawn;
cp.spawn = function (cmd, argv, opts) {
  if (/mpv(\.exe|\.com)?$/i.test(String(cmd)) && Array.isArray(argv)) argv = [...argv, '--ao=null', '--no-audio', '--vo=null'];
  return spawn0.call(this, cmd, argv, opts);
};
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

// The page only (Page.captureScreenshot): never the desktop.
async function shot(page, name) {
  if (!SHOTS) return;
  await sleep(500);
  const { data } = await page.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
  log(`screenshot ${name}`);
}

const isApp = (t) => /^(app:|http:\/\/localhost)/.test(t.url);

async function run(m) {
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), js({ ui: { language: 'en', reduceMotion: true, heroAutoplay: false, heroEnabled: false, onboarded: true }, windows: { trayHintShown: true }, playback: { player: 'mpv' } }));
  const guard = path.join(PROFILE, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  const app = spawn(createRequire(path.join(DESKTOP, 'package.json'))('electron'), ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    stdio: process.env.PXCDP_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore',
    windowsHide: true,
    env: { ...process.env, WICABY_DEV_URL: '', WICABY_TEST_SILENT: '1', WICABY_PLEXTV_BASE: m.plextv, NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
  children.push(app);
  const main = await attach((t) => isApp(t) && !t.url.includes('osd=1'));
  const ev = main.evaluate;
  await main.call('Runtime.enable');
  await main.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await until('bridge', () => ev(`!!window.wicaby`), 60000, 300);

  // ---- Link with a code, sign in as the owner, agree to the http LAN address (D-3) ----
  const pin = await ev(`wicaby.servers.plexLink()`);
  await fetch(`${m.plextv}/Mock/Pin/Link?code=${encodeURIComponent(pin.code)}`, { method: 'POST' });
  const linked = await until('linked', () => ev(`wicaby.servers.plexPoll().then((p) => (p.status === 'linked' ? p : null))`), 30000, 2100);
  ok('the mock plex.tv link lists the server', linked.servers.some((s) => s.id === MACHINE_ID));
  await ev(`wicaby.servers.select(${js(MACHINE_ID)}).then(() => true)`);
  let st = await ev(`wicaby.session.login('Wika', '', ${js(MACHINE_ID)})`);
  const confirm = st.sessions.find((x) => x.server.id === MACHINE_ID)?.confirm;
  if (confirm) st = await ev(`wicaby.servers.plexConfirm(${js(MACHINE_ID)}, ${js(confirm)})`);
  await until('signed in', () => ev(`wicaby.session.get().then((s) => s.sessions.some((x) => x.server.id === ${js(MACHINE_ID)} && x.status === 'signed-in'))`), 30000, 300);
  ok('signed in to the mock PMS', true, confirm ? `after agreeing to ${confirm}` : 'no LAN confirmation asked');

  // ---- The item page of show A's second episode (resume point 40 s on the server; 3 s set here) ----
  await ev(`wicaby.api.post('/Users/1/Items/2003/UserData', undefined, { PlaybackPositionTicks: 0 }, ${js(MACHINE_ID)}).catch(() => true)`);
  await ev(`location.hash = ${js(`#/item/${MACHINE_ID}/2003`)}`);
  await until('item page', () => ev(`!!document.querySelector('.actions')`), 20000);
  await shot(main, 'plex-item.png');

  // ---- Play: mpv, direct play ----
  m.state.timelines.length = 0;
  await ev(`wicaby.playback.play({ itemIds: ['2003'], serverId: ${js(MACHINE_ID)} }).then(() => true)`);
  const playing = await until('playing', () => ev(`wicaby.playback.getState().then((s) => (s.active && s.positionMs > 3500 && !s.buffering ? s : null))`), 40000, 200).catch(() => null);
  ok('the episode plays in mpv (direct play)', playing?.player === 'mpv' && playing.playMethod === 'DirectPlay', playing ? `${playing.player}, ${playing.playMethod}, ${Math.round(playing.positionMs)} ms` : 'not playing');
  ok('markers: the intro from Plex (3 s to 15 s)', playing?.markers?.introStartMs === 3000 && playing.markers.introEndMs === 15000, js(playing?.markers ?? null));
  ok('trickplay: the BIF of the part', playing?.trickplay?.kind === 'bif' && /\/Videos\/2003\/index\.bif/.test(playing.trickplay.url), playing?.trickplay?.url ?? 'none');
  const bifOk = playing?.trickplay?.url ? await ev(`fetch(${js(playing.trickplay.url)}).then((r) => r.ok && r.arrayBuffer()).then((b) => b && b.byteLength > 64)`).catch(() => false) : false;
  ok('the BIF loads through wicaby-media://', bifOk);
  const osd = await attach((t) => isApp(t) && t.url.includes('osd=1')).catch(() => null);
  if (osd) {
    await osd.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const pill = await until('skip pill', () => osd.evaluate(`(() => { const w = document.querySelector('.skip-wrap.shown .skip-pill'); return w ? w.textContent.trim() : null; })()`), 10000, 150).catch(() => null);
    ok('the skip-intro pill shows in the intro', Boolean(pill), pill ?? 'not shown');
    await shot(osd, 'plex-osd-skip-intro.png');
  } else ok('the OSD page', false);

  // ---- Pause, seek, an audio change, stop ----
  await ev(`wicaby.playback.command({ type: 'pause' }).then(() => true)`);
  await until('paused', () => ev(`wicaby.playback.getState().then((s) => s.paused)`), 10000);
  await sleep(400);
  await ev(`wicaby.playback.command({ type: 'resume' }).then(() => true)`);
  await until('resumed', () => ev(`wicaby.playback.getState().then((s) => !s.paused)`), 10000);
  await sleep(400);
  await ev(`wicaby.playback.command({ type: 'seek', positionMs: 1000 }).then(() => true)`);
  await sleep(600);
  const state = await ev(`wicaby.playback.getState()`);
  const other = state.audioTracks.find((t) => t.index !== state.audioIndex);
  const puts = m.state.partPuts.length;
  if (other) await ev(`wicaby.playback.command({ type: 'audio', index: ${other.index} }).then(() => true)`);
  await sleep(800);
  const newPuts = m.state.partPuts.slice(puts);
  ok('an audio change sends one PUT /library/parts/{id}?audioStreamID=', newPuts.length === 1 && newPuts[0].audioStreamID === String(other?.index), js(newPuts));
  await ev(`wicaby.playback.command({ type: 'stop' }).then(() => true)`);
  await until('stopped', () => ev(`wicaby.playback.getState().then((s) => !s.active)`), 15000);
  await sleep(800);
  // The test clip has no audio track, so mpv cannot switch in place: the change reloads at the position, a new session.
  const lines = m.state.timelines.filter((x) => x.key === '2003');
  const sessions = [...new Set(lines.map((x) => x.session))];
  const states = lines.filter((x) => x.session === sessions[0]).map((x) => x.state);
  const compact = states.filter((s, i) => s !== states[i - 1]);
  ok('timelines playing…paused…playing…stopped', compact.join(',') === 'playing,paused,playing,stopped', compact.join(','));
  ok('exactly one stopped per session', sessions.every((s) => lines.filter((x) => x.session === s && x.state === 'stopped').length === 1), `${sessions.length} session(s), ${lines.length} timelines`);
  await shot(main, 'plex-after-stop.png');

  // ---- Termination by the server ----
  await ev(`wicaby.playback.play({ itemIds: ['2004'], serverId: ${js(MACHINE_ID)} }).then(() => true)`);
  await until('playing 2004', () => ev(`wicaby.playback.getState().then((s) => s.active && s.positionMs > 1000)`), 40000, 200);
  const session = await until('a session', () => m.state.timelines.filter((x) => x.key === '2004').at(-1)?.session, 15000);
  const t0 = Date.now();
  await fetch(`${m.pms}/Mock/Terminate?session=${encodeURIComponent(session)}&reason=${encodeURIComponent('The server owner stopped this stream')}`, { method: 'POST' });
  // No report is due: the 'playing' stopped notification on the PMS socket ends it, and the one stopped report
  // carries the owner's reason back.
  const ended = await until('terminated', () => ev(`wicaby.playback.getState().then((s) => !s.active)`), 5000, 100).catch(() => false);
  ok('/Mock/Terminate stops the player through the notification (no report due)', ended && m.state.terminations.some((x) => x.session === session), `${Date.now() - t0} ms`);
  const toast = await until('reason', () => ev(`document.body.innerText.includes('The server owner stopped this stream')`), 5000, 100).catch(() => false);
  ok('and shows the reason', toast);
  await shot(main, 'plex-terminated.png');
  await sleep(1500);
  const own = m.state.timelines.filter((x) => x.session === session);
  const stops = own.filter((x) => x.state === 'stopped');
  const after = stops.length ? own.filter((x) => x.at > stops[0].at).length : -1;
  ok('one stopped report (it got the reason), nothing after it', stops.length === 1 && after === 0, `${stops.length} stopped, ${after} after it`);

  const bad = m.state.tags.filter((t) => ['UNMAPPED', 'TOKEN-IN-URL', 'NO-CLIENT-ID', 'NO-TOKEN', 'DUP-STOPPED', 'DUP-SCROBBLE', 'SEEK-AFTER-OFFSET', 'ACCOUNT-TOKEN-ON-PMS'].includes(t));
  ok('mock tags: no UNMAPPED, TOKEN-IN-URL, NO-CLIENT-ID, DUP-STOPPED, DUP-SCROBBLE', bad.length === 0, bad.join(', ') || 'none');
}

const m = await startMockPlex({
  port: Number(process.env.PXCDP_PMS_PORT ?? 8941),
  tvPort: Number(process.env.PXCDP_TV_PORT ?? 8942),
  relayPort: Number(process.env.PXCDP_RELAY_PORT ?? 8943),
  env: { MOCK_PLEX_VIDEO: CLIP ?? '', MOCK_PLEX_SECOND: '0', MOCK_PLEX_TLS: '0' },
});
let failed = false;
try {
  if (!CLIP) throw new Error('no playable clip (mpv is needed to encode it)');
  await run(m);
} catch (err) {
  failed = true;
  log(`FAIL ${err.stack ?? err}`);
} finally {
  for (const c of children) kill(c);
  await m.close();
}
const fails = results.filter((r) => r.startsWith('FAIL')).length;
log(`${results.length - fails} passed, ${fails} failed${failed ? ', aborted' : ''}`);
process.exit(fails || failed ? 1 : 0);
