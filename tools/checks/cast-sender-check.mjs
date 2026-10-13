// The Android "Lire sur…" sender (docs/specs/cast-spec.md CA-03) against both mocks: the exact requests
// core/cast/RemoteTargets.kt sends (header auth, query-only /Playing, string command arguments, the mirror's
// GET /Sessions?DeviceId=), checked against what the CA-03 acceptance criteria need from the server side:
//   1  a virtual "Emby Web" session is listed (the caller is too: RemoteTargets drops its own DeviceId), and
//      Play reaches /Mock/State.remote as PlayNow with StartPositionTicks, AudioStreamIndex, SubtitleStreamIndex
//   2  an ignore:true session accepts Play (204) but its NowPlayingItem never changes (the handoff then resumes locally)
//   3  Seek, Pause and SetVolume reach the virtual session (its mirror shows them)
//   4  MOCK_NO_SESSIONS_PUSH=1: polling GET /Sessions?DeviceId= still sees the position move
//   5  a virtual Client "DLNA" session is listed (ownerless); with MOCK_SHARED_DEVICE_CONTROL=0 it is not, with a 200
//   6  MOCK_NON_ADMIN=1 (Jellyfin): the mirror's poll still finds the ownerless DLNA session and its position moves
// Loopback only: every URL is checked against 127.0.0.1 and the mocks are bound to it.
// Usage: node tools/checks/cast-sender-check.mjs [--verbose]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const LOOPBACK = '127.0.0.1';
const VERBOSE = process.argv.includes('--verbose');
const TICKS = 10_000; // per ms

function assertLoopbackUrl(url) {
  if (new URL(url).hostname !== LOOPBACK) throw new Error(`refusing ${url}: this check only talks to ${LOOPBACK}`);
}
for (const bad of ['http://192.0.2.10:8096/', 'http://192.0.2.20/', 'http://localhost:1/']) assert.throws(() => assertLoopbackUrl(bad));

const BOOT = `data:text/javascript,${encodeURIComponent(
  "import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'&&(a.length===1||typeof a[1]==='function'))a.splice(1,0,'127.0.0.1');return l.apply(this,a)};",
)}`;

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, LOOPBACK, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const children = new Set();
process.on('exit', () => children.forEach((c) => c.kill()));

