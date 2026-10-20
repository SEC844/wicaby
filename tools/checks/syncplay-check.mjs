// Self-check for Jellyfin SyncPlay on the desktop (main/playback/syncplay.ts, shared/syncplay.ts):
// - the /GetUtcTime offset and ping (jellyfin-web TimeSyncCore), the best-of-8 sample, delays and drift targets;
// - SyncPlay on a fake player and server 5 s ahead: join waits for GroupJoined, a PlayQueue starts the item paused at
//   the group's position and answers Ready, an Unpause stamped in the future seeks now and plays at its When,
//   a late Pause applies at once with "Paused by the group", the echo of our own request shows nothing, local
//   play/pause/seek go to /SyncPlay instead of the player, a drifted player is pulled back, leaving the player leaves.
// Usage: node tools/checks/syncplay-check.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(import.meta.dirname, '..', '..');
const src = (p) => path.join(repo, 'apps/desktop/src', p).replace(/\\/g, '/');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-syncplay-'));
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(entry, `export * from '${src('shared/syncplay.ts')}';\nexport { SyncPlay } from '${src('main/playback/syncplay.ts')}';\n`);
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export const net = { fetch: (...a) => fetch(...a) }; export const app = { isReady: () => false, isPackaged: true, getLocale: () => 'en', getPath: () => '.' }; export const safeStorage = {};`,
    }));
  },
};
const out = path.join(tmp, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [electronStub] });
const { measure, TimeSync, groupPositionMs, driftTarget, SyncPlay } = await import(pathToFileURL(out).href);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Clock ----
// Server 5000 ms ahead, 40 ms each way, 2 ms of server processing.
const s1 = measure(1000, 6040, 6042, 1082);
assert.equal(s1.offsetMs, 5000);
assert.equal(s1.pingMs, 80);
const clock = new TimeSync();
assert.equal(clock.ready, false);
clock.add({ offsetMs: 5300, pingMs: 400 });
clock.add(s1);
clock.add({ offsetMs: 4800, pingMs: 300 });
assert.equal(clock.offsetMs, 5000, 'the shortest round trip wins');
for (let i = 0; i < 8; i++) clock.add({ offsetMs: 7000, pingMs: 500 });
assert.equal(clock.offsetMs, 7000, 'only the last 8 samples count');
clock.reset();
clock.add(s1);
assert.equal(clock.serverNow(10_000), 15_000);
assert.equal(clock.delayUntil(15_500, 10_000), 500);
assert.equal(clock.delayUntil(14_000, 10_000), 0, 'a late command is due now');
assert.equal(groupPositionMs({ command: 'Unpause', whenMs: 1000, positionMs: 60_000 }, 4000), 63_000);
assert.equal(groupPositionMs({ command: 'Pause', whenMs: 1000, positionMs: 60_000 }, 4000), 60_000);
assert.equal(driftTarget({ command: 'Unpause', whenMs: 1000, positionMs: 0 }, 2500, 4000), null, '1.5 s off is left alone');
assert.equal(driftTarget({ command: 'Unpause', whenMs: 1000, positionMs: 0 }, 500, 4000), 3000);
assert.equal(driftTarget({ command: 'Pause', whenMs: 1000, positionMs: 0 }, 9000, 4000), null, 'no correction while paused');
assert.equal(driftTarget({ command: 'Unpause', whenMs: 5000, positionMs: 0 }, 9000, 4000), null, 'nor before the group starts');

// ---- SyncPlay on fakes ----
const OFFSET = 5000;
const posts = [];
const api = {
  kind: 'jellyfin',
  async get(p) {
    if (p === '/GetUtcTime') {
      const t = new Date(Date.now() + OFFSET).toISOString();
      return { RequestReceptionTime: t, ResponseTransmissionTime: t };
    }
    if (p === '/SyncPlay/List') return [{ GroupId: 'g1', GroupName: 'Movie night', State: 'Playing', Participants: ['Ann'] }];
    throw new Error(p);
  },
  async post(p, _q, body) {
    posts.push({ p, body });
  },
};
const connection = { primaryId: 's1', onlineApi: (sid) => (sid === 's1' || sid === undefined ? api : null) };
class FakePlayback extends EventEmitter {
  state = { active: false, positionMs: 0, durationMs: 7_200_000, paused: false, buffering: false };
  divert = null;
  plays = [];
  cmds = [];
  notices = [];
  get serverId() {
    return this.state.active ? 's1' : undefined;
  }
  getState() {
    return this.state;
  }
  async play(req) {
    if (this.divert?.play(req)) return;
    this.plays.push(req);
    Object.assign(this.state, { active: true, item: { id: req.itemIds[req.startIndex ?? 0], serverId: 's1' }, paused: false });
    this.emit('state', this.state);
  }
  async command(cmd) {
    if (!this.state.active) return;
    if (this.divert?.command(cmd)) return;
    this.cmds.push(cmd);
    if (cmd.type === 'pause') this.state.paused = true;
    if (cmd.type === 'resume') this.state.paused = false;
    if (cmd.type === 'seek') this.state.positionMs = cmd.positionMs;
    if (cmd.type === 'stop') this.state.active = false;
    this.emit('state', this.state);
  }
  notify(key) {
    this.notices.push(key);
  }
}
const pb = new FakePlayback();
const messages = [];
const sp = new SyncPlay({ connection, playback: pb, onMessage: (kind, text) => messages.push([kind, text]) });
const update = (Type, Data) => sp.onMessage({ MessageType: 'SyncPlayGroupUpdate', Data: { GroupId: 'g1', Type, Data } }, 's1');
const command = (Command, whenOffsetMs, positionMs, emitted = new Date().toISOString()) =>
  sp.onMessage({ MessageType: 'SyncPlayCommand', Data: { GroupId: 'g1', PlaylistItemId: 'p1', Command, When: new Date(Date.now() + OFFSET + whenOffsetMs).toISOString(), EmittedAt: emitted, PositionTicks: positionMs * 10_000 } }, 's1');
const posted = (p) => posts.filter((x) => x.p === p);

assert.deepEqual((await sp.list()).map((g) => [g.name, g.state, g.members.length]), [['Movie night', 'playing', 1]]);
const changes = [];
sp.on('change', (g) => changes.push(g));
const joining = sp.join('g1');
await wait(20);
update('GroupJoined', { GroupId: 'g1', GroupName: 'Movie night', State: 'Playing', Participants: ['Ann', 'Wika'] });
await joining;
assert.deepEqual(posted('/SyncPlay/Join').map((x) => x.body), [{ GroupId: 'g1' }]);
assert.deepEqual(sp.current?.members, ['Ann', 'Wika']);
assert.ok(Math.abs(sp.clock.offsetMs - OFFSET) < 100, `clock offset ${sp.clock.offsetMs}`);

// Messages of another server are not ours.
sp.onMessage({ MessageType: 'SyncPlayGroupUpdate', Data: { Type: 'GroupLeft' } }, 's2');
assert.ok(sp.current);

// The group's queue: play its item here, paused at its position, then Ready.
update('PlayQueue', { Reason: 'NewPlaylist', Playlist: [{ ItemId: 'm1', PlaylistItemId: 'p1' }], PlayingItemIndex: 0, StartPositionTicks: 60_000 * 10_000, IsPlaying: true });
await wait(20);
assert.deepEqual(pb.plays.map((r) => r.itemIds), [['m1']], 'the group item plays here (not diverted back to the group)');
assert.deepEqual(pb.cmds, [{ type: 'pause' }, { type: 'seek', positionMs: 60_000 }]);
const ready = posted('/SyncPlay/Ready').at(-1)?.body;
assert.equal(ready?.PlaylistItemId, 'p1');
assert.equal(ready?.PositionTicks, 60_000 * 10_000);
assert.equal(ready?.IsPlaying, false);
assert.ok(Math.abs(Date.parse(ready.When) - (Date.now() + OFFSET)) < 200, 'Ready is stamped in server time');

// Unpause 300 ms ahead: seek now, play at When; it follows our Ready, so no notice.
pb.cmds.length = 0;
command('Unpause', 300, 60_000);
assert.deepEqual(pb.cmds, [{ type: 'seek', positionMs: 60_000 }]);
await wait(150);
assert.equal(pb.state.paused, true, 'not before When');
await wait(250);
assert.equal(pb.state.paused, false, 'playing at When');
assert.deepEqual(pb.notices, []);

// A re-delivered command is dropped.
pb.cmds.length = 0;
const emitted = new Date().toISOString();
command('Pause', -1000, 61_000, emitted);
assert.deepEqual(pb.cmds, [{ type: 'pause' }, { type: 'seek', positionMs: 61_000 }], 'a late Pause applies at once');
assert.deepEqual(pb.notices, ['player.notice.syncplay.pause']);
sp.last.whenMs = Date.parse(new Date(Date.now() + OFFSET - 1000).toISOString());
pb.cmds.length = 0;
sp.onMessage({ MessageType: 'SyncPlayCommand', Data: { Command: 'Pause', When: new Date(sp.last.whenMs).toISOString(), EmittedAt: emitted, PositionTicks: 61_000 * 10_000 } }, 's1');
assert.deepEqual(pb.cmds, [], 'duplicate dropped');

// Local controls go to the group, not to the player.
pb.cmds.length = 0;
await pb.command({ type: 'toggle-pause' });
await pb.command({ type: 'seek-relative', deltaMs: 10_000 });
await pb.command({ type: 'volume', value: 50 });
await wait(10);
assert.deepEqual(pb.cmds, [{ type: 'volume', value: 50 }], 'only the volume stays local');
assert.equal(posted('/SyncPlay/Unpause').length, 1);
assert.deepEqual(posted('/SyncPlay/Seek').map((x) => x.body), [{ PositionTicks: 71_000 * 10_000 }]);
// Its echo: no "by the group" notice.
command('Unpause', 0, 61_000);
assert.deepEqual(pb.notices, ['player.notice.syncplay.pause']);

// A group Seek: pause there and answer Ready.
pb.cmds.length = 0;
const readies = posted('/SyncPlay/Ready').length;
command('Seek', 0, 90_000);
await wait(10);
assert.deepEqual(pb.cmds, [{ type: 'pause' }, { type: 'seek', positionMs: 90_000 }]);
assert.equal(posted('/SyncPlay/Ready').length, readies + 1);

// Drift: the group plays from 0 since 10 s ago, this player is at 5 s.
command('Unpause', -10_000, 0);
pb.cmds.length = 0;
sp.driftAfter = 0;
Object.assign(pb.state, { paused: false, positionMs: 5000 });
pb.emit('state', pb.state);
assert.equal(pb.cmds.length, 1);
assert.ok(Math.abs(pb.cmds[0].positionMs - 10_000) < 200, `drift seek to ${pb.cmds[0].positionMs}`);
pb.emit('state', pb.state);
assert.equal(pb.cmds.length, 1, 'one correction, then it waits');

// Play from the item page goes to the group's queue.
await pb.play({ itemIds: ['m2'], startIndex: 0, startPositionTicks: 0, serverId: 's1' });
await wait(10);
assert.deepEqual(posted('/SyncPlay/SetNewQueue').map((x) => x.body), [{ PlayingQueue: ['m2'], PlayingItemPosition: 0, StartPositionTicks: 0 }]);
assert.equal(pb.plays.length, 1);

// Members.
update('UserLeft', 'Ann');
assert.deepEqual(sp.current.members, ['Wika']);
assert.ok(pb.notices.includes('player.notice.syncplay.left'));

// Leaving the player leaves the group.
await pb.command({ type: 'stop' });
await wait(10);
assert.equal(posted('/SyncPlay/Leave').length, 1);
assert.equal(sp.current, null);
assert.equal(changes.at(-1), null);
assert.deepEqual(messages, []);

// A group Stop ends the player but keeps the group.
const again = sp.join('g1');
await wait(20);
update('GroupJoined', { GroupId: 'g1', GroupName: 'Movie night', State: 'Idle', Participants: ['Wika'] });
await again;
Object.assign(pb.state, { active: true });
command('Stop', 0, 0);
await wait(10);
assert.equal(pb.state.active, false);
assert.ok(sp.current, 'still in the group');
await sp.leave();

fs.rmSync(tmp, { recursive: true, force: true });
console.log('syncplay-check: OK');
