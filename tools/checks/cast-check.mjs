// Self-check for the desktop Sessions-API sender (docs/specs/cast-spec.md CA-04):
// - pure: the golden fixtures in fixtures/cast/ (target filtering and dedupe, the /Playing query, the command
//   bodies with string values, the §2.3 greyed-out matrix) against main/cast/targets.ts and sessions-sender.ts;
// - against mock Jellyfin and mock Emby on loopback, with the real ConnectionManager signed in as desktop A, a CA-01
//   virtual session as receiver B and a fake local player standing in for PlaybackService (no mpv, nothing audible):
//   A lists B and not itself; a handoff sends PlayNow with A's position and tracks, pauses on the 204 and stops A
//   once B shows the item; B's pause and seek reach A's mirror within 2 s (push) or 3 s (MOCK_NO_SESSIONS_PUSH=1);
//   "Reprendre ici" stops B and plays here within 2 s of B's position; SeekRelative and SetPlaybackRate on Emby
//   only; a channel goes without position, its tuner released before /Playing only under break-before-make; a
//   session that ignores Play resumes A with cast.error.unreachable.
// Usage: node tools/checks/cast-check.mjs   (starts mocks on 8971-8973, then stops them)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(import.meta.dirname, '..', '..');
const root = path.join(repo, 'apps', 'desktop');
const fixtures = path.join(import.meta.dirname, 'fixtures', 'cast');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-cast-'));
const src = (p) => path.join(root, 'src/main', p).replace(/\\/g, '/');
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `export * from '${src('cast/targets.ts')}';
export { requestFor } from '${src('cast/sessions-sender.ts')}';
export { CastManager } from '${src('cast/cast-manager.ts')}';
export { ConnectionManager, supportedCommands } from '${src('connection/connection-manager.ts')}';
`,
);
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export const net = { fetch: (...a) => fetch(...a) }; export const app = { isReady: () => false, isPackaged: true, getLocale: () => 'fr' }; export const safeStorage = {}; export const powerSaveBlocker = {}; export const protocol = {}; export const session = {};`,
    }));
  },
};
const out = path.join(tmp, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [electronStub] });
const C = await import(pathToFileURL(out).href);

// ---- Pure: golden fixtures ----
{
  const f = fixture('targets.json');
  const rows = C.sessionTargets(f.sessions, f.ctx);
  assert.deepEqual(rows.map((r) => r.key), f.expected.map((e) => e.key), 'section 1 filters (own device, no remote control, media type)');
  for (const [i, e] of f.expected.entries()) for (const [k, v] of Object.entries(e)) assert.deepEqual(rows[i][k], v, `${e.key}.${k}`);
  assert.deepEqual(rows[0].commands, f.sessions[1].SupportedCommands);
  assert.deepEqual(rows[1].mediaTypes, [], 'only the exact Audio/Video spellings cross as media types');
  assert.deepEqual(C.mergeTargets(rows, f.ssdp, f.cast).map((r) => r.key), f.merged, 'section order and SSDP dedupe');
  for (const c of f.sessionsOnly) assert.equal(C.sessionsOnly(c.item), c.expected, JSON.stringify(c.item));
}
for (const c of fixture('play-query.json').cases) assert.deepEqual(C.playQuery(c.options, c.live), c.query, c.name);
{
  const f = fixture('controls.json');
  for (const m of f.matrix) assert.deepEqual(C.controlsFor(m.target, m.server, m.queueLength), m.expected, m.name);
  for (const r of f.requests) assert.deepEqual(C.requestFor(r.cmd, { server: r.server, controls: r.controls, positionTicks: r.positionTicks }), r.expected, JSON.stringify(r.cmd) + ' ' + r.server);
  for (const v of [Number.NaN, Infinity]) assert.equal(C.requestFor({ type: 'seek', positionTicks: v }, { server: 'emby', controls: f.matrix[1].expected, positionTicks: 0 }), null, 'NaN never goes out');
  assert.deepEqual(C.commandBody('SetVolume', { Volume: 40, Flag: true }), { Name: 'SetVolume', Arguments: { Volume: '40', Flag: 'true' } }, 'argument values are strings');
}

// ---- Against the mocks (loopback only) ----
const TICKS = 10_000;
const children = [];
function startMock(script, port, env = {}) {
  const child = spawn(process.execPath, [path.join(repo, 'tools/mock-server', script), String(port)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...env } });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`${script} exited (${code}): is port ${port} taken?`)));
    child.stdout.on('data', (d) => String(d).includes(`:${port}`) && resolve());
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return Date.now() - t0;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms: ${what}`);
    await wait(25);
  }
}

class FakeVault {
  entries = {};
  get(id) {
    return this.entries[id];
  }
  set(id, c) {
    this.entries[id] = JSON.parse(JSON.stringify(c));
  }
  delete(id) {
    delete this.entries[id];
  }
}

