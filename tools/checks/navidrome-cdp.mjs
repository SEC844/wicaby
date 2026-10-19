#!/usr/bin/env node
// Navidrome on the desktop through the built app (music-feishin-navidrome spec part b), against
// tools/mock-server/mock-navidrome.mjs and mock-emby, on loopback only. Never audible: WICABY_TEST_SILENT=1 (mpv
// --ao=null, Chromium muted) and the mocks serve silence. The guard keeps every main-process TCP/UDP socket on loopback
// and points Chromium at a dead proxy (loopback is never proxied), so nothing reaches the LAN or the internet.
//
//   node tools/checks/navidrome-cdp.mjs [--shots=<dir>]
//
// Checked: Sources > Add > Navidrome then the user name and password form signs in; the password is in no file of the profile but the
// vault; the Music header switches between mock-emby and Navidrome (Settings > Audio shows the same choice); albums
// and an album's tracks; the row heart stars through star.view; "Add to playlist" updates the playlist; a track plays
// (muted) from a stream that reaches the mock signed; the stop reports a scrobble once; mock tags stay empty; no
// password or token in the logs; switching back to Emby shows Emby's music. Not part of run-all: it needs a build
// (npm run build) and vendor/mpv. Ports: NDCDP_EMBY_PORT (8898), NDCDP_CDP_PORT (9798). Exit 1 on any failure.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockNavidrome, USERS } from '../mock-server/mock-navidrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const SHOTS = args.shots ? path.resolve(String(args.shots)) : null;
const EMBY_PORT = Number(process.env.NDCDP_EMBY_PORT ?? 8898);
const CDP_PORT = Number(process.env.NDCDP_CDP_PORT ?? 9798);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-ndcdp-'));
const BLOCKED = path.join(PROFILE, 'blocked.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[navidrome-cdp]', ...m);
const js = JSON.stringify;
const results = [];
const pageErrors = [];
const ok = (name, cond, detail = '') => (results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`), log(results.at(-1)));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const children = [];
function start(cmd, argv, opts) {
  const c = spawn(cmd, argv, { stdio: process.env.NDCDP_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
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

// Main-process guard: loopback-only TCP and UDP (blocked attempts are written to blocked.txt), Chromium behind a dead
// proxy, windows that never take focus or the mouse.
const GUARD = String.raw`'use strict';
const fs = require('node:fs');
const dgram = require('node:dgram');
const net = require('node:net');
const BLOCKED = process.env.NDCDP_BLOCKED;
const loopback = (a) => a === 'localhost' || a === '::1' || /^127\./.test(a);
const note = (what) => { try { fs.appendFileSync(BLOCKED, what + '\n'); } catch {} };
const send = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (msg, ...rest) {
  const address = rest.find((a) => typeof a === 'string');
  const cb = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null;
  if (address !== undefined && !loopback(address)) { note('udp ' + address); if (cb) process.nextTick(cb, null, 0); return; }
  return send.call(this, msg, ...rest);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) {
  const o = Array.isArray(a[0]) ? a[0][0] : a[0];
  const host = typeof o === 'object' && o ? (o.path ? 'localhost' : o.host ?? 'localhost') : typeof a[1] === 'string' ? a[1] : typeof o === 'string' && isNaN(Number(o)) ? 'localhost' : 'localhost';
  if (!loopback(host)) { note('tcp ' + host); process.nextTick(() => this.destroy(new Error('blocked by the test guard'))); return this; }
  return connect.apply(this, a);
};
const Module = require('node:module');
const load = Module._load;
let hooked = false;
Module._load = function (request, ...rest) {
  const m = load.call(this, request, ...rest);
  if (!hooked && request === 'electron' && m && m.app) {
    hooked = true;
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

async function shot(page, name) {
  if (!SHOTS) return;
  await sleep(800);
  const { data } = await page.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
  log(`screenshot ${name}`);
}

async function run() {
  const nd = await startMockNavidrome({ port: 0 });
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(EMBY_PORT)], { cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '', MOCK_PHOTOS: '0', MOCK_MUSIC: '1' } });
  await until('mock-emby', async () => (await fetch(`http://127.0.0.1:${EMBY_PORT}/emby/System/Info/Public`)).ok, 60000, 200);
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), js({ ui: { language: 'fr', reduceMotion: true, heroAutoplay: false, heroEnabled: false, onboarded: true }, windows: { trayHintShown: true } }));
  const guard = path.join(PROFILE, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  const app = start(createRequire(path.join(DESKTOP, 'package.json'))('electron'), ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_URL: '', WICABY_TEST_SILENT: '1', NDCDP_BLOCKED: BLOCKED, NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
  const main = await attach((t) => /^(app:|http:\/\/localhost)/.test(t.url) && !t.url.includes('osd=1'));
  const ev = main.evaluate;
  await main.call('Runtime.enable');
  await main.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await until('bridge', () => ev(`!!window.wicaby`), 60000, 300);
  const click = (sel, text) => ev(`(() => { const b = [...document.querySelectorAll(${js(sel)})].find((x) => ${text ? `x.textContent.includes(${js(text)})` : 'true'}); if (!b) return false; b.click(); return true; })()`);
  const type = (sel, v) => ev(`(() => { const i = document.querySelector(${js(sel)}); if (!i) return false; i.value = ${js(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

  // ---- Sources > Add > Navidrome: the address, then "Other user" ----
  await ev(`location.hash = '#/servers'`);
  await until('navidrome type', () => click('[data-type="navidrome"]'), 20000);
  await until('address field', () => type('#source-address', nd.url), 10000);
  await shot(main, 'nd-01-add-source.png');
  await ev(`document.querySelector('#source-address').form.requestSubmit()`);
  await until('login route', () => ev(`location.hash.startsWith('#/login/')`), 20000);
  const sid = await ev(`location.hash.split('/')[2]`);
  ok('probe: the address is a Navidrome server (id nd…)', /^nd[0-9a-f]{16}$/.test(sid), sid);
  // No public user list on Navidrome: the login page shows the user name and password form inline.
  await until('the sign-in form', () => ev(`!!document.querySelector('form.fields input[type=password]')`), 15000);
  await type('form.fields input[autocomplete=username]', 'wika');
  await type('form.fields input[type=password]', 'wrong-pass');
  await ev(`document.querySelector('form.fields button[type=submit]').click()`);
  const wrong = await until('error', () => ev(`document.querySelector('form.fields .error')?.textContent.trim() ?? null`), 10000).catch(() => null);
  ok('a wrong password is refused with a message', !!wrong, wrong ?? 'none');
  await shot(main, 'nd-02-wrong-password.png');
  await type('form.fields input[type=password]', USERS.wika);
  await ev(`document.querySelector('form.fields button[type=submit]').click()`);
  await until('signed in', () => ev(`wicaby.session.get().then((s) => s.sessions.some((x) => x.server.id === ${js(sid)} && x.status === 'signed-in'))`), 20000);
  ok('signed in to Navidrome', true);
  const files = fs.readdirSync(PROFILE, { recursive: true }).filter((f) => fs.statSync(path.join(PROFILE, f)).isFile() && !/guard\.cjs|blocked\.txt|Cache|GPUCache|Code Cache/.test(f));
  const readable = (f) => {
    try {
      return fs.readFileSync(path.join(PROFILE, f));
    } catch {
      return Buffer.alloc(0); // locked by Chromium (cookies, leveldb): not where the app writes its own files
    }
  };
  const leaking = files.filter((f) => readable(f).includes(USERS.wika));
  ok('the password is in no plain file of the profile', leaking.length === 0, leaking.join(', ') || `${files.length} files`);

  // ---- mock-emby with its music library, in the same session ----
  await ev(`wicaby.servers.add(${js(`http://127.0.0.1:${EMBY_PORT}`)}).then((s) => wicaby.servers.select(s.id)).then(() => true)`);
  const embyId = await until('emby selected', () => ev(`wicaby.session.get().then((s) => s.sessions.find((x) => x.server.kind === 'emby' && x.status === 'server-selected')?.server.id ?? null)`), 30000);
  await ev(`wicaby.session.login('Wika', 'wicaby', ${js(embyId)}).then((s) => s.status)`);
  // The app sent us to /login when the server was selected; let it go home before we navigate.
  await until('home again', () => ev(`location.hash.startsWith('#/home')`), 15000).catch(() => null);
  await sleep(1000);

  // ---- Music source: the header switch, Emby first ----
  const embyMusic = await until('emby music view', () => ev(`(async () => { const s = await wicaby.session.get(); const u = s.sessions.find((x) => x.server.id === ${js(embyId)}).user.id; const r = await wicaby.api.get('/Users/' + u + '/Views', undefined, ${js(embyId)}); return r.Items.find((v) => v.CollectionType === 'music')?.Id ?? null; })()`), 20000);
  await ev(`location.hash = ${js(`#/library/${embyId}/${embyMusic}`)}`);
  await until('music header switch', () => ev(`!!document.querySelector('.music .head .trigger')`), 20000);
  await click('.music .head .trigger');
  const choices = await until('source menu', () => ev(`(() => { const o = [...document.querySelectorAll('[role="menuitemradio"]')].map((x) => x.textContent.trim()); return o.length ? o : null; })()`), 5000);
  ok('the Music header offers Auto, Emby and Navidrome', choices.length === 3 && choices.some((c) => /Navidrome/.test(c)), choices.join(' | '));
  await shot(main, 'nd-03-source-menu.png');
  await click('[role="menuitemradio"]', 'Navidrome');
  await until('navidrome music', () => ev(`location.hash.startsWith(${js(`#/library/${sid}/`)})`), 15000);
  const setting = await ev(`wicaby.settings.get().then((s) => s.music.source)`);
  ok('the switch saves the source and opens Navidrome music', setting === sid, setting);
  const sidebar = await ev(`[...document.querySelectorAll('nav.sidebar .link .label')].map((l) => l.textContent.trim())`);
  log(`info: sidebar ${sidebar.join(', ')}`);


  // ---- Browse: albums, an album ----
  const cells = await until('album cells', () => ev(`(() => { const c = document.querySelectorAll('.tab .cell'); const imgs = [...document.querySelectorAll('.tab .cell img')].filter((i) => i.complete && i.naturalWidth > 0).length; return c.length >= 4 && imgs >= 1 ? { cells: c.length, imgs } : null; })()`), 30000).catch(() => null);
  ok('Navidrome albums are listed with covers', !!cells, js(cells));
  await shot(main, 'nd-04-albums.png');
  await ev(`(() => { const c = document.querySelector('.tab .cell a') ?? document.querySelector('.tab .cell button'); c.click(); return true; })()`);
  const tracks = await until('album tracks', () => ev(`document.querySelectorAll('section.tracks button.track').length || null`), 20000).catch(() => null);
  ok('an album opens with its tracks', !!tracks, String(tracks));
  await shot(main, 'nd-05-album.png');

  // ---- Star (the row heart) ----
  const stars0 = nd.state.stars.length;
  await ev(`(document.querySelector('section.tracks .row .fav').click(), true)`);
  await until('star', () => nd.state.stars.length > stars0, 8000).catch(() => null);
  const star = nd.state.stars.at(-1);
  ok('the row heart stars or unstars the song on Navidrome', !!star && star.as === 'id', js(star));

  // ---- Add to playlist (the track menu, then "Mix du dimanche") ----
  const edits0 = nd.state.playlistEdits.length;
  await ev(`(() => { document.querySelectorAll('section.tracks .row')[1].querySelector('.more').click(); return true; })()`);
  await until('track menu', () => ev(`!!document.querySelector('[data-track-menu]')`), 5000);
  await click('[data-track-menu] [data-action="playlist"]');
  await until('playlist sheet', () => ev(`!!document.querySelector('[role="dialog"] form.new')`), 5000);
  await until('playlist listed', () => ev(`[...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent.includes('Mix du dimanche'))`), 10000).catch(() => null);
  await shot(main, 'nd-06-add-to-playlist.png');
  await click('[role="dialog"] button', 'Mix du dimanche');
  await until('playlist edit', () => nd.state.playlistEdits.length > edits0, 8000).catch(() => null);
  const edit = nd.state.playlistEdits.at(-1);
  ok('"Add to playlist" updates the Navidrome playlist', !!edit && edit.op === 'update' && edit.add?.length === 1, js(edit));
  await sleep(600);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

  // ---- Play (muted), then stop: one scrobble ----
  const streams0 = nd.state.streams.length;
  await click('section.tracks button.track');
  const playing = await until('playing', () => ev(`wicaby.playback.getState().then((s) => (s.active && s.positionMs > 500 ? s.item?.id ?? true : null))`), 30000).catch(() => null);
  ok('a Navidrome track plays (muted, mpv --ao=null)', !!playing, String(playing));
  ok('the stream reached the mock (signed hop)', nd.state.streams.length > streams0, js(nd.state.streams.at(-1)));
  await until('the bar', () => ev(`!!document.querySelector('[data-now-playing-bar] [data-title]')`), 10000).catch(() => null);
  await shot(main, 'nd-07-playing.png');
  // Seek past the scrobble threshold (half the track or 240 s) but under 90 % (no resume point kept), stop: one submission.
  const dur = await ev(`wicaby.playback.getState().then((s) => s.durationMs ?? 0)`);
  if (dur > 0) await ev(`wicaby.playback.command({ type: 'seek', positionMs: ${Math.floor(dur * 0.6)} }).then(() => true)`).catch(() => null);
  await sleep(1500);
  log(`info: before stop ${js(await ev(`wicaby.playback.getState().then((s) => ({ pos: s.positionMs, dur: s.durationMs, id: s.item?.id }))`))}, duration ${dur}`);
  await ev(`wicaby.playback.command({ type: 'stop' }).then(() => true)`).catch(() => null);
  await until('stopped', () => ev(`wicaby.playback.getState().then((s) => !s.active)`), 10000).catch(() => null);
  await until('scrobble', () => nd.state.scrobbles.some((s) => s.submission !== 'false' && s.submission !== false), 8000).catch(() => null);
  const subs = nd.state.scrobbles.filter((s) => s.submission !== 'false' && s.submission !== false);
  ok('the stop reports exactly one scrobble', subs.length === 1, js(nd.state.scrobbles));

  // ---- Settings > Audio: the same choice ----
  await ev(`location.hash = '#/settings?pane=music'`);
  await until('music source row', () => ev(`[...document.querySelectorAll('.lbl')].some((l) => /musique|music/i.test(l.textContent))`), 10000).catch(() => null);
  await ev(`[...document.querySelectorAll('h3.gh')].find((h) => /Musique|Music/.test(h.textContent))?.scrollIntoView({ block: 'start' })`);
  await shot(main, 'nd-08-settings-audio.png');

  // ---- Back to Emby: Emby's music again ----
  await ev(`wicaby.settings.update({ music: { source: ${js(embyId)} } }).then(() => true)`).catch(() => ev(`wicaby.settings.set({ music: { source: ${js(embyId)} } }).then(() => true)`));
  await ev(`location.hash = ${js(`#/library/${embyId}/${embyMusic}`)}`);
  const embyCells = await until('emby albums', () => ev(`document.querySelectorAll('.tab .cell').length || null`), 20000).catch(() => null);
  ok('switching back shows Emby music (no regression)', !!embyCells, String(embyCells));
  await shot(main, 'nd-09-emby-music.png');

  // ---- Hygiene ----
  const tags = [...new Set(nd.state.tags.map((t) => (typeof t === 'string' ? t : t.tag ?? js(t))))];
  ok('mock-navidrome: no tag (UNMAPPED, SALT-REUSE, CLEARTEXT-PASSWORD, DUP-SCROBBLE, SIZE-ZERO, NO-JSON)', tags.length === 0, tags.join(', '));
  const logs = fs.readdirSync(PROFILE, { recursive: true }).filter((f) => /\.log$/.test(f)).map((f) => fs.readFileSync(path.join(PROFILE, f), 'utf8')).join('\n');
  const leak = /mock-pass|[?&](t|s|p)=[0-9a-f]{6,}/.test(logs);
  ok('no password, token or salt in the logs', !leak, `${logs.length} bytes`);
  const unmapped = [...new Set(logs.match(/NAVIDROME-UNMAPPED[^\n]*/g) ?? [])];
  log(`info: NAVIDROME-UNMAPPED in the log: ${unmapped.slice(0, 8).join(' | ') || 'none'}`);
  const blocked = fs.existsSync(BLOCKED) ? fs.readFileSync(BLOCKED, 'utf8').trim() : '';
  log(`info: non-loopback attempts blocked by the guard: ${blocked.replace(/\n/g, ', ') || 'none'}`);
  if (pageErrors.length) log(`info: page errors: ${pageErrors.slice(0, 5).join(' | ')}`);
  main.close();
  kill(app);
  await nd.close();
}

let code = 1;
try {
  await run();
  code = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
} catch (e) {
  console.error('[navidrome-cdp] error', e.stack ?? e.message);
}
console.log(results.join('\n'));
for (const c of children) kill(c);
await sleep(800);
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
} catch {}
process.exit(code);
