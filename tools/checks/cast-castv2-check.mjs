// Self-check for the desktop Chromecast sender (docs/specs/cast-spec.md CA-09).
// - pure: the CASTV2 codec against the hand-encoded golden vectors (fixtures/cast/castv2-vectors.json: CONNECT, PING,
//   LAUNCH, LOAD, RECEIVER_STATUS), split and oversize frames; the mDNS query and the parser on the recorded-shape
//   packets (fixtures/cast/mdns-packets.json: Chromecast with Google TV, Nest Hub, Bravia, an audio-only Nest Mini,
//   a forged reply), pointer loops, the 9000-byte cap, the dev seed; castProfile per model; the picker row;
// - the heartbeat: a device that never answers PING is lost after 3 missed PONGs (CastChannel);
// - against mock Emby, mock Jellyfin and mock-cast on loopback, with the real ConnectionManager and CastManager, the
//   device found through the dev seed (WICABY_CAST_SEED), never mDNS, and a fake local player (no mpv, nothing
//   audible): AC 1 the seeded device is listed, an Emby cast LOADs an HLS remux of the MKV through the relay, the
//   mock's fetch has no token; AC 2 on Jellyfin the connectsdk PlayNow has every required field and the server mock
//   gets no progress from the sender; AC 3 pause, seek and volume reach the mock's MEDIA_STATUS within 1 s; AC 4 the
//   mock killed -> cast.error.lost within 20 s and Stopped reported (DMR); AC 5 the VTT track is fetched with an
//   Origin and CORS is satisfied (relay); AC 6 SetSubtitleStreamIndex with a numeric index, a 2-item queue with its
//   startIndex; plus the DMR fallback when the Jellyfin receiver does not launch, and local playback stopping a DMR
//   cast first (§1);
// - music: a song queue handed off to the DMR (Emby, mock-cast as a TV): MusicTrackMediaMetadata with the cover
//   through the relay (fetched without a token), a WAV transcoded to MP3 and a FLAC played directly, the next song
//   LOADed at IDLE/FINISHED with Stopped then Playing reported, next/previous, the end of the queue; a speaker group
//   (a second mock-cast with MOCK_CAST_AUDIO_ONLY=1, seeded as /group) is listed for songs only, with its icon, and
//   gets the DMR even from Jellyfin.
// Nothing leaves 127.0.0.1: outgoing TCP and UDP to a non-loopback address throw, the electron stub's fetch and
// request refuse any other host, and mDNS asks on no interface.
// Usage: node tools/checks/cast-castv2-check.mjs [--verbose]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const T0 = Date.now();
const repo = path.resolve(import.meta.dirname, '..', '..');
const FX = path.join(import.meta.dirname, 'fixtures', 'cast');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FX, name), 'utf8'));
const VERBOSE = process.argv.includes('--verbose');
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|localhost)$/;
const TICKS = 10_000_000; // per second
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Loopback guards (this process) ----
{
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...a) {
    let o = a[0];
    if (Array.isArray(o)) o = o[0];
    const h = o && typeof o === 'object' ? (o.path ? undefined : o.host) : a[1];
    if (h !== undefined && !LOOPBACK.test(String(h).replace(/^\[|\]$/g, ''))) throw new Error(`GUARD: non-loopback connect to ${h}`);
    return connect.apply(this, a);
  };
  const send = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (msg, ...a) {
    const host = a.find((x) => typeof x === 'string');
    if (host && !LOOPBACK.test(host)) throw new Error(`GUARD: UDP to ${host}`);
    return send.call(this, msg, ...a);
  };
}
function loopbackUrl(url) {
  const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK.test(h)) throw new Error(`GUARD: refusing ${url}`);
}
globalThis.__castNet = {
  fetch(url, init = {}) {
    loopbackUrl(url);
    return fetch(url, init);
  },
  // fetchServer's net.request (the relay), over node:http.
  request(opts) {
    loopbackUrl(opts.url);
    const ee = new EventEmitter();
    const headers = {};
    let req;
    ee.setHeader = (k, v) => (headers[k] = v);
    ee.followRedirect = () => {
      throw new Error('no redirect in this check');
    };
    ee.abort = () => {
      req?.destroy();
      ee.emit('abort');
    };
    ee.end = () => {
      req = http.request(opts.url, { method: opts.method, headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return ee.emit('redirect', res.statusCode, opts.method, new URL(res.headers.location, opts.url).href);
        }
        ee.emit('response', res);
      });
      req.on('error', (e) => ee.emit('error', e));
      req.end();
    };
    return ee;
  },
};

// ---- Bundle (esbuild, electron stubbed) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-cast-v2-'));
const src = (p) => path.join(repo, 'apps/desktop/src/main', p).replace(/\\/g, '/');
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `export * from '${src('cast/castv2-codec.ts')}';
export * from '${src('cast/mdns.ts')}';
export { castProfile } from '${src('cast/profiles.ts')}';
export { CastChannel, NS } from '${src('cast/castv2.ts')}';
export { ChromecastCast } from '${src('cast/chromecast-cast.ts')}';
export { CastManager, castTarget } from '${src('cast/cast-manager.ts')}';
export { ConnectionManager } from '${src('connection/connection-manager.ts')}';
`,
);
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `export const net = { fetch: (...a) => globalThis.__castNet.fetch(...a), request: (o) => globalThis.__castNet.request(o) };
export const app = { isReady: () => false, isPackaged: false, getLocale: () => 'fr', getPath: () => '.', on() {} };
export const powerSaveBlocker = { start: () => (globalThis.__blocks = (globalThis.__blocks ?? 0) + 1), stop: () => (globalThis.__blocks -= 1), isStarted: () => true };
export const safeStorage = {}; export const protocol = {}; export const session = {};`,
    }));
  },
};
const out = path.join(tmp, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [electronStub] });
const C = await import(pathToFileURL(out).href);
C.CastManager.ssdpInterfaces = () => [];
C.CastManager.mdnsInterfaces = () => [];

