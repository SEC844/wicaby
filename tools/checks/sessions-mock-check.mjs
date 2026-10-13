// Remote control through the Sessions API on both mocks (docs/specs/cast-spec.md CA-01).
//
// Spawns tools/mock-server/mock-emby.mjs and mock-jellyfin.mjs on free loopback ports (plus one variant of each
// with MOCK_SHARED_DEVICE_CONTROL=0 and MOCK_NON_ADMIN=1 / MOCK_NO_SESSIONS_PUSH=1), signs in twice (a "sender"
// and a "receiver" DeviceId), opens the receiver's socket and asserts:
//   1  the receiver is controllable only after capabilities AND a socket open (and SupportsMediaControl); the
//      caller is not removed; DeviceId filters
//   2  /Playing, /Playing/Pause and /Command SetVolume reach the receiver's socket with the right Data
//   3  after SessionsStart, a Sessions push arrives within 2 s of a progress report
//   4  a virtual DLNA session (ownerless) records and simulates commands; ignore:true accepts without playing;
//      /Mock/Sessions/{id}/Unpause drives it; /Mock/State lists remote[]
//   5  Jellyfin: SetPlaybackRate and SeekRelative get a 400, and so do capabilities naming SetPlaybackRate (Emby: 204)
//   6  variants: ownerless sessions leave ControllableByUserId without shared device control; non-admin pushes carry
//      only owned sessions; MOCK_NO_SESSIONS_PUSH=1 never pushes
//
// Loopback only: every URL is checked against 127.0.0.1 and the mocks are bound to it through a --import preload.
// Usage: node tools/checks/sessions-mock-check.mjs [--verbose]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const LOOPBACK = '127.0.0.1';
const VERBOSE = process.argv.includes('--verbose');
const TICKS = 10_000; // per ms

function assertLoopbackUrl(url) {
  const host = new URL(url).hostname;
  if (host !== LOOPBACK) throw new Error(`refusing ${url}: this check only talks to ${LOOPBACK}`);
}
for (const bad of ['http://localhost:1/', 'http://192.0.2.10:8096/', 'ws://10.0.0.1/', 'http://[::1]/']) assert.throws(() => assertLoopbackUrl(bad), `the loopback guard accepted ${bad}`);

// Binds every server the mock creates to 127.0.0.1 (the mocks themselves listen on all interfaces).
const BOOT = `data:text/javascript,${encodeURIComponent(
  "import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'&&(a.length===1||typeof a[1]==='function'))a.splice(1,0,'127.0.0.1');return l.apply(this,a)};",
)}`;

const handedOut = new Set();
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, LOOPBACK, () => {
      const { port } = s.address();
      // Never the same port twice: a closed port can be handed out again before its mock binds it.
      s.close(() => (handedOut.has(port) ? freePort().then(resolve, reject) : (handedOut.add(port), resolve(port))));
    });
  });
}

const children = new Set();
process.on('exit', () => children.forEach((c) => c.kill()));

async function startMock(kind, env = {}) {
  const port = await freePort();
  const script = path.join(root, 'tools/mock-server', kind === 'emby' ? 'mock-emby.mjs' : 'mock-jellyfin.mjs');
  const child = spawn(process.execPath, ['--import', BOOT, script, String(port)], {
    cwd: root,
    // The developer's own MOCK_* settings never leak into the run.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MOCK_'))), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  const log = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${kind}: not listening after 10 s\n${log.join('\n')}`)), 10_000);
    const onData = (d) => {
      for (const line of String(d).split(/\r?\n/).filter(Boolean)) {
        log.push(line);
        if (VERBOSE) console.log(`  [${kind}] ${line}`);
        if (/^Mock (Emby|Jellyfin)/.test(line)) (clearTimeout(timer), resolve());
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => (clearTimeout(timer), reject(new Error(`${kind}: exited with ${code}\n${log.join('\n')}`))));
  });
  return { kind, port, base: `http://${LOOPBACK}:${port}${kind === 'emby' ? '/emby' : ''}`, root: `http://${LOOPBACK}:${port}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(url, { method = 'GET', headers = {}, body } = {}) {
  assertLoopbackUrl(url);
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // plain text
  }
  return { status: res.status, json, text };
}

async function signIn(m, deviceId) {
  const fields = `Client="Wicaby checks", Device="${deviceId}", DeviceId="${deviceId}", Version="1.0.0"`;
  const r = await call(`${m.base}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: m.kind === 'emby' ? { 'X-Emby-Authorization': `Emby ${fields}` } : { Authorization: `MediaBrowser ${fields}` },
    body: { Username: 'Wika', Pw: 'wicaby' },
  });
  assert.equal(r.status, 200, `${m.kind}: sign-in ${deviceId}`);
  const token = r.json.AccessToken;
  const headers = m.kind === 'emby' ? { 'X-Emby-Authorization': `Emby ${fields}`, 'X-Emby-Token': token } : { Authorization: `MediaBrowser ${fields}, Token="${token}"` };
  const c = {
    m,
    deviceId,
    token,
    userId: r.json.User.Id,
    sessionId: r.json.SessionInfo?.Id,
    req: (method, p, body) => call(`${m.base}${p}`, { method, headers, body }),
    caps: (extra = {}) => c.req('POST', '/Sessions/Capabilities/Full', { PlayableMediaTypes: ['Audio', 'Video'], SupportedCommands: ['Play', 'PlayState', 'SetVolume', 'DisplayMessage'], SupportsMediaControl: true, SupportsPersistentIdentifier: true, ...extra }),
    report: (kind, body) => c.req('POST', `/Sessions/Playing${kind ? `/${kind}` : ''}`, { MediaSourceId: body.ItemId, PlaySessionId: 'ps-check', PlayMethod: 'DirectPlay', ...body }),
    controllable: async () => (await c.req('GET', `/Sessions?ControllableByUserId=${c.userId}`)).json,
  };
  return c;
}

