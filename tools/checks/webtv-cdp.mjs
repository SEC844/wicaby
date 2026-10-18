#!/usr/bin/env node
// The web TV app end to end in a headless Edge or Chrome at 1920x1080 (docs/webtv.md), with the TV remote's keys.
//
//   1. Demo build (apps/webtv/dist/demo): the first visit signs in to the demo server with a Demo badge whose button
//      opens the sources page (the demo listed there); Home shows posters; arrow keys and Enter open a film; LG Back (461) returns; Play opens the
//      player and the clip plays; Samsung Back (10009) stops it and the demo server keeps the position.
//   2. TV build (apps/webtv/dist/tv) against mock-emby and mock-jellyfin on 127.0.0.1, behind a CORS front (what a
//      real server must answer, docs/webtv.md): add by address, sign in, Home, play; each mock sees the right
//      auth header (X-Emby-Token / Authorization MediaBrowser Token=), PlaybackInfo with the device profile and
//      the start / stopped reports; the token never shows in the app's log.
//
//   3. The 10-foot look (?tv=webos): drawn at 1.5x, focus ring, scoped styles, remote navigation.
//
// Old Chromium works too (WEBTV_BROWSER=<a Chromium 79 or 85 snapshot>, docs/webtv.md): the checks' own expressions
// are lowered to chrome79, and playback checks are skipped when the browser has no H.264 (Chromium snapshots).
// Not part of run-all: it needs Edge or Chrome (WEBTV_BROWSER=<path> picks one). Nothing leaves loopback, the
// browser is muted. Build first: npm run build:webtv && npm run build:webtv-demo.
//   node tools/checks/webtv-cdp.mjs            (WEBTV_SHOTS=<dir> saves a screenshot per step)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { transformSync } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SHOTS = process.env.WEBTV_SHOTS ? path.resolve(process.env.WEBTV_SHOTS) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond, detail = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  console.log(`[webtv] ${results.at(-1)}`);
};
let h264 = true;
const okPlay = (name, cond, detail) => (h264 ? ok(name, cond, detail) : console.log(`[webtv] SKIP ${name} (no H.264 in this browser)`));
const children = [];
const servers = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-webtv-cdp-'));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.md': 'text/markdown' };
// A static server for a build folder (like GitHub Pages: extension-less image files go out as octet-stream).
async function serveDir(dir) {
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(dir, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    const size = fs.statSync(file).size;
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
      fs.createReadStream(file).pipe(res);
    }
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  servers.push(srv);
  return `http://127.0.0.1:${port}`;
}

// A CORS front for a mock (what Jellyfin does by default; for Emby see docs/webtv.md), logging what the app sends.
async function corsFront(target) {
  const port = await freePort();
  const seen = [];
  const srv = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, OPTIONS' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body.toString('utf8').slice(0, 20_000) });
      const up = http.request(`${target}${req.url}`, { method: req.method, headers: { ...req.headers, host: new URL(target).host } }, (r) => {
        const h = Object.fromEntries(Object.entries(r.headers).filter(([k]) => !k.startsWith('access-control-')));
        res.writeHead(r.statusCode ?? 502, { ...h, ...cors });
        r.pipe(res);
      });
      up.on('error', () => res.writeHead(502, cors).end());
      up.end(body);
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  servers.push(srv);
  return { url: `http://127.0.0.1:${port}`, seen };
}

function browserPath() {
  const list = [
    process.env.WEBTV_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean);
  const hit = list.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('No Edge or Chrome found (set WEBTV_BROWSER)');
  return hit;
}