async function startMock(kind, env = {}) {
  const port = await freePort();
  const script = path.join(root, 'tools/mock-server', kind === 'emby' ? 'mock-emby.mjs' : 'mock-jellyfin.mjs');
  const child = spawn(process.execPath, ['--import', BOOT, script, String(port)], {
    cwd: root,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MOCK_'))), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${kind}: not listening after 10 s`)), 10_000);
    const onData = (d) => {
      if (VERBOSE) process.stdout.write(`  [${kind}] ${d}`);
      if (/Mock (Emby|Jellyfin)/.test(String(d))) (clearTimeout(timer), resolve());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => (clearTimeout(timer), reject(new Error(`${kind}: exited with ${code}`))));
  });
  return { kind, port, child, base: `http://${LOOPBACK}:${port}${kind === 'emby' ? '/emby' : ''}`, root: `http://${LOOPBACK}:${port}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(url, { method = 'GET', headers = {}, body } = {}) {
  assertLoopbackUrl(url);
  const res = await fetch(url, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // plain text
  }
  return { status: res.status, json };
}

// Signs in as the phone, with the header auth Api.authHeaders() sends.
async function phone(m) {
  const fields = `Client="Wicaby", Device="Pixel", DeviceId="phone", Version="1.0.0"`;
  const auth = m.kind === 'emby' ? { 'X-Emby-Authorization': `Emby ${fields}` } : { Authorization: `MediaBrowser ${fields}` };
  const r = await call(`${m.base}/Users/AuthenticateByName`, { method: 'POST', headers: auth, body: { Username: 'Wika', Pw: 'wicaby' } });
  assert.equal(r.status, 200, `${m.kind}: sign-in`);
  const t = r.json.AccessToken;
  const uid = r.json.User.Id;
  const headers = m.kind === 'emby' ? { 'X-Emby-Authorization': `Emby UserId="${uid}", ${fields}`, 'X-Emby-Token': t } : { Authorization: `MediaBrowser ${fields}, Token="${t}"` };
  const req = (method, p, body) => call(`${m.base}${p}`, { method, headers, body });
  return {
    uid,
    token: t,
    req,
    // RemoteTargets.list / mirror / play / transport / command.
    list: async () => (await req('GET', `/Sessions?ControllableByUserId=${uid}&ActiveWithinSeconds=960`)).json,
    poll: async (deviceId) => (await req('GET', `/Sessions?DeviceId=${encodeURIComponent(deviceId)}`)).json,
    play: (id, q) => req('POST', `/Sessions/${id}/Playing?${new URLSearchParams(q)}`),
    transport: (id, cmd, seek) => req('POST', `/Sessions/${id}/Playing/${cmd}${seek === undefined ? '' : `?SeekPositionTicks=${seek}`}`),
    command: (id, Name, args) => req('POST', `/Sessions/${id}/Command`, { Name, Arguments: args }),
  };
}

const addVirtual = async (m, body) => (await call(`${m.root}/Mock/Sessions`, { method: 'POST', body })).json;
const remote = async (m) => (await call(`${m.root}/Mock/State`)).json.remote;
const stop = (m) => (m.child.kill(), children.delete(m.child));
const CMDS = ['SetVolume', 'Mute', 'Unmute', 'SetAudioStreamIndex', 'SetSubtitleStreamIndex', 'DisplayMessage'];

async function main(kind) {
  const m = await startMock(kind);
  try {
    const p = await phone(m);
    // The phone itself as a receiver (capabilities + socket): the server lists it, the sender must drop it.
    await p.req('POST', '/Sessions/Capabilities/Full', { PlayableMediaTypes: ['Audio', 'Video'], SupportedCommands: ['SetVolume'], SupportsMediaControl: true });
    const wsUrl = kind === 'emby' ? `ws://${LOOPBACK}:${m.port}/embywebsocket?api_key=${p.token}&deviceId=phone` : `ws://${LOOPBACK}:${m.port}/socket?ApiKey=${p.token}&deviceId=phone`;
    assertLoopbackUrl(wsUrl.replace(/^ws/, 'http'));
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => (ws.addEventListener('open', resolve), ws.addEventListener('error', reject)));

    // 1: the picker lists the virtual session; Play carries position and tracks.
    const web = await addVirtual(m, { DeviceName: 'Emby Web', Client: 'Emby Web', DeviceId: 'web-1', SupportedCommands: CMDS });
    const listed = await p.list();
    assert.ok(listed.some((s) => s.Id === web.Id && s.SupportsRemoteControl && s.PlayableMediaTypes.includes('Video')), `${kind}: virtual session not listed`);
    assert.ok(listed.some((s) => s.DeviceId === 'phone'), `${kind}: the caller is expected in the list (RemoteTargets filters its own DeviceId)`);
    const start = 754_000 * TICKS;
    assert.equal((await p.play(web.Id, { ItemIds: 'movie-1', PlayCommand: 'PlayNow', StartPositionTicks: start, AudioStreamIndex: 2, SubtitleStreamIndex: -1 })).status, 204, `${kind}: play`);
    const sent = (await remote(m)).at(-1);
    assert.equal(sent.MessageType, 'Play');
    assert.equal(sent.Data.PlayCommand, 'PlayNow');
    assert.equal(sent.Data.StartPositionTicks, start);
    assert.equal(sent.Data.AudioStreamIndex, 2);
    assert.equal(sent.Data.SubtitleStreamIndex, -1);
    let s = (await p.poll('web-1'))[0];
    assert.equal(s.NowPlayingItem?.Id, 'movie-1', `${kind}: the mirror does not show the item`);

    // 3: Seek, Pause, SetVolume (string argument) reach it.
    await p.transport(web.Id, 'Seek', 100_000 * TICKS);
    await p.transport(web.Id, 'Pause');
    assert.equal((await p.command(web.Id, 'SetVolume', { Volume: '35' })).status, 204, `${kind}: SetVolume`);
    s = (await p.poll('web-1'))[0];
    assert.equal(s.PlayState.IsPaused, true, `${kind}: Pause`);
    assert.ok(Math.abs(s.PlayState.PositionTicks - 100_000 * TICKS) < 2_000 * TICKS, `${kind}: Seek`);
    assert.equal(s.PlayState.VolumeLevel, 35, `${kind}: SetVolume`);
    assert.equal((await remote(m)).at(-1).Data.Arguments.Volume, '35');

    // 2: ignore:true takes the 204 but never plays.
    const deaf = await addVirtual(m, { DeviceName: 'Deaf TV', Client: 'Emby Web', DeviceId: 'deaf-1', ignore: true });
    assert.equal((await p.play(deaf.Id, { ItemIds: 'movie-1', PlayCommand: 'PlayNow' })).status, 204);
    await sleep(500);
    assert.equal((await p.poll('deaf-1'))[0].NowPlayingItem, undefined, `${kind}: an ignore:true session shows the item`);

    // 5: an ownerless DLNA session is listed with Client "DLNA".
    const dlna = await addVirtual(m, { DeviceName: 'Mock TV', Client: 'DLNA', DeviceId: 'uuid-mock-tv' });
    assert.ok((await p.list()).some((x) => x.Id === dlna.Id && x.Client === 'DLNA' && !x.UserId), `${kind}: DLNA session not listed`);
    ws.close();
  } finally {
    stop(m);
  }

  // 5 (variant): no shared device control, no DLNA row and no error.
  const shared = await startMock(kind, { MOCK_SHARED_DEVICE_CONTROL: '0' });
  try {
    const p = await phone(shared);
    await addVirtual(shared, { DeviceName: 'Mock TV', Client: 'DLNA', DeviceId: 'uuid-mock-tv' });
    const r = await p.req('GET', `/Sessions?ControllableByUserId=${p.uid}&ActiveWithinSeconds=960`);
    assert.equal(r.status, 200);
    assert.ok(!r.json.some((x) => x.Client === 'DLNA'), `${kind}: DLNA listed without shared device control`);
  } finally {
    stop(shared);
  }

  // 4 and 6: no pushes (and, on Jellyfin, a non-admin): polling alone sees the position move.
  const env = kind === 'jellyfin' ? { MOCK_NO_SESSIONS_PUSH: '1', MOCK_NON_ADMIN: '1' } : { MOCK_NO_SESSIONS_PUSH: '1' };
  const quiet = await startMock(kind, env);
  try {
    const p = await phone(quiet);
    const dlna = await addVirtual(quiet, { DeviceName: 'Mock TV', Client: 'DLNA', DeviceId: 'uuid-mock-tv', PlayableMediaTypes: ['Video'] });
    await p.play(dlna.Id, { ItemIds: 'movie-1', PlayCommand: 'PlayNow', StartPositionTicks: 0 });
    const a = (await p.poll('uuid-mock-tv'))[0];
    await sleep(1_200);
    const b = (await p.poll('uuid-mock-tv'))[0];
    assert.equal(b?.NowPlayingItem?.Id, 'movie-1', `${kind}: the poll lost the ownerless DLNA session`);
    assert.ok(b.PlayState.PositionTicks > a.PlayState.PositionTicks, `${kind}: the polled position does not move`);
  } finally {
    stop(quiet);
  }
}

for (const kind of ['jellyfin', 'emby']) await main(kind);
console.log('cast-sender-check: OK (list, play, commands, ignore:true, DLNA relabel and permissions, polling without pushes; Emby and Jellyfin)');
