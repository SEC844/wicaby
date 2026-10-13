// Plex playback on the desktop (plex-spec §6, PX-08 to PX-10) against tools/mock-server/mock-plex.mjs on loopback,
// with the real PlexClient, SessionReporter, MpvController (bundled mpv, --vo=null --ao=null --mute: nothing
// visible or audible) and the cast relay:
//   decision  mpv direct plays the h264 MKV through Part.key (token as a header, never in the URL); HEVC on the HTML
//             player transcodes; a resume at 600 s has offset=600 in start.m3u8 and StartTimeTicks, and mpv
//             playing it asks no segment before the offset (SEEK-AFTER-OFFSET = 0); a remote session starts at the
//             owner's cap (one decision, no refusal); a shared user, who cannot read the cap, steps down the presets
//             once and then starts at the cap it found; MOCK_REMOTE_PASS=0 explains the remote-pass gate; a PGS pick
//             on the HTML player sends subtitles=burn; a two-part film resumed in part 2 transcodes partIndex=1 from
//             the offset inside it, counted from the film's start; a BIF is offered only where the part has one
//   play      resume at the viewOffset, 5 s muted, pause, seek, an audio change, stop (twice): timelines
//             playing…paused…playing…stopped, exactly one stopped, one PUT /library/parts/{id}?audioStreamID=,
//             DUP-STOPPED = DUP-SCROBBLE = TOKEN-IN-URL = NO-CLIENT-ID = 0; a stop past 90 % lets PMS mark it
//             played with no extra scrobble, and so does a stop in the credits before 90 % (§6.5, Plezy #1740);
//             /Mock/Terminate ends the session at the next report with its reason, or through the PMS socket's
//             'playing' notification (ServerSocket, then serverEnded) with one stopped report that brings the reason;
//             Trakt still gets its stop; our own stop echoed back is ignored; nothing is reported after, not even a
//             progress racing the server-forced stop; a two-part film hands its session from part to part (one
//             stopped timeline, a progress at the boundary); a multi-episode file's episodes share their source
//   extras    intro and credits markers on show A (none on a film's intro), PlexPass=false explained when a
//             server without Plex Pass has none; the part's BIF decodes; a two-part film plays as one mpv EDL
//   cast      the relay serves the part and the HLS without a token in any URL; a Plex cast without the relay is
//             refused (plex.errors.castNeedsRelay). The senders themselves: plex-cast-check.mjs
// Without mpv the mpv parts are skipped and said so.
// Usage: node tools/checks/plex-playback-check.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { buildFilesFixture, findMpv } from '../mock-server/files-fixture.mjs';
import { MACHINE_ID, startMockPlex } from '../mock-server/mock-plex.mjs';

const repo = path.resolve(import.meta.dirname, '..', '..');
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|localhost)$/;
const TICKS = 10_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (c, m) => (assert.ok(c, m), passed++, process.env.VERBOSE && console.log(`  ok ${m}`));

// ---- Nothing leaves 127.0.0.1 ----
{
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...a) {
    let o = a[0];
    if (Array.isArray(o)) o = o[0];
    const h = o && typeof o === 'object' ? (o.path ? undefined : o.host) : a[1];
    if (h !== undefined && !LOOPBACK.test(String(h).replace(/^\[|\]$/g, ''))) throw new Error(`GUARD: non-loopback connect to ${h}`);
    return connect.apply(this, a);
  };
}
const loopbackUrl = (url) => {
  if (!LOOPBACK.test(new URL(url).hostname.replace(/^\[|\]$/g, ''))) throw new Error(`GUARD: refusing ${url}`);
};
globalThis.__plexNet = {
  fetch: (url, init) => (loopbackUrl(String(url)), fetch(url, init)),
  // fetchServer's net.request, over node:http.
  request(opts) {
    loopbackUrl(opts.url);
    const ee = new EventEmitter();
    const headers = {};
    let req;
    ee.setHeader = (k, v) => (headers[k] = v);
    ee.followRedirect = () => {
      throw new Error('no redirect in this check');
    };
    ee.abort = () => (req?.destroy(), ee.emit('abort'));
    ee.end = () => {
      req = http.request(opts.url, { method: opts.method, headers }, (res) => ee.emit('response', res));
      req.on('error', (e) => ee.emit('error', e));
      req.end();
    };
    return ee;
  },
};