function openSocket(c) {
  const url = c.m.kind === 'emby' ? `ws://${LOOPBACK}:${c.m.port}/embywebsocket?api_key=${c.token}&deviceId=${c.deviceId}` : `ws://${LOOPBACK}:${c.m.port}/socket?ApiKey=${c.token}&deviceId=${c.deviceId}`;
  assertLoopbackUrl(url.replace(/^ws/, 'http'));
  const ws = new WebSocket(url);
  const frames = [];
  ws.addEventListener('message', (e) => frames.push({ at: Date.now(), ...JSON.parse(String(e.data)) }));
  const s = {
    ws,
    frames,
    send: (MessageType, Data) => ws.send(JSON.stringify({ MessageType, Data })),
    // The first frame of that type (after index `from`) matching pred, within ms.
    async next(type, { from = 0, pred = () => true, ms = 2000 } = {}) {
      const until = Date.now() + ms;
      for (;;) {
        const f = frames.slice(from).find((x) => x.MessageType === type && pred(x));
        if (f) return f;
        if (Date.now() > until) return null;
        await sleep(20);
      }
    },
    opened: new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error(`${c.m.kind}: socket did not open`)));
    }),
  };
  return s;
}

const mockState = async (m) => (await call(`${m.root}/Mock/State`)).json;
const addVirtual = async (m, body) => (await call(`${m.root}/Mock/Sessions`, { method: 'POST', body })).json;

