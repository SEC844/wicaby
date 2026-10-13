// Phone-to-TV features, exercised headlessly against the mock servers with the exact requests the
// Android clients send (core/cast/RemoteTargets.kt, RemoteControl.kt, tv/ui/PhonePair.kt):
// - "Lire sur…": GET /Sessions?ControllableByUserId=, POST /Sessions/{id}/Playing (PlayNow) and
//   /Sessions/{id}/Playing/{command}; on Jellyfin 12 they must reach the TV's /socket as Play / Playstate;
// - QR sign-in: the TV checks the phone's token with GET /Users/{id}.
// Usage: node tools/checks/play-on-check.mjs   (starts mock-emby and mock-jellyfin on 8938/8939, then stops them)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const EMBY = 8938;
const JELLYFIN = 8939;
const TICKS = 10_000;
const device = (id) => `Client="Wicaby", Device="${id}", DeviceId="${id}", Version="0"`;

function start(script, port) {
  const child = spawn(process.execPath, [path.join(root, 'tools/mock-server', script), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => reject(new Error(`${script} exited (${code}): is port ${port} taken?`)));
    child.stdout.on('data', (d) => String(d).includes(`:${port}`) && resolve(child));
  });
}

async function call(base, p, headers, init = {}) {
  const res = await fetch(base + p, { ...init, headers: { 'Content-Type': 'application/json', ...headers } });
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
}
const post = (base, p, h, body) => call(base, p, h, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
try {
  children.push(await start('mock-emby.mjs', EMBY), await start('mock-jellyfin.mjs', JELLYFIN));

  // Emby: the dashboard sessions; commands change what the session reports.
  {
    const base = `http://127.0.0.1:${EMBY}/emby`;
    const login = await post(base, '/Users/AuthenticateByName', { 'X-Emby-Authorization': `Emby ${device('phone')}` }, { Username: 'Wika', Pw: 'wicaby' });
    assert.equal(login.status, 200, 'emby login');
    const h = { 'X-Emby-Token': login.body.AccessToken };
    const uid = login.body.User.Id;
    const list = async () => (await call(base, `/Sessions?ControllableByUserId=${uid}&ActiveWithinSeconds=960`, h)).body;
    const sessions = await list();
    assert.ok(sessions.length > 0, 'emby: no controllable session');
    assert.ok(sessions.every((s) => s.SupportsRemoteControl), 'emby: a session without remote control is listed');
    const tv = sessions.find((s) => s.Id === 'sess-theater');
    assert.ok(tv, 'emby: idle remote-controllable session missing');
    const state = async () => (await list()).find((s) => s.Id === tv.Id);

    assert.equal((await post(base, `/Sessions/${tv.Id}/Playing?ItemIds=movie-1&PlayCommand=PlayNow&StartPositionTicks=${60_000 * TICKS}`, h)).status, 204, 'emby: PlayNow');
    let s = await state();
    assert.equal(s.NowPlayingItem?.Id, 'movie-1', 'emby: PlayNow did not start the item');
    assert.equal(s.PlayState.IsPaused, false);
    assert.ok(s.PlayState.PositionTicks >= 60_000 * TICKS, 'emby: StartPositionTicks ignored');

    await post(base, `/Sessions/${tv.Id}/Playing/Seek?SeekPositionTicks=${600_000 * TICKS}`, h);
    await post(base, `/Sessions/${tv.Id}/Playing/PlayPause`, h);
    s = await state();
    assert.equal(s.PlayState.IsPaused, true, 'emby: PlayPause did not pause');
    assert.ok(Math.abs(s.PlayState.PositionTicks - 600_000 * TICKS) < 5_000 * TICKS, 'emby: Seek ignored');
    await post(base, `/Sessions/${tv.Id}/Playing/Stop`, h);
    assert.equal((await state()).NowPlayingItem, undefined, 'emby: Stop ignored');
    assert.equal((await post(base, `/Sessions/sess-nope/Playing/Stop`, h)).status, 404, 'emby: unknown session');

    // QR sign-in: the token the phone hands over is checked against /Users/{id}.
    assert.equal((await call(base, `/Users/${uid}`, h)).body?.Id, uid, 'emby: /Users/{id} with the token');
    assert.equal((await call(base, `/Users/${uid}`, { 'X-Emby-Token': 'forged' })).status, 401, 'emby: forged token accepted');
  }

  // Jellyfin 12: a "TV" with an open /socket is controllable; commands arrive on that socket.
  {
    const base = `http://127.0.0.1:${JELLYFIN}`;
    const signIn = async (id) => {
      const r = await post(base, '/Users/AuthenticateByName', { Authorization: `MediaBrowser ${device(id)}` }, { Username: 'Wika', Pw: 'wicaby' });
      assert.equal(r.status, 200, `jellyfin login ${id}`);
      return { token: r.body.AccessToken, uid: r.body.User.Id, h: { Authorization: `MediaBrowser ${device(id)}, Token="${r.body.AccessToken}"` } };
    };
    const phone = await signIn('phone');
    const tv = await signIn('tv');
    await post(base, '/Sessions/Capabilities/Full', tv.h, { PlayableMediaTypes: ['Video', 'Audio'], SupportedCommands: ['Play', 'Playstate'], SupportsMediaControl: true });
    const ws = new WebSocket(`ws://127.0.0.1:${JELLYFIN}/socket?ApiKey=${tv.token}&deviceId=tv`);
    const frames = [];
    ws.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data))));
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    await post(base, '/Sessions/Playing', tv.h, { ItemId: 'movie-0', MediaSourceId: 'movie-0', PlaySessionId: 'p', PlayMethod: 'DirectPlay', PositionTicks: 42 * TICKS * 1000, IsPaused: false });

    const sessions = (await call(base, `/Sessions?ControllableByUserId=${phone.uid}&ActiveWithinSeconds=960`, phone.h)).body;
    const target = sessions.find((s) => s.DeviceId === 'tv');
    assert.ok(target, 'jellyfin: the TV with a socket is not listed');
    assert.ok(!sessions.some((s) => s.DeviceId === 'phone'), 'jellyfin: a session without a socket is listed');
    assert.equal(target.NowPlayingItem?.Id, 'movie-0', 'jellyfin: NowPlayingItem missing');
    assert.equal(target.PlayState?.PositionTicks, 42 * TICKS * 1000);

    await post(base, `/Sessions/${target.Id}/Playing?ItemIds=movie-1&PlayCommand=PlayNow&StartPositionTicks=0`, phone.h);
    await post(base, `/Sessions/${target.Id}/Playing/Seek?SeekPositionTicks=${600_000 * TICKS}`, phone.h);
    await post(base, `/Sessions/${target.Id}/Playing/NextTrack`, phone.h);
    for (let i = 0; i < 50 && frames.filter((f) => f.MessageType !== 'ForceKeepAlive').length < 3; i++) await wait(20);
    const got = frames.filter((f) => f.MessageType !== 'ForceKeepAlive');
    assert.deepEqual(got[0]?.MessageType, 'Play', 'jellyfin: Play not relayed');
    assert.deepEqual(got[0].Data.ItemIds, ['movie-1']);
    assert.equal(got[0].Data.PlayCommand, 'PlayNow');
    assert.equal(got[0].Data.StartPositionTicks, 0);
    assert.equal(got[1]?.MessageType, 'Playstate', 'jellyfin: Seek not relayed');
    assert.equal(got[1].Data.Command, 'Seek');
    assert.equal(got[1].Data.SeekPositionTicks, 600_000 * TICKS);
    assert.equal(got[2]?.Data?.Command, 'NextTrack', 'jellyfin: NextTrack not relayed');
    assert.equal((await post(base, `/Sessions/nope/Playing/Stop`, phone.h)).status, 404, 'jellyfin: unknown session');
    ws.close();

    assert.equal((await call(base, `/Users/${phone.uid}`, { Authorization: `MediaBrowser ${device('tv')}, Token="${phone.token}"` })).body?.Id, phone.uid, 'jellyfin: /Users/{id} with the shared token');
    assert.equal((await call(base, `/Users/${phone.uid}`, { Authorization: `MediaBrowser ${device('tv')}, Token="forged"` })).status, 401, 'jellyfin: forged token accepted');
  }
  console.log('play-on-check: OK (Emby and Jellyfin sessions, remote commands, token check)');
} finally {
  for (const c of children) c.kill();
}
