#!/usr/bin/env node
// First-run setup and Settings > Remote access, end to end through the desktop app (onboarding spec OB-D1..D4).
//
//   1. A fresh profile opens /welcome on step 1; English relabels it; OLED and pink apply and persist;
//      the LAN card plus a loopback address reaches step 4; Add Another Server goes back with one session;
//      signing in reaches step 5 without visiting /home; Done marks the setup as done.
//   2. Run Setup Again opens /welcome?rerun=1; the public card warns about http:// to an Internet host;
//      Done returns to /settings.
//   3. Remote access, served by the dev-only VPN fixture (WICABY_VPN_FIXTURE): the five states with their
//      label and actions, peers online first with the server badge of the fixture peer that runs a mock on
//      127.0.0.1:8096, routes, Copy Diagnostics without any fixture address or key, and the status popover's
//      VPN row leading to the pane.
//   4. A second fresh profile: Skip Setup lands on /servers with onboarded:true.
//   5. A profile whose settings.json predates the setup never shows /welcome.
//
// Not part of run-all: it needs Electron. Nothing leaves loopback (UDP discovery is held to loopback, the
// public address is typed, never sent). No VPN, no audio.
//
//   node tools/checks/onboarding-cdp.mjs        (ONB_SHOTS=<dir> saves a screenshot of each step, app window only)
//
// Runs the built app (npm run build in apps/desktop first). Ports: ONB_MOCK_PORT (8875), ONB_CDP_PORT (9775),
// and 8096 for the fixture peer's mock. Exit 1 on any failure.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const MOCK_PORT = Number(process.env.ONB_MOCK_PORT ?? 8875);
const PEER_PORT = 8096;
const CDP_PORT = Number(process.env.ONB_CDP_PORT ?? 9775);
const SHOTS = process.env.ONB_SHOTS ? path.resolve(process.env.ONB_SHOTS) : null;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-onb-'));
const FIXTURE = path.join(TMP, 'vpn-fixture.json');
const FR = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'src/renderer/locales/fr/shell.json'), 'utf8')).status.vpn;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[onb]', ...m);
const js = JSON.stringify;
const results = [];
const ok = (name, cond, detail = '') => (results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`), log(results.at(-1)));

const children = [];
function start(cmd, argv, opts) {
  const c = spawn(cmd, argv, { stdio: process.env.ONB_VERBOSE ? ['ignore', 'inherit', 'inherit'] : 'ignore', windowsHide: true, ...opts });
  children.push(c);
  return c;
}
function kill(c) {
  if (c.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(c.pid)], { stdio: 'ignore' });
  else c.kill('SIGKILL');
}
async function until(what, fn, timeoutMs = 20000, every = 150) {
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

// Preloaded into main: loopback-only UDP (server discovery), and windows that never take focus or the mouse.
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
const guardFile = path.join(TMP, 'guard.cjs');
fs.writeFileSync(guardFile, GUARD);

// The dev-only VPN fixture: Wicaby's own NetBird node in `state`. Documentation addresses only; the online peer
// "nas" is 127.0.0.1, where the peer mock answers on 8096; "laptop" has only an IPv6 address (never probed).
function writeFixture(state) {
  const on = state === 'connected';
  fs.writeFileSync(
    FIXTURE,
    js({
      status: [
        { kind: 'tailscale', state: 'not-installed', ips: [] },
        { kind: 'netbird', state: 'not-installed', ips: [] },
        {
          kind: 'embedded',
          provider: 'netbird',
          state,
          selfName: 'wicaby-test',
          selfDnsName: on ? 'wicaby-test.netbird.example' : undefined,
          ips: on ? ['100.64.0.10'] : [],
          managementUrl: 'https://netbird.example.com',
          routes: on ? ['192.0.2.0/24'] : undefined,
          authUrl: state === 'needs-login' ? 'https://app.netbird.io/device?user_code=ABCD-EFGH' : undefined,
          error: state === 'error' ? 'management: 401 Unauthorized' : undefined,
          lastError: { message: 'management: 401 Unauthorized, setup key 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', at: Date.now() - 60_000 },
        },
      ],
      peers: {
        embedded: [
          { kind: 'embedded', name: 'phone', ips: ['100.64.0.12'], online: false, os: 'android', servers: [] },
          { kind: 'embedded', name: 'laptop', ips: ['fd7a:115c:a1e0::9'], online: true, os: 'windows', servers: [] },
          { kind: 'embedded', name: 'nas', ips: ['127.0.0.1'], online: true, os: 'linux', servers: [] },
        ],
      },
      log: ['netbird: dial 192.0.2.7:443 for nas.netbird.example', 'netbird: login with tskey-auth-k1234567890abcdef', 'peer 100.64.0.11 connected'],
    }),
  );
}
const LEAKS = /100\.64\.0\.|192\.0\.2\.|127\.0\.0\.1|0a1b2c3d|tskey-auth-k|ABCD-EFGH|netbird\.example|wicaby-test|\bnas\b|\blaptop\b|\bphone\b/;

async function attach() {
  const page = await until('page', async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === 'page' && /^(app:|http:\/\/localhost)/.test(t.url) && !t.url.includes('osd=1')), 90000, 300);
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

async function launch(profile, env = {}) {
  const app = start(createRequire(path.join(DESKTOP, 'package.json'))('electron'), ['.', `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: DESKTOP,
    env: { ...process.env, WICABY_DEV_URL: '', WICABY_VPN_FIXTURE: '', ...env, NODE_OPTIONS: `--require "${guardFile.replaceAll('\\', '/')}"` },
  });
  const page = await attach();
  await until('app ready', () => page.evaluate(`!!window.wicaby && !!document.querySelector('#app > *')`), 60000, 300);
  return { app, page };
}
async function close({ app, page }) {
  page.close();
  kill(app);
  await until('cdp port free', async () => !(await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(() => true, () => false)), 15000, 300).catch(() => undefined);
}

