// Headless Live TV integration check (docs/specs/livetv-spec-final.md §17.3, §21.6, work package MK-3).
//
// Starts tools/mock-server/mock-emby.mjs and mock-jellyfin.mjs with MOCK_LIVETV=iptv on free loopback ports,
// signs in as Wika and drives the shared Live TV modules (apps/desktop/src/shared/livetv/*.ts: the dialect.ts
// request builders, normalisation, probes, tiles, timers, prefs and the zap reducer) with fetch, the way the
// clients do. Each check runs on both flavours; the whole run must finish in under 20 s.
//
//    1  lineup: 300 in one page of 500 and in pages of 200; radio typed
//    2  GuideInfo spans 7 days; MinEndDate keeps the airing programme; a slab-spanning programme appears once
//    3  same ids, same window: same programmes on Emby and Jellyfin
//    4  category rows; MOCK_LIVE_CATEGORY_IGNORED=1 → "dim only"; MOCK_LIVE_FLAGLESS=1 → genre probe says 'genres'
//    5  search: Emby SearchTerm; Jellyfin /Items, then memory with MOCK_JF_PROGRAM_SEARCH=0
//    6  DVR: duplicate 400 and non-series 500 mapped; empty body then refetch; 3 overlaps on 2 tuners → one
//       ConflictedNotOk; rule edit by GET-merge-POST; delete cascades
//    7  tuner hygiene: 50 random zaps (MOCK_LIVE_TUNE_MS=800 + jitter, first frame after 200 ms) → one open
//       stream, no double release, closes in the query string; 2 tuners held → the third tune releases and retries
//    8  hdhr mode: the static URL is chosen and answers 200
//    9  DisplayPreferences round trip with chunked keys; the client=emby guard
//   10  a WebSocket TimerCreated updates the overlay with zero /LiveTv/Programs requests
//   11  V15: Emby ignoring IsAiring switches "En ce moment" to the window query
//   12  killEncodes stops after one 404 (Jellyfin 12.2)
//   13  Jellyfin hides "Inédit" (no IsNew, newFlag false)
//   14  the Emby DisplayPreferences POST body carries Client: "wicaby"
//
// Loopback only: the host must be 127.0.0.1 (anything else is refused before any process starts or any request
// is sent), every request URL is checked again, and the mocks are bound to 127.0.0.1 through a --import preload.
// No sound and no real server: the mocks serve a few kilobytes of zeros as the "video".
//
// Usage: node tools/checks/livetv-mock-check.mjs [--host=127.0.0.1] [--verbose]
//        LIVETV_MOCK_HOST is read like --host. Exit 1 on any failure, 2 on a refused host.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const T0 = performance.now();
const BUDGET_MS = 20_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const srcDir = path.join(root, 'apps/desktop/src/shared/livetv');
const mockDir = path.join(root, 'tools/mock-server');
const VERBOSE = process.argv.includes('--verbose');

// ---- Loopback guard ----

const LOOPBACK = '127.0.0.1';
function assertLoopback(host) {
  if (host !== LOOPBACK) throw new Error(`refusing host "${host}": this check only talks to ${LOOPBACK}`);
}
function assertLoopbackUrl(url) {
  const u = new URL(url);
  assertLoopback(u.hostname);
}
// The guard guards itself (strings only; nothing is contacted).
for (const bad of ['localhost', '0.0.0.0', '::1', '127.0.0.2', '10.0.0.1', 'example.invalid', '']) {
  let threw = false;
  try {
    assertLoopback(bad);
  } catch {
    threw = true;
  }
  if (!threw) {
    console.log(`livetv-mock-check: the loopback guard accepted "${bad}"`);
    process.exit(1);
  }
}
const hostArg = process.argv.find((a) => a.startsWith('--host='))?.slice(7) ?? process.env.LIVETV_MOCK_HOST ?? LOOPBACK;
try {
  assertLoopback(hostArg);
} catch (e) {
  console.log(`livetv-mock-check: ${e.message}`);
  process.exit(2);
}

// ---- Shared modules (type-stripped TypeScript; same resolver as livetv-check.mjs) ----

const srcUrl = pathToFileURL(srcDir).href + '/';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(srcUrl) && !/\.[cm]?[jt]s$/.test(specifier)) return next(specifier + '.ts', context);
    return next(specifier, context);
  },
});
const load = (name) => import(pathToFileURL(path.join(srcDir, `${name}.ts`)).href);
const [D, M, L, TL, TM, P, Z, O] = await Promise.all(['dialect', 'model', 'lens', 'tiles', 'timers', 'prefs', 'zap', 'channel-order'].map(load));

