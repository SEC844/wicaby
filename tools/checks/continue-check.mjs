// Continue Watching and Emby correctness check (docs/specs/feature-specs.md X-01). No network beyond loopback.
//  1. mergeContinue (apps/desktop/src/renderer/lib/continue.ts) on fixtures: one card per series, positionless
//     Resume rows moved to next up, newest LastPlayedDate first, undated cards after in server order; the hide list
//     (hidden until played again, capped at 500, oldest out).
//  2. Socket ordering (apps/desktop/src/main/connection/server-socket.ts) with a stubbed WebSocket and client: the
//     socket opens only after the capabilities POST resolves, fails or times out, and every reconnect posts again.
//  3. The Emby mock (tools/mock-server/mock-emby.mjs): Resume mixes a positionless row, HideFromResume hides and
//     un-hides, playing an item again brings it back.
//  4. Grep guard: apps/ never calls /Items/Filters (404 on Emby), /Users/Me (500 on Emby) or /Audio/{id}/Lyrics.
// Usage: node tools/checks/continue-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (cond, msg) => (assert.ok(cond, msg), passed++);

// ---- 1. Merge and hide list ----
const C = await import(pathToFileURL(path.join(root, 'apps/desktop/src/renderer/lib/continue.ts')).href);
const S = 'srv';
const ep = (id, series, pos, played) => ({ Id: id, Type: 'Episode', ServerId: S, SeriesId: series, UserData: { PlaybackPositionTicks: pos, LastPlayedDate: played } });
const movie = (id, pos, played) => ({ Id: id, Type: 'Movie', ServerId: S, UserData: { PlaybackPositionTicks: pos, LastPlayedDate: played } });
const ids = (list) => list.map((x) => x.Id).join(',');

// Episode 4 in progress, episode 5 next up: one card, episode 4.
ok(ids(C.mergeContinue([ep('e4', 'A', 100, '2026-10-01T10:00:00Z')], [ep('e5', 'A', 0)], new Map())) === 'e4', 'series in progress keeps one card (the episode in progress)');

const resume = [
  movie('m1', 50, '2026-10-02T10:00:00Z'),
  ep('b3', 'B', 70, '2026-10-05T10:00:00Z'),
  movie('m2', 10), // in progress, no date
  ep('c1', 'C', 0), // Emby mixes a positionless row in: next-up material
];
const nextUp = [ep('b4', 'B', 0), ep('d2', 'D', 0), ep('c1', 'C', 0), ep('e1', 'E', 0), ep('f1', 'F', 0)];
const series = new Map([
  [`${S}:D`, '2026-10-04T10:00:00Z'],
  [`${S}:C`, '2026-10-03T10:00:00Z'],
  // E: null LastPlayedDate on the server (absent here); F: unknown series.
]);
const merged = C.mergeContinue(resume, nextUp, series);
ok(ids(merged) === 'b3,d2,c1,m1,m2,e1,f1', `newest first, undated after in server order (got ${ids(merged)})`);
ok(C.recency(merged[1], series) === '2026-10-04T10:00:00Z', 'a next-up card sorts by its series LastPlayedDate');
ok(merged.filter((x) => x.Id === 'c1').length === 1, 'a positionless Resume row also in next up shows once');
ok(C.mergeContinue([], [], new Map()).length === 0, 'empty input');

let hidden = C.withHidden([], 'srv:u:m1', '2026-10-02T10:00:00Z');
ok(C.isHidden(hidden, 'srv:u:m1', '2026-10-02T10:00:00Z'), 'hidden while the date is unchanged');
ok(!C.isHidden(hidden, 'srv:u:m1', '2026-10-06T10:00:00Z'), 'back once played again');
ok(!C.isHidden(hidden, 'srv:u:other', ''), 'other items unaffected');
ok(C.isHidden(C.withHidden([], 'k', ''), 'k', ''), 'an undated card stays hidden until it gets a date');
ok(C.withoutHidden(hidden, 'srv:u:m1').length === 0, 'undo removes the entry');
for (let i = 0; i < 520; i++) hidden = C.withHidden(hidden, `k${i}`, '');
ok(hidden.length === C.HIDE_CAP && hidden[0].key === 'k20' && hidden.at(-1).key === 'k519', 'capped at 500, oldest evicted');
ok(C.hiddenKey({ Id: 'i', ServerId: 's' }, 'u') === 's:u:i', 'key is serverId:userId:itemId');

// ---- 2. Socket ordering ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-continue-check-'));
const out = path.join(dir, 'server-socket.mjs');
await build({
  entryPoints: [path.join(root, 'apps/desktop/src/main/connection/server-socket.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'error',
  packages: 'external',
  plugins: [
    {
      name: 'stubs',
      setup(b) {
        b.onResolve({ filter: /^electron$|\/i18n$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
          contents: a.path === 'electron' ? 'export const net = {}; export const app = { getLocale: () => "fr", on() {} };' : 'export const t = (k) => k;',
        }));
      },
    },
  ],
});
const { ServerSocket } = await import(pathToFileURL(out).href);
const events = [];
const sockets = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  readyState = 0;
  constructor(url) {
    this.url = url;
    this.listeners = {};
    events.push('ws');
    sockets.push(this);
    setTimeout(() => ((this.readyState = 1), this.fire('open')), 5);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type, ev = {}) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
  send() {}
  close() {
    this.readyState = 3;
    this.fire('close');
  }
};

