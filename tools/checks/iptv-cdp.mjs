#!/usr/bin/env node
// TV en direct and IPTV end to end in the desktop app (dev build, CDP), with screenshots. Not part of run-all: it
// needs Electron and mpv (vendor/mpv). Everything is local: the Emby mock (127.0.0.1) and the IPTV mock
// (tools/mock-server/mock-iptv.mjs); the app runs with WICABY_TEST_SILENT=1 (mpv --ao=null, Chromium muted) in a
// throwaway profile.
//
//   node tools/checks/iptv-cdp.mjs [--out=<folder for the screenshots>]
//
// Phase 1, a server with a tuner: the sidebar's TV en direct rows, and IPTV's "Add" row.
// Phase 2, a server without one (MOCK_LIVETV=off): the setup row and page, the IPTV empty page and add sheet, then an
// IPTV source added through the sheet with an Xtream-style address: channels, guide (group filter), playback of the
// channel that needs its #EXTVLCOPT user agent, and the address kept out of sources.json, the cache and the logs.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockIptv } from '../mock-server/mock-iptv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const OUT = typeof args.out === 'string' ? args.out : fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-iptv-shots-'));
const MOCK_PORT = 8861;
const DEV_PORT = 5601;
const CDP_PORT = 9761;
const SERVER_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SECRET = 's3cret';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[iptv-cdp]', ...m);
const js = (v) => JSON.stringify(v);
fs.mkdirSync(OUT, { recursive: true });

