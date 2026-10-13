// Self-check for the desktop receiver hardening (cast-spec CA-02):
// - the capabilities body per server kind (connection-manager.ts supportedCommands): Jellyfin only gets
//   names from its GeneralCommandType enum (PlayState, no SetPlaybackRate), Emby gets SetPlaybackRate;
// - "Autoriser le contrôle à distance" off posts SupportsMediaControl:false again on every signed-in server;
// - handleRemote (playback/remote-commands.ts) on a fake player: NaN never reaches the player, volume is
//   clamped, ids are checked, SeekRelative and SetPlaybackRate, and everything but DisplayMessage is dropped while off;
// - against mock Jellyfin on loopback: the real ConnectionManager's capabilities are accepted, and with
//   the CA-01 sessions mock the desktop leaves the ControllableByUserId list once the toggle is off.
// Usage: node tools/checks/remote-check.mjs   (starts mock-jellyfin on 8952, then stops it)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(import.meta.dirname, '..', '..');
const root = path.join(repo, 'apps', 'desktop');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-remote-'));
const src = (p) => path.join(root, 'src/main', p).replace(/\\/g, '/');
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `export { ConnectionManager, supportedCommands } from '${src('connection/connection-manager.ts')}';
export { handleRemote, commandName } from '${src('playback/remote-commands.ts')}';
`,
);
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export const net = { fetch: (...a) => fetch(...a) }; export const app = { isReady: () => false, isPackaged: true, getLocale: () => 'fr' }; export const safeStorage = {};`,
    }));
  },
};
const out = path.join(tmp, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [electronStub] });
const { ConnectionManager, supportedCommands, handleRemote, commandName } = await import(pathToFileURL(out).href);

// Jellyfin master, MediaBrowser.Model/Session/GeneralCommandType.cs.
const JELLYFIN_ENUM = new Set(
  'MoveUp MoveDown MoveLeft MoveRight PageUp PageDown PreviousLetter NextLetter ToggleOsd ToggleContextMenu Select Back TakeScreenshot SendKey SendString GoHome GoToSettings VolumeUp VolumeDown Mute Unmute ToggleMute SetVolume SetAudioStreamIndex SetSubtitleStreamIndex ToggleFullscreen DisplayContent GoToSearch DisplayMessage SetRepeatMode ChannelUp ChannelDown Guide ToggleStats PlayMediaSource PlayTrailers SetShuffleQueue PlayState PlayNext ToggleOsdMenu Play SetMaxStreamingBitrate SetPlaybackOrder'.split(' '),
);

// ---- Capabilities per kind.
const jf = supportedCommands('jellyfin');
const emby = supportedCommands('emby');
for (const c of jf) assert.ok(JELLYFIN_ENUM.has(c), `jellyfin: ${c} is not a GeneralCommandType`);
assert.ok(jf.includes('PlayState') && !jf.includes('Playstate'), 'jellyfin spells it PlayState');
assert.ok(!jf.includes('SetPlaybackRate'));
assert.ok(emby.includes('SetPlaybackRate') && emby.includes('Playstate'), 'emby keeps Playstate and adds SetPlaybackRate');
for (const c of ['Play', 'PlayNext', 'PlayMediaSource', 'SetVolume', 'DisplayMessage', 'DisplayContent', 'ToggleFullscreen', 'GoToSettings']) assert.ok(jf.includes(c) && emby.includes(c), c);
assert.equal(commandName('playstate', ['PlayState']), 'PlayState', 'command names compare case-insensitively');

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
const identity = { client: 'Wicaby', version: '0.1.0', deviceId: 'desk', deviceName: 'pc' };

// ---- The toggle posts again on every signed-in server, with each server's own list.
{
  const m = new ConnectionManager(path.join(tmp, 'servers.json'), new FakeVault(), identity);
  const posts = [];
  const client = (kind) => ({ kind, token: 't', post: async (p, _q, body) => posts.push({ kind, p, body }) });
  m.conns.set('A', { client: client('emby'), state: { status: 'signed-in' } });
  m.conns.set('B', { client: client('jellyfin'), state: { status: 'signed-in' } });
  m.conns.set('C', { client: client('emby'), state: { status: 'server-selected' } });
  m.setAllowControl(false);
  assert.equal(posts.length, 2, 'one capabilities post per signed-in server');
  for (const { kind, p, body } of posts) {
    assert.equal(p, '/Sessions/Capabilities/Full');
    assert.equal(body.SupportsMediaControl, false);
    assert.deepEqual(body.SupportedCommands, supportedCommands(kind));
    assert.deepEqual(body.PlayableMediaTypes, ['Audio', 'Video']);
    assert.equal(body.SupportsPersistentIdentifier, true);
  }
  m.setAllowControl(false);
  assert.equal(posts.length, 2, 'no post when nothing changed');
  m.setAllowControl(true);
  assert.equal(posts.length, 4);
  assert.equal(posts[3].body.SupportsMediaControl, true);
  m.conns.clear();
}

// ---- handleRemote on a fake player.
const settings = { value: { remote: { allowControl: true }, playback: { seekShortS: 10 } } };
const target = {
  plays: [],
  cmds: [],
  play(req) {
    this.plays.push(req);
    return Promise.resolve();
  },
  command(cmd) {
    this.cmds.push(cmd);
    return Promise.resolve();
  },
  getState: () => ({ volume: 50, muted: false }),
};
const send = (MessageType, Data) => handleRemote(target, settings, { MessageType, Data }, 'srv');
const general = (Name, Arguments) => send('GeneralCommand', { Name, Arguments });
const last = () => target.cmds.at(-1);
const noNaN = () => assert.ok(target.cmds.every((c) => Object.values(c).every((v) => typeof v !== 'number' || Number.isFinite(v))), 'NaN reached the player');

general('SetVolume', { Volume: 'x' });
general('SetVolume', { Volume: '' });
general('SetAudioStreamIndex', { Index: 'abc' });
general('SetSubtitleStreamIndex', { Index: '1.5' });
general('SetPlaybackRate', { PlaybackRate: 'fast' });
general('SetPlaybackRate', { PlaybackRate: '8' });
send('Playstate', { Command: 'Seek', SeekPositionTicks: 'abc' });
send('Playstate', { Command: 'Seek' });
send('Playstate', { Command: 'SeekRelative', SeekPositionTicks: 'NaN' });
assert.deepEqual(target.cmds, [], 'malformed numbers are dropped');
general('SetVolume', { Volume: '250' });
assert.deepEqual(last(), { type: 'volume', value: 100 });
general('setvolume', { Volume: '-3' });
assert.deepEqual(last(), { type: 'volume', value: 0 });
general('SetSubtitleStreamIndex', { Index: '-1' });
assert.deepEqual(last(), { type: 'subtitle', index: -1 });
general('SetAudioStreamIndex', { Index: 2 });
assert.deepEqual(last(), { type: 'audio', index: 2 });
general('SetPlaybackRate', { PlaybackRate: '1.5' });
assert.deepEqual(last(), { type: 'rate', value: 1.5 });
send('Playstate', { Command: 'SeekRelative', SeekPositionTicks: 300000000 });
assert.deepEqual(last(), { type: 'seek-relative', deltaMs: 30000 }, 'SeekRelative +30 s');
send('Playstate', { Command: 'SeekRelative', SeekPositionTicks: '-100000000' });
assert.deepEqual(last(), { type: 'seek-relative', deltaMs: -10000 });
send('Playstate', { Command: 'Seek', SeekPositionTicks: '600000000' });
assert.deepEqual(last(), { type: 'seek', positionMs: 60000 });
send('Playstate', { Command: 'pause' });
assert.deepEqual(last(), { type: 'pause' });
send('Playstate', { Command: 'FastForward' });
assert.deepEqual(last(), { type: 'seek-relative', deltaMs: 10000 });
noNaN();
// GeneralCommands main handles itself (index.ts) are left to it.
assert.equal(general('DisplayMessage', { Text: 'hi' }), false);
assert.equal(send('LibraryChanged', {}), false);

assert.equal(send('Play', { ItemIds: ['12345'], PlayCommand: 'PlayNow', StartPositionTicks: 0 }), true);
assert.deepEqual(target.plays.at(-1)?.itemIds, ['12345'], 'Emby numeric id accepted');
assert.equal(target.plays.at(-1).serverId, 'srv');
send('Play', { ItemIds: ['0123456789abcdef0123456789abcdef', '4f3e2d1c-0000-4000-8000-123456789abc'], PlayCommand: 'playnext', StartIndex: '1' });
assert.equal(target.plays.length, 2, 'Jellyfin ids accepted');
assert.equal(target.plays.at(-1).command, 'PlayNext');
assert.equal(target.plays.at(-1).startIndex, 1);
for (const bad of [['../x'], ['x'.repeat(65)], ['12345', 'a/b'], [], 'not-an-array', [12345]]) send('Play', { ItemIds: bad });
send('Play', { ItemIds: ['12345'], StartPositionTicks: 'abc' });
send('Play', { ItemIds: ['12345'], AudioStreamIndex: 'x' });
assert.equal(target.plays.length, 2, 'bad ids or numbers drop the Play');

// Remote control off: everything but DisplayMessage (a notification, index.ts shows it) is dropped, and the
// caller is told not to act on it either.
settings.value.remote.allowControl = false;
const before = [target.plays.length, target.cmds.length];
assert.equal(send('Play', { ItemIds: ['12345'] }), true);
assert.equal(send('Playstate', { Command: 'Stop' }), true);
assert.equal(general('SetVolume', { Volume: '10' }), true);
assert.equal(general('DisplayMessage', { Text: 'hi' }), false, 'DisplayMessage is left to index.ts');
assert.equal(general('DisplayContent', { ItemId: '12345' }), true);
assert.deepEqual([target.plays.length, target.cmds.length], before, 'a command got through with remote control off');
assert.equal(send('LibraryChanged', {}), false, 'server events still flow');
settings.value.remote.allowControl = true;

// ---- Against mock Jellyfin (loopback only).
const PORT = 8952;
const child = spawn(process.execPath, [path.join(repo, 'tools/mock-server/mock-jellyfin.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
const logs = [];
try {
  await new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`mock-jellyfin exited (${code}): is port ${PORT} taken?`)));
    child.stdout.on('data', (d) => {
      logs.push(String(d));
      if (String(d).includes(`:${PORT}`)) resolve();
    });
  });
  const base = `http://127.0.0.1:${PORT}`;
  const m = new ConnectionManager(path.join(tmp, 'servers-mock.json'), new FakeVault(), identity);
  const info = await m.add(base);
  await m.select(info.id);
  await m.login('Wika', 'wicaby', info.id);
  const conn = [...m.conns.values()][0];
  assert.equal(conn.client.kind, 'jellyfin');
  // The capabilities go out before the socket opens; a 400 here would be a rejected body.
  const caps = await conn.client.post('/Sessions/Capabilities/Full', undefined, {
    PlayableMediaTypes: ['Audio', 'Video'],
    SupportedCommands: supportedCommands('jellyfin'),
    SupportsMediaControl: true,
    SupportsPersistentIdentifier: true,
  }).then(() => 'ok', (e) => e);
  assert.equal(caps, 'ok', `mock Jellyfin refused the capabilities: ${caps}`);

  // Another app of the account looks for controllable sessions.
  const h = `MediaBrowser Client="Wicaby", Device="phone", DeviceId="phone", Version="0"`;
  const login = await (await fetch(`${base}/Users/AuthenticateByName`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: h }, body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }) })).json();
  const auth = { Authorization: `${h}, Token="${login.AccessToken}"` };
  const listed = async () => {
    const list = await (await fetch(`${base}/Sessions?ControllableByUserId=${login.User.Id}`, { headers: auth })).json();
    return list.find((s) => s.DeviceId === 'desk');
  };
  let desk;
  for (let i = 0; i < 100 && !desk; i++) {
    desk = await listed();
    if (!desk) await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(desk, 'the desktop (capabilities and socket) is not controllable');
  if ('SupportedCommands' in desk) {
    // CA-01 sessions mock: SupportsRemoteControl = socket open and SupportsMediaControl.
    m.setAllowControl(false);
    let gone = false;
    for (let i = 0; i < 100 && !gone; i++) {
      gone = !(await listed());
      if (!gone) await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(gone, 'still controllable after SupportsMediaControl:false');
    m.setAllowControl(true);
  } else {
    console.log('remote-check: SKIP the ControllableByUserId toggle test (mock-jellyfin lacks the CA-01 sessions store)');
  }
  m.disconnect?.(conn.state.server.id);
  for (const c of m.conns.values()) c.socket?.close();
} finally {
  child.kill();
}

console.log('remote-check: OK (capabilities per kind, toggle reposts, handleRemote guards, mock Jellyfin)');
process.exit(0);