// ---- Bundle (esbuild, Electron stubbed) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-plex-play-'));
const srcOf = (p) => path.join(repo, 'apps/desktop/src', p).replace(/\\/g, '/');
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `export { PlexClient } from '${srcOf('main/connection/plex-client.ts')}';
export { SessionReporter } from '${srcOf('main/playback/session-reporter.ts')}';
export { ServerSocket } from '${srcOf('main/connection/server-socket.ts')}';
export { MpvController } from '${srcOf('main/playback/mpv-controller.ts')}';
export { buildDeviceProfile } from '${srcOf('main/playback/device-profile.ts')}';
export { Relay, relayPathAllowed } from '${srcOf('main/cast/relay.ts')}';
export { deviceUrls, serverPath, CastFailure } from '${srcOf('main/cast/dlna-cast.ts')}';
export { fetchFromServer } from '${srcOf('main/protocols.ts')}';
export { resolveServerUrl } from '${srcOf('main/connection/api-client.ts')}';
export { parseBif } from '${srcOf('shared/bif.ts')}';
`,
);
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export const net = { fetch: (...a) => globalThis.__plexNet.fetch(...a), request: (o) => globalThis.__plexNet.request(o) };
export const app = { isReady: () => false, isPackaged: false, getLocale: () => 'en', getPath: () => '.', on() {} };
export const powerSaveBlocker = { start: () => 1, stop: () => undefined, isStarted: () => true };
export const safeStorage = {}; export const protocol = {}; export const session = {}; export const shell = {}; export const dialog = {};
export const BrowserWindow = class {}; export const screen = {}; export const nativeTheme = {}; export const ipcMain = {};
export default { app, net };`,
    }));
  },
};
const out = path.join(tmp, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [electronStub], banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
const P = await import(pathToFileURL(out).href);
for (const k of ['debug', 'info']) console[k] = () => {};

const plexStrings = Object.fromEntries(['fr', 'en'].map((l) => [l, JSON.parse(fs.readFileSync(path.join(repo, `apps/desktop/src/renderer/locales/${l}/plex.json`), 'utf8'))]));
const isString = (msg, group, key) => ['fr', 'en'].some((l) => plexStrings[l][group][key] === msg);

// ---- The mock, its 10 s test clip behind every part ----
const fx = buildFilesFixture(path.join(tmp, 'tree'));
const clip = fx.playable ? path.join(fx.dir, ...fx.film.split('/')) : undefined;
const m = await startMockPlex({ port: 0, tvPort: 0, relayPort: 0, env: { MOCK_PLEX_VIDEO: clip ?? '', MOCK_REMOTE_CAP_KBPS: '2000', MOCK_PLEX_SECOND: '0', MOCK_PLEX_TLS: '0' } });
const identity = { client: 'Wicaby', version: '0.0.0-check', deviceId: 'check-device-plex', deviceName: 'check' };
const token = m.serverToken();
const client = new P.PlexClient(m.pms, identity, token, '1', { machineId: MACHINE_ID, userName: 'Wika', owner: true });
const remote = new P.PlexClient(m.relay, identity, token, '1', { machineId: MACHINE_ID, userName: 'Wika', owner: true, remote: true });
const mpvExe = findMpv();

const info = (api, id, player, extra = {}) =>
  api.request('POST', `/Items/${id}/PlaybackInfo`, { UserId: '1', IsPlayback: true }, { DeviceProfile: P.buildDeviceProfile(player, 100_000_000, 'plex'), MaxStreamingBitrate: 100_000_000, ...extra });
const lastDecision = () => m.state.decisions.at(-1);
const film = (await client.request('GET', '/Users/1/Items/1000')).MediaSources;
const theatrical = film.find((s) => s.Name === 'Theatrical').Id;
const directorsCut = film.find((s) => s.Name === "Director's Cut").Id;

// ---- Decision ----
const direct = await info(client, '1000', 'mpv', { MediaSourceId: theatrical });
ok(direct.MediaSources[0].SupportsDirectPlay && !direct.MediaSources[0].TranscodingUrl && lastDecision().result === 'directplay', 'mpv direct plays the h264 MKV');
const partUrl = client.url('/Videos/1000/stream', { Static: true, MediaSourceId: theatrical, PlaySessionId: direct.PlaySessionId });
ok(/\/library\/parts\/\d+\/\d+\/file\.mkv$/.test(new URL(partUrl).pathname) && !partUrl.includes(token), `mpv gets Part.key, no token in the URL (${new URL(partUrl).pathname})`);
const hevc = await info(client, '1000', 'html', { MediaSourceId: directorsCut });
ok(!hevc.MediaSources[0].SupportsDirectPlay && /\/video\/:\/transcode\/universal\/start\.m3u8\?/.test(hevc.MediaSources[0].TranscodingUrl) && lastDecision().result === 'transcode', 'HEVC on the HTML player transcodes (start.m3u8)');
const resume = await info(client, '1002', 'html', { StartTimeTicks: 600_000 * TICKS });
const startUrl = resume.MediaSources[0].TranscodingUrl;
ok(new URL(startUrl, 'http://x').searchParams.get('offset') === '600' && resume.MediaSources[0].StartTimeTicks === 600_000 * TICKS && lastDecision().offset === 600, 'resume at 600 s: offset=600 in the decision and start.m3u8, StartTimeTicks on the source');
ok(!startUrl.includes(token) && new URL(startUrl, 'http://x').searchParams.get('X-Plex-Client-Identifier') === identity.deviceId, 'start.m3u8 carries the client id, never the token');
let capped = m.state.decisions.length;
const viaRelay = await info(remote, '1001', 'mpv');
let sent = m.state.decisions.slice(capped);
ok(sent.length === 1 && sent[0].maxVideoBitrate === '2000' && sent[0].result !== '500' && viaRelay.MediaSources.length === 1, `a remote session starts at the owner's 2000 kbps cap: one decision, no refusal (${sent.map((d) => `${d.maxVideoBitrate}:${d.result}`).join(', ')})`);
// A shared user cannot read /:/prefs: one refusal, the presets down to the cap, then the next play starts there.
const guest = new P.PlexClient(m.relay, identity, m.serverToken('c3d4e5f60718293a'), '3', { machineId: MACHINE_ID, userName: 'Guest', owner: false, remote: true });
capped = m.state.decisions.length;
const guestPlay = await info(guest, '1001', 'mpv');
sent = m.state.decisions.slice(capped);
ok(guestPlay.MediaSources.length === 1 && sent[0].result === '500' && sent.at(-1).maxVideoBitrate === '2000' && sent.at(-1).result !== '500', `a shared user: refused, then the presets down to the cap (${sent.map((d) => `${d.maxVideoBitrate ?? '-'}:${d.result}`).join(', ')})`);
capped = m.state.decisions.length;
await info(guest, '1002', 'mpv');
sent = m.state.decisions.slice(capped);
ok(sent.length === 1 && sent[0].maxVideoBitrate === '2000' && sent[0].result !== '500', 'and its next remote play starts at the cap it found (one decision)');
const pgsId = (await client.request('GET', '/Users/1/Items/1004')).MediaSources[0].MediaStreams.find((s) => s.Codec === 'pgssub').Index;
await info(client, '1004', 'html', { SubtitleStreamIndex: pgsId });
ok(lastDecision().subtitles === 'burn', 'a PGS pick on the HTML player sends subtitles=burn');
await info(client, '1004', 'mpv', { SubtitleStreamIndex: pgsId });
ok(lastDecision().subtitles === 'auto' && lastDecision().result === 'directplay', 'mpv draws PGS itself (subtitles=auto, direct play)');