// ---- Small helpers ----

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const localDayStart = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const atLocal = (day, h, m = 0) => {
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
const fold = (s) => O.nameKey(s);

class CheckError extends Error {}
function ok(cond, msg) {
  if (!cond) throw new CheckError(msg);
}

// ---- Mock processes ----

// Binds every server the mock creates to 127.0.0.1 (the mocks themselves listen on all interfaces).
const BOOT = `data:text/javascript,${encodeURIComponent(
  "import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'&&(a.length===1||typeof a[1]==='function'))a.splice(1,0,'127.0.0.1');return l.apply(this,a)};",
)}`;
const VIDEO = path.join(os.tmpdir(), `wicaby-livetv-mock-check-${process.pid}.mkv`);
fs.writeFileSync(VIDEO, Buffer.alloc(128 * 1024));
// Every instance generates the same lineup: the anchor is pinned to today's local midnight.
const ANCHOR = new Date(localDayStart(Date.now())).toISOString();
const children = new Set();
const cleanup = () => {
  for (const c of children) c.kill();
  children.clear();
  try {
    fs.rmSync(VIDEO, { force: true });
  } catch {
    // already gone
  }
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, LOOPBACK, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startMock(flavour, label, env = {}) {
  const port = await freePort();
  const script = path.join(mockDir, flavour === 'emby' ? 'mock-emby.mjs' : 'mock-jellyfin.mjs');
  const child = spawn(process.execPath, ['--import', BOOT, script, String(port), VIDEO], {
    cwd: root,
    // The developer's own MOCK_* settings never leak into the run.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MOCK_'))), MOCK_LIVETV: 'iptv', MOCK_LIVE_ANCHOR: ANCHOR, MOCK_LIVE_SEED: '42', MOCK_LIVE_CHANNELS: '300', MOCK_LIVE_DAYS: '7', MOCK_TUNERS: '2', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  const log = [];
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: no "listening" line after 10 s\n${log.slice(-20).join('\n')}`)), 10_000);
    const onLine = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line) continue;
        log.push(line);
        if (log.length > 400) log.shift();
        if (/^Mock (Emby|Jellyfin)/.test(line)) (clearTimeout(timer), resolve());
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    child.once('exit', (code) => (clearTimeout(timer), reject(new Error(`${label}: exited with ${code}\n${log.slice(-20).join('\n')}`))));
  });
  await ready;
  return { flavour, label, port, base: `http://${LOOPBACK}:${port}`, log, child };
}

// ---- Client over the dialect builders ----

const AUTH_FIELDS = 'Client="Wicaby checks", Device="livetv-mock-check", DeviceId="livetv-mock-check", Version="1.0.0"';

class Client {
  constructor(mock) {
    this.mock = mock;
    this.kind = mock.flavour;
    this.prefix = this.kind === 'emby' ? '/emby' : '';
    this.headers = {};
    this.userId = '';
    this.token = '';
  }
  async signIn() {
    const h = this.kind === 'emby' ? { 'X-Emby-Authorization': `MediaBrowser ${AUTH_FIELDS}` } : { Authorization: `MediaBrowser ${AUTH_FIELDS}` };
    const r = await this.fetch('POST', `${this.prefix}/Users/AuthenticateByName`, { headers: h, body: { Username: 'Wika', Pw: 'wicaby' } });
    ok(r.status === 200 && r.json?.AccessToken, `sign-in answered ${r.status}`);
    this.token = r.json.AccessToken;
    this.userId = r.json.User.Id;
    this.headers = this.kind === 'emby' ? { 'X-Emby-Token': this.token } : { Authorization: `MediaBrowser ${AUTH_FIELDS}, Token="${this.token}"` };
    return this;
  }
  async fetch(method, pathAndQuery, { headers = {}, body, raw = false } = {}) {
    const url = `${this.mock.base}${pathAndQuery}`;
    assertLoopbackUrl(url);
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, init);
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    return { status: res.status, text, json, headers: res.headers };
  }
  // Runs one dialect request (path + query + JSON body) with the session's auth.
  exec(req) {
    ok(req, 'a builder returned null');
    return this.fetch(req.method, `${this.prefix}${D.toUrl(req)}`, { headers: this.headers, body: req.body });
  }
  async state() {
    const r = await this.fetch('GET', '/Mock/LiveTv/State');
    ok(r.status === 200, `state answered ${r.status}`);
    return r.json;
  }
  async control(method, what, body) {
    const r = await this.fetch(method, `/Mock/LiveTv/${what}`, { body });
    ok(r.status < 300, `control ${what} answered ${r.status}`);
    return r.json;
  }
  get v() {
    return { userId: this.userId };
  }
}

const programRequests = (state) => Object.entries(state.requests).reduce((n, [k, v]) => (k.toLowerCase().startsWith('/livetv/programs') ? n + v : n), 0);

async function lineup(c) {
  const r = await c.exec(D.channelsPage(c.kind, { userId: c.userId, startIndex: 0, limit: 500 }));
  ok(r.status === 200, `channels answered ${r.status}`);
  return r.json.Items.map((d, i) => M.normalizeChannel(d, 'srv', i)).filter(Boolean);
}
async function guideInfo(c) {
  const r = await c.exec(D.guideInfo(c.kind));
  ok(r.status === 200, `GuideInfo answered ${r.status}`);
  return { start: M.parseServerDate(r.json.StartDate), end: M.parseServerDate(r.json.EndDate) };
}
async function tile(c, channelIds, from, to, genres = false) {
  const r = await c.exec(D.programsTile(c.kind, { userId: c.userId, channelIds, from, to, genres }));
  ok(r.status === 200, `Programs answered ${r.status}`);
  return r.json.Items;
}
const normalizeAll = (c, raw, categorySource) => raw.map((d) => M.normalizeProgram(d, { kind: c.kind, categorySource })).filter(Boolean);
// Programmes airing at t on the given channels (raw DTOs).
async function airingAt(c, ids, t) {
  const raw = await tile(c, ids, t, t + 1);
  return raw.filter((d) => M.parseServerDate(d.StartDate) <= t && M.parseServerDate(d.EndDate) > t);
}
async function timersNow(c) {
  const r = await c.exec(D.timers(c.kind));
  ok(r.status === 200, `timers answered ${r.status}`);
  return r.json.Items;
}
async function defaultsFor(c, programId) {
  const r = await c.exec(D.timerDefaults(c.kind, { programId }));
  ok(r.status === 200, `timer defaults answered ${r.status}`);
  return r.json;
}
const tvRows = (rows) => O.sortChannels(rows.filter((r) => !r.radio), 'number');

// ---- Fake live session (spec §8.1, §8.2): PlaybackInfo → (Open) → pick → first frame → adopt; release ledger ----

const DEVICE_ID = 'livetv-mock-check';
const MAX_BITRATE = 20_000_000;

class LiveSession {
  constructor(c, { firstFrameMs = 200, onFrame } = {}) {
    this.c = c;
    this.firstFrameMs = firstFrameMs;
    this.onFrame = onFrame; // optional fake player work (check 8 reads the stream)
    this.seq = 0;
    this.adopted = null;
    this.ledger = new Map();
    this.policy = 'MBB';
    this.killEncodes = true;
    this.counts = { tunes: 0, closes: 0, transcodeCloses: 0, kills: 0, killAttempts: 0, stops: 0, retries: 0, busy: 0, adopted: 0, superseded: 0, failed: 0 };
    this.inflight = new Set();
    this.errors = [];
  }
  isBusy(r) {
    if (r.status === 200) {
      const ec = r.json?.ErrorCode;
      if (ec === 'NoCompatibleStream' || ec === 'RateLimitExceeded') return true;
      return !r.json?.MediaSources?.length && !!this.adopted;
    }
    if ([409, 500, 503].includes(r.status)) return /tuner|no.*(available|free)|conflict|limit/i.test(`${r.text} ${r.json?.ErrorCode ?? ''}`);
    return false;
  }
  pick(ms, channelId, psid) {
    const stat = () => this.c.mock.base + this.c.prefix + D.toUrl(D.staticStream(this.c.kind, { itemId: channelId, container: ms.Container, mediaSourceId: ms.Id, liveStreamId: ms.LiveStreamId, deviceId: DEVICE_ID, playSessionId: psid }));
    if (ms.SupportsDirectPlay) return { method: 'DirectPlay', url: stat() };
    if (ms.TranscodingUrl) return { method: 'Transcode', url: this.c.mock.base + ms.TranscodingUrl };
    if (ms.SupportsDirectStream) return { method: 'DirectStream', url: stat() };
    return null;
  }
  report(e) {
    return { itemId: e.channelId, mediaSourceId: e.msid, playSessionId: e.psid, liveStreamId: e.lsid, playMethod: e.method };
  }
  tune(channelId) {
    const p = this.#tune(channelId).catch((err) => {
      this.errors.push(`${channelId}: ${err.message}`);
      return { result: 'error' };
    });
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
    return p;
  }
  async #tune(channelId) {
    const seq = ++this.seq;
    this.counts.tunes++;
    const kind = this.c.kind;
    const superseded = () => seq !== this.seq;
    if (this.policy === 'BBM' && this.adopted) await this.releaseAdopted();
    const pbi = () => this.c.exec(D.tune(kind, { userId: this.c.userId, channelId, maxBitrate: MAX_BITRATE, rung: 0 }));
    let r = await pbi();
    if (superseded()) return this.#dropAnswer(r);
    if (this.isBusy(r)) {
      this.counts.busy++;
      if (this.adopted) {
        // MBB with a current stream: learn BBM, release the old stream and retry once.
        this.policy = 'BBM';
        this.counts.retries++;
        await this.releaseAdopted();
        r = await pbi();
        if (superseded()) return this.#dropAnswer(r);
      }
    }
    if (r.status !== 200 || !r.json?.MediaSources?.length) return this.#failed(r);
    let ms = r.json.MediaSources[0];
    const psid = r.json.PlaySessionId;
    if (ms.RequiresOpening && !ms.LiveStreamId) {
      const o = await this.c.exec(D.open(kind, { userId: this.c.userId, itemId: channelId, playSessionId: psid, maxBitrate: MAX_BITRATE, openToken: ms.OpenToken }));
      if (superseded()) return this.#dropAnswer(o.json?.MediaSource ? { status: o.status, json: { MediaSources: [o.json.MediaSource], PlaySessionId: psid } } : o);
      if (o.status !== 200 || !o.json?.MediaSource) return this.#failed(o);
      ms = o.json.MediaSource;
    }
    const chosen = this.pick(ms, channelId, psid);
    const e = { lsid: ms.LiveStreamId, psid, channelId, msid: ms.Id, transcoding: !!ms.TranscodingUrl, method: chosen?.method, url: chosen?.url, released: null, adopted: false };
    if (e.lsid) this.ledger.set(e.lsid, e);
    if (!chosen) {
      await this.closeUnadopted(e);
      return this.#failed({ status: 0, text: 'no play method' });
    }
    // The fake player: the first frame arrives after firstFrameMs.
    await Promise.all([sleep(this.firstFrameMs), this.onFrame?.(e)]);
    if (superseded()) {
      await this.closeUnadopted(e);
      this.counts.superseded++;
      return { result: 'superseded' };
    }
    const prev = this.adopted;
    this.adopted = e;
    e.adopted = true;
    this.counts.adopted++;
    const rp = await this.c.exec(D.reportPlaying(kind, this.report(e)));
    ok(rp.status < 300, `Playing report answered ${rp.status}`);
    if (prev) await this.#stop(prev);
    return { result: 'adopted', entry: e };
  }
  async #dropAnswer(r) {
    this.counts.superseded++;
    const ms = r.status === 200 ? r.json?.MediaSources?.[0] : null;
    if (ms?.LiveStreamId) {
      const e = { lsid: ms.LiveStreamId, psid: r.json.PlaySessionId, channelId: '', msid: ms.Id, transcoding: !!ms.TranscodingUrl, released: null, adopted: false };
      this.ledger.set(e.lsid, e);
      await this.closeUnadopted(e);
    }
    return { result: 'superseded' };
  }
  #failed(r) {
    this.counts.failed++;
    return { result: 'failed', status: r.status, text: r.text };
  }
  // Never-adopted streams: Close (ids in the query string), plus killEncodes when a TranscodingUrl was issued.
  async closeUnadopted(e) {
    if (!e.lsid || e.released) return;
    e.released = 'close';
    const r = await this.c.exec(D.close(this.c.kind, { liveStreamId: e.lsid, playSessionId: e.psid }));
    ok(r.status < 300, `Close ${e.lsid} answered ${r.status} ${r.text}`);
    this.counts.closes++;
    if (e.transcoding) {
      this.counts.transcodeCloses++;
      if (this.killEncodes) {
        this.counts.killAttempts++;
        const k = await this.c.exec(D.killEncodes(this.c.kind, { deviceId: DEVICE_ID, playSessionId: e.psid }));
        if (k.status === 404 || k.status === 405) this.killEncodes = false;
        else if (k.status < 300) this.counts.kills++;
      }
    }
  }
  // Adopted streams: the Stopped report releases them.
  async #stop(e) {
    if (e.released) return;
    e.released = 'stop';
    const r = await this.c.exec(D.reportStopped(this.c.kind, this.report(e)));
    ok(r.status < 300, `Stopped report answered ${r.status}`);
    this.counts.stops++;
  }
  async releaseAdopted() {
    const e = this.adopted;
    this.adopted = null;
    if (e) await this.#stop(e);
  }
  async idle(timeoutMs = 10_000) {
    const until = Date.now() + timeoutMs;
    while (this.inflight.size && Date.now() < until) await Promise.race([...this.inflight, sleep(50)]);
    ok(!this.inflight.size, 'tunes still in flight');
  }
}