async function runMain(m) {
  const notes = [];
  const sender = await signIn(m, 'ck-sender');
  const recv = await signIn(m, 'ck-receiver');
  const listed = async () => (await sender.controllable()).find((s) => s.DeviceId === recv.deviceId);

  // 1. Capabilities and a socket, both needed.
  assert.equal(await listed(), undefined, `${m.kind}: receiver controllable before anything`);
  assert.equal((await recv.caps()).status, 204, `${m.kind}: capabilities`);
  assert.equal(await listed(), undefined, `${m.kind}: controllable with capabilities but no socket`);
  const sock = openSocket(recv);
  await sock.opened;
  await sleep(50);
  const target = await listed();
  assert.ok(target, `${m.kind}: receiver not controllable after capabilities and a socket`);
  assert.equal(target.SupportsRemoteControl, true);
  assert.deepEqual(target.PlayableMediaTypes, ['Audio', 'Video'], `${m.kind}: PlayableMediaTypes`);
  assert.ok(target.SupportedCommands.includes('SetVolume'), `${m.kind}: SupportedCommands`);
  await recv.caps({ SupportsMediaControl: false });
  assert.equal(await listed(), undefined, `${m.kind}: controllable with SupportsMediaControl false`);
  await recv.caps();
  assert.ok(await listed(), `${m.kind}: not controllable again`);
  // The caller is not removed (neither server does), and DeviceId filters.
  await sender.caps();
  const senderSock = openSocket(sender);
  await senderSock.opened;
  await sleep(50);
  assert.ok((await sender.controllable()).some((s) => s.DeviceId === sender.deviceId), `${m.kind}: the caller was removed`);
  const byDevice = (await sender.req('GET', `/Sessions?DeviceId=${recv.deviceId}`)).json;
  assert.equal(byDevice.length, 1, `${m.kind}: DeviceId filter returned ${byDevice.length}`);
  assert.equal(byDevice[0].Id, target.Id);
  notes.push('1 caps+socket');

  // 2. Commands reach the receiver's socket.
  let from = sock.frames.length;
  const pos = 123_000 * TICKS;
  assert.equal((await sender.req('POST', `/Sessions/${target.Id}/Playing?ItemIds=movie-1,movie-2&PlayCommand=PlayNow&StartPositionTicks=${pos}&MediaSourceId=movie-1&AudioStreamIndex=2&SubtitleStreamIndex=-1&StartIndex=0`)).status, 204, `${m.kind}: /Playing`);
  const play = await sock.next('Play', { from });
  assert.ok(play, `${m.kind}: Play not relayed`);
  assert.deepEqual(play.Data.ItemIds, ['movie-1', 'movie-2']);
  assert.equal(play.Data.PlayCommand, 'PlayNow');
  assert.equal(play.Data.StartPositionTicks, pos);
  assert.equal(play.Data.MediaSourceId, 'movie-1');
  assert.equal(play.Data.AudioStreamIndex, 2);
  assert.equal(play.Data.SubtitleStreamIndex, -1);
  assert.equal(play.Data.StartIndex, 0);
  assert.equal(play.Data.ControllingUserId, sender.userId);
  from = sock.frames.length;
  assert.equal((await sender.req('POST', `/Sessions/${target.Id}/Playing/Pause`)).status, 204, `${m.kind}: /Playing/Pause`);
  const pause = await sock.next('Playstate', { from });
  assert.equal(pause?.Data?.Command, 'Pause', `${m.kind}: Pause not relayed`);
  from = sock.frames.length;
  assert.equal((await sender.req('POST', `/Sessions/${target.Id}/Playing/Seek?SeekPositionTicks=${pos}`)).status, 204);
  assert.equal((await sock.next('Playstate', { from }))?.Data?.SeekPositionTicks, pos, `${m.kind}: Seek position`);
  from = sock.frames.length;
  assert.equal((await sender.req('POST', `/Sessions/${target.Id}/Command`, { Name: 'SetVolume', Arguments: { Volume: 35 } })).status, 204, `${m.kind}: /Command`);
  const vol = await sock.next('GeneralCommand', { from });
  assert.equal(vol?.Data?.Name, 'SetVolume', `${m.kind}: SetVolume not relayed`);
  assert.equal(vol.Data.Arguments.Volume, '35', `${m.kind}: Arguments are strings on both servers`);
  from = sock.frames.length;
  assert.equal((await sender.req('POST', `/Sessions/${target.Id}/Command/Mute`)).status, 204);
  assert.equal((await sock.next('GeneralCommand', { from }))?.Data?.Name, 'Mute', `${m.kind}: /Command/Mute`);
  assert.equal((await sender.req('POST', '/Sessions/nope/Playing/Stop')).status, 404, `${m.kind}: unknown session`);
  assert.equal((await sender.req('POST', `/Sessions/${target.Id}/Playing?PlayCommand=PlayNow`)).status, 400, `${m.kind}: /Playing without ItemIds`);
  if (m.kind === 'jellyfin') assert.equal((await sender.req('POST', `/Sessions/${target.Id}/Playing?ItemIds=movie-1`)).status, 400, 'jellyfin: /Playing without PlayCommand');
  notes.push('2 Play/Playstate/GeneralCommand');

  // 3. Sessions push within 2 s of a progress report.
  from = senderSock.frames.length;
  senderSock.send('SessionsStart', '0,1500');
  assert.ok(await senderSock.next('Sessions', { from }), `${m.kind}: no initial Sessions push`);
  from = senderSock.frames.length;
  const reportAt = Date.now();
  assert.equal((await recv.report('', { ItemId: 'movie-1', PositionTicks: pos, IsPaused: false, VolumeLevel: 35, IsMuted: true })).status, 204);
  const pushed = await senderSock.next('Sessions', { from, ms: 2000, pred: (f) => f.Data.some((s) => s.DeviceId === recv.deviceId && s.NowPlayingItem?.Id === 'movie-1') });
  assert.ok(pushed, `${m.kind}: no Sessions push within 2 s of the report`);
  const mirrored = pushed.Data.find((s) => s.DeviceId === recv.deviceId);
  assert.equal(mirrored.PlayState.PositionTicks, pos);
  assert.equal(mirrored.PlayState.VolumeLevel, 35);
  assert.equal(mirrored.PlayState.IsMuted, true);
  notes.push(`3 push after ${pushed.at - reportAt} ms`);
  from = senderSock.frames.length;
  senderSock.send('SessionsStop');
  await sleep(100);
  await recv.report('Progress', { ItemId: 'movie-1', PositionTicks: pos + 1000 * TICKS, IsPaused: false });
  assert.equal(await senderSock.next('Sessions', { from, ms: 1700 }), null, `${m.kind}: pushed after SessionsStop`);

  // 4. Virtual sessions.
  const dlna = await addVirtual(m, { DeviceName: 'Mock TV', Client: 'DLNA', DeviceId: 'uuid-mock-tv', PlayableMediaTypes: ['Video'], SupportedCommands: ['SetVolume', 'Mute', 'Unmute'] });
  assert.ok(dlna?.Id, `${m.kind}: POST /Mock/Sessions`);
  assert.equal(dlna.UserId, undefined, `${m.kind}: a DLNA session is ownerless`);
  const vlisted = (await sender.controllable()).find((s) => s.Id === dlna.Id);
  assert.ok(vlisted, `${m.kind}: the virtual DLNA session is not controllable`);
  assert.equal(vlisted.Client, 'DLNA');
  await sender.req('POST', `/Sessions/${dlna.Id}/Playing?ItemIds=movie-2&PlayCommand=PlayNow&StartPositionTicks=${pos}`);
  await sender.req('POST', `/Sessions/${dlna.Id}/Playing/Pause`);
  await sender.req('POST', `/Sessions/${dlna.Id}/Playing/Seek?SeekPositionTicks=${2 * pos}`);
  await sender.req('POST', `/Sessions/${dlna.Id}/Command`, { Name: 'SetVolume', Arguments: { Volume: 20 } });
  let v = (await sender.req('GET', `/Sessions?DeviceId=uuid-mock-tv`)).json[0];
  assert.equal(v.NowPlayingItem?.Id, 'movie-2', `${m.kind}: virtual Play not simulated`);
  assert.equal(v.PlayState.IsPaused, true, `${m.kind}: virtual Pause`);
  assert.equal(v.PlayState.PositionTicks, 2 * pos, `${m.kind}: virtual Seek`);
  assert.equal(v.PlayState.VolumeLevel, 20, `${m.kind}: virtual SetVolume`);
  assert.equal((await call(`${m.root}/Mock/Sessions/${dlna.Id}/Unpause`, { method: 'POST' })).status, 204, `${m.kind}: drive Unpause`);
  await sleep(120);
  v = (await sender.req('GET', `/Sessions?DeviceId=uuid-mock-tv`)).json[0];
  assert.equal(v.PlayState.IsPaused, false, `${m.kind}: driven Unpause`);
  assert.ok(v.PlayState.PositionTicks > 2 * pos, `${m.kind}: the position does not advance while playing`);
  const stale = await addVirtual(m, { DeviceName: 'Stale socket', Client: 'Wicaby', DeviceId: 'ck-stale', ignore: true });
  assert.equal((await sender.req('POST', `/Sessions/${stale.Id}/Playing?ItemIds=movie-3&PlayCommand=PlayNow`)).status, 204, `${m.kind}: ignore:true still answers 204`);
  assert.equal((await sender.req('GET', '/Sessions?DeviceId=ck-stale')).json[0].NowPlayingItem, undefined, `${m.kind}: ignore:true started playing`);
  const st = await mockState(m);
  assert.ok(Array.isArray(st.remote), `${m.kind}: /Mock/State has no remote[]`);
  const rec = st.remote.filter((r) => r.SessionId === dlna.Id).map((r) => r.Data.Command ?? r.Data.Name ?? r.Data.PlayCommand);
  assert.deepEqual(rec, ['PlayNow', 'Pause', 'Seek', 'SetVolume'], `${m.kind}: remote[] for the DLNA session: ${rec}`);
  assert.ok(st.remote.some((r) => r.SessionId === stale.Id && r.virtual), `${m.kind}: the ignored command is not recorded`);
  notes.push(`4 virtual (${st.remote.length} in remote[])`);

  // 5. Dialect differences.
  const playbackRate = (await sender.req('POST', `/Sessions/${target.Id}/Command`, { Name: 'SetPlaybackRate', Arguments: { PlaybackRate: 1.5 } })).status;
  const playbackRatePath = (await sender.req('POST', `/Sessions/${target.Id}/Command/SetPlaybackRate`)).status;
  const seekRelative = (await sender.req('POST', `/Sessions/${target.Id}/Playing/SeekRelative?SeekPositionTicks=${10_000 * TICKS}`)).status;
  const capsRate = (await recv.caps({ SupportedCommands: ['Play', 'SetPlaybackRate'] })).status;
  const want = m.kind === 'jellyfin' ? 400 : 204;
  assert.deepEqual([playbackRate, playbackRatePath, seekRelative, capsRate], [want, want, want, want], `${m.kind}: SetPlaybackRate, /Command/SetPlaybackRate, SeekRelative, capabilities`);
  if (m.kind === 'jellyfin') assert.ok(await listed(), 'jellyfin: a rejected capabilities body replaced the stored one');
  notes.push(`5 Emby-only names → ${want}`);

  sock.ws.close();
  senderSock.ws.close();
  return notes.join('; ');
}

