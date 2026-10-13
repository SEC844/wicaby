// Live session check (docs/specs/livetv-spec-final.md §8.1, §8.2, §17.3; work package D-2).
//
// Drives apps/desktop/src/main/livetv/live-session.ts (no Electron import) against tools/mock-server
// (MOCK_LIVETV=iptv) on free loopback ports, both flavours in parallel. A minimal player side stands in for
// live-player.ts: it "shows a first frame" once it read some bytes of the chosen URL, and its Stopped report
// goes through the ledger. Every scenario ends with /Mock/LiveTv/State openStreams = 0 and doubleReleases = 0.
//
//   S15  busy pool → release, retry, learn break-before-make, toast once, next zap BBM at once
//   S16  a superseded tune whose PlaybackInfo answers after the timeout: its stream is closed on arrival
//   S17  hdhr (DirectStream only): the static URL, never noPlayMethod
//   S18  a failing channel: three rungs, the previous channel kept (MBB); a rung that opened but did not play is closed
//   S30  quit sweep with a tune pending
//   +    Open ids in query and body, Close in the query; 50 random zaps → one open stream; Jellyfin 12.2 killEncodes
//        off after a 404; VOD-path streams (a programme, a recording in progress) closed or stopped through the ledger;
//        the stream-URL 503/429 busy rule.
//
// Loopback only, no sound: the mocks serve zeros as the "video". Takes about 25 s (S16 waits for the late answer).
// Usage: node tools/checks/livetv-session-check.mjs [--only=S16]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const srcUrl = pathToFileURL(path.join(root, 'apps/desktop/src')).href + '/';
// The desktop sources import without extensions (bundler style).
registerHooks({
  resolve(s, c, next) {
    if (s.startsWith('.') && c.parentURL?.startsWith(srcUrl) && !/\.[cm]?[jt]s$/.test(s)) return next(`${s}.ts`, c);
    return next(s, c);
  },
});
const LS = await import(pathToFileURL(path.join(root, 'apps/desktop/src/main/livetv/live-session.ts')).href);
const D = await import(pathToFileURL(path.join(root, 'apps/desktop/src/shared/livetv/dialect.ts')).href);
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Pure rules ----