// ---- Checks ----

const results = []; // {no, flavour, title, ok, msg, ms}
async function check(no, flavour, title, fn) {
  const t = performance.now();
  try {
    const note = await fn();
    results.push({ no, flavour, title, ok: true, msg: note ?? '', ms: performance.now() - t });
  } catch (e) {
    results.push({ no, flavour, title, ok: false, msg: e instanceof CheckError ? e.message : e.stack, ms: performance.now() - t });
  }
}

// 1. Lineup.
async function check1(c) {
  const one = await c.exec(D.channelsPage(c.kind, { userId: c.userId, startIndex: 0, limit: 500 }));
  ok(one.status === 200, `page of 500 answered ${one.status}`);
  ok(one.json.Items.length === 300 && one.json.TotalRecordCount === 300, `page of 500: ${one.json.Items.length} items, total ${one.json.TotalRecordCount}`);
  const pages = [];
  for (let start = 0; ; start += 200) {
    const r = await c.exec(D.channelsPage(c.kind, { userId: c.userId, startIndex: start, limit: 200 }));
    ok(r.status === 200, `page at ${start} answered ${r.status}`);
    pages.push(r.json.Items);
    if (start === 0) ok(r.json.TotalRecordCount === 300, `first page of 200: total ${r.json.TotalRecordCount}`);
    if (r.json.Items.length < 200) break;
  }
  ok(pages.length === 2 && pages[0].length === 200 && pages[1].length === 100, `pages of 200: ${pages.map((p) => p.length).join(' + ')}`);
  const a = one.json.Items.map((x) => x.Id).join();
  const b = pages.flat().map((x) => x.Id).join();
  ok(a === b, 'pages of 200 differ from the page of 500');
  const rows = one.json.Items.map((d, i) => M.normalizeChannel(d, 'srv', i));
  ok(rows.every(Boolean) && new Set(rows.map((r) => r.id)).size === 300, 'normalised lineup has nulls or duplicate ids');
  const radio = rows.filter((r) => r.radio);
  ok(radio.length === 10, `${radio.length} radio channels (want 10)`);
  ok(radio.every((r) => one.json.Items[r.serverIndex].ChannelType === 'Radio' && one.json.Items[r.serverIndex].MediaType === 'Audio'), 'radio rows not typed Radio/Audio');
  ok(rows.filter((r) => !r.radio).every((r) => one.json.Items[r.serverIndex].ChannelType === 'TV'), 'TV rows not typed TV');
  return `300 channels, 10 radio`;
}

// 2. GuideInfo and the tile window; returns the tiles for later checks.
async function check2(c, rows) {
  const gi = await guideInfo(c);
  const now = Date.now();
  ok(gi.end - gi.start >= 7 * DAY, `GuideInfo spans ${((gi.end - gi.start) / DAY).toFixed(2)} days`);
  ok(gi.start <= now && gi.end >= now + 6 * DAY, 'GuideInfo does not cover now … now + 6 days');
  // Every 7th TV channel: all the groups, so programme edges do not all fall on the slab edges.
  const ids = tvRows(rows)
    .filter((_, i) => i % 7 === 3)
    .slice(0, 40)
    .map((r) => r.id);
  const k = TL.slabOf(now);
  const reqA = { priority: 0, channelIds: ids, slabs: [k], from: TL.slabStart(k), to: TL.slabEnd(k) };
  const reqB = { priority: 1, channelIds: ids, slabs: [k + 1], from: TL.slabStart(k + 1), to: TL.slabEnd(k + 1) };
  const rawA = await tile(c, ids, reqA.from, reqA.to);
  const rawB = await tile(c, ids, reqB.from, reqB.to);
  const a = normalizeAll(c, rawA);
  const b = normalizeAll(c, rawB);
  ok(a.length === rawA.length && b.length === rawB.length, 'some programmes failed to normalise');
  ok(a.every((p) => p.end > reqA.from && p.start < reqA.to), 'tile A holds programmes outside its window');
  const airing = a.filter((p) => p.start < reqA.from);
  ok(airing.length > 0, 'MinEndDate lost the programmes airing at the slab start');
  const ia = TL.ingestTile(reqA, a);
  const ib = TL.ingestTile(reqB, b);
  ok(ia.coverage.length === ids.length && ib.coverage.length === ids.length, 'coverage does not list every requested channel');
  const both = new Set(a.map((p) => p.id).filter((id) => b.some((q) => q.id === id)));
  ok(both.size > 0, 'no programme spans the slab boundary');
  let spanning = 0;
  for (const id of ids) {
    const merged = TL.mergePrograms(ia.byChannel.get(id), ib.byChannel.get(id));
    for (const pid of both) {
      const n = merged.filter((p) => p.id === pid).length;
      if (a.some((p) => p.id === pid && p.channelId === id)) {
        ok(n === 1, `${pid} appears ${n} times after the merge`);
        spanning++;
      }
    }
    for (let i = 1; i < merged.length; i++) ok(merged[i].start >= merged[i - 1].end, `${id}: merged list overlaps`);
  }
  return { note: `${((gi.end - gi.start) / DAY).toFixed(2)} days; ${airing.length} airing at the slab start; ${spanning} spanning programmes merged once`, ids, rawA, rawB, a, b, slab: k };
}