// MOCK_SHARED_DEVICE_CONTROL=0 (both), MOCK_NON_ADMIN=1 (Jellyfin), MOCK_NO_SESSIONS_PUSH=1 (Emby variant).
async function runVariant(m) {
  const sender = await signIn(m, 'ck-sender');
  await sender.caps();
  const s = openSocket(sender);
  await s.opened;
  const dlna = await addVirtual(m, { DeviceName: 'Mock TV', Client: 'DLNA', DeviceId: 'uuid-mock-tv' });
  const other = await addVirtual(m, { DeviceName: 'Someone else', Client: 'Wicaby', DeviceId: 'ck-other', UserId: 'another-user' });
  const ctl = await sender.controllable();
  assert.ok(!ctl.some((x) => x.Id === dlna.Id), `${m.kind}: ownerless session listed without shared device control`);
  assert.ok(ctl.some((x) => x.Id === other.Id), `${m.kind}: another user's session should stay controllable`);
  assert.ok((await sender.req('GET', '/Sessions')).json.some((x) => x.Id === dlna.Id), `${m.kind}: the plain list lost the ownerless session`);
  s.send('SessionsStart', '0,1500');
  const push = await s.next('Sessions', { ms: m.kind === 'emby' ? 800 : 2000 });
  if (m.kind === 'emby') assert.equal(push, null, 'emby: pushed with MOCK_NO_SESSIONS_PUSH=1');
  else {
    assert.ok(push, 'jellyfin: no push for a non-admin');
    assert.ok(push.Data.some((x) => x.DeviceId === 'ck-sender'), 'jellyfin: non-admin push lacks the own session');
    assert.ok(!push.Data.some((x) => x.Id === dlna.Id || x.Id === other.Id), 'jellyfin: non-admin push carries sessions the caller does not own');
  }
  s.ws.close();
  return m.kind === 'emby' ? 'no shared control, no push' : 'no shared control, non-admin push';
}