// §8.2: the stream URL answering 503/429 within 3 s is a busy pool. mpv says only "loading failed", so
// live-player.ts probes the URL and feeds "HTTP <status>" here.
assert.equal(LS.isBusyStream('loading failed', 500), false);
assert.equal(LS.isBusyStream('HTTP 503', 2900), true);
assert.equal(LS.isBusyStream('HTTP 429', 100), true);
assert.equal(LS.isBusyStream('HTTP 503', 3100), false);
assert.equal(LS.isBusyStream('HTTP 0', 100), false);
assert.equal(LS.isBusyStream('HTTP 5030', 100), false);
// §21.5 display mode for live (DM-1): cadence families from the measured frame rate, a switch only across them.
{
  assert.deepEqual(LS.cadenceTarget(25), { family: 50, hz: 50 }); // 1080i25 decoded as frames
  assert.deepEqual(LS.cadenceTarget(50), { family: 50, hz: 50 }); // 1080i25 deinterlaced to fields, 720p50
  assert.deepEqual(LS.cadenceTarget(59.94), { family: 60, hz: 59.94 });
  assert.deepEqual(LS.cadenceTarget(29.97), { family: 60, hz: 59.94 });
  assert.deepEqual(LS.cadenceTarget(23.976), { family: 24, hz: 23.976 });
  assert.deepEqual(LS.cadenceTarget(24), { family: 24, hz: 24 });
  for (const v of [undefined, 0, 5, 37, 27.5]) assert.equal(LS.cadenceTarget(v), null);
  const gate = new LS.CadenceGate();
  assert.equal(gate.next(25), 50); // first channel: match once
  let switches = 0;
  // 20 zaps between two 1080i25 channels (one measured as frames, one as deinterlaced fields): no switch.
  for (let i = 0; i < 20; i++) if (gate.next(i % 2 ? 25 : 50.02) !== null) switches++;
  assert.equal(switches, 0);
  assert.equal(gate.next(59.94), 59.94); // 1080i25 → 720p60: one switch
  assert.equal(gate.next(60), null);
  assert.equal(gate.next(undefined), null); // radio / no estimate: keep
  gate.reset(); // stop restored the display
  assert.equal(gate.next(59.94), 59.94);
}
// §8.8 timeshift (D-7): window sizing, the 1 GiB memory cap, the free-space fallback, the rebase threshold,
// the wall-clock mapping and the seek clamp.
{
  const GIB = 1024 ** 3;
  const noDisk = () => assert.fail('free space is asked only above 15 min');
  assert.deepEqual(LS.timeshiftPlan(0, 8e6, noDisk, 'C:\\c'), { mode: 'off', windowMs: 0, windowBytes: 0, options: [] });
  const m = LS.timeshiftPlan(15, 3e6, noDisk, 'C:\\c'); // 15 min × 60 × 0.375 MB/s × 1.2 = 405 MB: the full window
  assert.equal(m.mode, 'memory');
  assert.equal(m.windowMs, 15 * 60_000);
  assert.equal(m.limited, undefined);
  assert.deepEqual(Object.fromEntries(m.options), { 'demuxer-seekable-cache': 'yes', 'force-seekable': 'yes', 'demuxer-max-back-bytes': '405000000', 'demuxer-max-bytes': '405000000' });
  // Memory mode: back + forward ≤ 1 GiB of RAM, so each side is capped at 512 MiB.
  const capped = LS.timeshiftPlan(15, undefined, noDisk, 'C:\\c'); // 12 Mbps default: 1.62 GB > 512 MiB
  assert.equal(capped.windowBytes, GIB / 2);
  assert.equal(capped.limited, 'memory');
  const o = Object.fromEntries(capped.options);
  assert.ok(Number(o['demuxer-max-back-bytes']) + Number(o['demuxer-max-bytes']) <= GIB);
  assert.ok(capped.windowMs < 5 * 60_000 && capped.windowMs > 4.5 * 60_000);
  const disk = LS.timeshiftPlan(60, 12e6, () => 100 * GIB, 'C:\\Users\\a b\\live-cache');
  assert.equal(disk.mode, 'disk');
  assert.equal(disk.windowMs, 60 * 60_000);
  assert.equal(Object.fromEntries(disk.options)['demuxer-cache-dir'], 'C:\\Users\\a b\\live-cache');
  const tight = LS.timeshiftPlan(60, 12e6, () => 3 * 6.48e9, 'C:\\c'); // < 3 × window + 2 GiB
  assert.equal(tight.mode, 'memory');
  assert.equal(tight.limited, 'space');
  assert.equal(Object.fromEntries(tight.options)['cache-on-disk'], undefined);
  assert.equal(LS.rebaseBytes(disk.windowBytes), 4 * disk.windowBytes);
  assert.equal(LS.rebaseBytes(0.1 * GIB), 4 * GIB);
  assert.equal(LS.rebaseBytes(disk.windowBytes, 2 * GIB), 2 * GIB); // S21b forces 2 GiB
  // Rebase: only at the edge; at the boundary, 10 min after the crossing, or at once past 1.05 × the threshold.
  const T = 2 * GIB;
  const t0 = 1e12;
  assert.equal(LS.rebaseDue(T - 1, T, true, t0, t0, t0), false);
  assert.equal(LS.rebaseDue(T, T, true, t0, t0, t0 + 60_000), false);
  assert.equal(LS.rebaseDue(T, T, true, t0 + 60_000, t0, t0 + 60_000), true); // the boundary
  assert.equal(LS.rebaseDue(T, T, true, t0 + 10 * 60_000, t0, null), true); // 10 min after the crossing
  assert.equal(LS.rebaseDue(1.05 * T, T, true, t0, t0, null), true); // the ceiling, mid-programme
  assert.equal(LS.rebaseDue(2 * T, T, false, t0 + 3_600_000, t0, t0), false); // never behind the edge or paused
  // Window from mpv's seekable ranges (ms of player time), at most windowMs, around the position.
  assert.equal(LS.timeshiftWindow(5_000, [], 60_000), null);
  assert.deepEqual(LS.timeshiftWindow(100_000, [[0, 120_000]], 60_000), { start: 60_000, end: 120_000 });
  assert.deepEqual(LS.timeshiftWindow(30_000, [[0, 120_000]], 600_000), { start: 0, end: 120_000 });
  const win = { start: 60_000, end: 120_000 };
  assert.equal(LS.clampLiveSeek(10_000, win, 90_000), 60_000);
  assert.equal(LS.clampLiveSeek(500_000, win, 90_000), 120_000 - LS.TIMESHIFT_EDGE_MARGIN_MS);
  // At the edge playback runs past win.end (the last keyframe): → never seeks backwards, ← still does.
  assert.equal(LS.clampLiveSeek(131_000, win, 121_000), null);
  assert.equal(LS.clampLiveSeek(119_000, win, 118_500), null);
  assert.equal(LS.clampLiveSeek(111_000, win, 121_000), 111_000);
  // S21: wall clock = tune wall + (pos − first pos); "Revenir au direct" only more than 15 s behind.
  const anchor = { wall: Date.UTC(2026, 9, 11, 20, 0, 0), pos: 1_000 };
  const v = LS.timeshiftWall(anchor, 90_000, win);
  assert.equal(v.startWall, anchor.wall + 59_000);
  assert.equal(v.endWall, anchor.wall + 119_000);
  assert.equal(v.posWall, anchor.wall + 89_000);
  assert.equal(v.atEdge, false);
  assert.equal(LS.timeshiftWall(anchor, 106_000, win).atEdge, true);
  // Past the last keyframe at the edge: the edge is the position, never behind it.
  assert.equal(LS.timeshiftWall(anchor, 123_000, win).endWall, anchor.wall + 122_000);
  // live-cache: emptied (a held file is skipped, not fatal); a missing dir is fine.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-live-cache-'));
  fs.writeFileSync(path.join(dir, 'mpv-cache-1'), 'x');
  LS.clearLiveCache(dir);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true });
  LS.clearLiveCache(dir);
}
const livePlayer = fs.readFileSync(path.join(root, 'apps/desktop/src/main/livetv/live-player.ts'), 'utf8');
assert.match(livePlayer, /isBusyStream\(`HTTP \$\{await streamStatus\(/, 'live-player probes the stream URL on an early load error');

// ---- Mocks (loopback) ----

const VIDEO = path.join(os.tmpdir(), `wicaby-livetv-session-check-${process.pid}.mkv`);
fs.writeFileSync(VIDEO, Buffer.alloc(256 * 1024));
const BOOT = `data:text/javascript,${encodeURIComponent("import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'&&(a.length===1||typeof a[1]==='function'))a.splice(1,0,'127.0.0.1');return l.apply(this,a)};")}`;
const kids = new Set();
process.on('exit', () => {
  kids.forEach((k) => k.kill());
  fs.rmSync(VIDEO, { force: true });
});

const freePort = () =>
  new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });

async function mock(flavour, env) {
  const port = await freePort();
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MOCK_')));
  const child = spawn(process.execPath, ['--import', BOOT, path.join(root, `tools/mock-server/mock-${flavour}.mjs`), String(port), VIDEO], {
    cwd: root,
    env: { ...clean, MOCK_LIVETV: 'iptv', MOCK_LIVE_SEED: '42', MOCK_TUNERS: '2', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  kids.add(child);
  const log = [];
  await new Promise((res, rej) => {
    const on = (b) => {
      for (const l of String(b).split(/\r?\n/)) {
        if (l) log.push(l);
        if (/^Mock (Emby|Jellyfin)/.test(l)) res();
      }
    };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.once('exit', (c) => rej(new Error(`mock exit ${c}\n${log.join('\n')}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const prefix = flavour === 'emby' ? '/emby' : '';
  const AUTH = 'Client="Wicaby check", Device="check", DeviceId="livetv-session-check", Version="1.0.0"';
  const h0 = flavour === 'emby' ? { 'X-Emby-Authorization': `MediaBrowser ${AUTH}` } : { Authorization: `MediaBrowser ${AUTH}` };
  const a = await (
    await fetch(`${base}${prefix}/Users/AuthenticateByName`, { method: 'POST', headers: { ...h0, 'Content-Type': 'application/json' }, body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }) })
  ).json();
  const headers = flavour === 'emby' ? { 'X-Emby-Token': a.AccessToken } : { Authorization: `MediaBrowser ${AUTH}, Token="${a.AccessToken}"` };
  const reqLog = [];
  const api = {
    kind: flavour,
    userId: a.User.Id,
    async request(method, p, query, body, timeoutMs = 20_000) {
      const url = `${base}${prefix}${D.toUrl({ method, path: p, query: query ?? {} })}`;
      assert.equal(new URL(url).hostname, '127.0.0.1');
      reqLog.push({ method, p, query, body });
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method, headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
        const text = await res.text();
        if (!res.ok) throw Object.assign(new Error(text.slice(0, 300) || `HTTP ${res.status}`), { status: res.status });
        return text ? JSON.parse(text) : undefined;
      } finally {
        clearTimeout(tm);
      }
    },
  };
  const state = async () => (await fetch(`${base}/Mock/LiveTv/State`)).json();
  const control = (what) => fetch(`${base}/Mock/LiveTv/${what}`, { method: 'POST' });
  const chans = (await api.request('GET', '/LiveTv/Channels', { UserId: api.userId, StartIndex: '0', Limit: '50', EnableUserData: 'false' })).Items.filter(
    (c) => c.ChannelType !== 'Audio' && c.Type === 'TvChannel',
  );
  return { api, state, control, chans, reqLog, base, prefix, headers, kill: () => child.kill() };
}