// 3. Same ids, same window → same programmes on both servers.
async function check3(ce, cj, ids, slab) {
  const from = TL.slabStart(slab);
  const to = TL.slabEnd(slab + 1);
  const [re, rj] = await Promise.all([tile(ce, ids, from, to), tile(cj, ids, from, to)]);
  const key = (p) => [p.id, p.channelId, p.start, p.end, p.title, p.episodeTitle ?? '', p.season ?? '', p.episode ?? '', p.seriesId ?? '', p.rating ?? '', p.flags & ~M.PF.New].join('|');
  const e = normalizeAll(ce, re).map(key);
  const j = normalizeAll(cj, rj).map(key);
  ok(e.length > 0, 'no programme in the window');
  ok(e.length === j.length, `Emby ${e.length} programmes, Jellyfin ${j.length}`);
  const diff = e.findIndex((x, i) => x !== j[i]);
  ok(diff < 0, `first difference: emby ${e[diff]} vs jellyfin ${j[diff]}`);
  return `${e.length} programmes over 6 h on ${ids.length} channels`;
}

// 4a. Category rows on a server that honours the flags; tiles carry the flags.
async function check4a(c, rows, tiles) {
  const notes = [];
  for (const cat of ['movies', 'sports']) {
    const r = await c.exec(D.channelCategorySet(c.kind, { userId: c.userId, category: cat }));
    ok(r.status === 200, `${cat} set answered ${r.status}`);
    const set = r.json.Items.map((x) => x.Id);
    const honoured = L.categoryRowsProbe(set.length, rows.length);
    ok(honoured, `${cat}: probe concluded "dim only" with ${set.length}/${rows.length}`);
    const kept = L.categoryRows(rows, cat, set, honoured);
    ok(kept.length === set.length && kept.length > 0 && kept.length < rows.length, `${cat}: ${kept.length} rows kept`);
    notes.push(`${cat} ${kept.length} rows`);
  }
  ok(L.categorySourceFromTiles(tiles, rows.length) === 'flags', 'tiles carry no category flags');
  return `${notes.join(', ')}; categorySource flags`;
}

// 4b. MOCK_LIVE_CATEGORY_IGNORED=1 → dim only; MOCK_LIVE_FLAGLESS=1 → genres.
async function check4b(c, rows) {
  const r = await c.exec(D.channelCategorySet(c.kind, { userId: c.userId, category: 'movies' }));
  ok(r.status === 200, `movies set answered ${r.status}`);
  const set = r.json.Items.map((x) => x.Id);
  const honoured = L.categoryRowsProbe(set.length, rows.length);
  ok(!honoured, `probe kept the rows filter with ${set.length}/${rows.length}`);
  ok(L.categoryRows(rows, 'movies', set, honoured).length === rows.length, 'dim only must keep every row');
  // Probe 2: three tiles without any category flag, then one onNow page with Fields=Genres.
  const ids = tvRows(rows).map((x) => x.id);
  const now = Date.now();
  const k = TL.slabOf(now);
  const first3 = [];
  for (let i = 0; i < 3; i++) first3.push(...normalizeAll(c, await tile(c, ids.slice(i * 40, i * 40 + 40), TL.slabStart(k), TL.slabEnd(k))));
  ok(first3.length > 0, 'first tiles are empty');
  const src = L.categorySourceFromTiles(first3, rows.length);
  ok(src === 'probe', `categorySourceFromTiles said ${src}`);
  const on = await c.exec(D.onNow(c.kind, { userId: c.userId, now }));
  ok(on.status === 200 && on.json.Items.length > 0, `onNow answered ${on.status}`);
  const verdict = L.categorySourceFromGenres(on.json.Items.map((x) => x.Genres ?? []));
  ok(verdict === 'genres', `genre probe said ${verdict}`);
  const spread = ids.filter((_, i) => i % 7 === 3).slice(0, 40);
  const withGenres = normalizeAll(c, await tile(c, spread, TL.slabStart(k), TL.slabEnd(k), true), 'genres');
  const mapped = withGenres.filter((p) => p.flags & (M.PF.Movie | M.PF.Sports | M.PF.News | M.PF.Kids | M.PF.Series));
  ok(mapped.length > 0, 'genre mapping set no category bit');
  // Dim only: cells outside the category fade, the others stay lit, on the same rows.
  const split = M.CATEGORIES.filter((cat) => cat !== 'new' && withGenres.some((p) => L.dimmed(p, cat)) && withGenres.some((p) => !L.dimmed(p, cat)));
  ok(split.length >= 2, `dimming splits the cells for ${split.join(', ') || 'no category'}`);
  return `dim only (${set.length}/${rows.length}); genres → ${mapped.length}/${withGenres.length} cells categorised (${split.join(', ')})`;
}

// 5a. Search on servers that answer it.
async function check5a(c, cached, guideEnd) {
  const now = Date.now();
  const src = cached.find((p) => p.end > now && p.flags & M.PF.Movie) ?? cached.find((p) => p.end > now);
  ok(src, 'nothing in the cache to search for');
  const r = await c.exec(D.searchPrograms(c.kind, { userId: c.userId, query: src.title, now, guideEnd }));
  ok(r.status === 200, `search answered ${r.status}`);
  const items = normalizeAll(c, r.json.Items);
  ok(items.length > 0, `server search for "${src.title}" found nothing`);
  ok(items.every((p) => fold(p.title).includes(fold(src.title))), 'server search returned a non-matching title');
  const caps = M.defaultCaps(c.kind);
  ok(caps.programSearch === (c.kind === 'emby' ? 'server' : 'items'), `programSearch starts as ${caps.programSearch}`);
  return `${c.kind === 'emby' ? 'SearchTerm' : '/Items'} "${src.title}" → ${items.length}`;
}

// 5b. MOCK_JF_PROGRAM_SEARCH=0: /Items finds nothing for a cached title → memory search.
async function check5b(c, rows) {
  const now = Date.now();
  const ids = tvRows(rows).slice(0, 40).map((r) => r.id);
  const k = TL.slabOf(now);
  const cache = normalizeAll(c, await tile(c, ids, TL.slabStart(k), TL.slabEnd(k + 1)));
  const src = cache.find((p) => p.end > now && p.title.length > 3);
  ok(src, 'nothing cached');
  const gi = await guideInfo(c);
  const r = await c.exec(D.searchPrograms(c.kind, { userId: c.userId, query: src.title, now, guideEnd: gi.end }));
  ok(r.status === 200, `search answered ${r.status}`);
  if (c.kind === 'emby') {
    ok(r.json.Items.length > 0, 'Emby SearchTerm found nothing');
    return `SearchTerm "${src.title}" → ${r.json.Items.length} (Emby has no memory fallback)`;
  }
  ok(r.json.Items.length === 0, `/Items answered ${r.json.Items.length} items with MOCK_JF_PROGRAM_SEARCH=0`);
  const caps = M.defaultCaps(c.kind);
  if (!r.json.Items.length && cache.some((p) => fold(p.title) === fold(src.title))) caps.programSearch = 'memory';
  ok(caps.programSearch === 'memory', 'did not fall back to memory');
  const hits = cache.filter((p) => fold(p.title).includes(fold(src.title)));
  ok(hits.some((p) => p.id === src.id), 'memory search missed the cached programme');
  return `/Items empty → memory "${src.title}" → ${hits.length}`;
}