// A second PMS: no remote pass, no Plex Pass.
const m2 = await startMockPlex({ port: 0, tvPort: 0, relayPort: 0, env: { MOCK_REMOTE_PASS: '0', MOCK_PLEX_PASS: '0', MOCK_PLEX_SECOND: '0', MOCK_PLEX_TLS: '0' } });
const remote2 = new P.PlexClient(m2.relay, identity, m2.serverToken(), '1', { machineId: MACHINE_ID, userName: 'Wika', owner: true, remote: true });
const gated = await info(remote2, '1000', 'mpv').then(() => null, (e) => e);
ok(gated?.status === 403 && isString(gated.message, 'errors', 'remoteNeedsPass'), 'MOCK_REMOTE_PASS=0: the remote-pass message (plex.errors.remoteNeedsPass)');
const local2 = new P.PlexClient(m2.pms, identity, m2.serverToken(), '1', { machineId: MACHINE_ID, userName: 'Wika', owner: true });
const noMarkers = await local2.request('GET', '/MediaSegments/2102');
ok(noMarkers.Items.length === 0 && noMarkers.PlexPass === false, 'no markers on a server without Plex Pass: PlexPass=false (the player explains it)');
const soft = await info(local2, '1000', 'html', { MediaSourceId: directorsCut });
ok(soft.PlexPass === false && soft.MediaSources[0].TranscodingUrl, 'a transcode on a server without Plex Pass says so (PlexPass=false)');