// ---- Pure ----
// The codec against the golden vectors (encoded by hand from the .proto field numbers).
{
  const { vectors } = fixture('castv2-vectors.json');
  assert.deepEqual(vectors.map((v) => v.name), ['CONNECT', 'PING', 'LAUNCH', 'LOAD', 'RECEIVER_STATUS']);
  for (const v of vectors) {
    const frame = Buffer.from(v.hex, 'hex');
    assert.equal(C.encodeFrame(v.message).toString('hex'), v.hex, `encode ${v.name}`);
    assert.deepEqual(C.decodeMessage(frame.subarray(4)), v.message, `decode ${v.name}`);
  }
  // One frame split across chunks, two frames in one chunk.
  const got = [];
  const read = C.frameReader((m) => got.push(m.namespace));
  const both = Buffer.concat(vectors.slice(0, 2).map((v) => Buffer.from(v.hex, 'hex')));
  read(both.subarray(0, 7));
  read(both.subarray(7));
  assert.deepEqual(got, [vectors[0].message.namespace, vectors[1].message.namespace]);
  const big = Buffer.alloc(4);
  big.writeUInt32BE(C.MAX_MESSAGE + 1);
  assert.throws(() => C.frameReader(() => {})(big), RangeError, 'a frame over 64 KB is refused');
  assert.throws(() => C.encodeFrame({ source: 's', destination: 'd', namespace: 'n', data: 'x'.repeat(C.MAX_MESSAGE) }), RangeError);
}
// mDNS: the query, the recorded-shape answers, forged and malformed packets, the dev seed.
{
  const q = C.mdnsQuery(0x1234);
  assert.equal(q.toString('hex'), '123400000001000000000000' + '0b5f676f6f676c6563617374045f746370056c6f63616c00' + '000c0001', 'one PTR question for _googlecast._tcp.local');
  const { packets } = fixture('mdns-packets.json');
  for (const p of packets) assert.deepEqual(C.castDevices(Buffer.from(p.hex, 'hex'), p.from), p.expected, `mDNS: ${p.name}`);
  const ccgtv = Buffer.from(packets[0].hex, 'hex');
  assert.deepEqual(C.castDevices(ccgtv, '::ffff:192.168.1.40'), packets[0].expected, 'an IPv4-mapped source');
  assert.deepEqual(C.castDevices(ccgtv, '192.168.1.41'), [], 'an A record on another host than the replier');
  assert.deepEqual(C.castDevices(ccgtv, '8.8.8.8'), [], 'a reply from off the LAN');
  assert.deepEqual(C.castDevices(ccgtv, '100.100.1.1'), [], 'a reply from the mesh');
  assert.throws(() => C.parseMdns(Buffer.concat([ccgtv, Buffer.alloc(C.MAX_PACKET)])), RangeError, 'the 9000-byte cap');
  const loop = Buffer.from(ccgtv);
  loop.writeUInt16BE(0xc000 | 12, 12); // the question name points at itself
  assert.throws(() => C.parseMdns(loop), RangeError, 'a pointer loop');
  assert.throws(() => C.parseMdns(ccgtv.subarray(0, ccgtv.length - 3)), RangeError, 'a truncated record');
  const query = Buffer.from(q);
  assert.deepEqual(C.parseMdns(query), [], 'a query is not an answer');
  assert.deepEqual(C.castSeeds('127.0.0.1:18009, 8.8.8.8:8009,junk,192.168.1.5:99999', false).map((d) => [d.ip, d.port]), [['127.0.0.1', 18009]], 'seeds: LAN or loopback, a valid port');
  assert.deepEqual(C.castSeeds('127.0.0.1:18009', true), [], 'a packaged build ignores the seed');
  const row = C.castTarget(packets[0].expected[0]);
  assert.deepEqual([row.key, row.kind, row.section, row.name, row.detail], ['c:0123456789abcdef0123456789abcdef', 'cast', 'chromecast', 'Living room', 'Chromecast with Google TV']);
  assert.deepEqual(C.castTarget(packets[3].expected[0]).mediaTypes, ['Audio'], 'an audio-only device');
  assert.equal(C.castTarget(packets[3].expected[0]).device, 'speaker', 'a speaker icon');
  assert.equal(C.castTarget(packets[0].expected[0]).device, undefined, 'a screen keeps the default icon');
  // A speaker group: TXT ca with the multizone bit (32), its own port, answered by the group's leader.
  {
    // The Nest Mini's TXT ca=199172 (audio out, no video out) with bit 32 set: 199204, same length.
    const groupTxt = packets[3].hex.replace(Buffer.from('ca=199172').toString('hex'), Buffer.from('ca=199204').toString('hex'));
    assert.notEqual(groupTxt, packets[3].hex);
    const g = C.castDevices(Buffer.from(groupTxt, 'hex'), packets[3].from)[0];
    assert.deepEqual([g.group, g.video], [true, false], 'ca bit 32: a speaker group');
    assert.equal(C.castTarget(g).device, 'group');
  }
  const seeds = C.castSeeds('127.0.0.1:18009,127.0.0.1:18011/speaker,127.0.0.1:18013/group', false);
  assert.deepEqual(seeds.map((d) => [d.port, d.video, Boolean(d.group), C.castTarget(d).device]), [[18009, true, false, undefined], [18011, false, false, 'speaker'], [18013, false, true, 'group']], 'seeds: /speaker and /group');
  assert.deepEqual(C.castTarget(seeds[2]).mediaTypes, ['Audio'], 'a group takes songs only');
}
// castProfile per model (§2.6.6).
{
  const p = (model, prefs = {}, server = 'emby') => C.castProfile(model, prefs, server);
  const level = (x) => x.CodecProfiles[0].Conditions[0].Value;
  const mp4 = (x) => x.DirectPlayProfiles[0];
  assert.equal(level(p('Chromecast')), '41');
  assert.equal(level(p('Chromecast Ultra')), '51');
  assert.equal(level(p('Chromecast with Google TV')), '51');
  assert.doesNotMatch(mp4(p('Google Nest Hub')).VideoCodec, /hevc/, 'no HEVC on an unknown model');
  assert.match(mp4(p('Google Nest Hub', { allowHevc: true })).VideoCodec, /hevc/, 'cast.allowHevc');
  assert.match(mp4(p('BRAVIA 4K VH2', { allowHevc: true })).VideoCodec, /hevc/);
  assert.doesNotMatch(mp4(p('Chromecast with Google TV')).VideoCodec, /av1/, 'AV1 only on the Streamer');
  assert.match(mp4(p('Google TV Streamer')).VideoCodec, /av1/);
  assert.doesNotMatch(mp4(p('Chromecast')).AudioCodec, /ac3/);
  assert.match(mp4(p('Chromecast', { dolby: true })).AudioCodec, /ac3,eac3/, 'cast.dolby');
  assert.ok(!p('Chromecast').DirectPlayProfiles.some((d) => /mkv/.test(d.Container)), 'MKV is always remuxed');
  assert.equal(p('Chromecast Ultra', {}, 'jellyfin').TranscodingProfiles[0].Container, 'mp4', 'HEVC in fMP4 on Jellyfin');
  assert.equal(p('Chromecast Ultra', {}, 'emby').TranscodingProfiles[0].Container, 'ts', 'h264 TS on Emby');
  assert.equal(p('Chromecast').MaxStreamingBitrate, 20_000_000);
}
console.log(`ok pure: codec vectors, mDNS packets, seeds, castProfile (${Date.now() - T0} ms)`);