// 6. DVR.
async function check6(c, rows) {
  const kind = c.kind;
  const ids = tvRows(rows).map((r) => r.id);
  const day = localDayStart(Date.now());
  const notes = [];

  // Duplicate one-off → 400 mapped; the create answers an empty body, the refetch finds the id.
  const t1 = atLocal(day + 3 * DAY + 2 * HOUR, 21, 0);
  const at1 = await airingAt(c, ids, t1);
  const movie = at1.map((d) => M.normalizeProgram(d, { kind })).find((p) => p && p.flags & M.PF.Movie && !p.timerId);
  ok(movie, 'no film airing at day + 3, 21:00');
  const defs = await defaultsFor(c, movie.id);
  const cr = await c.exec(D.createTimer(kind, { body: TM.quickRecordBody(defs) }));
  ok(cr.status === 200 || cr.status === 204, `createTimer answered ${cr.status}`);
  ok(!cr.text, 'createTimer answered a body (the client must not rely on one)');
  let overlay = TM.buildOverlay(TM.normalizeTimers(await timersNow(c)));
  const made = overlay.get(movie.id);
  ok(made?.id, 'the refetch did not find the new timer');
  ok(TM.markFor(movie, overlay) === 'timer', `mark ${TM.markFor(movie, overlay)}`);
  const dup = await c.exec(D.createTimer(kind, { body: TM.quickRecordBody(defs) }));
  ok(dup.status === 400, `duplicate answered ${dup.status}`);
  ok(TM.mapDvrError(kind, 'createTimer', dup.status, dup.text) === 'already-scheduled', 'duplicate not mapped to already-scheduled');
  notes.push('dup 400');

  // Series rule on a film → 500 mapped.
  const ns = await c.exec(D.createSeriesTimer(kind, { body: defs }));
  ok(ns.status === 500, `series rule on a film answered ${ns.status}`);
  ok(TM.mapDvrError(kind, 'createSeriesTimer', ns.status, ns.text) === 'not-series', `non-series mapped to ${TM.mapDvrError(kind, 'createSeriesTimer', ns.status, ns.text)}`);
  notes.push('non-series 500');
  const cancel = await c.exec(D.cancelTimer(kind, { id: made.id }));
  ok(cancel.status < 300, `cancelTimer answered ${cancel.status}`);
  overlay = TM.buildOverlay(TM.normalizeTimers(await timersNow(c)));
  ok(!overlay.has(movie.id), 'the cancelled one-off is still in the overlay');

  // Three overlapping one-offs on two tuners → exactly one ConflictedNotOk.
  const t2 = atLocal(day + 4 * DAY + 2 * HOUR, 14, 10);
  const existing = TM.normalizeTimers(await timersNow(c)).map((t) => [t.start - t.prePaddingS * 1000, t.end + t.postPaddingS * 1000]);
  const pre = defs.PrePaddingSeconds * 1000;
  const post = defs.PostPaddingSeconds * 1000;
  const picks = [];
  for (const d of await airingAt(c, ids, t2)) {
    const p = M.normalizeProgram(d, { kind });
    if (!p || p.timerId || p.seriesTimerId || p.end - p.start > 4 * HOUR || picks.some((q) => q.channelId === p.channelId)) continue;
    if (existing.some(([s, e]) => s < p.end + post && e > p.start - pre)) continue;
    picks.push(p);
    if (picks.length === 3) break;
  }
  ok(picks.length === 3, `found ${picks.length} free programmes airing at day + 4, 14:10`);
  for (const p of picks) {
    const r = await c.exec(D.createTimer(kind, { body: TM.quickRecordBody(await defaultsFor(c, p.id)) }));
    ok(r.status < 300, `createTimer ${p.id} answered ${r.status}`);
  }
  const all = TM.normalizeTimers(await timersNow(c));
  overlay = TM.buildOverlay(all);
  const mine = picks.map((p) => overlay.get(p.id));
  ok(mine.every(Boolean), 'an overlapping timer is missing');
  const wont = mine.filter((t) => t.status === 'conflict-wont');
  ok(wont.length === 1, `${wont.length} ConflictedNotOk among the 3 overlapping timers (statuses ${mine.map((t) => t.status).join(', ')})`);
  ok(mine.filter((t) => t.status === 'conflict-ok').length === 2, 'the 2 timers that keep a tuner are not ConflictedOk');
  ok(TM.conflictCount(all) >= 1 && picks.some((p) => TM.markFor(p, overlay) === 'conflict-wont'), 'the conflict mark is missing');
  for (const t of mine) ok((await c.exec(D.cancelTimer(kind, { id: t.id }))).status < 300, 'cancel failed');
  notes.push('3 overlaps → 1 ConflictedNotOk');

  // Series rule: create, edit by GET-merge-POST, delete with its children.
  const rules = (await c.exec(D.seriesTimers(kind))).json.Items;
  const ruled = new Set(rules.map((r) => `${r.SeriesId}|${r.ChannelId}`));
  const series = at1
    .concat(await airingAt(c, ids, atLocal(day + 2 * DAY + 2 * HOUR, 18, 30)))
    .map((d) => M.normalizeProgram(d, { kind }))
    .find((p) => p && p.seriesId && p.flags & M.PF.Series && !p.timerId && !ruled.has(`${p.seriesId}|${p.channelId}`));
  ok(series, 'no series episode without a rule');
  const sdefs = await defaultsFor(c, series.id);
  const sc = await c.exec(D.createSeriesTimer(kind, { body: sdefs }));
  ok(sc.status === 200 || sc.status === 204, `createSeriesTimer answered ${sc.status}`);
  const rule = (await c.exec(D.seriesTimers(kind))).json.Items.find((r) => r.ProgramId === series.id);
  ok(rule?.Id, 'the refetch did not find the new rule');
  const children = TM.normalizeTimers((await c.exec(D.timersOfRule(kind, { id: rule.Id }))).json.Items);
  ok(children.length >= 1, 'the rule created no timer');
  const partial = await c.exec(D.updateSeriesTimer(kind, { id: rule.Id, body: { PrePaddingSeconds: 1 } }));
  ok(partial.status === 400, `a partial rule body answered ${partial.status} (the mock must refuse it)`);
  const full = await c.exec(D.seriesTimer(kind, { id: rule.Id }));
  ok(full.status === 200, `GET rule answered ${full.status}`);
  const merged = TM.applyOptions(full.json, { PrePaddingSeconds: 180, PostPaddingSeconds: 900, NotAField: 1 });
  ok(!('NotAField' in merged), 'applyOptions added a field the server did not send');
  const up = await c.exec(D.updateSeriesTimer(kind, { id: rule.Id, body: merged }));
  ok(up.status < 300, `rule update answered ${up.status} ${up.text}`);
  const after = (await c.exec(D.seriesTimer(kind, { id: rule.Id }))).json;
  ok(after.PrePaddingSeconds === 180 && after.PostPaddingSeconds === 900, 'the rule edit did not stick');
  const kids = TM.normalizeTimers((await c.exec(D.timersOfRule(kind, { id: rule.Id }))).json.Items);
  ok(kids.length >= 1 && kids.every((t) => t.prePaddingS === 180 && t.postPaddingS === 900), 'children did not follow the rule edit');
  const del = await c.exec(D.deleteSeriesTimer(kind, { id: rule.Id }));
  ok(del.status < 300, `rule delete answered ${del.status}`);
  ok(!(await c.exec(D.seriesTimers(kind))).json.Items.some((r) => r.Id === rule.Id), 'the rule is still listed');
  const left = TM.normalizeTimers((await c.exec(D.timersOfRule(kind, { id: rule.Id }))).json.Items);
  ok(left.length === 0, `${left.length} child timers survived the rule`);
  notes.push(`rule edit (${kids.length} children) and cascade`);
  return notes.join('; ');
}