// ---- Markers and BIF ----
const segs = await client.request('GET', '/MediaSegments/2003');
ok(segs.Items.some((s) => s.Type === 'Intro') && segs.Items.some((s) => s.Type === 'Outro') && segs.PlexPass === undefined, 'show A: intro and credits markers');
ok(!(await client.request('GET', '/MediaSegments/1000')).Items.some((s) => s.Type === 'Intro'), "a film's intro marker is dropped (#2235)");
const ep = await client.request('GET', '/Users/1/Items/2003');
const bifRes = await P.fetchFromServer(client, `/Videos/2003/index.bif?MediaSourceId=${ep.MediaSources[0].Id}`, 'GET', () => null);
const bif = P.parseBif(new Uint8Array(await bifRes.arrayBuffer()));
ok(bifRes.status === 200 && bif.frames.length > 0 && bif.intervalMs === 10_000, `the part's BIF decodes (${bif.frames.length} frames)`);
ok((await P.fetchFromServer(client, '/Videos/2003/index.bif?MediaSourceId=0', 'GET', () => null)).status === 200, 'a BIF for an unknown version falls back to the first readable part');
ok((await info(client, '2003', 'mpv')).MediaSources[0].Bif === true && !(await info(client, '1005', 'mpv')).MediaSources[0].Bif, 'PlaybackInfo offers the BIF of a part that has one (Bif), none on a multi-part film');

// ---- Reports (the session reporter with a stand-in host; mpv drives the position when it is here) ----
function host(api, item, source, playSessionId, playMethod = 'DirectPlay') {
  const ended = [];
  const trakt = [];
  const h = {
    deps: { connection: { onlineApi: () => api }, downloads: { queueUserData() {} } },
    current: { item, source, playSessionId, playMethod, offline: false, serverId: MACHINE_ID, userId: '1', audioIndex: source.DefaultAudioStreamIndex ?? null, subtitleIndex: null, kind: 'mpv', trailer: false },
    state: { positionMs: 0, durationMs: (item.RunTimeTicks ?? 0) / TICKS, paused: false, muted: true, volume: 0, rate: 1, markers: undefined },
    serverId: MACHINE_ID,
    lives: { releaseLive: async () => true, endEncode: async () => {}, session: { killEncodes: async () => {} } },
    report: (action) => trakt.push(action),
    terminated: (c, text) => ended.push({ c, text }),
  };
  return { h, ended, trakt, reporter: new P.SessionReporter(h) };
}
const flush = () => sleep(150);
const timelinesOf = (session) => m.state.timelines.filter((x) => x.session === session).map((x) => x.state);