// Page helpers (run in the renderer).
const HELPERS = `
  window.$q = (s) => document.querySelector(s);
  window.$click = (s) => { const e = document.querySelector(s); if (!e) throw new Error('no ' + s); e.click(); return true; };
  window.$clickText = (s, text) => { const e = [...document.querySelectorAll(s)].find((x) => x.textContent.trim() === text); if (!e) throw new Error('no ' + s + ' ' + text); e.click(); return true; };
  window.$type = (s, v) => { const e = document.querySelector(s); if (!e) throw new Error('no ' + s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); return true; };
  window.__hashes = window.__hashes ?? [];
  if (!window.__hashWatch) { window.__hashWatch = true; addEventListener('hashchange', () => window.__hashes.push(location.hash)); }
  true;
`;
const step = (page, n) => until(`step ${n}`, () => page.evaluate(`!!document.querySelector('.card[data-step="${n}"]')`), 20000);
async function shot(page, name) {
  if (!SHOTS) return;
  await sleep(700);
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from((await page.call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
}
const settingsFile = (profile) => JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
const remoteState = (page, state) => until(`remote pane ${state}`, () => page.evaluate(`document.querySelector('.remote-pane')?.dataset.state === ${js(state)}`), 15000);
async function openRemote(page) {
  await page.evaluate(`location.hash = '#/home'`);
  await sleep(400);
  await page.evaluate(`location.hash = '#/settings?pane=remote'`);
}
const actions = (page) => page.evaluate(`[...document.querySelectorAll('.remote-pane [data-action]')].map((b) => b.dataset.action).join(',')`);

async function addLoopbackServer(page) {
  await page.evaluate(`$click('[data-where="lan"]')`);
  await until('address field', () => page.evaluate(`!!$q('.embed form input.field')`));
  await page.evaluate(`$type('.embed form input.field', ${js(`http://127.0.0.1:${MOCK_PORT}`)})`);
}

async function run() {
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(MOCK_PORT)], { cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '' } });
  start(process.execPath, [path.join(ROOT, 'tools', 'mock-server', 'mock-emby.mjs'), String(PEER_PORT)], {
    cwd: ROOT,
    env: { ...process.env, NODE_OPTIONS: '', MOCK_SERVER_ID: 'f0e1d2c3b4a5968778695a4b3c2d1e0f', MOCK_NAME: 'Peer Mock' },
  });
  await until('mock', async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/emby/System/Info/Public`)).ok);
  await until('peer mock', async () => (await fetch(`http://127.0.0.1:${PEER_PORT}/emby/System/Info/Public`)).ok);
  writeFixture('connected');

  // ---- 1. Fresh profile, the whole setup ----
  const fresh = path.join(TMP, 'fresh');
  fs.mkdirSync(fresh);
  let s = await launch(fresh, { WICABY_VPN_FIXTURE: FIXTURE });
  let p = s.page;
  await until('welcome', () => p.evaluate(`location.hash === '#/welcome'`), 20000);
  await p.evaluate(HELPERS);
  await step(p, 1);
  ok('fresh profile shows /welcome step 1', true);
  await p.evaluate(`$clickText('.card .seg button', 'English')`);
  await sleep(300);
  const en = await p.evaluate(`$q('.card h1').textContent`);
  await p.evaluate(`$clickText('.card .seg button', 'Français')`);
  await sleep(300);
  const fr = await p.evaluate(`$q('.card h1').textContent`);
  ok('English relabels the page', en === 'Welcome to Wicaby' && fr === 'Bienvenue dans Wicaby', `${en} / ${fr}`);
  await shot(p, 'desktop-1-welcome');

  await p.evaluate(`$click('[data-action="start"]')`);
  await step(p, 2);
  await p.evaluate(`$click('[data-theme-card="oled"]')`);
  await p.evaluate(`$click('[data-accent-swatch="pink"]')`);
  await sleep(800);
  const html = await p.evaluate(`document.documentElement.dataset.theme + ' ' + document.documentElement.dataset.accent`);
  let file = settingsFile(fresh);
  ok('OLED and pink apply and persist', html === 'oled pink' && file.ui.theme === 'oled' && file.ui.accent === 'pink', `${html}, file ${file.ui.theme} ${file.ui.accent}`);
  await shot(p, 'desktop-2-look');

  await p.evaluate(`$click('[data-action="continue"]')`);
  await step(p, 3);
  await addLoopbackServer(p);
  await shot(p, 'desktop-3-where');
  await p.evaluate(`$click('.embed form button[type="submit"]')`);
  await step(p, 4);
  await until('users', () => p.evaluate(`!!$q('.card [data-user="u-wika"]')`));
  ok('LAN card and a loopback address reach step 4', await p.evaluate(`location.hash === '#/welcome'`));
  await shot(p, 'desktop-4-signin');

  await p.evaluate(`$click('[data-action="add-another"]')`);
  await step(p, 3);
  const sessions = await p.evaluate(`wicaby.session.get().then((x) => x.sessions.length)`);
  ok('Add Another Server returns to step 3 with one session', sessions === 1, `sessions ${sessions}`);

  await addLoopbackServer(p);
  await p.evaluate(`$click('.embed form button[type="submit"]')`);
  await step(p, 4);
  await until('users', () => p.evaluate(`!!$q('.card [data-user="u-wika"]')`));
  await p.evaluate(`$click('.card [data-user="u-wika"]')`);
  await until('password sheet', () => p.evaluate(`!!$q('.sheet input[type="password"]')`));
  await p.evaluate(`$type('.sheet input[type="password"]', 'wicaby')`);
  await p.evaluate(`$click('.sheet button[type="submit"]')`);
  await step(p, 5);
  const hashes = await p.evaluate(`window.__hashes.join(' ')`);
  ok('signing in reaches step 5 without /home', !hashes.includes('#/home') && (await p.evaluate(`location.hash`)) === '#/welcome', hashes || 'no hash change');
  await shot(p, 'desktop-5-extras');

  await p.evaluate(`$click('[data-action="continue"]')`);
  await step(p, 6);
  await until('done list', () => p.evaluate(`!!$q('.card[data-step="6"] .row')`), 10000).catch(() => undefined);
  await shot(p, 'desktop-6-done');
  await p.evaluate(`$click('[data-action="finish"]')`);
  await until('home', () => p.evaluate(`location.hash === '#/home'`), 15000);
  await sleep(500);
  file = settingsFile(fresh);
  ok('Start Watching marks the setup done and opens the app', file.ui.onboarded === true, `onboarded ${file.ui.onboarded}`);

  // ---- 2. Run Setup Again ----
  await p.evaluate(`location.hash = '#/settings'`);
  await until('general pane', () => p.evaluate(`!!$q('[data-action="rerun-setup"]')`));
  await p.evaluate(`$click('[data-action="rerun-setup"]')`);
  await until('rerun', () => p.evaluate(`location.hash === '#/welcome?rerun=1'`));
  await p.evaluate(HELPERS);
  await step(p, 1);
  ok('Run Setup Again opens /welcome?rerun=1', true);
  await p.evaluate(`$click('[data-action="start"]')`);
  await step(p, 2);
  await p.evaluate(`$click('[data-action="continue"]')`);
  await step(p, 3);
  const hasContinue = await p.evaluate(`!!$q('[data-action="continue"]')`);
  await p.evaluate(`$click('[data-where="public"]')`);
  await until('public field', () => p.evaluate(`!!$q('.embed form input.field')`));
  await p.evaluate(`$type('.embed form input.field', 'http://media.example.com')`);
  await sleep(200);
  const caution = await p.evaluate(`!!$q('.embed .caution')`);
  await p.evaluate(`$type('.embed form input.field', 'https://media.example.com')`);
  await sleep(200);
  const noCaution = !(await p.evaluate(`!!$q('.embed .caution')`));
  ok('rerun step 3 offers Continue; http:// to an Internet host shows the caution', hasContinue && caution && noCaution, `continue ${hasContinue}, caution ${caution}, https quiet ${noCaution}`);
  await p.evaluate(`$type('.embed form input.field', 'http://media.example.com')`);
  await shot(p, 'desktop-3b-where-public');
  await p.evaluate(`$click('[data-action="continue"]')`);
  await step(p, 5);
  await p.evaluate(`$click('[data-action="continue"]')`);
  await step(p, 6);
  await p.evaluate(`$click('[data-action="finish"]')`);
  ok('Done after a rerun returns to /settings', await until('settings', () => p.evaluate(`location.hash === '#/settings'`), 10000).catch(() => false));

  // ---- 3. Remote access with the fixture ----
  await openRemote(p);
  await remoteState(p, 'connected');
  ok('/settings?pane=remote opens the pane', true);
  const order = await p.evaluate(`[...document.querySelectorAll('.remote-pane [data-peer]')].map((r) => r.dataset.peer + ':' + r.dataset.online).join(' ')`);
  ok('peers online first', /^(laptop|nas):true (laptop|nas):true phone:false$/.test(order), order);
  await p.evaluate(`$click('[data-action="find-servers"]')`);
  const badge = await until('server badge', () => p.evaluate(`document.querySelector('.remote-pane [data-peer="nas"] [data-server]')?.textContent`), 15000).catch(() => null);
  const laptopBadge = await p.evaluate(`!!$q('.remote-pane [data-peer="laptop"] [data-server]')`);
  ok('Find Servers badges the peer that runs a server', badge === 'Emby · Peer Mock' && !laptopBadge, `${badge}, laptop ${laptopBadge}`);
  const routes = await p.evaluate(`$q('.remote-pane [data-routes]')?.textContent.trim()`);
  ok('routes show for NetBird', routes === '192.0.2.0/24', routes);
  await shot(p, 'desktop-remote-connected');
  await p.evaluate(`navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; true`);
  await p.evaluate(`$click('[data-action="copy-diagnostics"]')`);
  const diag = await until('diagnostics', () => p.evaluate(`window.__copied`), 10000);
  ok('Copy Diagnostics leaves no fixture address, key or name', diag.startsWith('Wicaby ') && diag.includes('state: connected') && !LEAKS.test(diag), diag.match(LEAKS)?.[0] ?? `${diag.split('\n').length} lines`);

  const expected = {
    connected: [FR.connected, ['turn-off', 'sign-out', 'switch']],
    'needs-login': [FR.needsLogin, ['sign-in', 'sign-out', 'switch']],
    connecting: [FR.connecting, ['turn-off', 'sign-out', 'switch']],
    error: [FR.error, ['retry', 'turn-off', 'sign-out', 'switch']],
    stopped: [FR.off, []],
  };
  for (const [state, [label, acts]] of Object.entries(expected)) {
    writeFixture(state);
    await openRemote(p);
    await remoteState(p, state);
    const shown = await p.evaluate(`$q('.remote-pane [data-label]')?.textContent.trim()`);
    const got = (await actions(p)).split(',').filter((a) => !['copy-diagnostics', 'change', 'find-servers', 'add'].includes(a));
    const panel = await p.evaluate(`!!$q('.remote-pane .panel')`);
    ok(`state ${state}: label and actions`, shown === label && acts.every((a) => got.includes(a)) && (state !== 'stopped' || panel), `${shown}; ${got.join(' ')}${state === 'stopped' ? `; sign-in panel ${panel}` : ''}`);
    if (state === 'error') await shot(p, 'desktop-remote-error');
  }

  writeFixture('connected');
  await p.evaluate(`location.hash = '#/home'`);
  await until('sidebar', () => p.evaluate(`!!$q('.trigger[aria-controls="connection-status"]')`), 15000);
  await sleep(500);
  await p.evaluate(`$click('.trigger[aria-controls="connection-status"]')`);
  const vpnRow = await until('popover vpn row', () => p.evaluate(`[...document.querySelectorAll('#connection-status .row')].some((r) => r.textContent.includes('NetBird'))`), 8000).catch(() => false);
  if (vpnRow) await p.evaluate(`[...document.querySelectorAll('#connection-status .row')].find((r) => r.textContent.includes('NetBird')).click(); true`);
  ok('the popover VPN row opens Remote access', vpnRow && (await remoteState(p, 'connected').then(() => true, () => false)));
  await close(s);

  // ---- 4. Skip on a fresh profile ----
  const skip = path.join(TMP, 'skip');
  fs.mkdirSync(skip);
  s = await launch(skip);
  p = s.page;
  await until('welcome', () => p.evaluate(`location.hash === '#/welcome'`), 20000);
  await p.evaluate(HELPERS);
  await p.evaluate(`$click('[data-action="skip"]')`);
  await until('servers', () => p.evaluate(`location.hash === '#/servers'`), 10000).catch(() => undefined);
  await sleep(600);
  ok('Skip lands on /servers with onboarded:true', (await p.evaluate(`location.hash`)) === '#/servers' && settingsFile(skip).ui.onboarded === true);
  await close(s);

  // ---- 5. An install from before the setup ----
  const old = path.join(TMP, 'old');
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, 'settings.json'), js({ ui: { language: 'fr', theme: 'dark' } }));
  s = await launch(old);
  p = s.page;
  await until('servers', () => p.evaluate(`location.hash === '#/servers'`), 20000).catch(() => undefined);
  await sleep(1500);
  const where = await p.evaluate(`location.hash`);
  const onb = await p.evaluate(`wicaby.settings.get().then((x) => x.ui.onboarded)`);
  ok('settings.json without onboarded never shows /welcome', where === '#/servers' && onb === true, `${where}, onboarded ${onb}`);
  await close(s);
}

let code = 1;
try {
  await run();
  code = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
} catch (e) {
  console.error('[onb] error', e.message);
}
console.log(results.join('\n'));
for (const c of children) kill(c);
await sleep(800);
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {}
process.exit(code);