class Page {
  static async open(port) {
    let targets = [];
    for (let i = 0; i < 100 && !targets.length; i++) {
      targets = await fetch(`http://127.0.0.1:${port}/json`)
        .then((r) => r.json())
        .then((l) => l.filter((t) => t.type === 'page'))
        .catch(() => []);
      if (!targets.length) await sleep(100);
    }
    const p = new Page();
    p.ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    await new Promise((r) => p.ws.addEventListener('open', r));
    p.id = 0;
    p.pending = new Map();
    p.errors = [];
    p.console = [];
    p.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && p.pending.has(m.id)) {
        p.pending.get(m.id)(m);
        p.pending.delete(m.id);
      } else if (m.method === 'Runtime.consoleAPICalled') p.console.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      else if (m.method === 'Runtime.exceptionThrown') p.errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    });
    await p.call('Runtime.enable');
    await p.call('Page.enable');
    await p.call('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    return p;
  }
  call(method, params = {}) {
    return new Promise((r) => {
      const i = ++this.id;
      this.pending.set(i, r);
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  async eval(expression) {
    expression = transformSync(expression, { target: 'chrome79', loader: 'js' }).code;
    const r = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  }
  async until(expression, ms = 15_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.eval(expression).catch(() => false)) return true;
      await sleep(150);
    }
    return false;
  }
  async go(url) {
    await this.call('Page.navigate', { url });
    await sleep(300);
  }
  // A remote key: keyCode as the TV sends it (key as webOS/Tizen name it, else Unidentified).
  async key(keyCode, key = 'Unidentified') {
    for (const type of ['rawKeyDown', 'keyUp']) await this.call('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, key, code: key });
    await sleep(250);
  }
  async shot(name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const r = await this.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  }
}

// Parenthesised: the checks append .includes(...) to it.
const route = '(location.hash.slice(1) || location.pathname)';
const ARROW = { up: [38, 'ArrowUp'], down: [40, 'ArrowDown'], left: [37, 'ArrowLeft'], right: [39, 'ArrowRight'], enter: [13, 'Enter'] };

async function demoScenario(page, base) {
  await page.go(`${base}/index.html`);
  ok('demo: first visit opens signed in to Home', await page.until(`${route}.includes('home')`, 15_000), await page.eval(route).catch(() => '?'));
  ok('demo: Demo badge shown', await page.until(`!document.querySelector('.webtv-demo')?.hidden && /Dem|Dém/.test(document.querySelector('.webtv-demo').textContent)`));
  await page.shot('01-badge');
  await page.eval(`document.querySelector('.webtv-demo button').click()`);
  ok('demo: the badge button opens the sources page', await page.until(`${route}.includes('servers')`), await page.eval(route));
  ok('demo: the demo server is listed', await page.until(`[...document.querySelectorAll('button.row')].some((b) => b.textContent.includes('Wicaby Demo'))`));
  await page.shot('02-servers');
  await page.eval(`[...document.querySelectorAll('button.row')].find((b) => b.textContent.includes('Wicaby Demo')).click()`);
  ok('demo: back to Home', await page.until(`${route}.includes('home')`));
  ok('demo: Home shows posters', await page.until(`[...document.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth > 0).length >= 6`, 20_000), String(await page.eval(`[...document.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth > 0).length`)));
  await sleep(800);
  await page.shot('03-home');
  // Remote: down from the hero into the first row of cards, right once, Enter opens that item.
  await page.eval(`document.activeElement?.blur()`);
  for (let i = 0; i < 8 && !(await page.eval(`!!document.activeElement?.closest('.card')`)); i++) await page.key(...ARROW.down);
  ok('demo: Down reaches a row of cards', await page.eval(`!!document.activeElement?.closest('.card')`), await page.eval(`document.activeElement?.className ?? ''`));
  const first = await page.eval(`document.activeElement?.getBoundingClientRect().left`);
  await page.key(...ARROW.right);
  ok('demo: Right moves along the row', (await page.eval(`document.activeElement?.getBoundingClientRect().left`)) > first);
  await page.key(...ARROW.enter);
  ok('demo: Enter opens an item page', await page.until(`${route}.includes('item/')`, 5000), await page.eval(route));
  await sleep(600);
  await page.shot('04-item');
  await page.key(461, 'GoBack');
  ok('demo: LG Back (461) goes back', await page.until(`!(${route}).includes('item/')`, 5000), await page.eval(route));
  // Play a film from its page.
  await page.eval(`location.hash = '#/item/wicabydemo0000000000000000000001/movie-2'`);
  ok('demo: film page', await page.until(`${route}.includes('movie-2')`));
  await sleep(800);
  await page.until(`[...document.querySelectorAll('button')].some((b) => /^(Play|Lire|Resume|Reprendre)/i.test(b.textContent.trim()))`);
  const played = await page.eval(`(() => { const b = [...document.querySelectorAll('button')].find((b) => /^(Play|Lire|Resume|Reprendre)/i.test(b.textContent.trim())); b?.click(); return !!b; })()`);
  ok('demo: Play button', played);
  ok('demo: the player opens', await page.until(`${route}.includes('player')`));
  okPlay('demo: the clip plays', await page.until(`(document.querySelector('video')?.currentTime ?? 0) > 2`, 20_000), String(await page.eval(`document.querySelector('video')?.currentTime`)));
  okPlay('demo: the Demo badge hides over the player', await page.until(`document.querySelector('.webtv-demo')?.hidden === true`));
  await page.shot('05-player');
  await page.key(10009, 'XF86Back');
  // The first Back may only close the controls; a second one stops.
  if (!(await page.until(`!(${route}).includes('player')`, 2500))) await page.key(10009, 'XF86Back');
  okPlay('demo: Samsung Back (10009) leaves the player for the film page', await page.until(`(${route}).includes('item/')`, 6000), await page.eval(route));
  okPlay('demo: position kept', await page.until(`(JSON.parse(localStorage.getItem('wicaby.demo.userdata') || '{}')['movie-2']?.PlaybackPositionTicks ?? 0) > 10000000`, 5000));
  ok('demo: no uncaught exception', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));

  // Chromium before 88 (webOS 6 and 22, Tizen 6.5) has no aspect-ratio: with it switched off, the fallback
  // (apps/webtv/src/aspect.ts) must still give the posters their height.
  const { result } = await page.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '*{aspect-ratio:auto!important}'; document.head.appendChild(s); });`,
  });
  await page.go(`${base}/index.html?aspect-fallback#/home`);
  ok('demo: posters keep their shape without aspect-ratio', await page.until(`(() => { const c = [...document.querySelectorAll('.card .cover')]; const r = c.map((e) => e.getBoundingClientRect()); return r.length > 3 && r.every((b) => b.height >= b.width * 0.5) && r.filter((b) => b.height > b.width * 1.3).length >= 3; })()`, 15_000));
  await page.shot('06-aspect-fallback');
  await page.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: result.identifier });
}