// PlaybackService as the cast manager sees it; log keeps the order of calls.
class FakeLocal {
  log = [];
  snapshot = null;
  onStop = null;
  castSnapshot() {
    return this.snapshot;
  }
  async command(cmd) {
    this.log.push(cmd.type);
  }
  async stop() {
    this.log.push('stop');
    await this.onStop?.();
    this.snapshot = null;
  }
  async play(req) {
    this.log.push('play');
    this.played = req;
  }
}

async function desktop(base, deviceId) {
  const m = new C.ConnectionManager(path.join(tmp, `servers-${deviceId}.json`), new FakeVault(), { client: 'Wicaby', version: '0.2.0', deviceId, deviceName: 'pc-a' });
  const info = await m.add(base);
  await m.select(info.id);
  await m.login('Wika', 'wicaby', info.id);
  const conn = [...m.conns.values()][0];
  const local = new FakeLocal();
  const toasts = [];
  const cast = new C.CastManager({ connection: m, local, deviceId, notify: (kind, message) => toasts.push({ kind, message }) });
  // index.ts routes the socket's Sessions pushes to the cast manager.
  m.on('server-message', (msg, sid) => msg.MessageType === 'Sessions' && cast.onSessions(sid, msg.Data));
  return { m, conn, serverId: info.id, local, toasts, cast };
}