// A minimal player side: the adopted stream, a make-before-break zap, Stopped reports through the ledger.
function rig(m, settings = { release: 'auto', releaseFirst: {} }) {
  const notices = [];
  const session = new LS.LiveSession({
    deviceId: 'livetv-session-check',
    settings: () => settings,
    saveReleaseFirst: (id, until) => {
      if (until === null) delete settings.releaseFirst[id];
      else settings.releaseFirst[id] = { until };
    },
    notice: (k) => notices.push(k),
    api: () => m.api,
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  });
  let current = null;
  let seq = 0;
  let failPlay = null;
  const stopReport = async (o) => {
    if (!session.stopping(o, true)) return session.closeUnadopted(o);
    await m.api.request('POST', '/Sessions/Playing/Stopped', {}, { ItemId: o.channelId, MediaSourceId: o.source.Id, PlaySessionId: o.playSessionId, LiveStreamId: o.liveStreamId, PlayMethod: o.playMethod });
  };
  const play = async (o) => {
    if (failPlay?.(o)) throw new LS.LiveError('play', 'decoder');
    const url = o.play.kind === 'static' ? `${m.base}${m.prefix}${D.toUrl(o.play.req)}` : new URL(o.play.url.startsWith('http') ? o.play.url : `${m.prefix}${o.play.url}`, m.base).href;
    assert.equal(new URL(url).hostname, '127.0.0.1');
    const ctl = new AbortController();
    const res = await fetch(url, { headers: m.headers, signal: ctl.signal });
    if (!res.ok) throw new LS.LiveError(LS.isBusyStream(`HTTP ${res.status}`, 0) ? 'busy' : 'play', `HTTP ${res.status}`);
    await res.body.getReader().read();
    ctl.abort();
  };
  const tune = async (channelId, extra = {}) => {
    const my = ++seq;
    const o = await session.tune(
      { api: m.api, serverId: 'srv', channelId, maxBitrate: 40_000_000, deviceProfile: () => ({}), staticOk: true, stale: () => my !== seq, ...extra },
      {
        hasCurrent: () => !!current,
        releaseCurrent: async () => {
          const c = current;
          current = null;
          if (c) await stopReport(c);
        },
        play,
      },
    );
    if (o) {
      const prev = current;
      current = o;
      if (prev) await stopReport(prev);
    }
    return o;
  };
  const stop = async () => {
    seq++;
    const c = current;
    current = null;
    if (c) await stopReport(c);
  };
  return {
    session,
    notices,
    tune,
    stop,
    get current() {
      return current;
    },
    set failPlay(f) {
      failPlay = f;
    },
  };
}