// The 10-foot look (?tv=webos, what a TV gets): drawn at 1.5x, focus ring on, Svelte's scoped styles kept for
// Chromium 79-85 (apps/webtv/scripts/legacy-css.mjs), remote navigation through it. Runs after the demo sign-in.
async function tvLookScenario(page, base) {
  await page.go(`${base}/index.html?tv=webos#/home`);
  // Cards below the fold load lazily: count them, and the images that did load.
  ok('tv look: Home with cards and artwork', await page.until(`document.documentElement.dataset.tv === 'webos' && document.querySelectorAll('.card').length >= 4 && [...document.querySelectorAll('img')].some((i) => i.complete && i.naturalWidth > 0)`, 20_000));
  ok('tv look: drawn at 1.5x on 1920x1080', await page.eval(`getComputedStyle(document.documentElement).zoom`) === '1.5', await page.eval(`getComputedStyle(document.documentElement).zoom + ' ' + innerWidth`));
  // A scoped component rule (Card.svelte rounds its cover) still applies.
  ok('tv look: component styles apply', await page.eval(`parseFloat(getComputedStyle(document.querySelector('.card .cover') ?? document.body).borderTopLeftRadius) > 0`));
  await sleep(800);
  await page.shot('20-tv-home');
  await page.eval(`document.activeElement?.blur()`);
  for (let i = 0; i < 8 && !(await page.eval(`!!document.activeElement?.closest('.card')`)); i++) await page.key(...ARROW.down);
  const ring = await page.eval(`(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle + ' ' + s.outlineWidth; })()`);
  ok('tv look: focused card shows the ring', /^solid ([3-9]|2\.[5-9])/.test(ring ?? ''), ring); // 3px, snapped at 1.5x
  await sleep(700); // the smooth scroll
  // On screen: rects are in zoomed px (current Chromium) or in CSS px, where the screen is 1080 / 1.5 (Chromium 79-85).
  const onScreen = `(() => { const r = document.activeElement.getBoundingClientRect(); const k = document.documentElement.getBoundingClientRect().width < innerWidth * 0.8 ? 1.5 : 1; return r.top >= 0 && r.bottom <= innerHeight / k + 1 && r.left >= 0 && r.right <= innerWidth / k + 1 ? 'yes' : [r.top, r.bottom, r.left, r.right].map(Math.round).join(' ') + ' k=' + k; })()`;
  const seen = await page.eval(onScreen);
  ok('tv look: focused card is on screen', seen === 'yes', seen);
  await page.shot('21-tv-focus');
  for (let i = 0; i < 6; i++) await page.key(...ARROW.right);
  await sleep(700);
  const seenRight = await page.eval(onScreen);
  ok('tv look: focus stays on screen along a row', seenRight === 'yes', seenRight);
  await page.key(...ARROW.enter);
  ok('tv look: Enter opens an item', await page.until(`${route}.includes('item/')`, 5000), await page.eval(route));
  const bd = `(() => { const i = document.querySelector('.sharp img'); if (!i) return 'none'; const r = i.getBoundingClientRect(); const s = getComputedStyle(i); const p = getComputedStyle(i.parentElement); return ['loaded ' + i.naturalWidth, 'opacity ' + s.opacity + '/' + p.opacity, 'height ' + Math.round(r.height)].join(', '); })()`;
  ok('tv look: item backdrop shows', await page.until(`(() => { const i = document.querySelector('.sharp img'); return !!i && i.naturalWidth > 0 && +getComputedStyle(i).opacity > 0.9 && +getComputedStyle(i.parentElement).opacity > 0.9 && i.getBoundingClientRect().height > 300; })()`, 8000), await page.eval(bd));
  await page.shot('22-tv-item');
  // Viewport units are corrected for the zoom: the Play button is on the first screen.
  // Old Chromium reports rects in unzoomed px, new in zoomed px: either way the bottom is within 1080 / 1.5.
  const fold = `(() => { const b = [...document.querySelectorAll('button')].find((b) => /^(Play|Resume)/.test(b.textContent.trim())); return b ? Math.round(b.getBoundingClientRect().bottom) : -1; })()`;
  const bottom = await page.eval(fold);
  ok('tv look: Play is on the first screen', bottom > 0 && bottom <= (await page.eval('document.documentElement.clientHeight')) / 1.5, String(bottom));
  await page.key(...ARROW.down);
  await page.shot('23-tv-item-focus');
  await page.key(10009, 'XF86Back');
  ok('tv look: Samsung Back (10009) returns Home', await page.until(`(${route}).includes('home')`, 5000), await page.eval(route));
  ok('tv look: no uncaught exception', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
}

async function mockScenario(page, base, kind) {
  const port = await freePort();
  const script = path.join(ROOT, 'tools/mock-server', kind === 'emby' ? 'mock-emby.mjs' : 'mock-jellyfin.mjs');
  const mock = spawn(process.execPath, [script, String(port), path.join(ROOT, 'apps/webtv/demo/demo.mp4')], { env: { ...process.env, MOCK_HOST: '127.0.0.1', MOCK_DURATION_S: '30' }, stdio: 'ignore' });
  children.push(mock);
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${port}/System/Info/Public`).then((r) => r.ok, () => false)) break;
    await sleep(100);
  }
  const front = await corsFront(`http://127.0.0.1:${port}`);
  await page.go(`${base}/index.html`);
  await page.eval(`localStorage.clear()`);
  await page.go(`${base}/index.html`);
  await page.until(`${route}.includes('servers')`);
  const added = await page.eval(`window.wicaby.servers.add(${JSON.stringify(front.url)}).then((s) => s.kind)`);
  ok(`${kind}: added by address`, added === kind, added);
  const id = await page.eval(`window.wicaby.servers.list().then((l) => l[0].id)`);
  await page.eval(`window.wicaby.servers.select(${JSON.stringify(id)})`);
  const st = await page.eval(`window.wicaby.session.login('Wika', 'wicaby', ${JSON.stringify(id)}).then((s) => s.status)`);
  ok(`${kind}: signs in`, st === 'signed-in', st);
  await page.eval(`location.hash = '#/home'`);
  ok(`${kind}: Home loads`, await page.until(`document.querySelectorAll('.card, [data-card]').length > 3 || document.querySelectorAll('img').length > 3`, 15_000));
  await page.shot(`10-${kind}-home`);
  // The app's API calls after sign-in (the address probe and images go without: plain requests, no token).
  const authed = front.seen.filter((r) => r.headers.accept?.includes('json') && !/\/(System\/Info\/Public|Users\/Public|Users\/AuthenticateByName)/.test(r.url));
  const header = (r) => (kind === 'emby' ? r.headers['x-emby-token'] : /Token="/.test(r.headers.authorization ?? ''));
  const bare = authed.filter((r) => !header(r)).map((r) => r.url.split('?')[0]);
  ok(`${kind}: auth header on API calls`, authed.length > 0 && bare.length === 0, `${authed.length} calls${bare.length ? `, without: ${bare.slice(0, 4).join(' ')}` : ''}`);
  if (kind === 'emby') ok('emby: /emby prefix', authed.every((r) => r.url.startsWith('/emby/')));
  else ok('jellyfin: no /emby prefix', authed.every((r) => !r.url.startsWith('/emby/')));
  // Play the first film.
  const uid = await page.eval(`JSON.parse(localStorage.getItem('wicaby.web.servers'))[0].userId`);
  const films = kind === 'emby' ? `'/Users/${uid}/Items', {` : `'/Items', { userId: '${uid}',`;
  const film = await page.eval(`window.wicaby.api.get(${films} IncludeItemTypes: 'Movie', Recursive: true, Limit: 1 }).then((r) => r.Items[0].Id)`);
  await page.eval(`window.wicaby.playback.play({ itemIds: [${JSON.stringify(film)}] })`);
  ok(`${kind}: the player opens`, await page.until(`${route}.includes('player')`));
  const info = front.seen.find((r) => r.url.includes('/PlaybackInfo'));
  ok(`${kind}: PlaybackInfo with a device profile`, Boolean(info && JSON.parse(info.body || '{}').DeviceProfile?.DirectPlayProfiles?.length));
  okPlay(`${kind}: the stream plays`, await page.until(`(document.querySelector('video')?.currentTime ?? 0) > 1.5`, 20_000), String(await page.eval(`document.querySelector('video')?.currentTime`)));
  okPlay(`${kind}: start reported`, await page.until(`true`) && front.seen.some((r) => r.method === 'POST' && /\/Sessions\/Playing$/.test(r.url.split('?')[0])));
  await page.shot(`11-${kind}-player`);
  await page.key(461, 'GoBack');
  if (!(await page.until(`!(${route}).includes('player')`, 2500))) await page.key(461, 'GoBack');
  await page.until(`!(${route}).includes('player')`, 6000);
  await sleep(800);
  okPlay(`${kind}: stop reported`, front.seen.some((r) => r.method === 'POST' && r.url.split('?')[0].endsWith('/Sessions/Playing/Stopped')));
  const token = await page.eval(`JSON.parse(localStorage.getItem('wicaby.web.servers'))[0].token`);
  ok(`${kind}: token not in the console log`, Boolean(token) && !page.console.join(' ').includes(token), `${page.console.length} lines`);
  mock.kill();
}

const browser = browserPath();
const cdpPort = await freePort();
const b = spawn(browser, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(tmp, 'profile')}`, '--window-size=1920,1080', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
children.push(b);
try {
  const page = await Page.open(cdpPort);
  h264 = await page.eval(`document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') !== ''`);
  const demoDir = path.join(ROOT, 'apps/webtv/dist/demo');
  if (fs.existsSync(demoDir)) {
    const demo = await serveDir(demoDir);
    await demoScenario(page, demo);
    await tvLookScenario(page, demo);
  }
  else ok('demo build present (npm run build:webtv-demo)', false);
  const tvDir = path.join(ROOT, 'apps/webtv/dist/tv');
  if (fs.existsSync(tvDir)) {
    const base = await serveDir(tvDir);
    for (const kind of ['emby', 'jellyfin']) await mockScenario(page, base, kind);
  } else ok('TV build present (npm run build:webtv)', false);
} catch (err) {
  ok('run', false, String(err?.stack ?? err));
} finally {
  for (const c of children) c.kill();
  for (const s of servers) s.close();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(`\nwebtv-cdp: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
