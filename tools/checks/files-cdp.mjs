#!/usr/bin/env node
// File sources FS-06 acceptance through the built desktop app (file-sources-spec §9.1, §11), against mock-emby and
// the WebDAV mock on loopback only (never a real server or share). A main-process guard answers playback.play itself
// (no player starts, nothing makes a sound) and stands in for the OS folder picker with a temp tree.
//
//   node tools/checks/files-cdp.mjs [--shots=<dir>]
//
// Checked: the Files section lists the sources; Shows › Example Show › Season 1 shows 10 episodes in natural order;
// an item of the source has no heart, cast or download button while a mock-emby item has them; Home has no file item
// with "Show file sources on Home" off and the item with its source badge with it on; the Add sheet shows an
// untrusted certificate's fingerprint. Not part of run-all: it needs Electron and a build (npm run build).
// Ports: FSCDP_MOCK_PORT (8895), FSCDP_CDP_PORT (9795). Exit 1 on any failure.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFilesFixture } from '../mock-server/files-fixture.mjs';
import { startMockWebdav } from '../mock-server/mock-webdav.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const SHOTS = args.shots ? path.resolve(String(args.shots)) : null;
const MOCK_PORT = Number(process.env.FSCDP_MOCK_PORT ?? 8895);
const CDP_PORT = Number(process.env.FSCDP_CDP_PORT ?? 9795);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-fscdp-'));
// --play: a real play of the 10 s video-only test clip through the relay, with mpv forced to --ao=null --no-audio --vo=null.
const PLAY = Boolean(args.play);
const FIXTURE = buildFilesFixture(path.join(PROFILE, 'tree'), { video: PLAY });
const TREE = FIXTURE.dir;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[files-cdp]', ...m);
const js = JSON.stringify;
const results = [];
const pageErrors = [];
const ok = (name, cond, detail = '') => (results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`), log(results.at(-1)));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const children = [];
function start(cmd, argv, opts) {
  const c = spawn(cmd, argv, { stdio: process.env.FSCDP_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
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

// Main-process guard: loopback-only UDP, windows that never take focus or the mouse, no player, a fake folder picker.
const GUARD = String.raw`'use strict';
const PLAY = ${js(PLAY)};
if (PLAY) {
  const cp = require('node:child_process');
  const spawn0 = cp.spawn;
  cp.spawn = function (cmd, argv, opts) {
    if (/mpv(\.exe|\.com)?$/i.test(String(cmd)) && Array.isArray(argv)) argv = [...argv, '--ao=null', '--no-audio', '--vo=null'];
    return spawn0.call(this, cmd, argv, opts);
  };
}
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
    m.app.on('browser-window-created', (_e, win) => { win.show = () => win.showInactive(); win.setFocusable(false); win.setIgnoreMouseEvents(true); });
    m.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${js(TREE)}] });
    const handle = m.ipcMain.handle.bind(m.ipcMain);
    m.ipcMain.handle = (ch, fn) => handle(ch, (e, ...a) => {
      if (ch === 'api:request' && process.env.FSCDP_SPY) require('node:fs').appendFileSync(process.env.FSCDP_SPY, JSON.stringify(a) + String.fromCharCode(10));
      return ch === 'playback:play' && !PLAY ? undefined : fn(e, ...a);
    });
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

// The page only (Page.captureScreenshot): never the desktop.
async function shot(page, name) {
  if (!SHOTS) return;
  await sleep(600);
  const { data } = await page.call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
  log(`screenshot ${name}`);
}