const T0 = performance.now();
let failed = 0;
try {
  const mocks = await Promise.all([
    startMock('emby'),
    startMock('jellyfin'),
    startMock('emby', { MOCK_SHARED_DEVICE_CONTROL: '0', MOCK_NO_SESSIONS_PUSH: '1' }),
    startMock('jellyfin', { MOCK_SHARED_DEVICE_CONTROL: '0', MOCK_NON_ADMIN: '1' }),
  ]);
  const runs = [
    ['emby', () => runMain(mocks[0])],
    ['jellyfin', () => runMain(mocks[1])],
    ['emby variant', () => runVariant(mocks[2])],
    ['jellyfin variant', () => runVariant(mocks[3])],
  ];
  const results = await Promise.allSettled(runs.map(([, f]) => f()));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') console.log(`  ok   ${runs[i][0]}: ${r.value}`);
    else {
      failed++;
      console.log(`  FAIL ${runs[i][0]}: ${r.reason?.message ?? r.reason}`);
    }
  });
} catch (err) {
  failed++;
  console.log(`sessions-mock-check: ${err.message}`);
} finally {
  children.forEach((c) => c.kill());
}
console.log(failed ? `sessions-mock-check: ${failed} failure(s)` : `sessions-mock-check: OK (${Math.round(performance.now() - T0)} ms)`);
process.exit(failed ? 1 : 0);