// ---- Heartbeat: PING every 5 s, lost after 3 missed PONGs (scaled down here) ----
{
  const tlsDir = path.join(repo, 'tools/mock-server/fixtures/cast-tls');
  const mute = tls.createServer({ key: fs.readFileSync(path.join(tlsDir, 'key.pem')), cert: fs.readFileSync(path.join(tlsDir, 'cert.pem')) }, (s) => s.on('data', () => {}).on('error', () => {}));
  await new Promise((r) => mute.listen(0, '127.0.0.1', r));
  assert.equal(C.CastChannel.pingMs, 5000);
  assert.equal(C.CastChannel.missLimit, 3);
  C.CastChannel.pingMs = 150;
  const ch = new C.CastChannel();
  const t = Date.now();
  const lost = new Promise((r) => ch.once('lost', () => r(Date.now() - t)));
  await ch.connect('127.0.0.1', mute.address().port);
  const ms = await lost;
  assert.ok(ms >= 3 * 150 && ms < 2000, `lost after 3 missed PONGs (${ms} ms)`);
  C.CastChannel.pingMs = 5000;
  mute.close();
  console.log(`ok heartbeat: a silent device is lost after 3 missed PONGs (${ms} ms at 150 ms per PING)`);
}

// ---- Mocks (loopback only) ----
const children = new Set();
process.on('exit', () => children.forEach((c) => c.kill()));
const handedOut = new Set();
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      // Never the same port twice: a closed port can be handed out again before its mock binds it.
      s.close(() => (handedOut.has(port) ? freePort().then(resolve, reject) : (handedOut.add(port), resolve(port))));
    });
  });
}
// Binds the mocks to 127.0.0.1 and kills any non-loopback connect they try (as cast-mock-check does).
const BOOT = `data:text/javascript,${encodeURIComponent(
  "import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'&&(a.length===1||typeof a[1]==='function'))a.splice(1,0,'127.0.0.1');return l.apply(this,a)};const ok=(h)=>h===undefined||/^127\\./.test(h)||h==='::1'||h==='localhost';const c=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...a){let o=a[0];if(Array.isArray(o))o=o[0];const h=o&&typeof o==='object'?(o.path?undefined:o.host):a[1];if(!ok(h))throw new Error('GUARD: non-loopback connect to '+h);return c.apply(this,a)};",
)}`;
async function startMock(name, script, args, env, ready) {
  const child = spawn(process.execPath, ['--import', BOOT, path.join(repo, 'tools/mock-server', script), ...args], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MOCK_'))), MOCK_DURATION_S: '3600', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  const log = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: not listening after 10 s\n${log.join('\n')}`)), 10_000);
    const onData = (d) => {
      for (const line of String(d).split(/\r?\n/).filter(Boolean)) {
        log.push(line);
        if (VERBOSE) console.log(`  [${name}] ${line}`);
        if (ready.test(line)) (clearTimeout(timer), resolve());
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => (clearTimeout(timer), reject(new Error(`${name}: exited with ${code}\n${log.join('\n')}`))));
  });
  return { log, child };
}
const json = async (url, init) => (loopbackUrl(url), (await fetch(url, init)).json());
async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return Date.now() - t0;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms: ${what}`);
    await sleep(50);
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
// PlaybackService as the cast manager sees it; play() runs beforePlay first (index.ts: stopSenderReported).
class FakeLocal {
  log = [];
  snapshot = null;
  beforePlay = null;
  constructor(api) {
    this.api = api;
  }
  castSnapshot() {
    return this.snapshot;
  }
  async command(cmd) {
    this.log.push(cmd.type);
  }
  async stop() {
    this.log.push('stop');
    this.snapshot = null;
  }
  async play(req) {
    this.log.push('play');
    await this.beforePlay?.();
    await this.api().post('/Sessions/Playing', undefined, { ItemId: req.itemIds[0], MediaSourceId: req.itemIds[0], PlaySessionId: 'local-play', PlayMethod: 'DirectPlay', PositionTicks: 0 });
  }
}

try {
  const video = path.join(tmp, 'video.mkv');
  fs.writeFileSync(video, Buffer.alloc(256 * 1024, 0x1a)); // only its bytes are fetched, never decoded
  const ports = { jf: await freePort(), emby: await freePort(), cast: await freePort(), castState: await freePort(), group: await freePort(), groupState: await freePort() };
  const castEnv = { MOCK_CAST_PORT: String(ports.cast), MOCK_CAST_STATE_PORT: String(ports.castState) };
  const startCast = () => startMock('cast', 'mock-cast.mjs', [], castEnv, /^Mock Cast device/);
  const t1 = Date.now();
  let [jf, emby, cast, group] = await Promise.all([
    startMock('jellyfin', 'mock-jellyfin.mjs', [String(ports.jf), video], { MOCK_MUSIC: '1' }, /^Mock Jellyfin/),
    startMock('emby', 'mock-emby.mjs', [String(ports.emby), video], { MOCK_MUSIC: '1' }, /^Mock Emby/),
    startCast(),
    startMock('group', 'mock-cast.mjs', [], { MOCK_CAST_PORT: String(ports.group), MOCK_CAST_STATE_PORT: String(ports.groupState), MOCK_CAST_AUDIO_ONLY: '1' }, /^Mock Cast speaker/),
  ]);
  if (VERBOSE) console.log(`  mocks up in ${Date.now() - t1} ms`);
  const root = (p) => `http://127.0.0.1:${ports[p]}`;
  process.env.WICABY_CAST_SEED = `127.0.0.1:${ports.cast},127.0.0.1:${ports.group}/group`;
  const castState = () => json(`${root('castState')}/Mock/State`);
  const groupState = () => json(`${root('groupState')}/Mock/State`);
  const jfReports = () => jf.log.filter((l) => l.startsWith('REPORT ')).length;
  const embyReports = () => emby.log.filter((l) => l.startsWith('Report '));

  async function desktop(kind, deviceId) {
    const m = new C.ConnectionManager(path.join(tmp, `servers-${deviceId}.json`), new FakeVault(), { client: 'Wicaby', version: '0.2.0', deviceId, deviceName: 'pc-a' });
    const info = await m.add(root(kind));
    await m.select(info.id);
    await m.login('Wika', 'wicaby', info.id);
    const api = () => m.onlineApi(info.id);
    const local = new FakeLocal(api);
    const toasts = [];
    const settings = { value: { cast: { discovery: true, relay: true, allowHevc: false, dolby: false } } };
    const mgr = new C.CastManager({ connection: m, local, deviceId, notify: (k, message) => toasts.push({ kind: k, message }), settings });
    local.beforePlay = () => mgr.stopSenderReported();
    const pbi = [];
    const client = api();
    const post = client.post.bind(client);
    client.post = (p, q, b) => (/\/PlaybackInfo$/.test(p) && pbi.push({ path: p, query: q, body: b }), post(p, q, b));
    return { m, serverId: info.id, local, toasts, cast: mgr, settings, pbi };
  }
  async function listCast(D, itemId = 'movie-0') {
    const t = Date.now();
    let first = null;
    const on = (list) => first === null && list.some((r) => r.kind === 'cast') && (first = Date.now() - t);
    D.cast.on('targets', on);
    const rows = await D.cast.targets(itemId, D.serverId);
    D.cast.off('targets', on);
    return { rows, first, key: rows.find((r) => r.kind === 'cast')?.key };
  }
  const lastLoad = async () => (await castState()).calls.findLast((c) => c.type === 'LOAD')?.data;

  assert.equal(C.ChromecastCast.progressMs, 10_000, 'progress every 10 s');
  assert.equal(C.ChromecastCast.pingMs, 30_000, 'ping every 30 s while transcoding');
  assert.equal(C.ChromecastCast.statusMs, 5000, 'GET_STATUS every 5 s');
  C.ChromecastCast.progressMs = 700;

  // ---- AC 1, 3, 5 (Emby, Default Media Receiver, relay on) ----
  const E = await desktop('emby', 'desk-cast-emby');
  {
    const { rows, first, key } = await listCast(E);
    assert.ok(key && first !== null && first <= 3000, `AC 1: the seeded device is listed (${first} ms)`);
    const row = rows.find((r) => r.key === key);
    assert.deepEqual([row.section, row.name], ['chromecast', `Chromecast 127.0.0.1:${ports.cast}`]);
    assert.ok(!(await E.cast.targets('ch-1', E.serverId)).some((r) => r.kind === 'cast'), 'a channel lists no Chromecast row');
    await E.cast.targets('movie-0', E.serverId);

    E.local.snapshot = { serverId: E.serverId, itemIds: ['movie-0'], startIndex: 0, positionTicks: 600 * TICKS, msid: 'movie-0-1080', audio: 1, sub: 2, live: false, policy: 'mbb' };
    const before = embyReports().length;
    await E.cast.start(key);
    assert.equal(E.cast.state?.status, 'playing', `casting from Emby (${JSON.stringify(E.toasts)})`);
    assert.deepEqual(E.local.log, ['pause', 'stop'], 'local pauses once the device took it, stops once it plays');
    assert.equal(E.cast.senderReported?.key, key, 'a DMR cast is sender-reported (quit prompt)');
    const s = await castState();
    assert.equal(s.app.appId, 'CC1AD845', 'Emby: the Default Media Receiver');
    const load = await lastLoad();
    assert.match(load.media.contentId, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/c/[0-9a-f]{32}/Videos/movie-0/master\\.m3u8\\?`), 'AC 1: the MKV goes as an HLS remux, through the relay');
    assert.equal(load.media.contentType, 'application/x-mpegurl');
    assert.equal(load.media.hlsVideoSegmentFormat, 'mpeg2_ts');
    assert.equal(load.media.streamType, 'BUFFERED');
    assert.equal(load.autoplay, true);
    assert.equal(load.currentTime, 600, 'LOAD at the handoff position');
    const vtt = load.media.tracks.find((t) => t.trackId === 3);
    assert.deepEqual([vtt?.type, vtt?.subtype, vtt?.trackContentType], ['TEXT', 'SUBTITLES', 'text/vtt'], 'text subtitles as VTT tracks');
    assert.match(vtt.trackContentId, /\/c\/[0-9a-f]{32}\/Videos\/movie-0\/movie-0-1080\/Subtitles\/2\/Stream\.vtt$/, "Emby's VTT path (no /0/)");
    assert.deepEqual(load.activeTrackIds, [3], 'the chosen subtitle is active');
    assert.ok(!JSON.stringify(load).match(/api_key|ApiKey|X-Emby-Token/i), 'no token anywhere in the LOAD');
    const content = s.fetched.findLast((f) => f.kind === 'content');
    assert.equal(content.status, 200, `the mock fetched the playlist (${content.status} ${content.error ?? ''})`);
    assert.equal(content.tokenInUrl, false, 'AC 1: no token in the URL (relay)');
    const track = s.fetched.findLast((f) => f.kind === 'track');
    assert.equal(track.status, 200, 'AC 5: the VTT track was fetched');
    assert.equal(track.cors, true, `AC 5: CORS satisfied for Origin: https://mock-cast (${track.allowOrigin})`);
    assert.equal(track.tokenInUrl, false);
    const last = E.pbi.at(-1).body;
    assert.equal(last.MaxStreamingBitrate, 20_000_000, '20 Mbps for Cast');
    assert.equal(last.DeviceProfile.Name, 'Wicaby Cast', "the Chromecast's profile");
    const psid = new URL(load.media.contentId).searchParams.get('PlaySessionId');
    await until(() => embyReports().slice(before).some((l) => l.startsWith('Report Start movie-0') && l.includes(`PlaySessionId=${psid}`) && l.includes('PlayMethod=Transcode')), 3000, 'Playing reported with the cast PlaySessionId');
    await until(() => embyReports().slice(before).filter((l) => l.startsWith('Report Progress') && l.includes(psid)).length >= 2, 4000, 'progress reports');

    // AC 3: pause, seek, volume reach MEDIA_STATUS within 1 s.
    const within = async (what, cmd, test) => {
      const t = Date.now();
      await E.cast.control(cmd);
      const ms = await until(async () => test(await castState()), 1000, what);
      return Date.now() - t;
    };
    const times = [
      await within('pause', { type: 'pause' }, (st) => st.media?.playerState === 'PAUSED'),
      await within('resume', { type: 'resume' }, (st) => st.media?.playerState === 'PLAYING'),
      await within('seek', { type: 'seek', positionTicks: 900 * TICKS }, (st) => Math.abs(st.media?.currentTime - 900) < 2),
      await within('volume', { type: 'volume', value: 35 }, (st) => Math.abs(st.volume.level - 0.35) < 0.001),
      await within('mute', { type: 'mute', value: true }, (st) => st.volume.muted === true),
    ];
    assert.ok(times.every((t) => t <= 1000), `AC 3: within 1 s (${times.join(', ')} ms)`);
    assert.ok(embyReports().some((l) => l.startsWith('Report Progress') && l.includes(psid)), 'Pause/seek/volume reported');
    await until(() => Math.abs(E.cast.state.positionTicks - 900 * TICKS) < 3 * TICKS && E.cast.state.volume === 35 && E.cast.state.muted === true, 2000, 'the bar mirrors MEDIA_STATUS');
    // Subtitles: off, then back on, both through EDIT_TRACKS_INFO (no restart).
    const loads = (await castState()).calls.filter((c) => c.type === 'LOAD').length;
    await E.cast.control({ type: 'subtitle', index: -1 });
    assert.deepEqual((await castState()).media.activeTrackIds, [], 'subtitles off');
    await E.cast.control({ type: 'subtitle', index: 2 });
    assert.deepEqual((await castState()).media.activeTrackIds, [3], 'subtitles back on');
    assert.equal((await castState()).calls.filter((c) => c.type === 'LOAD').length, loads, 'a text subtitle switch is no restart');
    // An audio switch on the DMR is a restart (§2.3).
    await E.cast.control({ type: 'audio', index: 1 });
    assert.equal(E.pbi.at(-1).body.AudioStreamIndex, 1);
    assert.equal((await castState()).calls.filter((c) => c.type === 'LOAD').length, loads + 1, 'an audio switch reloads');
    assert.equal(E.cast.state.status, 'playing');
    // The end of the media: Stopped with the cast's PlaySessionId (the newest one), the bar closes.
    const psid2 = new URL((await lastLoad()).media.contentId).searchParams.get('PlaySessionId');
    await fetch(`${root('castState')}/Mock/End`, { method: 'POST' });
    await until(() => E.cast.state === null, 3000, 'the bar closes after /Mock/End');
    await until(() => embyReports().some((l) => l.startsWith('Report Stopped') && l.includes(psid2)), 2000, 'Stopped reported');
    assert.equal(globalThis.__blocks, 0, 'the power blocker is released');
    console.log(`ok AC1/AC3/AC5 Emby DMR: HLS remux through the relay, VTT with CORS, pause/seek/volume in ${Math.max(...times)} ms max, end of media`);
  }

  // ---- AC 4: the device killed -> cast.error.lost within 20 s, Stopped reported (DMR) ----
  {
    const { key } = await listCast(E);
    E.toasts.length = 0;
    await E.cast.start(key, { itemIds: ['movie-0'], msid: 'movie-0-1080', positionTicks: 0 });
    assert.equal(E.cast.state?.status, 'playing');
    const psid = new URL((await lastLoad()).media.contentId).searchParams.get('PlaySessionId');
    const t = Date.now();
    cast.child.kill();
    await until(() => E.cast.state === null, 20_000, 'the bar closes after the device is gone');
    const ms = Date.now() - t;
    assert.ok(E.toasts.some((x) => x.kind === 'error' && x.message.includes('perdue')), `cast.error.lost (${JSON.stringify(E.toasts)})`);
    await until(() => embyReports().some((l) => l.startsWith('Report Stopped') && l.includes(psid)), 2000, 'Stopped reported for the lost cast');
    console.log(`ok AC4 device lost: cast.error.lost in ${ms} ms, Stopped reported`);
    cast = await startCast();
  }
  // ---- Music: a song queue on the DMR (a TV) ----
  {
    const ids = ['track-3-0-0', 'track-5-0-0', 'track-3-0-1'];
    const { rows, key } = await listCast(E, ids[0]);
    const groupRow = rows.find((r) => r.device === 'group');
    assert.ok(groupRow && groupRow.section === 'chromecast' && groupRow.name.startsWith('Speaker group'), 'a song lists the speaker group, with its icon');
    assert.ok(!(await E.cast.targets('movie-0', E.serverId)).some((r) => r.device === 'group'), 'a film does not list the speaker group');
    await E.cast.targets(ids[0], E.serverId);
    E.toasts.length = 0;
    E.local.log.length = 0;
    E.local.snapshot = { serverId: E.serverId, itemIds: ids, startIndex: 0, positionTicks: 0, msid: 'mediasource_track-3-0-0', sub: -1, live: false, policy: 'mbb' };
    const before = embyReports().length;
    await E.cast.start(key);
    assert.equal(E.cast.state?.status, 'playing', `a song cast (${JSON.stringify(E.toasts)})`);
    assert.deepEqual(E.local.log, ['pause', 'stop'], 'the music player hands off like the video player');
    let load = await lastLoad();
    const md = load.media.metadata;
    assert.deepEqual([md.metadataType, md.title, md.artist, md.albumName, md.albumArtist, md.trackNumber], [3, 'Fil', 'Nora Vale', 'Lignes claires', 'Nora Vale', 1], `MusicTrackMediaMetadata (${JSON.stringify(md)})`);
    assert.match(md.images?.[0]?.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/c\/[0-9a-f]{32}\/Items\/album-3-0\/Images\/Primary\?maxHeight=600&quality=90&format=jpg&tag=p$/, "the album's cover through the relay");
    assert.match(load.media.contentId, /\/c\/[0-9a-f]{32}\/Audio\/track-3-0-0\/stream\.mp3\?/, 'a WAV the device cannot play: the server transcodes to MP3');
    assert.equal(load.media.contentType, 'audio/mpeg');
    assert.ok(!JSON.stringify(load).match(/api_key|ApiKey|X-Emby-Token/i), 'no token in the song LOAD');
    const s = await castState();
    const img = s.fetched.findLast((f) => f.kind === 'image');
    assert.ok(img && [200, 206].includes(img.status) && img.tokenInUrl === false, `the device fetched the cover (${img?.status})`);
    assert.deepEqual(E.cast.state.item.artists, ['Nora Vale']);
    assert.deepEqual([E.cast.state.item.album, E.cast.state.item.imageItemId], ['Lignes claires', 'album-3-0'], 'the bar gets the album and its cover');
    assert.deepEqual(E.cast.state.queue, { index: 0, length: 3 });
    assert.equal(E.cast.state.controls.nextPrev, true, 'next/previous with a song queue');
    // The song ends: the next one is LOADed (FLAC, played directly), each reported as its own play.
    await fetch(`${root('castState')}/Mock/End`, { method: 'POST' });
    await until(() => E.cast.state?.item?.id === ids[1] && E.cast.state.status === 'playing', 4000, 'the next song after IDLE/FINISHED');
    load = await lastLoad();
    assert.match(load.media.contentId, /\/Audio\/track-5-0-0\/stream\.flac\?Static=true&/, 'a FLAC the device plays: direct');
    assert.equal(load.media.contentType, 'audio/flac');
    assert.equal(load.media.metadata.title, 'Niveau');
    await until(() => embyReports().slice(before).some((l) => l.startsWith('Report Start track-5-0-0')), 3000, 'Playing for the next song');
    const seq = embyReports().slice(before).filter((l) => /^Report (Start|Stopped) track-/.test(l)).map((l) => l.split(' ').slice(1, 3).join(' '));
    assert.deepEqual(seq, ['Start track-3-0-0', 'Stopped track-3-0-0', 'Start track-5-0-0'], `each song its own play (${seq.join(' | ')})`);
    // Next, then previous within 5 s (the music player's rule), from the bar.
    await E.cast.control({ type: 'next' });
    assert.equal(E.cast.state.item.id, ids[2], 'next');
    assert.deepEqual(E.cast.state.queue, { index: 2, length: 3 });
    await E.cast.control({ type: 'previous' });
    assert.equal(E.cast.state.item.id, ids[1], 'previous within 5 s: the song before');
    await E.cast.control({ type: 'next' });
    // The last song ends: so does the cast.
    await fetch(`${root('castState')}/Mock/End`, { method: 'POST' });
    await until(() => E.cast.state === null, 4000, 'the cast ends with the queue');
    await until(() => embyReports().some((l) => l.startsWith('Report Stopped track-3-0-1')), 2000, 'Stopped for the last song');
    console.log('ok music DMR: metadata and cover, MP3 transcode and direct FLAC, next song at the end, next/previous');
  }
  E.cast.dispose();
  for (const c of E.m.conns.values()) c.socket?.close();

  // ---- AC 2 and 6 (Jellyfin receiver) ----
  const J = await desktop('jf', 'desk-cast-jf');
  {
    const { key } = await listCast(J);
    const reportsBefore = jfReports();
    await J.cast.start(key, { itemIds: ['movie-0', 'movie-2'], startIndex: 1, positionTicks: 120 * TICKS, audio: 1, sub: -1 });
    assert.equal(J.cast.state?.status, 'playing', `casting to the Jellyfin receiver (${JSON.stringify(J.toasts)})`);
    const s = await castState();
    assert.equal(s.app.appId, 'F007D354', 'Jellyfin: its own receiver');
    const play = s.connectsdk.find((m) => m.command === 'PlayNow');
    assert.ok(play?.ok, `AC 2: PlayNow accepted (${JSON.stringify(play?.missing)})`);
    for (const k of ['userId', 'deviceId', 'accessToken', 'serverAddress', 'serverId', 'serverVersion', 'receiverName']) assert.ok(play[k], `AC 2: ${k}`);
    assert.equal(play.serverAddress, root('jf'), 'the server LAN address (loopback for the dev seed)');
    assert.equal(play.deviceId, 'desk-cast-jf');
    assert.equal(play.options.items.length, 2, 'AC 6: the whole queue');
    assert.equal(play.options.startIndex, 1, 'AC 6: its startIndex');
    assert.deepEqual(Object.keys(play.options.items[0]).sort(), ['Id', 'IsFolder', 'MediaType', 'Name', 'ServerId', 'Type']);
    assert.deepEqual(play.options.items.map((i) => i.Id), ['movie-0', 'movie-2']);
    assert.ok(play.options.items.every((i) => i.Name && i.Type === 'Movie'), 'items carry their names and types');
    assert.equal(play.options.startPositionTicks, 120 * TICKS);
    assert.equal(play.options.audioStreamIndex, 1);
    assert.equal(play.options.subtitleStreamIndex, -1);
    assert.equal(J.cast.senderReported, null, 'the receiver reports for itself: no quit prompt');
    assert.equal(J.cast.state.item?.id, 'movie-2', 'the mirror shows the queue entry');
    assert.equal(J.cast.state.controls.nextPrev, true, 'next/previous with a queue');
    // AC 6: track switches go as connectsdk commands with numeric indexes.
    await J.cast.control({ type: 'subtitle', index: 3 });
    await J.cast.control({ type: 'audio', index: 1 });
    await J.cast.control({ type: 'previous' });
    await until(async () => (await castState()).connectsdk.length >= 4, 1000, 'connectsdk commands recorded');
    const sdk = (await castState()).connectsdk;
    const sub = sdk.find((m) => m.command === 'SetSubtitleStreamIndex');
    assert.ok(sub?.ok && sub.options.index === 3 && typeof sub.options.index === 'number', `AC 6: SetSubtitleStreamIndex with a number (${JSON.stringify(sub?.options)})`);
    assert.equal(sdk.find((m) => m.command === 'SetAudioStreamIndex')?.options.index, 1);
    assert.ok(sdk.every((m) => m.ok), 'every connectsdk message carries command, serverAddress and accessToken');
    await until(() => J.cast.state.item?.id === 'movie-0', 1000, 'PreviousTrack moves the mirror');
    // AC 3 on the receiver: pause and volume through the media and receiver namespaces.
    await J.cast.control({ type: 'pause' });
    await until(async () => (await castState()).media?.playerState === 'PAUSED', 1000, 'receiver paused');
    await J.cast.control({ type: 'volume', value: 60 });
    await until(async () => Math.abs((await castState()).volume.level - 0.6) < 0.001, 1000, 'receiver volume');
    await sleep(1500); // two DMR progress periods: the receiver path sends none
    assert.equal(jfReports(), reportsBefore, 'AC 2: the server mock receives no progress from the sender');
    await J.cast.stop();
    assert.equal(J.cast.state, null);
    assert.equal((await castState()).app, null, 'Stop closes the receiver app');
    console.log('ok AC2/AC6 Jellyfin receiver: PlayNow fields, 2-item queue, numeric track indexes, no sender reports');
  }

  // ---- The Jellyfin receiver does not launch: the Default Media Receiver, sender-reported; local play stops it ----
  {
    C.ChromecastCast.jellyfinReceiver = 'BADC0DE0';
    const { key } = await listCast(J);
    const before = jfReports();
    await J.cast.start(key, { itemIds: ['movie-0'], msid: 'movie-0-1080', sub: 2 });
    C.ChromecastCast.jellyfinReceiver = 'F007D354';
    assert.equal(J.cast.state?.status, 'playing', `fallback cast (${JSON.stringify(J.toasts)})`);
    const s = await castState();
    assert.equal(s.app.appId, 'CC1AD845', 'LAUNCH_ERROR -> Default Media Receiver');
    const load = await lastLoad();
    assert.match(load.media.tracks[0].trackContentId, /\/Videos\/movie-0\/movie-0-1080\/Subtitles\/2\/0\/Stream\.vtt$/, "Jellyfin's VTT path (with /0/)");
    assert.equal(s.fetched.findLast((f) => f.kind === 'content').tokenInUrl, false);
    assert.ok(J.cast.senderReported, 'the fallback is sender-reported');
    await until(() => jfReports() > before, 2000, 'the fallback reports Playing');
    // §1: local playback stops a sender-reported cast first.
    await J.local.play({ itemIds: ['movie-2'], serverId: J.serverId });
    assert.equal(J.cast.state, null, 'the cast ended');
    // The local Playing report is sent asynchronously: wait for it before reading the order (flaked on CI).
    await until(() => jf.log.some((l) => l.startsWith('REPORT start item=movie-2')), 2000, 'the local Playing report');
    const tail = jf.log.filter((l) => l.startsWith('REPORT ')).slice(-2);
    assert.ok(/^REPORT stopped .*method=Transcode/.test(tail[0]) && /^REPORT start item=movie-2/.test(tail[1]), `the cast's Stopped before the local Playing (${tail.join(' | ')})`);
    console.log('ok fallback: receiver LAUNCH_ERROR -> DMR with reports; local play stops it first');
  }
  // ---- Music on a speaker group from Jellyfin: the DMR (documented on speakers), the sender reports ----
  {
    const ids = ['track-3-0-0', 'track-3-0-1'];
    const rows = await J.cast.targets(ids[0], J.serverId);
    const key = rows.find((r) => r.device === 'group')?.key;
    assert.ok(key, 'the group is listed for a Jellyfin song');
    const before = jfReports();
    await J.cast.start(key, { itemIds: ids, startIndex: 0 });
    assert.equal(J.cast.state?.status, 'playing', `a song to the group (${JSON.stringify(J.toasts)})`);
    const g = await groupState();
    assert.equal(g.app.appId, 'CC1AD845', 'a speaker group gets the Default Media Receiver, not the Jellyfin receiver');
    assert.equal(g.connectsdk.length, 0);
    const load = g.calls.findLast((c) => c.type === 'LOAD').data;
    assert.match(load.media.contentType, /^audio\//, 'an audio stream for a speaker');
    assert.equal(load.media.metadata.metadataType, 3);
    assert.equal(g.fetched.findLast((f) => f.kind === 'content').tokenInUrl, false, 'no token to the group (relay)');
    assert.ok(J.cast.senderReported, 'sender-reported: the quit prompt applies');
    await until(() => jfReports() > before, 2000, 'Playing reported by the sender');
    await J.cast.stop();
    assert.ok(!group.log.some((l) => /NO-VIDEO-OUT/.test(l)), 'nothing but audio went to the speaker group');
    console.log('ok music group: Jellyfin song queue to a speaker group through the DMR');
  }
  J.cast.dispose();
  for (const c of J.m.conns.values()) c.socket?.close();
  assert.ok(![jf, emby, cast, group].some((x) => x.log.some((l) => /GUARD|REFUSED/.test(l))), 'no mock tried to leave loopback');
} finally {
  for (const c of children) c.kill();
}

// Wiring: the picker's Chromecast rows come from the manager, the settings exist in both languages.
{
  const fr = JSON.parse(fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/locales/fr/settings.json'), 'utf8')).cast;
  const en = JSON.parse(fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/locales/en/settings.json'), 'utf8')).cast;
  for (const k of ['allowHevc', 'allowHevcHint', 'dolby']) assert.ok(fr[k] && en[k], `settings.cast.${k}`);
}
console.log(`cast-castv2-check: OK (${((Date.now() - T0) / 1000).toFixed(1)} s)`);
process.exit(0);