// Resume point at 3 s (offline progress, /:/progress), read back as the item's UserData.
await client.request('POST', '/Users/1/Items/2003/UserData', undefined, { PlaybackPositionTicks: 3_000 * TICKS });
const item = await client.request('GET', '/Users/1/Items/2003');
const startMs = item.UserData.PlaybackPositionTicks / TICKS;
ok(startMs === 3000, 'the viewOffset comes back as the resume point (3 s)');
const play = await info(client, '2003', 'mpv', { StartTimeTicks: startMs * TICKS, AudioStreamIndex: item.MediaSources[0].DefaultAudioStreamIndex });
const src = play.MediaSources[0];
ok(src.SupportsDirectPlay && !src.StartTimeTicks, 'direct play: the player seeks to the resume point itself (no StartTimeTicks)');
const { h, reporter } = host(client, item, src, play.PlaySessionId);
const callsBefore = m.state.calls.length;
reporter.start();
await flush();
let mpv = null;
if (mpvExe && clip) {
  mpv = new P.MpvController(mpvExe);
  await mpv.start(['--idle=yes', '--vo=null', '--ao=null', '--mute=yes', '--no-config', '--no-terminal']);
  await mpv.observe('time-pos');
  mpv.on('property', (n, v) => n === 'time-pos' && typeof v === 'number' && (h.state.positionMs = Math.round(v * 1000)));
  const headers = client.mediaAuthHeaders().join(',');
  // As MpvPlayer loads a file: start as a global, the auth header as a per-file option (%n% quoting).
  await mpv.set('start', `+${(startMs / 1000).toFixed(3)}`);
  await mpv.command('loadfile', client.url('/Videos/2003/stream', { Static: true, MediaSourceId: src.Id }), 'replace', -1, `http-header-fields=%${Buffer.byteLength(headers)}%${headers}`);
  const t0 = Date.now();
  while (h.state.positionMs < startMs + 5000 && Date.now() - t0 < 30_000) await sleep(100);
  ok(h.state.positionMs >= startMs + 5000, `mpv played 5 s from the resume point (at ${h.state.positionMs} ms)`);
  await mpv.set('pause', true);
} else {
  console.log(`plex-playback-check: mpv part skipped (${mpvExe ? 'no playable clip' : 'mpv not found'})`);
  h.state.positionMs = startMs + 5000;
}
h.state.paused = true;
reporter.progress('Pause');
await flush();
h.state.paused = false;
if (mpv) await mpv.set('pause', false);
reporter.progress('Unpause');
await flush();
if (mpv) {
  await mpv.command('seek', 1, 'absolute');
  const t1 = Date.now();
  while ((h.state.positionMs > 2500 || h.state.positionMs < 1000) && Date.now() - t1 < 10_000) await sleep(50);
  ok(h.state.positionMs >= 1000 && h.state.positionMs <= 2500, `mpv seeked back to 1 s (at ${h.state.positionMs} ms)`);
} else h.state.positionMs = 1000;
reporter.progress('TimeUpdate');
await flush();
// An audio change in place: the progress event, and the part remembers it.
const otherAudio = src.MediaStreams.find((s) => s.Type === 'Audio' && s.Index !== h.current.audioIndex).Index;
h.current.audioIndex = otherAudio;
reporter.progress('AudioTrackChange');
await flush();
reporter.progress('AudioTrackChange');
await flush();
const c = h.current;
await reporter.stopped(c);
await reporter.stopped(c);
await flush();
if (mpv) await mpv.quit();
const states = timelinesOf(play.PlaySessionId);
ok(states.join(',') === 'playing,paused,playing,playing,playing,playing,stopped', `timelines playing…paused…playing…stopped (${states.join(',')})`);
ok(states.filter((s) => s === 'stopped').length === 1, 'exactly one stopped timeline, the second stop sent nothing');
const puts = m.state.partPuts.filter((p) => p.audioStreamID === String(otherAudio));
ok(puts.length === 1 && puts[0].allParts === '1', `one PUT /library/parts/${puts[0]?.part}?audioStreamID=${otherAudio}&allParts=1 for the change (the same pick again sends none)`);
if (mpv) {
  const partCalls = m.state.calls.slice(callsBefore).filter((x) => /^\/library\/parts\/\d+\/\d+\/file\.mkv$/.test(x.path));
  ok(partCalls.length > 0 && partCalls.every((x) => x.status === 200 || x.status === 206) && partCalls.every((x) => !('X-Plex-Token' in x.query)), `mpv's ${partCalls.length} part request(s) were authorised by the header (no token in a URL, client id sent)`);
}

// Stop past 90 %: PMS marks it played; no scrobble from Wicaby.
const near = await info(client, '2004', 'mpv');
const nearItem = await client.request('GET', '/Users/1/Items/2004');
const r2 = host(client, nearItem, near.MediaSources[0], near.PlaySessionId);
r2.reporter.start();
await flush();
r2.h.state.positionMs = Math.round(r2.h.state.durationMs * 0.95);
const scrobbles = m.state.scrobbles.length;
await r2.reporter.stopped();
await sleep(300);
ok((await client.request('GET', '/Users/1/Items/2004')).UserData.Played === true && m.state.scrobbles.length === scrobbles, 'a stop at 95 %: PMS marks it played at its threshold, Wicaby adds no scrobble');

// Stop in the credits (marker at 80 %) before 90 %: Wicaby counts it played, but PMS applies its own threshold, so
// no /:/scrobble either (a second history entry, Plezy #1740).
const credits = await info(client, '1000', 'mpv', { MediaSourceId: theatrical });
const creditsItem = await client.request('GET', '/Users/1/Items/1000');
const r2b = host(client, creditsItem, credits.MediaSources[0], credits.PlaySessionId);
r2b.h.state.markers = { creditsStartMs: Math.round(r2b.h.state.durationMs * 0.8) };
r2b.reporter.start();
await flush();
r2b.h.state.positionMs = Math.round(r2b.h.state.durationMs * 0.85);
const scrobbles2 = m.state.scrobbles.length;
await r2b.reporter.stopped();
await sleep(300);
ok(timelinesOf(credits.PlaySessionId).join(',') === 'playing,stopped' && m.state.scrobbles.length === scrobbles2, `a stop in the credits at 85 %: one stopped timeline, no scrobble (${timelinesOf(credits.PlaySessionId).join(',')}; ${m.state.scrobbles.length - scrobbles2} scrobble)`);