// 7a. Tuner hygiene over 50 random zaps; 12. killEncodes stops after one 404.
async function check7a(c, rows) {
  const st0 = await c.state();
  ok(st0.openStreams.length === 0, 'streams open before the run');
  const list = tvRows(rows).slice(0, 16).map(M.zapEntry);
  const s = new LiveSession(c, { firstFrameMs: 200 });
  const rng = mulberry32(7);
  let st = Z.zapInit(list[0].id);
  const fired = []; // {id, result}
  const apply = (out) => {
    st = out.state;
    for (const eff of out.effects) {
      if (eff.type !== 'tune') continue;
      const f = { id: eff.id, result: null };
      fired.push(f);
      s.tune(eff.id).then((res) => {
        f.result = res.result;
        if (res.result === 'adopted') st = Z.zapReduce(st, { type: 'adopted', id: eff.id }, list).state;
        else if (res.result === 'failed' || res.result === 'error') st = Z.zapReduce(st, { type: 'failed', id: eff.id }, list).state;
      });
    }
  };
  const ticker = setInterval(() => apply(Z.zapReduce(st, { type: 'tick', at: Date.now() }, list)), 10);
  try {
    for (let i = 0; i < 50; i++) {
      apply(Z.zapReduce(st, { type: 'press', delta: rng() < 0.6 ? 1 : -1, at: Date.now() }, list));
      if (i === 49) break;
      const r = rng();
      // Mostly merged presses, some that fire and get superseded, and two pauses long enough to adopt.
      await sleep(i === 15 || i === 32 ? 1300 : r < 0.28 ? 420 + Math.floor(rng() * 60) : 25 + Math.floor(rng() * 85));
    }
    const until = Date.now() + 5000;
    while ((st.pending !== null || s.inflight.size) && Date.now() < until) await sleep(20);
    await s.idle();
  } finally {
    clearInterval(ticker);
  }
  ok(!s.errors.length, s.errors.join('; '));
  const last = fired.at(-1);
  ok(last?.result === 'adopted', `the last tune (${last?.id}) ended ${last?.result}`);
  ok(s.adopted?.channelId === last.id && st.current === last.id && st.tuning === null, `ended on ${s.adopted?.channelId ?? 'nothing'} / reducer ${st.current}, last tune ${last.id}`);
  const state = await c.state();
  ok(state.openStreams.length === 1 && state.openStreams[0].id === s.adopted.lsid, `openStreams = ${state.openStreams.length} (${state.openStreams.map((x) => x.id).join(', ')})`);
  ok(state.doubleReleases === 0, `${state.doubleReleases} double releases`);
  ok(state.closeRejects === 0 && state.closeWithBody === 0 && state.closeUnknown === 0, `close rejects ${state.closeRejects}, with body ${state.closeWithBody}, unknown ${state.closeUnknown}`);
  ok(state.closes === s.counts.closes, `mock counted ${state.closes} closes, client sent ${s.counts.closes}`);
  ok(state.stopsWithoutPlaySessionId === 0 && state.missingBitrate === 0, 'a report without PlaySessionId or a tune without MaxStreamingBitrate');
  ok(s.counts.closes >= 3 && s.counts.adopted >= 2, `only ${s.counts.closes} closes and ${s.counts.adopted} adoptions: the run did not exercise supersede`);
  const unreleased = [...s.ledger.values()].filter((e) => !e.released);
  ok(unreleased.length === 1 && unreleased[0] === s.adopted, `${unreleased.length} unreleased ledger entries`);
  await s.releaseAdopted();
  const end = await c.state();
  ok(end.openStreams.length === 0 && end.doubleReleases === 0, `after stop: ${end.openStreams.length} open, ${end.doubleReleases} double releases`);
  const note = `${s.counts.tunes} tunes: ${s.counts.adopted} adopted, ${s.counts.superseded} superseded, ${s.counts.closes} closes, ${s.counts.busy} busy`;
  return { note, s, state: end };
}

function check12(c, s, state) {
  ok(s.counts.transcodeCloses >= 2, `only ${s.counts.transcodeCloses} transcoding closes`);
  if (c.kind === 'jellyfin') {
    ok(!s.killEncodes, 'killEncodes still enabled after a 404');
    ok(state.encodingsKillAttempts === 1 && s.counts.killAttempts === 1, `${state.encodingsKillAttempts} DELETE /Videos/ActiveEncodings (want 1)`);
    return `1 attempt (404), then off for ${s.counts.transcodeCloses - 1} more transcoding closes`;
  }
  ok(s.killEncodes && state.encodingsKilled === s.counts.kills && s.counts.kills === s.counts.transcodeCloses, `Emby: ${state.encodingsKilled} kills for ${s.counts.transcodeCloses} transcoding closes`);
  return `${s.counts.kills} kills, still on`;
}

// 7b. Two tuners held → the third tune releases the adopted stream and retries once.
async function check7b(c, rows) {
  await c.control('POST', 'Reset');
  const ids = tvRows(rows).slice(20, 23).map((r) => r.id);
  const s = new LiveSession(c, { firstFrameMs: 50 });
  const a = await s.tune(ids[0]);
  ok(a.result === 'adopted', `first tune ${a.result} ${a.status ?? ''}`);
  // Another client holds the second tuner.
  const other = await c.exec(D.tune(c.kind, { userId: c.userId, channelId: ids[1], maxBitrate: MAX_BITRATE, rung: 0 }));
  ok(other.status === 200 && other.json.MediaSources[0].LiveStreamId, `the other client's tune answered ${other.status}`);
  ok((await c.state()).openStreams.length === 2, 'both tuners are not held');
  const b = await s.tune(ids[2]);
  ok(b.result === 'adopted', `third tune ${b.result} ${b.status ?? ''}`);
  const st = await c.state();
  ok(s.counts.busy === 1 && s.counts.retries === 1 && st.busyRejects === 1, `busy ${s.counts.busy}, retries ${s.counts.retries}, mock busyRejects ${st.busyRejects}`);
  ok(s.policy === 'BBM', 'policy not learned');
  ok(st.stopReleases === 1 && st.doubleReleases === 0, `stopReleases ${st.stopReleases}, doubleReleases ${st.doubleReleases}`);
  const open = st.openStreams.map((x) => x.channelId).sort();
  ok(open.join() === [ids[1], ids[2]].sort().join(), `open after retry: ${open.join(', ')}`);
  const o = other.json.MediaSources[0];
  ok((await c.exec(D.close(c.kind, { liveStreamId: o.LiveStreamId, playSessionId: other.json.PlaySessionId }))).status < 300, 'closing the other stream failed');
  await s.releaseAdopted();
  const end = await c.state();
  ok(end.openStreams.length === 0 && end.doubleReleases === 0, `after stop: ${end.openStreams.length} open`);
  return 'busy 500 → Stopped for the adopted stream → retry adopted';
}

// 8. hdhr mode: DirectStream only, no TranscodingUrl → the static URL, which answers 200.
async function check8(c, rows) {
  await c.control('POST', 'Reset');
  const id = tvRows(rows)[3].id;
  let got = null;
  const s = new LiveSession(c, {
    firstFrameMs: 0,
    onFrame: async (e) => {
      const res = await c.fetch('GET', e.url.slice(c.mock.base.length), { headers: c.headers, raw: true });
      const reader = res.body.getReader();
      const first = await reader.read();
      await reader.cancel();
      got = { status: res.status, length: res.headers.get('content-length'), bytes: first.value?.length ?? 0, method: e.method, url: e.url };
    },
  });
  const r = await s.tune(id);
  ok(r.result === 'adopted', `tune ${r.result} ${r.status ?? ''} ${r.text ?? ''}`);
  ok(!r.entry.transcoding, 'hdhr answered a TranscodingUrl');
  ok(got?.method === 'DirectStream', `method ${got?.method}`);
  const u = new URL(got.url);
  ok(/\/Videos\/[^/]+\/stream\.\w+$/.test(u.pathname) && u.searchParams.get('Static') === 'true' && u.searchParams.get('LiveStreamId') === r.entry.lsid, `not the static URL: ${u.pathname}${u.search}`);
  ok(got.status === 200 && got.bytes > 0, `static URL answered ${got.status} with ${got.bytes} bytes`);
  ok(got.length === null, 'a live stream must not carry Content-Length');
  await s.releaseAdopted();
  ok((await c.state()).openStreams.length === 0, 'stream left open');
  return `DirectStream ${u.pathname} → 200`;
}