const mockState = async (root) => (await fetch(`${root}/Mock/State`)).json();
const virtual = async (root, body) => (await fetch(`${root}/Mock/Sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const drive = (root, id, action, q = '') => fetch(`${root}/Mock/Sessions/${id}/${action}${q}`, { method: 'POST' });

try {
  const JF = 8971;
  const EMBY = 8972;
  const JF_POLL = 8973;
  await Promise.all([startMock('mock-jellyfin.mjs', JF), startMock('mock-emby.mjs', EMBY), startMock('mock-jellyfin.mjs', JF_POLL, { MOCK_NO_SESSIONS_PUSH: '1' })]);
  C.CastManager.confirmTimeoutMs = 2000;

  // ---- Jellyfin: AC 1, 2, 3, 4 (Jellyfin side), 5 ----
  {
    const root = `http://127.0.0.1:${JF}`;
    const A = await desktop(root, 'desk-a');
    const B = await virtual(root, { DeviceName: 'Living room', Client: 'Wicaby TV', DeviceId: 'tv-b', SupportedCommands: C.supportedCommands('jellyfin') });
    // A is controllable itself (capabilities and socket): the server lists it, the picker does not.
    await until(async () => (await A.conn.client.get('/Sessions', { ControllableByUserId: A.conn.client.userId })).some((s) => s.DeviceId === 'desk-a'), 3000, 'A listed by the server');
    const list = await A.cast.targets('movie-1', A.serverId);
    const b = list.find((t) => t.deviceId === 'tv-b');
    assert.ok(b, 'A lists B');
    assert.equal(b.section, 'apps');
    assert.ok(!list.some((t) => t.deviceId === 'desk-a'), 'A does not list itself');

    // AC 1: handoff from A's player.
    const pos = 1234 * 1000 * TICKS;
    A.local.snapshot = { serverId: A.serverId, itemIds: ['movie-1', 'movie-2'], startIndex: 0, positionTicks: pos, msid: 'movie-1', audio: 1, sub: 3, live: false, policy: 'mbb' };
    let stoppedWith = null;
    A.local.onStop = async () => (stoppedWith = (await mockState(root)).remote.filter((r) => r.MessageType === 'Play').length);
    await A.cast.start(b.key);
    const play = (await mockState(root)).remote.findLast((r) => r.MessageType === 'Play');
    assert.equal(play.DeviceId, 'tv-b');
    assert.deepEqual(play.Data.ItemIds, ['movie-1', 'movie-2']);
    assert.equal(play.Data.PlayCommand, 'PlayNow');
    assert.equal(play.Data.StartPositionTicks, pos, 'A\'s position');
    assert.equal(play.Data.AudioStreamIndex, 1);
    assert.equal(play.Data.SubtitleStreamIndex, 3);
    assert.equal(play.Data.MediaSourceId, 'movie-1');
    assert.deepEqual(A.local.log, ['pause', 'stop'], 'A pauses on the 204, then stops (Stopped at the handoff position)');
    assert.equal(stoppedWith, 1, 'A stopped after the Play went out');
    assert.equal(A.cast.state.status, 'playing');
    assert.equal(A.cast.state.item.id, 'movie-1');
    assert.ok(A.toasts.some((t) => t.kind === 'success'), 'cast.toast.started');
    assert.equal(A.cast.state.controls.seekRelative, false, 'AC 4: no SeekRelative on Jellyfin');
    assert.equal(A.cast.state.controls.rate, false, 'AC 4: no SetPlaybackRate on Jellyfin');
    assert.equal(A.cast.state.controls.nextPrev, true);
    await assert.rejects(A.cast.control({ type: 'rate', value: 1.5 }), 'SetPlaybackRate is never sent to Jellyfin');

    // AC 2 (push): B's own user pauses, then seeks.
    await wait(300);
    await drive(root, B.Id, 'Pause');
    const pauseMs = await until(() => A.cast.state?.paused === true, 2000, 'pause mirrored (push)');
    const seekTo = 3000 * 1000 * TICKS;
    await drive(root, B.Id, 'Seek', `?PositionTicks=${seekTo}`);
    const seekMs = await until(() => Math.abs(A.cast.state.positionTicks - seekTo) < 1000 * TICKS, 2000, 'seek mirrored (push)');
    console.log(`cast-check: Jellyfin push mirror: pause ${pauseMs} ms, seek ${seekMs} ms`);
    await drive(root, B.Id, 'Unpause');
    await until(() => A.cast.state?.paused === false, 2000, 'unpause mirrored');
    // A remote command reaches B.
    await A.cast.control({ type: 'seek-relative', deltaTicks: -60 * 1000 * TICKS });
    const seek = (await mockState(root)).remote.findLast((r) => r.MessageType === 'Playstate');
    assert.equal(seek.Data.Command, 'Seek', 'Jellyfin gets an absolute Seek for a relative one');
    await A.cast.control({ type: 'volume', value: 30 });
    const vol = (await mockState(root)).remote.findLast((r) => r.MessageType === 'GeneralCommand');
    assert.deepEqual(vol.Data.Arguments, { Volume: '30' });

    // AC 3: "Reprendre ici".
    await wait(500);
    const bNow = (await A.conn.client.get('/Sessions', { DeviceId: 'tv-b' }))[0].PlayState.PositionTicks;
    A.local.log = [];
    await A.cast.takeBack();
    const stopB = (await mockState(root)).remote.findLast((r) => r.MessageType === 'Playstate');
    assert.equal(stopB.Data.Command, 'Stop', 'B is stopped');
    assert.equal(A.cast.state, null, 'the cast ended');
    assert.deepEqual(A.local.log, ['play']);
    assert.equal(A.local.played.itemIds[A.local.played.startIndex], 'movie-1');
    // PlaybackService.play rewinds a resume by 5 s: what A shows first.
    const resumedAt = A.local.played.startPositionTicks - 5000 * TICKS;
    assert.ok(Math.abs(resumedAt - bNow) <= 2000 * TICKS, `A resumes within 2 s of B (${(resumedAt - bNow) / TICKS} ms)`);
    assert.equal(A.local.played.audioStreamIndex, 1);
    assert.equal(A.local.played.subtitleStreamIndex, 3);

    // AC 5: a channel lists only session targets, and its Play carries no position.
    const ch = await A.cast.targets('ch-1', A.serverId);
    assert.ok(ch.length > 0 && ch.every((t) => t.kind === 'session'), 'channel: session targets only');
    for (const policy of ['bbm', 'mbb']) {
      A.local.log = [];
      A.local.snapshot = { serverId: A.serverId, itemIds: ['ch-1'], startIndex: 0, positionTicks: 999 * TICKS, msid: 'ch-1', audio: 1, sub: -1, live: true, policy };
      const before = (await mockState(root)).remote.filter((r) => r.MessageType === 'Play').length;
      A.local.onStop = async () => (stoppedWith = (await mockState(root)).remote.filter((r) => r.MessageType === 'Play').length - before);
      await A.cast.start(b.key);
      const p = (await mockState(root)).remote.findLast((r) => r.MessageType === 'Play');
      assert.deepEqual(p.Data.ItemIds, ['ch-1']);
      for (const k of ['StartPositionTicks', 'MediaSourceId', 'AudioStreamIndex', 'SubtitleStreamIndex']) assert.equal(p.Data[k], undefined, `channel Play carries no ${k}`);
      if (policy === 'bbm') {
        assert.equal(stoppedWith, 0, 'break-before-make: the tuner is released before /Playing');
        assert.deepEqual(A.local.log, ['stop']);
      } else {
        assert.equal(stoppedWith, 1, 'make-before-break: released once the target confirms');
        assert.deepEqual(A.local.log, ['pause', 'stop']);
      }
      assert.equal(A.cast.state.status, 'playing');
      assert.equal(A.cast.state.controls.nextPrev, false);
      await A.cast.stop();
    }

    // A session that accepts the 204 but never plays (stale socket, §2.4): A resumes, cast.error.unreachable.
    const ghost = await virtual(root, { DeviceName: 'Fantôme', Client: 'Wicaby TV', DeviceId: 'tv-ghost', ignore: true, SupportedCommands: C.supportedCommands('jellyfin') });
    const g = (await A.cast.targets('movie-1', A.serverId)).find((t) => t.deviceId === 'tv-ghost');
    A.local.log = [];
    A.local.snapshot = { serverId: A.serverId, itemIds: ['movie-1'], startIndex: 0, positionTicks: 0, live: false, policy: 'mbb' };
    A.toasts.length = 0;
    await A.cast.start(g.key);
    assert.deepEqual(A.local.log, ['pause', 'resume'], 'A resumes when the target never shows the item');
    assert.equal(A.cast.state, null);
    assert.ok(A.toasts.some((t) => t.kind === 'error' && t.message.includes('Fantôme')), 'cast.error.unreachable');
    assert.ok(ghost.Id);

    // From an item page: options given, no local player involved.
    A.local.log = [];
    await A.cast.start(b.key, { itemIds: ['movie-2'], positionTicks: 42 * 1000 * TICKS, audio: 1, sub: -1 });
    const fromPage = (await mockState(root)).remote.findLast((r) => r.MessageType === 'Play');
    assert.deepEqual([fromPage.Data.ItemIds, fromPage.Data.StartPositionTicks, fromPage.Data.SubtitleStreamIndex], [['movie-2'], 42 * 1000 * TICKS, -1]);
    assert.deepEqual(A.local.log, []);
    await assert.rejects(A.cast.start(b.key, { itemIds: ['../x'] }), 'ids are checked');
    await A.cast.stop();
    A.cast.dispose();
    for (const c of A.m.conns.values()) c.socket?.close();
  }

  // ---- AC 2 (poll): MOCK_NO_SESSIONS_PUSH=1 ----
  {
    const root = `http://127.0.0.1:${JF_POLL}`;
    const A = await desktop(root, 'desk-poll');
    const B = await virtual(root, { DeviceName: 'Bedroom', Client: 'Wicaby TV', DeviceId: 'tv-poll', SupportedCommands: C.supportedCommands('jellyfin') });
    const b = (await A.cast.targets('movie-1', A.serverId)).find((t) => t.deviceId === 'tv-poll');
    await A.cast.start(b.key, { itemIds: ['movie-1'] });
    assert.equal(A.cast.state.status, 'playing');
    await wait(1000);
    await drive(root, B.Id, 'Pause');
    const ms = await until(() => A.cast.state?.paused === true, 3000, 'pause mirrored (poll)');
    console.log(`cast-check: Jellyfin poll mirror: pause ${ms} ms`);
    await A.cast.stop();
    A.cast.dispose();
    for (const c of A.m.conns.values()) c.socket?.close();
  }

  // ---- Emby: AC 4 (SeekRelative, SetPlaybackRate) and the push mirror ----
  {
    const root = `http://127.0.0.1:${EMBY}`;
    const A = await desktop(root, 'desk-emby');
    const B = await virtual(root, { DeviceName: 'Living room Emby', Client: 'Wicaby TV', DeviceId: 'tv-emby', SupportedCommands: C.supportedCommands('emby') });
    const b = (await A.cast.targets('movie-1', A.serverId)).find((t) => t.deviceId === 'tv-emby');
    assert.ok(b, 'emby: A lists B');
    await A.cast.start(b.key, { itemIds: ['movie-1'], positionTicks: 600 * 1000 * TICKS });
    assert.equal(A.cast.state.status, 'playing');
    assert.equal(A.cast.state.controls.seekRelative, true, 'AC 4: SeekRelative on Emby');
    assert.equal(A.cast.state.controls.rate, true, 'AC 4: SetPlaybackRate on Emby');
    await A.cast.control({ type: 'seek-relative', deltaTicks: 300_000_000 });
    const rel = (await mockState(root)).remote.findLast((r) => r.MessageType === 'Playstate');
    assert.deepEqual([rel.Data.Command, rel.Data.SeekPositionTicks], ['SeekRelative', 300_000_000]);
    await A.cast.control({ type: 'rate', value: 1.5 });
    const rate = (await mockState(root)).remote.findLast((r) => r.MessageType === 'GeneralCommand');
    assert.deepEqual([rate.Data.Name, rate.Data.Arguments], ['SetPlaybackRate', { PlaybackRate: '1.5' }]);
    await drive(root, B.Id, 'Pause');
    const ms = await until(() => A.cast.state?.paused === true, 2000, 'emby pause mirrored');
    console.log(`cast-check: Emby mirror: pause ${ms} ms`);
    await A.cast.stop();
    A.cast.dispose();
    for (const c of A.m.conns.values()) c.socket?.close();
  }
} finally {
  for (const c of children) c.kill();
}

console.log('cast-check: OK (fixtures, targets, handoff, mirror push and poll, take back, Emby-only controls, channels)');
process.exit(0);