// Termination: the next report carries the reason; the player stops and reports nothing more.
const term = await info(client, '1003', 'mpv');
const r3 = host(client, await client.request('GET', '/Users/1/Items/1003'), term.MediaSources[0], term.PlaySessionId);
r3.reporter.start();
await flush();
await fetch(`${m.pms}/Mock/Terminate?session=${encodeURIComponent(term.PlaySessionId)}&reason=${encodeURIComponent('Maintenance du serveur')}`, { method: 'POST' });
r3.h.state.positionMs = 20_000;
r3.reporter.progress('TimeUpdate');
await flush();
ok(r3.ended.length === 1 && r3.ended[0].text === 'Maintenance du serveur', 'a termination ends the session with the owner\'s reason');
const before = timelinesOf(term.PlaySessionId).length;
r3.reporter.progress('TimeUpdate');
await r3.reporter.stopped(r3.ended[0].c);
await flush();
ok(timelinesOf(term.PlaySessionId).length === before, 'nothing is reported after a termination');
ok(r3.trakt.join(',') === 'start,stop', `Trakt still gets its stop after a termination (${r3.trakt.join(',')})`);

// Termination through the PMS socket: the real ServerSocket turns the 'playing' stopped notification for this
// client into PlexSessionEnded; the reporter sends its one stopped report, which brings the reason back.
const sock = new P.ServerSocket(m.pms, 'plex', token, identity.deviceId);
const pushed = [];
sock.on('message', (msg) => pushed.push(msg));
sock.open();
for (let i = 0; i < 50 && sock.state !== 'open'; i++) await sleep(100);
const term2 = await info(client, '1003', 'mpv');
const r4 = host(client, await client.request('GET', '/Users/1/Items/1003'), term2.MediaSources[0], term2.PlaySessionId);
r4.reporter.start();
await flush();
await fetch(`${m.pms}/Mock/Terminate?session=${encodeURIComponent(term2.PlaySessionId)}&reason=${encodeURIComponent('Le propriétaire a arrêté ce flux')}`, { method: 'POST' });
for (let i = 0; i < 30 && !pushed.some((x) => x.MessageType === 'PlexSessionEnded'); i++) await sleep(100);
sock.close();
const endedMsg = pushed.find((x) => x.MessageType === 'PlexSessionEnded');
ok(endedMsg?.Data?.ItemId === '1003', `the socket's 'playing' stopped notification for this client becomes PlexSessionEnded (${JSON.stringify(endedMsg ?? null)})`);
r4.h.state.positionMs = 7000;
await r4.reporter.serverEnded(MACHINE_ID, endedMsg?.Data?.ItemId ?? '');
const states4 = timelinesOf(term2.PlaySessionId);
ok(r4.ended.length === 1 && r4.ended[0].text === 'Le propriétaire a arrêté ce flux' && states4.join(',') === 'playing,stopped', `the session ends with the owner's reason, one stopped report (${states4.join(',')})`);
await r4.reporter.stopped(r4.ended[0].c);
await flush();
ok(timelinesOf(term2.PlaySessionId).length === 2 && r4.trakt.join(',') === 'start,stop', 'nothing more is reported; Trakt gets its stop');
// Our own stop, echoed back while a restart of the same item plays: ignored.
const echo = await info(client, '1001', 'mpv');
const r5 = host(client, await client.request('GET', '/Users/1/Items/1001'), echo.MediaSources[0], echo.PlaySessionId);
r5.reporter.start();
await flush();
const again = r5.h.current;
await r5.reporter.stopped();
r5.h.current = { ...again, playSessionId: 'restart-session' };
await r5.reporter.serverEnded(MACHINE_ID, '1001');
ok(r5.ended.length === 0, 'our own stop echoed back by PMS during a restart is ignored');
// A server-forced end while the progress timer (or a pause, a seek) fires during the stopped report: no timeline
// after the stopped one.
const race = await info(client, '1003', 'mpv');
const r6 = host(client, await client.request('GET', '/Users/1/Items/1003'), race.MediaSources[0], race.PlaySessionId);
r6.reporter.start();
await flush();
const ending = r6.reporter.serverEnded(MACHINE_ID, '1003');
r6.h.state.positionMs = 9000;
r6.reporter.progress('TimeUpdate');
r6.reporter.progress('Pause');
await ending;
await flush();
ok(timelinesOf(race.PlaySessionId).join(',') === 'playing,stopped' && r6.ended.length === 1, `a progress racing a server-forced end is not sent (${timelinesOf(race.PlaySessionId).join(',')})`);