// 9. DisplayPreferences; 14. the Emby POST body carries Client.
async function check9(c, rows) {
  const kind = c.kind;
  const r0 = await c.exec(D.displayPrefs(kind, c.v));
  ok(r0.status === 200, `GET prefs answered ${r0.status}`);
  const ids = rows.map((r) => r.id);
  const groups = Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, name: `Groupe ${i} « été »`, ids }));
  ok(P.planWrite(P.queueChange(P.loaded(P.syncInit(), false), { sort: 'name' }), r0.json) === null, 'refuse-to-write: a failed load still planned a write');
  let sync = P.queueChange(P.loaded(P.syncInit(), true), { sort: 'name', fav: ids.slice(0, 120), groups, recents: ids.slice(0, 5) });
  const plan = P.planWrite(sync, r0.json);
  ok(plan, 'nothing planned');
  sync = plan.next;
  const w1 = await c.exec(D.saveDisplayPrefs(kind, { userId: c.userId, body: plan.body }));
  ok(w1.status < 300, `POST prefs answered ${w1.status} ${w1.text}`);
  const r1 = await c.exec(D.displayPrefs(kind, c.v));
  const custom = r1.json.CustomPrefs ?? {};
  const chunks = Object.keys(custom).filter((k) => /^lt\.groups\.\d+$/.test(k));
  ok(chunks.length >= 3, `groups wrote ${chunks.length} chunk keys`);
  ok(Object.values(custom).every((v) => typeof v === 'string' && P.utf8Length(v) <= P.CHUNK_BYTES), 'a CustomPrefs value is not a string or is above 6 kB');
  const back = P.decodePrefs(custom);
  ok(back.sort === 'name' && back.fav.join() === ids.slice(0, 120).join() && JSON.stringify(back.groups) === JSON.stringify(groups) && back.recents.length === 5, 'round trip changed the prefs');
  // Shrink the groups: the stale chunk keys go, the other fields stay.
  const plan2 = P.planWrite(P.queueChange(sync, { groups: groups.slice(0, 1) }), r1.json);
  ok((await c.exec(D.saveDisplayPrefs(kind, { userId: c.userId, body: plan2.body }))).status < 300, 'second POST failed');
  const custom2 = (await c.exec(D.displayPrefs(kind, c.v))).json.CustomPrefs ?? {};
  const chunks2 = Object.keys(custom2).filter((k) => /^lt\.groups\.\d+$/.test(k));
  const back2 = P.decodePrefs(custom2);
  ok(chunks2.length === 1 && back2.groups.length === 1 && back2.fav.length === 120 && back2.sort === 'name', `after shrinking: ${chunks2.length} chunk keys, ${back2.groups.length} groups, ${back2.fav.length} favourites`);
  const st = await c.state();
  ok(st.prefsWrites === 2 && st.clientEmby === 0, `prefsWrites ${st.prefsWrites}, clientEmby ${st.clientEmby}`);
  const last = st.lastPrefsPost;
  // The client=emby guard: the mock refuses it (and counts it, which fails a scenario run).
  const guard = await c.fetch('GET', `${c.prefix}/DisplayPreferences/${P.PREFS_ID}?${kind === 'emby' ? `UserId=${c.userId}&Client=emby` : `userId=${c.userId}&client=emby`}`, { headers: c.headers });
  ok(guard.status === 400 && (await c.state()).clientEmby === 1, `client=emby answered ${guard.status}`);
  return { note: `${chunks.length} group chunks round-tripped, shrunk to ${chunks2.length}; client=emby → 400`, last };
}

function check14(c, last) {
  ok(last?.queryClient === 'wicaby', `query client ${last?.queryClient}`);
  if (c.kind === 'emby') {
    ok(last.bodyClient === 'wicaby' && last.bodyId === P.PREFS_ID, `body Client ${last.bodyClient}, Id ${last.bodyId}`);
    return 'body Client "wicaby", Id "wicaby-livetv"';
  }
  ok(last.bodyClient === 'wicaby', `body Client ${last.bodyClient}`);
  return 'query client=wicaby (body Client too)';
}

// 10. A WebSocket TimerCreated updates the overlay with zero /LiveTv/Programs requests.
async function check10(c, rows) {
  const kind = c.kind;
  const ids = tvRows(rows).map((r) => r.id);
  const t = atLocal(localDayStart(Date.now()) + 5 * DAY + 2 * HOUR, 20, 50);
  const cand = (await airingAt(c, ids, t)).map((d) => M.normalizeProgram(d, { kind })).filter((p) => p && !p.timerId && !p.seriesTimerId);
  let overlay = TM.buildOverlay(TM.normalizeTimers(await timersNow(c)));
  const prog = cand.find((p) => !overlay.has(p.id));
  ok(prog, 'no programme without a timer');
  const wsUrl = `ws://${LOOPBACK}:${c.mock.port}${kind === 'emby' ? `/embywebsocket?api_key=${c.token}` : `/socket?ApiKey=${c.token}`}&deviceId=${DEVICE_ID}`;
  assertLoopbackUrl(wsUrl.replace(/^ws/, 'http'));
  const ws = new WebSocket(wsUrl);
  const seen = [];
  let refetches = 0;
  let debounce = null;
  let pending = null;
  const refetch = () =>
    (pending = timersNow(c).then((items) => {
      overlay = TM.buildOverlay(TM.normalizeTimers(items));
      refetches++;
    }));
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new CheckError('socket did not open')), 3000);
      ws.onopen = () => (clearTimeout(to), resolve());
      ws.onerror = () => (clearTimeout(to), reject(new CheckError('socket error')));
    });
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      seen.push(m.MessageType);
      // §7.2: timer events refetch the overlay (debounced), never the programmes.
      if (/^(Series)?Timer(Created|Cancelled)$|^Recording(Started|Ended)$/.test(m.MessageType)) {
        clearTimeout(debounce);
        debounce = setTimeout(refetch, 300);
      }
    };
    const before = programRequests(await c.state());
    // Another client (the server's web app) records the programme; its event reaches us over the socket.
    const cr = await c.exec(D.createTimer(kind, { body: TM.quickRecordBody(await defaultsFor(c, prog.id)) }));
    ok(cr.status < 300, `createTimer answered ${cr.status}`);
    await sleep(150);
    // Until the mock emits timer events by itself (MK-2), send the one the server would send.
    if (!seen.includes('TimerCreated')) await c.control('POST', 'Emit', { MessageType: 'TimerCreated', Data: { ProgramId: prog.id } });
    const until = Date.now() + 3000;
    while (!overlay.has(prog.id) && Date.now() < until) await sleep(25);
    await pending;
    ok(seen.includes('TimerCreated'), `socket saw ${seen.join(', ') || 'nothing'}`);
    ok(overlay.has(prog.id) && TM.markFor(prog, overlay) === 'timer', 'the overlay did not pick up the new timer');
    const after = programRequests(await c.state());
    ok(after === before, `${after - before} /LiveTv/Programs requests after the event`);
    // Cancel it the same way, so the next checks see the guide unchanged.
    const id = overlay.get(prog.id).id;
    ok((await c.exec(D.cancelTimer(kind, { id }))).status < 300, 'cancel failed');
    await sleep(150);
    if (!seen.includes('TimerCancelled')) await c.control('POST', 'Emit', { MessageType: 'TimerCancelled', Data: { Id: id } });
    const until2 = Date.now() + 3000;
    while (overlay.has(prog.id) && Date.now() < until2) await sleep(25);
    await pending;
    ok(!overlay.has(prog.id), 'TimerCancelled did not clear the mark');
    ok(programRequests(await c.state()) === before, 'TimerCancelled refetched programmes');
    return `${refetches} overlay refetches, 0 programme requests`;
  } finally {
    clearTimeout(debounce);
    ws.close();
  }
}

// 11. V15 probe on "En ce moment".
async function check11(c, expectWindow) {
  const now = Date.now();
  const r = await c.exec(D.onNow(c.kind, { userId: c.userId, now }));
  ok(r.status === 200 && r.json.Items.length > 0, `Recommended answered ${r.status}`);
  const source = M.onNowProbe(r.json.Items, now);
  if (!expectWindow) {
    ok(source === 'recommended', `probe switched to ${source} on a server that honours IsAiring`);
    return 'IsAiring honoured → recommended';
  }
  ok(source === 'window', `probe said ${source} although Emby ignored IsAiring`);
  const w = await c.exec(D.onNow(c.kind, { userId: c.userId, now, source: 'window' }));
  ok(w.status === 200 && w.json.Items.length > 0, `window query answered ${w.status}`);
  const t = Date.now();
  ok(
    w.json.Items.every((x) => M.parseServerDate(x.StartDate) <= t + 2000 && M.parseServerDate(x.EndDate) > now - 2000),
    'the window query returned a programme that is not airing',
  );
  ok(D.toUrl(D.onNow(c.kind, { userId: c.userId, now, source: 'window' })).startsWith('/LiveTv/Programs?'), 'window source is not /LiveTv/Programs');
  return `IsAiring ignored → window (${w.json.Items.length} airing)`;
}