async function run() {
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT)], { cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '', MOCK_PHOTOS: '0' } });
  await until('mock-emby', async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/emby/System/Info/Public`)).ok, 60000, 200);
  const dav = await startMockWebdav({ root: TREE, port: 0 });
  const secure = await startMockWebdav({ root: TREE, port: 0, env: { MOCK_DAV_TLS: '1' } });
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), js({ ui: { language: 'en', reduceMotion: true, heroAutoplay: false, heroEnabled: false, onboarded: true }, windows: { trayHintShown: true } }));
  const guard = path.join(PROFILE, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  const app = start(createRequire(path.join(DESKTOP, 'package.json'))('electron'), ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_URL: '', NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
  const main = await attach((t) => /^(app:|http:\/\/localhost)/.test(t.url) && !t.url.includes('osd=1'));
  const ev = main.evaluate;
  await main.call('Runtime.enable');
  await main.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await until('bridge', () => ev(`!!window.wicaby`), 60000, 300);
  await ev(`wicaby.servers.add(${js(`http://127.0.0.1:${MOCK_PORT}`)}).then((s) => wicaby.servers.select(s.id)).then(() => true)`);
  await until('server selected', () => ev(`wicaby.session.get().then((s) => s.status === 'server-selected' || s.status === 'signed-in')`), 30000, 300);
  const status = await ev(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
  if (status !== 'signed-in') throw new Error(`sign-in ${status}`);

  // ---- Add the sources through the bridge (the sheet is exercised below) ----
  const tested = await ev(`wicaby.files.test(${js({ protocol: 'webdav', url: dav.base, user: 'demo', pass: 'demo', insecure: true })})`);
  ok('Test against the mock: ok', tested.code === 'ok', `${tested.code}, ${tested.count} entries`);
  const source = await ev(`wicaby.files.add(${js({ protocol: 'webdav', url: dav.base, user: 'demo', pass: 'demo', insecure: true, name: 'Example DAV' })})`);
  const folder = await ev(`wicaby.files.pickFolder()`);
  const local = await ev(`wicaby.files.add({ protocol: 'local', url: ${js(folder)}, name: 'Example folder' })`);
  ok('a WebDAV source and a picked folder are added', Boolean(source?.id && local?.id));
  const info = await ev(`wicaby.files.list()`);
  ok('files.list() holds no credential', !js(info).includes('demo'), `${info.length} sources`);

  await ev(`location.hash = '#/home'`);
  await until('sidebar Files section', () => ev(`[...document.querySelectorAll('[data-files] .label')].map((l) => l.textContent.trim()).join('|')`), 15000);
  const side = await ev(`[...document.querySelectorAll('[data-files] .label')].map((l) => l.textContent.trim())`);
  ok('the sidebar Files section lists both sources', side.includes('Example DAV') && side.includes('Example folder'), side.join(', '));

  // ---- Browse: Shows › Example Show › Season 1 ----
  await ev(`[...document.querySelectorAll('[data-files] .link')].find((b) => b.textContent.includes('Example DAV')).click()`);
  await until('source root', () => ev(`location.hash.startsWith('#/files/') && document.querySelectorAll('.files .card').length >= 2`), 15000);
  await shot(main, 'files-root.png');
  const openCard = (name) => ev(`(() => { const c = [...document.querySelectorAll('.files .card')].find((x) => x.textContent.includes(${js(name)})); c.querySelector('a.cover').click(); return true; })()`);
  await openCard('Shows');
  await until('Shows', () => ev(`document.querySelector('.files .crumb.current')?.textContent.trim() === 'Shows' && document.querySelectorAll('.files .card').length > 0`), 15000);
  await openCard('Example Show');
  await until('Example Show', () => ev(`document.querySelector('.files .crumb.current')?.textContent.trim() === 'Example Show' && document.querySelectorAll('.files .card').length >= 3`), 15000);
  const seasons = await ev(`[...document.querySelectorAll('.files .card .ph-name, .files .card .title, .files .card')].length && [...document.querySelectorAll('.files .card')].map((c) => c.querySelector('a.cover').getAttribute('aria-label').split(',')[0])`);
  ok('seasons in natural order (Season 2 before Season 10)', seasons.join() === 'Season 1,Season 2,Season 10', seasons.join(', '));
  await openCard('Season 1');
  await until('Season 1', () => ev(`document.querySelector('.files .crumb.current')?.textContent.trim() === 'Season 1' && document.querySelectorAll('.files .card').length === 10`), 15000);
  const eps = await ev(`[...document.querySelectorAll('.files .card')].map((c) => c.querySelector('a.cover').getAttribute('aria-label').split(' · ')[0])`);
  ok('Season 1 shows 10 episodes in natural order', eps.length === 10 && eps.every((e, i) => e === `S1:E${i + 1}`), eps.join(', '));
  const crumbs = await ev(`[...document.querySelectorAll('.files .crumbs .crumb')].map((c) => c.textContent.trim())`);
  ok('breadcrumbs from the root', crumbs.join(' / ') === 'Example DAV / Shows / Example Show / Season 1', crumbs.join(' / '));
  await shot(main, 'files-season.png');
  await ev(`[...document.querySelectorAll('.files .segmented button')][1].click()`);
  await until('list view', () => ev(`document.querySelectorAll('.files .rows .line').length === 10`), 5000);
  await shot(main, 'files-list.png');
  await ev(`[...document.querySelectorAll('.files .segmented button')][0].click()`);

  // ---- An item of the source vs a mock-emby item ----
  const ep1 = await ev(`(() => { const a = [...document.querySelectorAll('.files .card a.cover')][0]; return a.getAttribute('href'); })()`);
  await ev(`location.hash = ${js(ep1)}`);
  await until('file item page', () => ev(`!!document.querySelector('.actions')`), 15000);
  const fileButtons = await ev(`({ heart: !!document.querySelector('.actions [aria-pressed] svg') && [...document.querySelectorAll('.actions button')].some((b) => /favorite|favori/i.test(b.title)), cast: [...document.querySelectorAll('.actions button')].some((b) => b.getAttribute('aria-label') === ${js('Play on…')} || /cast|lire sur|play on/i.test(b.title)), download: [...document.querySelectorAll('.actions button')].some((b) => /download/i.test(b.title)) })`);
  ok('a file item has no heart, cast (Play on) or download', !fileButtons.heart && !fileButtons.cast && !fileButtons.download, js(fileButtons));
  await shot(main, 'files-item.png');
  const movie = await ev(`wicaby.api.get('/Users/u-wika/Items', { Recursive: true, IncludeItemTypes: 'Movie', Limit: 1 }).then((r) => r.Items[0])`);
  const sid = await ev(`wicaby.session.get().then((s) => s.sessions.find((x) => x.server.kind !== 'files').server.id)`);
  await ev(`location.hash = ${js(`#/item/${sid}/${movie.Id}`)}`);
  await until('emby item page', () => ev(`!!document.querySelector('.actions') && location.hash.includes(${js(movie.Id)})`), 15000);
  await sleep(500);
  const embyButtons = await ev(`({ heart: [...document.querySelectorAll('.actions button')].some((b) => /favorite|favori/i.test(b.title)), cast: [...document.querySelectorAll('.actions button')].some((b) => /cast|play on/i.test(b.title + (b.getAttribute('aria-label') ?? ''))) })`);
  ok('a mock-emby item still has the heart and cast', embyButtons.heart && embyButtons.cast, js(embyButtons));
  const admin = await ev(`!!document.querySelector('nav.sidebar .group.end .link') && [...document.querySelectorAll('nav.sidebar .link')].some((b) => /admin/i.test(b.textContent))`);
  ok('Administration stays for the Emby admin', admin);

  // ---- A real play (--play): the files branch of the playback service, mpv on the relay, no audio ----
  if (PLAY && FIXTURE.playable) {
    const epId = decodeURIComponent(ep1.split('/').pop());
    dav.state.calls.length = 0;
    await ev(`wicaby.playback.play({ itemIds: [${js(epId)}], serverId: ${js(source.id)} }).then(() => true)`);
    const st = await until('playing', () => ev(`wicaby.playback.getState().then((s) => (s.active && s.positionMs > 1500 ? s : null))`), 30000, 250).catch(() => null);
    ok('play: the file plays in mpv through the relay', st?.player === 'mpv' && st.item?.serverId === source.id, st ? `${st.player}, ${Math.round(st.positionMs)} ms of ${Math.round(st.durationMs)}` : 'not playing');
    ok('play: the mock saw only authenticated GETs of the file', dav.state.calls.some((c) => c.method === 'GET' && /S01E01/.test(c.path)) && dav.state.calls.every((c) => c.auth) && !dav.state.tags.includes('AUTH-IN-URL'), `${dav.state.calls.length} calls`);
    await ev(`wicaby.playback.command({ type: 'seek', positionMs: 7000 }).then(() => true)`);
    await sleep(1200);
    // The 400 KB clip usually sits whole in mpv's cache by then: the 206 on a seek is files-playback-check's job.
    log(`info: seek ${dav.state.ranges.some((r) => r.start > 0) ? 'fetched a range past byte 0' : 'served from mpv\'s cache'}`);
    await ev(`wicaby.playback.command({ type: 'stop' }).then(() => true)`);
    await until('stopped', () => ev(`wicaby.playback.getState().then((s) => !s.active)`), 15000);
    await sleep(800);
    const rec = JSON.parse(fs.readFileSync(path.join(PROFILE, 'files', `progress-${source.id}.json`), 'utf8')).records;
    const r = rec['Shows/Example Show/Season 1/Example.Show.S01E01.720p.mkv'];
    ok('play: duration and title tag cached after the first play', r?.durationMs > 9000 && r.durationMs < 11000 && r.title === 'Example Tag Title', r ? `${r.durationMs} ms, "${r.title}"` : 'no record');
  } else if (PLAY) ok('play: a playable clip (mpv needed to encode it)', false);

  // ---- Home: Continue with the setting off, then on ----
  const epId = decodeURIComponent(ep1.split('/').pop());
  await ev(`wicaby.api.get('/Users/local/Items/' + ${js(epId)}, undefined, ${js(source.id)})`);
  await ev(`wicaby.api.post('/Sessions/Playing/Stopped', undefined, { ItemId: ${js(epId)}, PositionTicks: 600 * 1e7, RunTimeTicks: 1200 * 1e7 }, ${js(source.id)})`);
  // Played elsewhere than in this window: a reload drops the renderer's short GET cache (a real stop bumps dataVersion).
  await ev(`(location.hash = '#/home', location.reload(), true)`);
  await sleep(1500);
  await until('bridge again', () => ev(`!!window.wicaby && document.readyState === 'complete'`), 30000, 300);
  await until('home rows', () => ev(`document.querySelectorAll('.card').length > 0`), 20000);
  await sleep(1500);
  const offCards = await ev(`[...document.querySelectorAll('.card a.cover')].filter((a) => a.getAttribute('href')?.includes(${js(source.id)})).length`);
  ok('Home: no file item with the setting off', offCards === 0, `${offCards}`);
  await ev(`wicaby.settings.update({ ui: { filesOnHome: true } }).then(() => true)`);
  const badge = await until('file card on Home', () => ev(`(() => { const a = [...document.querySelectorAll('.card a.cover')].find((x) => x.getAttribute('href')?.includes(${js(source.id)})); return a ? a.getAttribute('aria-label') : null; })()`), 20000).catch(() => null);
  const why = badge
    ? ''
    : js(await ev(`Promise.all([wicaby.api.get('/Users/local/Items/Resume', { Limit: 24 }, ${js(source.id)}).then((r) => r.Items.map((x) => x.Name)), wicaby.session.get().then((s) => s.sessions.map((x) => x.server.kind + ':' + x.status)), wicaby.settings.get().then((s) => s.ui.filesOnHome), [...document.querySelectorAll('.card a.cover')].map((a) => a.getAttribute('href') + ' ' + a.getAttribute('aria-label')).slice(0, 4)])`));
  ok('Home: the file item with its source badge with the setting on', Boolean(badge) && badge.includes('Example DAV'), badge ?? `missing ${why} ${pageErrors.slice(-3).join(' | ')}`);
  await ev(`document.getElementById('main-scroller').scrollTop = 0`);
  await shot(main, 'files-home.png');

  // ---- Settings › Library: the sources, the setting, and the Add sheet with an untrusted certificate ----
  await ev(`location.hash = '#/settings'`);
  await until('settings', () => ev(`!!document.querySelector('nav.cats')`), 10000);
  await ev(`[...document.querySelectorAll('nav.cats button')].find((b) => /library/i.test(b.textContent)).click()`);
  await until('file sources settings', () => ev(`!!document.querySelector('[data-files-settings]')`), 10000);
  await ev(`document.querySelector('[data-files-settings]').scrollIntoView({ block: 'center' })`);
  await shot(main, 'files-settings.png');
  await ev(`document.querySelector('[data-files-settings] .row.add').click()`);
  await until('add sheet', () => ev(`!!document.querySelector('.sheet .choices')`), 5000);
  await ev(`[...document.querySelectorAll('.sheet .choice')][1].click()`);
  await sleep(200);
  await ev(`(() => { const i = document.querySelector('.sheet input.field'); i.value = ${js(secure.base)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await ev(`(() => { const f = [...document.querySelectorAll('.sheet input.field')]; f[1].value = 'demo'; f[1].dispatchEvent(new Event('input', { bubbles: true })); f[2].value = 'demo'; f[2].dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await ev(`[...document.querySelectorAll('.sheet .actions .btn')].find((b) => /test/i.test(b.textContent)).click()`);
  const fp = await until('certificate prompt', () => ev(`document.querySelector('.sheet .cert .fp')?.textContent.trim() ?? null`), 15000).catch(() => null);
  ok('the Add sheet shows an untrusted certificate fingerprint', /^[0-9A-F:]{95}$/.test(fp ?? ''), fp ?? 'missing');
  await shot(main, 'files-add-cert.png');
  await ev(`[...document.querySelectorAll('.sheet .cert .btn')][0].click()`);
  const trusted = await until('trusted test', () => ev(`document.querySelector('.sheet .result.ok')?.textContent.trim() ?? null`), 15000).catch(() => null);
  ok('trusting it for this source makes Test pass', Boolean(trusted), trusted ?? 'no ok');
  await shot(main, 'files-add-ok.png');

  const logs = fs.readdirSync(PROFILE, { recursive: true }).filter((f) => /\.log$/.test(f)).map((f) => fs.readFileSync(path.join(PROFILE, f), 'utf8')).join('\n');
  ok('no credential in the main log', !/demo/.test(logs), `${logs.length} bytes`);
  const stored = fs.readFileSync(path.join(PROFILE, 'files', 'sources.json'), 'utf8');
  ok('sources.json holds no credential', !/demo/.test(stored));
  main.close();
  kill(app);
  await Promise.all([dav.close(), secure.close()]);
}

let code = 1;
try {
  await run();
  code = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
} catch (e) {
  console.error('[files-cdp] error', e.stack ?? e.message);
}
console.log(results.join('\n'));
for (const c of children) kill(c);
await sleep(800);
try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
} catch {}
process.exit(code);