// A multi-part film on the HTML player or a transcode (D-4): the end of part 1 hands its session to part 2, one
// viewing reported under one ratingKey: playing…playing, exactly one stopped at the end, no resume point between.
{
  const p1 = await info(client, '1005', 'html');
  const two5 = await client.request('GET', '/Users/1/Items/1005');
  const rp = host(client, two5, p1.MediaSources[0], p1.PlaySessionId, p1.MediaSources[0].TranscodingUrl ? 'Transcode' : 'DirectPlay');
  rp.reporter.start();
  await flush();
  const endOfPart1 = p1.MediaSources[0].PartPaths[0].durationMs;
  rp.h.state.positionMs = endOfPart1;
  const cur1 = rp.h.current;
  await rp.reporter.stopped(cur1, false, true);
  const viewOffset = (await client.request('GET', '/Users/1/Items/1005')).UserData.PlaybackPositionTicks / TICKS;
  const p2 = await info(client, '1005', 'html', { StartTimeTicks: endOfPart1 * TICKS, PlaySessionId: cur1.playSessionId });
  ok(p2.PlaySessionId === p1.PlaySessionId && lastDecision().partIndex === 1, `part 2 continues the session of part 1 (${lastDecision().partIndex})`);
  rp.h.current = { ...cur1, source: p2.MediaSources[0] };
  rp.reporter.start();
  await flush();
  rp.h.state.positionMs = endOfPart1 + 60_000;
  await rp.reporter.stopped();
  await flush();
  const tl = timelinesOf(p1.PlaySessionId);
  ok(tl.filter((x) => x === 'stopped').length === 1 && tl.at(-1) === 'stopped' && viewOffset === endOfPart1, `a two-part film: one session, one stopped timeline, the hand-off a progress (${tl.join(',')}; offset ${viewOffset})`);
  ok(rp.trakt.join(',') === 'start,start,stop', `Trakt: no stop at the part boundary (${rp.trakt.join(',')})`);
}

// A multi-episode file (s02e17-e18 in one file, plex-spec §6.3, #1500): both episodes play the same source, which
// is how Up Next (playback-service upNextAfter) knows to skip the second.
{
  const [e17, e18, e16] = await Promise.all(['2210', '2211', '2204'].map((id) => client.request('GET', `/Users/1/Items/${id}`)));
  const fileOf = (i) => i.MediaSources?.[0]?.Id;
  ok(fileOf(e17) && fileOf(e17) === fileOf(e18) && fileOf(e16) !== fileOf(e17), `a multi-episode file: both episodes share their source (${fileOf(e17)}), the one before does not`);
}