// 13. Jellyfin hides "Inédit".
async function check13(c, raw, a, ids) {
  const caps = M.defaultCaps(c.kind);
  if (c.kind === 'jellyfin') {
    ok(!raw.some((d) => 'IsNew' in d), 'a Jellyfin programme carries IsNew');
    ok(caps.newFlag === false && !a.some((p) => p.flags & M.PF.New), 'Jellyfin programmes normalised with New');
    ok(D.channelCategorySet('jellyfin', { userId: c.userId, category: 'new' }) === null && D.onNow('jellyfin', { userId: c.userId, now: Date.now(), category: 'new' }) === null, 'the Inédits category has a Jellyfin request');
    ok(M.flagsOf({ IsNew: true }, 'jellyfin') === 0, 'flagsOf kept New on Jellyfin');
    return 'no IsNew, newFlag false, no Inédits request';
  }
  // The mock airs only repeats before 06:00, so a night-time run checks the next noon slab instead.
  if (!a.some((p) => p.flags & M.PF.New) && ids?.length) {
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    if (noon.getTime() <= Date.now()) noon.setDate(noon.getDate() + 1);
    a = normalizeAll(c, await tile(c, ids, noon.getTime(), noon.getTime() + 3 * HOUR));
  }
  ok(caps.newFlag === true && a.some((p) => p.flags & M.PF.New), 'no Emby programme carries IsNew (the badge would never show)');
  return `${a.filter((p) => p.flags & M.PF.New).length} programmes with the Inédit flag`;
}

// ---- Groups (one mock instance each, all in parallel) ----

async function core(mock) {
  const c = await new Client(mock).signIn();
  const f = c.kind;
  const rows = await lineup(c);
  const out = { c, rows };
  await check(1, f, 'lineup', () => check1(c));
  await check(2, f, 'guide window', async () => {
    const r = await check2(c, rows);
    Object.assign(out, r);
    return r.note;
  });
  const gi = await guideInfo(c);
  await check(4, f, 'category rows (flags honoured)', () => check4a(c, rows, out.a ?? []));
  await check(5, f, 'search', () => check5a(c, [...(out.a ?? []), ...(out.b ?? [])], gi.end));
  await check(6, f, 'DVR', () => check6(c, rows));
  let last = null;
  await check(9, f, 'DisplayPreferences', async () => {
    const r = await check9(c, rows);
    last = r.last;
    return r.note;
  });
  await check(14, f, 'DisplayPreferences Client', () => check14(c, last));
  await check(10, f, 'WebSocket TimerCreated', () => check10(c, rows));
  await check(11, f, 'V15 on-now probe (honoured)', () => check11(c, false));
  await check(13, f, 'Inédit badge', () => check13(c, out.rawA ?? [], out.a ?? [], out.ids));
  return out;
}

async function variant(mock) {
  const c = await new Client(mock).signIn();
  const f = c.kind;
  const rows = await lineup(c);
  await check(4, f, 'category probes (ignored, flagless)', () => check4b(c, rows));
  await check(5, f, 'search fallback', () => check5b(c, rows));
  await check(11, f, `V15 on-now probe (${f === 'emby' ? 'IsAiring ignored' : 'variant instance'})`, () => check11(c, f === 'emby'));
  await check(8, f, 'hdhr static URL', () => check8(c, rows));
  await check(7, f, 'tuner busy → release and retry', () => check7b(c, rows));
}

async function zapGroup(mock) {
  const c = await new Client(mock).signIn();
  const f = c.kind;
  const rows = await lineup(c);
  let run = null;
  await check(7, f, 'tuner hygiene (50 zaps)', async () => {
    run = await check7a(c, rows);
    return run.note;
  });
  await check(12, f, 'killEncodes', () => {
    ok(run, 'the zap run failed');
    return check12(c, run.s, run.state);
  });
}

// ---- Run ----

let exitCode = 0;
try {
  const VARIANT = { MOCK_LIVE_CATEGORY_IGNORED: '1', MOCK_LIVE_FLAGLESS: '1', MOCK_JF_PROGRAM_SEARCH: '0', MOCK_LIVE_MODE: 'hdhr', MOCK_EMBY_ONNOW: 'ignore' };
  const ZAP = { MOCK_LIVE_TUNE_MS: '800', MOCK_LIVE_TUNE_JITTER_MS: '200' };
  const specs = [
    ['emby', 'emby-core', {}],
    ['jellyfin', 'jellyfin-core', {}],
    ['emby', 'emby-variant', VARIANT],
    ['jellyfin', 'jellyfin-variant', VARIANT],
    ['emby', 'emby-zap', ZAP],
    ['jellyfin', 'jellyfin-zap', ZAP],
  ];
  const mocks = await Promise.all(specs.map(([f, label, env]) => startMock(f, label, env)));
  const byLabel = Object.fromEntries(mocks.map((m) => [m.label, m]));
  const tStart = performance.now();
  const [ce, cj] = await Promise.all([
    core(byLabel['emby-core']),
    core(byLabel['jellyfin-core']),
    variant(byLabel['emby-variant']),
    variant(byLabel['jellyfin-variant']),
    zapGroup(byLabel['emby-zap']),
    zapGroup(byLabel['jellyfin-zap']),
  ]);
  await check(3, 'both', 'Emby = Jellyfin', () => {
    ok(ce.ids && ce.slab !== undefined, 'check 2 failed on Emby');
    return check3(ce.c, cj.c, ce.ids, ce.slab);
  });

  results.sort((a, b) => a.no - b.no || a.flavour.localeCompare(b.flavour));
  for (const r of results) {
    const line = `  ${r.ok ? 'ok  ' : 'FAIL'} ${String(r.no).padStart(2)} [${r.flavour}] ${r.title}${r.msg ? `: ${r.msg}` : ''}`;
    if (!r.ok || VERBOSE) console.log(line);
    else console.log(line.length > 160 ? `${line.slice(0, 157)}...` : line);
  }
  const failed = results.filter((r) => !r.ok);
  const covered = new Set(results.filter((r) => r.ok).map((r) => `${r.no}|${r.flavour}`));
  const missing = [];
  for (let n = 1; n <= 14; n++) {
    if (n === 3) {
      if (!covered.has('3|both')) missing.push('3');
    } else for (const f of ['emby', 'jellyfin']) if (!covered.has(`${n}|${f}`)) missing.push(`${n}/${f}`);
  }
  const total = performance.now() - T0;
  if (failed.length) {
    for (const m of mocks) {
      if (!failed.some((r) => r.flavour === m.flavour || r.flavour === 'both')) continue;
      if (VERBOSE) console.log(`\n-- ${m.label} log tail --\n${m.log.slice(-25).join('\n')}`);
    }
  }
  if (total > BUDGET_MS) console.log(`  FAIL run took ${(total / 1000).toFixed(1)} s (budget ${BUDGET_MS / 1000} s)`);
  exitCode = failed.length || missing.length || total > BUDGET_MS ? 1 : 0;
  console.log(
    exitCode
      ? `\nlivetv-mock-check: ${failed.length} failure(s)${missing.length ? `, not passed: ${missing.join(' ')}` : ''}, ${(total / 1000).toFixed(1)} s.`
      : `livetv-mock-check: checks 1-14 passed on Emby and Jellyfin in ${(total / 1000).toFixed(1)} s (mocks up in ${((tStart - T0) / 1000).toFixed(1)} s).`,
  );
} catch (e) {
  console.log(`livetv-mock-check: ${e.stack ?? e}`);
  exitCode = 1;
} finally {
  cleanup();
}
process.exit(exitCode);