async function scenario(caps, waitMs) {
  events.length = 0;
  sockets.length = 0;
  const s = new ServerSocket('http://127.0.0.1:1', 'emby', 'token', 'device', caps);
  s.open();
  await sleep(waitMs);
  return s;
}
// Resolves late: the socket waits for it.
let s = await scenario(async () => {
  events.push('caps');
  await sleep(150);
  events.push('caps-done');
}, 60);
ok(events.join() === 'caps', `no socket before the capabilities POST resolves (${events})`);
await sleep(200);
ok(events.join() === 'caps,caps-done,ws', `socket after the POST (${events})`);
// Killed: the reconnect (1 s back-off) posts again first.
sockets[0].fire('close');
await sleep(1300);
ok(events.join() === 'caps,caps-done,ws,caps,caps-done,ws', `reconnect posts capabilities again (${events})`);
s.close();
// A failing POST still opens the socket.
s = await scenario(async () => {
  events.push('caps');
  throw new Error('HTTP 500');
}, 60);
ok(events.join() === 'caps,ws', `failed POST still connects (${events})`);
s.close();
// A POST that never answers: the socket opens after the timeout.
ServerSocket.beforeConnectTimeoutMs = 200;
s = await scenario(() => (events.push('caps'), new Promise(() => {})), 100);
ok(events.join() === 'caps', 'waits for the timeout');
await sleep(250);
ok(events.join() === 'caps,ws', `opens after the timeout (${events})`);
s.close();
// Closed while the POST is pending: no socket.
s = await scenario(() => (events.push('caps'), sleep(100)), 10);
s.close();
await sleep(150);
ok(events.join() === 'caps', 'closed during the POST: no socket');
fs.rmSync(dir, { recursive: true, force: true });

// ---- 3. Emby mock ----
const E = await import(pathToFileURL(path.join(root, 'tools/mock-server/mock-emby.mjs')).href);
E.hooks.log = () => {};
const server = http.createServer(E.handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/emby`;
const login = await fetch(`${base}/Users/AuthenticateByName`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="checks", Device="c", DeviceId="continue-check", Version="1"' },
  body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }),
}).then((r) => r.json());
const H = { 'X-Emby-Token': login.AccessToken, 'Content-Type': 'application/json' };
const uid = login.User.Id;
const api = (method, p, body) => fetch(`${base}${p}`, { method, headers: H, body: body && JSON.stringify(body) });
const resumeIds = async () => (await (await api('GET', `/Users/${uid}/Items/Resume?MediaTypes=Video&Limit=24`)).json()).Items.map((x) => x.Id);
const r0 = await (await api('GET', `/Users/${uid}/Items/Resume?MediaTypes=Video&Limit=24`)).json();
ok(r0.Items.some((x) => !x.UserData.PlaybackPositionTicks), 'mock Resume mixes a row without a position');
const n0 = (await (await api('GET', `/Shows/NextUp?UserId=${uid}`)).json()).Items;
const mockMerged = C.mergeContinue(r0.Items, n0, new Map());
ok(ids(mockMerged) === 'ep-1-3,movie-2', `mock: one card for series-1, newest first (got ${ids(mockMerged)})`);
const sd = (await (await api('GET', `/Users/${uid}/Items?Ids=series-1&Fields=UserData`)).json()).Items;
ok(sd.length === 1 && sd[0].UserData && !sd[0].UserData.LastPlayedDate, 'mock series UserData has a null LastPlayedDate');
ok((await api('POST', `/Users/${uid}/Items/movie-2/HideFromResume?Hide=true`)).ok, 'HideFromResume answers');
ok(!(await resumeIds()).includes('movie-2'), 'hidden from Resume');
ok((await api('POST', `/Users/${uid}/Items/movie-2/HideFromResume?Hide=false`)).ok && (await resumeIds()).includes('movie-2'), 'Hide=false brings it back');
await api('POST', `/Users/${uid}/Items/movie-2/HideFromResume?Hide=true`);
ok((await api('POST', '/Sessions/Playing', { ItemId: 'movie-2', PlaySessionId: 'x' })).status === 204 && (await resumeIds()).includes('movie-2'), 'playing again brings it back');
server.close();

// ---- 4. Grep guard ----
const banned = [/\/Items\/Filters\b/, /\/Users\/Me\b/, /\/Lyrics\b/];
// Comments, and a route picked by server kind (`if (server.isEmby) … else "/Users/Me"`), never reach Emby.
const allowed = (line) => /^\s*(\/\/|\*)/.test(line) || /\bisEmby\b/.test(line);
const hits = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', 'build', 'dist', 'out', 'release', '.gradle', 'generated'].includes(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|svelte|kt|mjs|js)$/.test(e.name))
      fs.readFileSync(p, 'utf8')
        .split('\n')
        .forEach((line, i) => !allowed(line) && banned.some((re) => re.test(line)) && hits.push(`${path.relative(root, p)}:${i + 1}: ${line.trim()}`));
  }
})(path.join(root, 'apps'));
ok(hits.length === 0, `routes Emby breaks on (feature-specs.md X-01):\n${hits.join('\n')}`);

console.log(`continue-check: ${passed} assertions passed`);
process.exit(0);