const noLeak = async (m) => {
  await sleep(200);
  const s = await m.state();
  assert.equal(s.openStreams.length, 0, `openStreams ${JSON.stringify(s.openStreams)}`);
  assert.equal(s.doubleReleases, 0, 'doubleReleases');
  return s;
};

const scenarios = {
  async 'S15 busy -> release, retry, BBM'(flavour) {
    const m = await mock(flavour, { MOCK_TUNERS: '1', MOCK_LIVE_MODE: 'direct' });
    const r = rig(m);
    await r.tune(m.chans[0].Id);
    assert.ok(await r.tune(m.chans[1].Id), 'retry succeeded');
    assert.deepEqual(r.notices, ['player.live.tunerReleased']);
    assert.equal(r.session.policy('srv'), 'bbm');
    const before = (await m.state()).busyRejects;
    await r.tune(m.chans[2].Id);
    assert.equal((await m.state()).busyRejects, before, 'next zap BBM at once (no busy)');
    assert.equal(r.notices.length, 1, 'toast once');
    await r.stop();
    assert.ok((await noLeak(m)).stopReleases >= 3);
    m.kill();
  },

  async 'S16 late answer closed'(flavour) {
    const m = await mock(flavour, { MOCK_LIVE_MODE: 'direct' });
    const r = rig(m);
    await m.control('Fault?kind=pbiSlow&count=1');
    const p = r.tune(m.chans[0].Id).catch((e) => e);
    await sleep(500);
    assert.ok(await r.tune(m.chans[1].Id));
    assert.equal(await p, null, 'superseded tune resolves null');
    // The answer comes at 20 s (pbiSlow), after the 15 s tune timeout.
    for (const until = Date.now() + 25_000; r.session.snapshot().counters.late < 1 && Date.now() < until; ) await sleep(250);
    await sleep(300);
    // The mock opened the late tuner even though the tune was abandoned: only the client's Close frees it.
    const s = await m.state();
    assert.equal(s.openStreams.length, 1, 'only the adopted one');
    assert.equal(r.session.snapshot().counters.late, 1, 'late answer seen and closed');
    await r.stop();
    await noLeak(m);
    m.kill();
  },

  async 'S17 hdhr DirectStream static'(flavour) {
    const m = await mock(flavour, { MOCK_LIVE_MODE: 'hdhr' });
    const r = rig(m);
    const o = await r.tune(m.chans[0].Id);
    assert.equal(o.play.kind, 'static');
    assert.equal(o.playMethod, 'DirectStream');
    assert.match(o.play.req.path, /^\/Videos\/.+\/stream\.\w+$/);
    assert.equal(String(o.play.req.query.Static), 'true');
    assert.ok(o.play.req.query.LiveStreamId);
    await r.stop();
    await noLeak(m);
    m.kill();
  },

  async 'S18 failing channel: ladder, each rung closed'(flavour) {
    const m0 = await mock(flavour, {});
    const bad = m0.chans[3].Id;
    m0.kill();
    const m = await mock(flavour, { MOCK_LIVE_FAIL: bad });
    const r = rig(m);
    const good = await r.tune(m.chans[0].Id);
    assert.ok((await r.tune(bad).catch((e) => e)) instanceof LS.LiveError, 'rejects');
    assert.equal(m.reqLog.filter((q) => q.p === `/Items/${bad}/PlaybackInfo`).length, 3, 'three rungs');
    assert.equal(r.current, good, 'previous channel still current (MBB)');
    assert.ok(r.session.isOpen(good.liveStreamId));
    // A rung whose stream opened but did not play: closed, next rung.
    r.failPlay = (o) => o.channelId === m.chans[1].Id && o.rung < 2;
    assert.equal((await r.tune(m.chans[1].Id)).rung, 2);
    assert.equal((await m.state()).openStreams.length, 1);
    await r.stop();
    await noLeak(m);
    m.kill();
  },

  async 'opening: Open ids in query and body, Close in query'(flavour) {
    const m = await mock(flavour, { MOCK_LIVE_MODE: 'opening' });
    const r = rig(m);
    assert.ok((await r.tune(m.chans[0].Id)).liveStreamId);
    const s = await m.state();
    assert.ok(s.openIdsInQuery >= 1 && s.openIdsInBody >= 1, JSON.stringify({ q: s.openIdsInQuery, b: s.openIdsInBody }));
    // A superseded rung closes by LiveStreams/Close.
    r.failPlay = () => true;
    await r.tune(m.chans[1].Id).catch(() => null);
    r.failPlay = null;
    await r.stop();
    const closes = m.reqLog.filter((q) => q.p === '/LiveStreams/Close');
    assert.ok(closes.length >= 1);
    for (const c of closes) {
      assert.equal(c.body, undefined);
      assert.ok(c.query.LiveStreamId && c.query.PlaySessionId);
    }
    await noLeak(m);
    m.kill();
  },

  async 'S30 quit sweep (tuned + pending)'(flavour) {
    const m = await mock(flavour, { MOCK_LIVE_MODE: 'direct', MOCK_LIVE_TUNE_MS: '1000' });
    const r = rig(m);
    await r.tune(m.chans[0].Id);
    const pending = r.tune(m.chans[1].Id).catch(() => null);
    await sleep(300);
    const t0 = Date.now();
    await r.stop();
    await r.session.sweep(LS.QUIT_SWEEP_MS);
    assert.ok(Date.now() - t0 < 2000, 'within 2 s');
    await pending;
    await sleep(500);
    await noLeak(m);
    m.kill();
  },

  async '50 random zaps, MBB, jitter'(flavour) {
    const m = await mock(flavour, { MOCK_LIVE_TUNE_MS: '300', MOCK_LIVE_TUNE_JITTER_MS: '500' });
    const r = rig(m);
    const tunes = [];
    for (let i = 0; i < 50; i++) {
      tunes.push(r.tune(m.chans[(i * 7) % m.chans.length].Id).catch((e) => e));
      await sleep(Math.random() * 150);
    }
    await Promise.all(tunes);
    await sleep(300);
    const s = await m.state();
    assert.equal(s.openStreams.length, 1, `one open: ${s.openStreams.length}`);
    assert.equal(s.doubleReleases, 0);
    await r.stop();
    await noLeak(m);
    m.kill();
  },

  // The VOD path (a programme, a recording in progress) can get a tuner stream from PlaybackInfo
  // (AutoOpenLiveStream): live-player.ts puts it in the ledger. Never played → closed; played → Stopped once.
  async 'VOD-path streams through the ledger'(flavour) {
    const m = await mock(flavour, { MOCK_LIVE_MODE: 'direct' });
    const r = rig(m);
    const pbi = async (id) => {
      const q = D.tune(m.api.kind, { userId: m.api.userId, channelId: id, maxBitrate: 40_000_000, rung: 0, deviceProfile: {} });
      const info = await m.api.request(q.method, q.path, q.query, q.body);
      const ps = info.MediaSources[0];
      assert.ok(ps.LiveStreamId, 'auto-opened');
      r.session.recordVod(m.api, 'srv', id, info.PlaySessionId, ps);
      return { info, ps };
    };
    await pbi(m.chans[0].Id);
    assert.equal((await m.state()).openStreams.length, 1);
    await r.session.closeOrphans();
    assert.equal((await m.state()).openStreams.length, 0, 'an orphan is closed');
    const { info, ps } = await pbi(m.chans[1].Id);
    r.session.adoptVod(ps.LiveStreamId);
    await r.session.closeOrphans();
    assert.equal((await m.state()).openStreams.length, 1, 'an adopted one is kept');
    assert.equal(r.session.stopping({ liveStreamId: ps.LiveStreamId }, true), true);
    await m.api.request('POST', '/Sessions/Playing/Stopped', {}, { ItemId: m.chans[1].Id, MediaSourceId: ps.Id, PlaySessionId: info.PlaySessionId, LiveStreamId: ps.LiveStreamId });
    assert.equal(r.session.stopping({ liveStreamId: ps.LiveStreamId }, true), false, 'released once');
    await r.session.sweep(LS.QUIT_SWEEP_MS);
    await noLeak(m);
    m.kill();
  },
};