// ---- Multi-part film: one EDL timeline over both parts ----
const two = await info(client, '1005', 'mpv');
const parts = two.MediaSources[0].PartPaths ?? [];
ok(parts.length === 2 && two.MediaSources[0].SupportsDirectPlay, 'a two-part film: PartPaths for one queue');
const part1Ms = parts[0].durationMs;
const inPart2 = await info(client, '1005', 'html', { StartTimeTicks: (part1Ms + 100_000) * TICKS });
const tq = new URL(inPart2.MediaSources[0].TranscodingUrl, 'http://x').searchParams;
ok(lastDecision().partIndex === 1 && tq.get('partIndex') === '1' && tq.get('offset') === '100' && inPart2.MediaSources[0].StartTimeTicks === (part1Ms + 100_000) * TICKS && inPart2.MediaSources[0].PartPaths?.length === 2, `a two-part film resumed in part 2 on the HTML player: partIndex=1, offset=100 inside it, StartTimeTicks from the film's start (${tq.get('partIndex')}, ${tq.get('offset')})`);
if (mpvExe && clip) {
  const edl = `edl://${parts.map((p) => ((u) => `%${Buffer.byteLength(u)}%${u}`)(client.url(p.path))).join(';')}`;
  const seen = m.state.calls.length;
  const mp = new P.MpvController(mpvExe);
  await mp.start(['--idle=yes', '--vo=null', '--ao=null', '--mute=yes', '--no-config', '--no-terminal']);
  const headers = client.mediaAuthHeaders().join(',');
  await mp.command('loadfile', edl, 'replace', -1, `http-header-fields=%${Buffer.byteLength(headers)}%${headers}`);
  let dur = 0;
  for (let i = 0; i < 100 && !(dur > 0); i++) {
    await sleep(100);
    dur = await mp.get('duration').catch(() => 0);
  }
  await mp.quit();
  const asked = new Set(m.state.calls.slice(seen).filter((x) => /^\/library\/parts\//.test(x.path)).map((x) => x.path.split('/')[3]));
  ok(asked.size === 2 && dur > 15, `mpv opened both parts as one timeline (${dur.toFixed(1)} s)`);
}

// ---- Cast: the relay holds the token ----
const relay = new P.Relay();
const castInfo = await info(client, '1000', 'mpv', { MediaSourceId: theatrical });
const { base } = await relay.open('127.0.0.1', '127.0.0.1', client);
const castCalls = m.state.calls.length;
const viaRelayPart = await fetch(`${base}/Videos/1000/stream.mkv?Static=true&MediaSourceId=${theatrical}&PlaySessionId=${castInfo.PlaySessionId}`, { headers: { Range: 'bytes=0-1023' } });
await viaRelayPart.arrayBuffer();
ok(clip ? viaRelayPart.status === 206 : viaRelayPart.status === 404, `the relay serves the part (${viaRelayPart.status})`);
ok(m.state.calls.slice(castCalls).every((x) => !('X-Plex-Token' in x.query)) && !base.includes(token), 'no token in any URL the renderer gets or the relay sends');
const hlsPath = P.serverPath(client, hevc.MediaSources[0].TranscodingUrl);
ok(P.relayPathAllowed(hlsPath.split('?')[0]) && P.relayPathAllowed('/video/:/transcode/universal/session/abc-1/base/index.m3u8') && P.relayPathAllowed('/video/:/transcode/universal/session/abc-1/base/12.ts'), 'the relay allows the Plex HLS paths');
ok(!P.relayPathAllowed('/video/:/transcode/universal/decision') && !P.relayPathAllowed('/library/sections') && !P.relayPathAllowed('/:/prefs'), 'and nothing else of the PMS');
const master = await fetch(base + hlsPath);
const playlist = await master.text();
const variant = playlist.split('\n').find((l) => l && !l.startsWith('#'));
const media = await fetch(`${base}/video/:/transcode/universal/${variant}`);
ok(master.status === 200 && media.status === 200 && /#EXTINF/.test(await media.text()), 'the Chromecast and DLNA HLS (start.m3u8, then its playlist) come through the relay');
relay.shutdown();
const refused = await P.deviceUrls({ api: client, relay: null, seed: true, ip: '127.0.0.1' }, ['/Videos/1000/stream.mkv']).then(() => null, (e) => e);
ok(refused instanceof P.CastFailure && refused.key === 'plex.errors.castNeedsRelay', 'relay off: a Plex cast is refused, never a token URL');

// ---- Mock tags ----
const bad = [...m.state.tags, ...m2.state.tags].filter((t) => ['UNMAPPED', 'TOKEN-IN-URL', 'NO-CLIENT-ID', 'NO-TOKEN', 'DUP-STOPPED', 'AFTER-STOPPED', 'DUP-SCROBBLE', 'SEEK-AFTER-OFFSET', 'ACCOUNT-TOKEN-ON-PMS'].includes(t));
ok(bad.length === 0, `mock tags: none of UNMAPPED, TOKEN-IN-URL, NO-CLIENT-ID, DUP-STOPPED, AFTER-STOPPED, DUP-SCROBBLE, SEEK-AFTER-OFFSET (${bad.join(', ') || 'none'})`);

// ---- Offset start through mpv: it plays start.m3u8 from the top, never a segment before the offset ----
if (mpvExe) {
  const offInfo = await info(client, '1002', 'mpv', { StartTimeTicks: 600_000 * TICKS, EnableDirectPlay: false, EnableDirectStream: false, AllowVideoStreamCopy: false });
  const url = P.resolveServerUrl(client, offInfo.MediaSources[0].TranscodingUrl);
  const seen = m.state.calls.length;
  const mp = new P.MpvController(mpvExe);
  await mp.start(['--idle=yes', '--vo=null', '--ao=null', '--mute=yes', '--no-config', '--no-terminal']);
  const headers = client.mediaAuthHeaders().join(',');
  // playback-service loads a stream with StartTimeTicks at start=none (Current.baseMs).
  await mp.set('start', 'none');
  await mp.command('loadfile', url, 'replace', -1, `http-header-fields=%${Buffer.byteLength(headers)}%${headers}`);
  for (let i = 0; i < 50 && !m.state.calls.slice(seen).some((x) => /\.ts$/.test(x.path)); i++) await sleep(100);
  await mp.quit();
  const segs2 = m.state.calls.slice(seen).filter((x) => /\/base\/\d+\.ts$/.test(x.path)).map((x) => Number(/(\d+)\.ts$/.exec(x.path)[1]));
  ok(segs2.length > 0 && segs2.every((n) => n >= 100) && !m.state.tags.includes('SEEK-AFTER-OFFSET'), `mpv asked segment ${segs2[0]} first (offset 600 s = segment 100), SEEK-AFTER-OFFSET = 0`);
}

await m.close();
await m2.close();
console.log(`plex-playback-check: ok (${passed} checks)`);
process.exit(0);