const children = [];
function start(cmd, argv, opts) {
  const child = spawn(cmd, argv, { stdio: process.env.IPTVCDP_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
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

async function until(what, fn, timeoutMs = 30000, everyMs = 200) {
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

// Keeps the windows from taking focus or the mouse, and UDP on loopback (tools/screenshots/desktop.mjs).
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
      m.app.on('browser-window-created', (_e, win) => { win.show = () => win.showInactive(); win.setFocusable(false); win.setIgnoreMouseEvents(true); win.setSize(1440, 900); });
    }
    return m;
  };
}
`;

async function attach() {
  const page = await until(
    'a Wicaby page',
    async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === 'page' && /^(app:|http:\/\/localhost)/.test(t.url) && !t.url.includes('osd=1')),
    90000,
    300,
  );
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
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  const shot = async (name) => {
    await sleep(1500);
    const r = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
    log(`screenshot ${name}.png`);
  };
  return { call, evaluate, shot, close: () => ws.close() };
}

async function launch(liveTv) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-iptvcdp-'));
  const address = `http://127.0.0.1:${MOCK_PORT}`;
  fs.writeFileSync(path.join(profile, 'servers.json'), js({ servers: [{ id: SERVER_ID, name: 'Maison', kind: 'emby', version: '4.9.1.0', manualAddress: address, lastAddress: address }], activeId: SERVER_ID, tokenBinding: 1 }));
  fs.writeFileSync(path.join(profile, 'settings.json'), js({ ui: { language: 'fr', reduceMotion: true, reduceTransparency: true, heroAutoplay: false }, windows: { trayHintShown: true }, playback: { player: 'mpv' } }));
  const guard = path.join(profile, 'guard.cjs');
  fs.writeFileSync(guard, GUARD);
  const mock = start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT)], { cwd: ROOT, env: { ...process.env, MOCK_LIVETV: liveTv ? '' : 'off', NODE_OPTIONS: '' } });
  await until('the Emby mock', async () => (await fetch(`${address}/emby/System/Info/Public`)).ok);
  const app = start(process.execPath, [path.join(DESKTOP, 'scripts', 'dev.mjs'), `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_TEST_SILENT: '1', WICABY_DEV_PORT: String(DEV_PORT), NODE_OPTIONS: `--require "${guard.replaceAll('\\', '/')}"` },
  });
  const page = await attach();
  await until('the session', () => page.evaluate(`window.wicaby?.session.get().then((s) => s.status !== 'no-server' && s.status !== 'connecting')`), 60000, 500);
  const status = await page.evaluate(`wicaby.session.login('Wika', 'wicaby').then((s) => s.status)`);
  if (status !== 'signed-in') throw new Error(`sign-in failed (${status})`);
  // Screenshots of a window that never paints on screen: route changes without a View Transition (it would freeze).
  await page.evaluate(`(() => { Document.prototype.startViewTransition = undefined; document.startViewTransition = undefined; location.hash = '#/home'; return true; })()`);
  return { page, profile, stop: () => (page.close(), stopAll()), app, mock };
}

const sidebarRows = (page, group) => page.evaluate(`[...document.querySelectorAll('#sb-${group} .link')].map((b) => b.textContent.trim())`);
const failures = [];
const expect = (ok, what) => (ok ? log(`ok   ${what}`) : (failures.push(what), log(`FAIL ${what}`)));

async function run() {
  for (const p of [MOCK_PORT, DEV_PORT, CDP_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is busy`);

  // ---- Phase 1: the server has a tuner ----
  {
    const { page } = await launch(true);
    const live = await until('the Live TV rows', async () => ((await sidebarRows(page, 'live')).length === 3 ? sidebarRows(page, 'live') : null), 30000);
    expect(live.join('|') === 'Chaînes|Guide|Enregistrements', `live rows with a tuner: ${live.join(', ')}`);
    const iptv = await sidebarRows(page, 'iptv');
    expect(iptv.join('|') === 'Ajouter une source IPTV', `IPTV row without a source: ${iptv.join(', ')}`);
    await page.shot('desktop-sidebar-with-livetv');
    stopAll();
    await sleep(1500);
  }

  // ---- Phase 2: no tuner, then an IPTV source ----
  const iptvMock = await startMockIptv({ port: 0 });
  const xtream = `http://127.0.0.1:${iptvMock.port}/get.php?username=wika&password=${SECRET}&type=m3u_plus`;
  try {
    const { page, profile } = await launch(false);
    await until('the setup row', async () => (await sidebarRows(page, 'live')).join('|') === 'Configurer', 30000);
    expect(true, 'live group shows "Configurer" without a tuner');
    await page.shot('desktop-sidebar-without-livetv');
    // Rail: both groups keep their rows and the rail tooltip names them.
    await page.evaluate(`wicaby.settings.update({ ui: { sidebarCollapsed: true } }).then(() => true)`).catch(() => undefined);
    await sleep(800);
    const railLabels = await page.evaluate(`[...document.querySelectorAll('#sb-live .link, #sb-iptv .link')].map((b) => b.getAttribute('aria-label'))`);
    expect(railLabels.join('|') === 'Configurer|Ajouter une source IPTV', `rail accessible names: ${railLabels.join(', ')}`);
    await page.shot('desktop-sidebar-rail');
    await page.evaluate(`wicaby.settings.update({ ui: { sidebarCollapsed: false } }).then(() => true)`).catch(() => undefined);

    await page.evaluate(`document.querySelector('#sb-live .link').click()`);
    await until('the setup page', () => page.evaluate(`!!document.querySelector('.setup .row')`));
    const adminLink = await page.evaluate(`document.querySelector('.setup .row .sub')?.textContent`);
    expect(/Emby/.test(adminLink ?? ''), `setup page links the Emby admin page: ${adminLink}`);
    await page.shot('desktop-livetv-setup');

    // IPTV: the add sheet opens on arrival; Escape shows the empty page underneath.
    await page.evaluate(`document.querySelector('#sb-iptv .link').click()`);
    await until('the add sheet', () => page.evaluate(`!!document.querySelector('#iptv-playlist')`));
    await page.shot('desktop-iptv-add-sheet');
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await until('the sheet to close', () => page.evaluate(`!document.querySelector('#iptv-playlist')`));
    await page.shot('desktop-iptv-empty');

    // Add through the sheet (an Xtream-style address with a password in it).
    await page.evaluate(`document.querySelector('.state.empty .btn.primary').click()`);
    await until('the add sheet again', () => page.evaluate(`!!document.querySelector('#iptv-playlist')`));
    await page.evaluate(`(() => { const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }; set('iptv-playlist', ${js(xtream)}); set('iptv-name', 'Mock IPTV'); return true; })()`);
    await page.shot('desktop-iptv-add-sheet-filled');
    await page.evaluate(`document.querySelector('form.body button[type=submit]').click()`);
    await until('the IPTV channels', () => page.evaluate(`location.hash.startsWith('#/iptv') && document.querySelectorAll('.now-list .row, [data-channel], .row').length >= 5`), 40000);
    const rows = await sidebarRows(page, 'iptv');
    expect(rows.join('|') === 'Chaînes|Guide', `IPTV rows with a source: ${rows.join(', ')}`);
    const list = await until('the guide data', () => page.evaluate(`wicaby.iptv.list().then((l) => l[0]?.programmes > 0 ? l : null)`), 60000, 500);
    expect(list[0].channels === 10, `10 channels (${list[0].channels}), ${list[0].programmes} programmes`);
    expect(!JSON.stringify(list).includes(SECRET), 'the source list never carries the address');
    await sleep(1500);
    await page.shot('desktop-iptv-channels');

    await page.evaluate(`document.querySelectorAll('#sb-iptv .link')[1].click()`);
    await until('the guide grid', () => page.evaluate(`location.hash.includes('tab=guide')`));
    await sleep(2500);
    await page.shot('desktop-iptv-guide');
    // group-title is the channel tag: one lens per group, in the "Groupes" picker.
    const lenses = await page.evaluate(`(async () => window.__wicabyLive.storeFor((await wicaby.session.get()).sessions.find((x) => x.server.kind === 'iptv').server.id).lenses.filter((l) => l.kind === 'tag').map((l) => l.tag))()`);
    expect(['Infos', 'Jeunesse', 'Sport'].every((g) => lenses.includes(g)), `group-title lenses: ${lenses.join(', ')}`);
    const sportRows = await page.evaluate(`(async () => { const s = window.__wicabyLive.storeFor((await wicaby.session.get()).sessions.find((x) => x.server.kind === 'iptv').server.id); s.setLens({ kind: 'tag', tag: 'Sport' }); await new Promise((r) => setTimeout(r, 800)); return s.rows.map((r) => r.name); })()`);
    expect(sportRows.join('|') === 'Mock Sport|Mock Sport 2|Mock Arena', `Sport group: ${sportRows.join(', ')}`);
    await page.shot('desktop-iptv-guide-sport');
    // Favourites are kept on this machine (main/iptv state file), through the store's usual toggle.
    const fav = await page.evaluate(`(async () => { const sid = (await wicaby.session.get()).sessions.find((x) => x.server.kind === 'iptv').server.id; const s = window.__wicabyLive.storeFor(sid); await s.prefsReady(); const on = await s.toggleFavorite(s.channels[0].id); const r = await wicaby.api.get('/LiveTv/Channels', {}, sid); return { on, stored: r.Items[0].UserData.IsFavorite }; })()`);
    expect(fav.on === true && fav.stored === true, `favourite kept locally (${JSON.stringify(fav)})`);
    await page.evaluate(`(async () => window.__wicabyLive.storeFor((await wicaby.session.get()).sessions.find((x) => x.server.kind === 'iptv').server.id).setLens({ kind: 'all' }))()`);

    // Play channel 6: its stream answers 403 without the #EXTVLCOPT user agent.
    const ch6 = await page.evaluate(`(async () => { const s = (await wicaby.session.get()).sessions.find((x) => x.server.kind === 'iptv'); const r = await wicaby.api.get('/LiveTv/Channels', {}, s.server.id); return { sid: s.server.id, id: r.Items.find((c) => c.Name === 'Mock Arena').Id }; })()`);
    await page.evaluate(`wicaby.playback.play({ itemIds: [${js(ch6.id)}], serverId: ${js(ch6.sid)} }).then(() => true)`);
    const st = await until('mpv playing the channel', () => page.evaluate(`wicaby.playback.getState().then((s) => s.active && !s.buffering && s.item?.id === ${js(ch6.id)} ? s : null)`), 45000, 500);
    expect(st.playMethod === 'DirectPlay', `IPTV channel plays (${st.playMethod})`);
    expect(iptvMock.state.userAgents.includes('WicabyMock/1.0') && !iptvMock.state.tags.some((t) => t.startsWith('UA-MISSING')), `EXTVLCOPT user agent sent (${iptvMock.state.userAgents.join(' / ')})`);
    await sleep(3000);
    await page.evaluate(`wicaby.playback.command({ type: 'stop' }).then(() => true)`).catch(() => undefined);
    await sleep(1500);

    // Sources screen: the IPTV source among the others, its type in the add sheet.
    await page.evaluate(`location.hash = '#/servers'`);
    await until('the IPTV row', () => page.evaluate(`[...document.querySelectorAll('.row .kind')].some((k) => k.textContent.trim() === 'IPTV')`), 15000);
    await page.shot('desktop-sources-iptv-row');
    await page.evaluate(`location.hash = '#/iptv?tab=now'`);

    // The address stays in the vault: not in sources.json, not in the cache, not in the logs.
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(json|bin|log|txt)$/.test(e.name) && fs.statSync(p).size < 64e6) files.push(p);
      }
    };
    for (const d of ['iptv', 'logs']) if (fs.existsSync(path.join(profile, d))) walk(path.join(profile, d));
    const leaks = files.filter((f) => fs.readFileSync(f).includes(SECRET));
    expect(files.some((f) => f.endsWith('sources.json')) && leaks.length === 0, `no plain address on disk (${files.length} files checked${leaks.length ? `, leaks: ${leaks.join(', ')}` : ''})`);
  } finally {
    stopAll();
    await iptvMock.close();
  }
  log(`screenshots in ${OUT}`);
  if (failures.length) {
    log(`${failures.length} failure(s)`);
    process.exit(1);
  }
  log('ok');
}

run().catch((err) => {
  console.error(err);
  stopAll();
  process.exit(1);
});