async function jf122() {
  const m = await mock('jellyfin', { MOCK_JF_VERSION: '12.2', MOCK_LIVE_MODE: 'hls' });
  const r = rig(m);
  const o = await r.tune(m.chans[0].Id);
  assert.equal(o.play.kind, 'transcode');
  await r.session.killEncodes('srv', o.playSessionId);
  await r.session.killEncodes('srv', o.playSessionId);
  assert.equal(m.reqLog.filter((q) => q.p === '/Videos/ActiveEncodings').length, 1);
  assert.deepEqual(r.session.snapshot().killEncodesOff, ['srv']);
  await r.stop();
  await noLeak(m);
  m.kill();
}

const results = [];
async function run(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push(`PASS ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.stack}`);
  }
}

const t0 = Date.now();
// Each flavour runs in order; S16 (~21 s, it waits for its late answer) runs beside the rest.
await Promise.all([
  ...['emby', 'jellyfin'].map((f) => run(`${f} S16 late answer closed`, () => scenarios['S16 late answer closed'](f))),
  ...['emby', 'jellyfin'].map(async (flavour) => {
    for (const [name, fn] of Object.entries(scenarios)) if (!name.startsWith('S16')) await run(`${flavour} ${name}`, () => fn(flavour));
  }),
  run('jellyfin 12.2 killEncodes off after a 404', jf122),
]);
console.log(results.join('\n'));
const failed = results.filter((l) => l.startsWith('FAIL')).length;
console.log(failed ? `livetv-session-check: ${failed} failed` : `livetv-session-check: ok (${results.length} scenarios, ${Date.now() - t0} ms)`);
process.exit(failed ? 1 : 0);
