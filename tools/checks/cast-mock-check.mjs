// The mock DLNA renderer and the mock Chromecast (docs/specs/cast-spec.md CA-06), against their fixtures.
//
// Spawns mock-emby, mock-jellyfin, mock-dlna (generic, sony, samsung) and mock-cast on free loopback ports, then
// drives the mocks with minimal raw SOAP and CASTV2 clients:
//   0  apps/desktop/src/main/cast/castv2-codec.ts (shared with mock-cast) matches CK/fixtures/cast/castv2-vectors.json
//   1  each new mock starts in under 1 s; the whole check runs in under 60 s
//   2  DLNA, per profile: the description and GetProtocolInfo are the recorded fixtures; SetAVTransportURI, Play
//      (the renderer fetches the stream: status, type, tokenInUrl), Seek, Pause, volume (501 outside 0-100), mute,
//      SetNextAVTransportURI refused (401, the sonos profile alone has it), /Mock/End; sony 701 (no Stop first) and 714 (empty metadata) and their recovery;
//      samsung 716 (no DLNA.ORG flags) and 714 (sec:CaptionInfoEx order); faults equal the fault fixtures;
//      generic: a token-free relay URL (tokenInUrl:false), the media ending at MOCK_DURATION_S, InstanceID 718,
//      an auth header to the renderer flagged
//   3  Cast: CONNECT, PING/PONG, LAUNCH (and LAUNCH_ERROR), NO-CONNECT, LOAD with an Origin header on every fetch
//      (Emby's Stream.vtt has no CORS, the relay stand-in has "*"), a moving currentTime, PAUSE, SEEK, SET_VOLUME,
//      EDIT_TRACKS_INFO, a stale mediaSessionId, /Mock/End (IDLE FINISHED); the Jellyfin receiver's connectsdk
//      (fails without accessToken; PlayNow with a 2-item queue, PreviousTrack, SetSubtitleStreamIndex recorded with a
//      number); an oversize frame and a lost heartbeat (15 s) close the connection
//   4  no mock contacts anything but 127.0.0.1: a URL on 192.0.2.1 (TEST-NET-1) is refused without a connection,
//      and every mock runs with a guard that kills any non-loopback connect; each mock's log tags what went wrong
// The desktop senders drive these same mocks from their own checks (CA-07: cast-dlna-check.mjs; CA-09 to come).
// Usage: node tools/checks/cast-mock-check.mjs [--verbose]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { transformSync } from 'esbuild';

const T0 = Date.now();
const root = path.resolve(import.meta.dirname, '../..');
const FX = path.join(root, 'tools/checks/fixtures/cast');
const LOOPBACK = '127.0.0.1';
const VERBOSE = process.argv.includes('--verbose');
const DURATION_S = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fixture = (name) => fs.readFileSync(path.join(FX, name), 'utf8');

function assertLoopbackUrl(url) {
  const host = new URL(url).hostname;
  if (host !== LOOPBACK) throw new Error(`refusing ${url}: this check only talks to ${LOOPBACK}`);
}

// ---- 0. Codec against the golden vectors (the same transpile mock-cast does) ----
const codecSrc = fs.readFileSync(path.join(root, 'apps/desktop/src/main/cast/castv2-codec.ts'), 'utf8');
const { encodeFrame, decodeMessage, frameReader, MAX_MESSAGE } = await import(`data:text/javascript,${encodeURIComponent(transformSync(codecSrc, { loader: 'ts', format: 'esm' }).code)}`);
const { vectors } = JSON.parse(fixture('castv2-vectors.json'));
assert.ok(vectors.length >= 5, 'golden vectors: CONNECT, PING, LAUNCH, LOAD, RECEIVER_STATUS');
for (const v of vectors) {
  assert.equal(encodeFrame(v.message).toString('hex'), v.hex, `codec encodes ${v.name} as the golden vector`);
  assert.deepEqual(decodeMessage(Buffer.from(v.hex, 'hex').subarray(4)), v.message, `codec decodes ${v.name}`);
}
{
  const all = Buffer.concat(vectors.map((v) => Buffer.from(v.hex, 'hex')));
  const got = [];
  const read = frameReader((m) => got.push(m));
  for (let i = 0; i < all.length; i += 7) read(all.subarray(i, i + 7)); // split across frame boundaries
  assert.deepEqual(got, vectors.map((v) => v.message), 'frameReader reassembles frames split across chunks');
  const big = Buffer.alloc(4);
  big.writeUInt32BE(MAX_MESSAGE + 1);
  assert.throws(() => frameReader(() => {})(big), /cap/, 'a frame over 64 KB is refused');
  assert.throws(() => encodeFrame({ source: 's', destination: 'd', namespace: 'n', data: 'x'.repeat(MAX_MESSAGE) }), /cap/, 'encode refuses over 64 KB');
  assert.throws(() => decodeMessage(Buffer.from([0x12, 0x05, 0x61])), /truncated/, 'a truncated field throws');
  assert.throws(() => decodeMessage(Buffer.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])), /varint/, 'an overlong varint throws');
}
console.log(`ok 0 codec matches ${vectors.length} golden vectors`);

// ---- Processes ----
// Binds every server the server mocks create to 127.0.0.1 (they listen on all interfaces).
const BOOT = `data:text/javascript,${encodeURIComponent(
  "import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'&&(a.length===1||typeof a[1]==='function'))a.splice(1,0,'127.0.0.1');return l.apply(this,a)};",
)}`;
// Kills any outgoing TCP/TLS connection (fetch included) to a host other than loopback, and says so on stderr.
const GUARD = `data:text/javascript,${encodeURIComponent(
  "import net from 'node:net';const ok=(h)=>h===undefined||/^127\\./.test(h)||h==='::1'||h==='localhost';const c=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...a){let o=a[0];if(Array.isArray(o))o=o[0];const h=o&&typeof o==='object'?(o.path?undefined:o.host):a[1];if(!ok(h)){console.error('GUARD non-loopback connect to '+h);throw new Error('GUARD: non-loopback connect to '+h)}return c.apply(this,a)};",
)}`;
{
  const r = spawnSync(process.execPath, ['--import', GUARD, '-e', "require('node:net').connect(9, '192.0.2.1')"], { encoding: 'utf8', windowsHide: true });
  assert.ok(r.status !== 0 && /GUARD non-loopback connect to 192\.0\.2\.1/.test(r.stderr), 'the connection guard stops a non-loopback connect');
}

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-castmock-'));
const video = path.join(tmp, 'video.mkv');
fs.writeFileSync(video, Buffer.alloc(256 * 1024, 0x1a)); // only its bytes are fetched, never decoded

async function startMock(name, script, args, env, ready) {
  const t = Date.now();
  const child = spawn(process.execPath, ['--import', BOOT, '--import', GUARD, path.join(root, 'tools/mock-server', script), ...args], {
    cwd: root,
    // The developer's own MOCK_* settings never leak into the run (no MOCK_*_HOST: loopback only).
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MOCK_'))), MOCK_DURATION_S: String(DURATION_S), ...env },
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
  return { name, log, ms: Date.now() - t };
}

async function call(url, { method = 'GET', headers = {}, body } = {}) {
  assertLoopbackUrl(url);
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // XML or plain text
  }
  return { status: res.status, headers: res.headers, text, json };
}

// ---- Server mocks (the streams the renderers fetch) ----
const servers = {};
for (const kind of ['emby', 'jellyfin']) {
  const port = await freePort();
  const p = await startMock(kind, `mock-${kind}.mjs`, [String(port), video], {}, /^Mock (Emby|Jellyfin)/);
  const base = `http://${LOOPBACK}:${port}${kind === 'emby' ? '/emby' : ''}`;
  const fields = `Client="Wicaby checks", Device="cast-mock-check", DeviceId="cast-mock-check", Version="1.0.0"`;
  const r = await call(`${base}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(kind === 'emby' ? { 'X-Emby-Authorization': `Emby ${fields}` } : { Authorization: `MediaBrowser ${fields}` }) },
    body: JSON.stringify({ Username: 'Wika', Pw: 'wicaby' }),
  });
  assert.equal(r.status, 200, `${kind}: sign-in`);
  servers[kind] = { ...p, port, base, root: `http://${LOOPBACK}:${port}`, token: r.json.AccessToken };
}
const emby = servers.emby;
const jf = servers.jellyfin;
const embyStream = `${emby.base}/Videos/12345/stream.mkv?Static=true&MediaSourceId=mediasource_12345&api_key=${emby.token}`;
const embyVtt = `${emby.base}/Videos/12345/mediasource_12345/Subtitles/2/Stream.vtt?api_key=${emby.token}`;
const jfVtt = `${jf.root}/Videos/0f1e2d3c4b5a69788796a5b4c3d2e1f0/0f1e2d3c4b5a69788796a5b4c3d2e1f0/Subtitles/2/0/Stream.vtt?ApiKey=${jf.token}`;
const OFF_LAN = 'http://192.0.2.1:8096/emby/Videos/12345/stream.mkv'; // TEST-NET-1: must never be contacted

// Emby CORS (CA-06 AC6, unverified on a real Emby): modelled WITHOUT Access-Control-Allow-Origin; Jellyfin sends "*".
{
  const e = await call(embyVtt, { headers: { Origin: 'x' } });
  assert.equal(e.status, 200, 'emby Stream.vtt');
  assert.equal(e.headers.get('access-control-allow-origin'), null, 'emby Stream.vtt is modelled without CORS');
  const j = await call(jfVtt, { headers: { Origin: 'x' } });
  assert.equal(j.status, 200, 'jellyfin Stream.vtt');
  assert.equal(j.headers.get('access-control-allow-origin'), '*', 'jellyfin Stream.vtt answers CORS *');
}

// A stand-in for the desktop LAN relay (CA-07): token-free /c/<nonce>/ URLs, CORS "*", Origin headers recorded.
const relaySeen = [];
const relay = http.createServer((req, res) => {
  relaySeen.push({ url: req.url, origin: req.headers.origin ?? null, range: req.headers.range ?? null });
  const vtt = req.url.endsWith('.vtt');
  res.writeHead(vtt ? 200 : 206, { 'Content-Type': vtt ? 'text/vtt' : 'video/mp4', 'Access-Control-Allow-Origin': '*', ...(vtt ? {} : { 'Content-Range': 'bytes 0-1023/1024' }) });
  res.end(vtt ? 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nrelay\n' : Buffer.alloc(1024));
});
await new Promise((r) => relay.listen(0, LOOPBACK, r));
const relayBase = `http://${LOOPBACK}:${relay.address().port}/c/0f1e2d3c4b5a69788796a5b4c3d2e1f0`;
const relayVideo = `${relayBase}/Videos/12345/stream.mp4?Static=true`;
const relayVtt = `${relayBase}/Videos/12345/mediasource_12345/Subtitles/2/Stream.vtt`;

// ---- New mocks: startup time ----
const dlna = {};
for (const profile of ['generic', 'sony', 'samsung']) {
  const port = await freePort();
  const p = await startMock(`dlna-${profile}`, 'mock-dlna.mjs', [String(port)], { MOCK_DLNA_PROFILE: profile }, /^Mock DLNA renderer/);
  dlna[profile] = { ...p, port, root: `http://${LOOPBACK}:${port}` };
}
const castPorts = { tls: await freePort(), state: await freePort() };
const castProc = await startMock('cast', 'mock-cast.mjs', [], { MOCK_CAST_PORT: String(castPorts.tls), MOCK_CAST_STATE_PORT: String(castPorts.state) }, /^Mock Cast device/);
const castState = `http://${LOOPBACK}:${castPorts.state}`;
for (const p of [...Object.values(dlna), castProc]) assert.ok(p.ms < 1000, `${p.name} starts in under 1 s (took ${p.ms} ms)`);
console.log(`ok 1 mocks started: ${[...Object.values(dlna), castProc].map((p) => `${p.name} ${p.ms} ms`).join(', ')}`);

// ---- Cast connections that must be closed by the mock: no heartbeat (15 s), oversize frame ----
function castClient() {
  const socket = tls.connect({ host: LOOPBACK, port: castPorts.tls, rejectUnauthorized: false }); // the TEST ONLY self-signed pair
  const msgs = [];
  let seen = 0;
  socket.on('data', frameReader((m) => msgs.push({ ...m, json: JSON.parse(m.data) })));
  socket.on('error', () => {});
  const c = {
    socket,
    msgs,
    opened: new Promise((r) => socket.once('secureConnect', r)),
    closed: new Promise((r) => socket.once('close', () => r(Date.now()))),
    send: (destination, namespace, payload) => socket.write(encodeFrame({ source: 'sender-0', destination, namespace, data: JSON.stringify(payload) })),
    // The next unseen message matching pred, within ms (null on timeout).
    async next(pred, ms = 2000) {
      const until = Date.now() + ms;
      for (;;) {
        const i = msgs.findIndex((m, k) => k >= seen && pred(m.json, m));
        if (i >= 0) {
          seen = i + 1;
          return msgs[i].json;
        }
        if (Date.now() > until) return null;
        await sleep(15);
      }
    },
  };
  return c;
}
const NS = 'urn:x-cast:com.google.cast.';
const CONNECTION = `${NS}tp.connection`;
const HEARTBEAT = `${NS}tp.heartbeat`;
const RECEIVER = `${NS}receiver`;
const MEDIA = `${NS}media`;
const CONNECTSDK = 'urn:x-cast:com.connectsdk';

const silent = castClient();
await silent.opened;
const silentAt = Date.now();
silent.send('receiver-0', CONNECTION, { type: 'CONNECT' });
const silentClosed = silent.closed;
{
  const bad = castClient();
  await bad.opened;
  const head = Buffer.alloc(4);
  head.writeUInt32BE(70_000);
  bad.socket.write(head);
  const at = await Promise.race([bad.closed, sleep(2000).then(() => null)]);
  assert.ok(at, 'mock-cast closes a connection that announces a frame over 64 KB');
}

// ---- 2. DLNA ----
const SERVICES = { avt: 'AVTransport', rc: 'RenderingControl', cm: 'ConnectionManager' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const unesc = (s) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, n) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[n]);
const hmsToS = (s) => s.split(':').reduce((a, b) => a * 60 + Number(b), 0);

function didl({ url, flags = '*', subs = false, captionFirst = true }) {
  const sub = `${relayBase}/Videos/12345/mediasource_12345/Subtitles/3/Stream.srt`;
  const res = `<res protocolInfo="http-get:*:video/x-matroska:${flags}" duration="0:02:00.000">${esc(url)}</res>`;
  const cap = `<sec:CaptionInfoEx sec:type="srt">${esc(sub)}</sec:CaptionInfoEx>`;
  const srt = `<res protocolInfo="http-get:*:text/srt:*">${esc(sub)}</res><pv:subtitleFileUri>${esc(sub)}</pv:subtitleFileUri>`;
  const body = subs ? (captionFirst ? res + cap + srt : res + srt + cap) : res;
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:sec="http://www.sec.co.kr/" xmlns:pv="http://www.pv.com/pvns/"><item id="0" parentID="-1" restricted="1"><dc:title>Mock &amp; film</dc:title><upnp:class>object.item.videoItem</upnp:class>${body}</item></DIDL-Lite>`;
}
const FLAGS = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';

function renderer(d, ctl) {
  const soap = async (svc, action, args = {}, { quoted = true, headers = {} } = {}) => {
    const ns = `urn:schemas-upnp-org:service:${SERVICES[svc]}:1`;
    const inner = Object.entries(args)
      .map(([k, v]) => `<${k}>${esc(v)}</${k}>`)
      .join('');
    const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${ns}">${inner}</u:${action}></s:Body></s:Envelope>`;
    const r = await call(ctl[svc], { method: 'POST', headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: quoted ? `"${ns}#${action}"` : `${ns}#${action}`, ...headers }, body });
    const out = {};
    for (const m of r.text.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) out[m[1]] = unesc(m[2]);
    return { status: r.status, text: r.text, out, error: Number(/<errorCode>(\d+)</.exec(r.text)?.[1]) || null };
  };
  const avt = (action, args = {}, o) => soap('avt', action, { InstanceID: 0, ...args }, o);
  return {
    soap,
    avt,
    rc: (action, args = {}) => soap('rc', action, { InstanceID: 0, Channel: 'Master', ...args }),
    set: (url, meta) => avt('SetAVTransportURI', { CurrentURI: url, CurrentURIMetaData: meta }),
    transport: async () => (await avt('GetTransportInfo')).out.CurrentTransportState,
    state: async () => (await call(`${d.root}/Mock/State`)).json,
  };
}

for (const profile of ['generic', 'sony', 'samsung']) {
  const d = dlna[profile];
  const location = `${d.root}/desc.xml`;
  const desc = await call(location);
  assert.equal(desc.status, 200, `${profile}: /desc.xml`);
  assert.equal(desc.text, fixture(`dlna-desc-${profile}.xml`).replace('http://127.0.0.1:8970/', `${d.root}/`), `${profile}: the description is the recorded fixture`);
  assert.match(desc.text, /urn:schemas-upnp-org:device:MediaRenderer:1/);
  const urlBase = /<URLBase>([^<]+)</.exec(desc.text)?.[1];
  assert.equal(Boolean(urlBase), profile === 'generic', `${profile}: URLBase only on generic`);
  // controlURL resolved against URLBase, or against LOCATION without one (CA-07); it stays on the same host and port.
  const ctl = {};
  for (const [, type, url] of desc.text.matchAll(/<service>[\s\S]*?<serviceType>urn:schemas-upnp-org:service:(\w+):1<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>[\s\S]*?<\/service>/g)) {
    const key = Object.keys(SERVICES).find((k) => SERVICES[k] === type);
    ctl[key] = new URL(url, urlBase ?? location).href;
    assert.equal(new URL(ctl[key]).host, new URL(location).host, `${profile}: ${type} controlURL on the LOCATION host`);
  }
  assert.deepEqual(Object.keys(ctl).sort(), ['avt', 'cm', 'rc'], `${profile}: three services`);
  const R = renderer(d, ctl);

  const pi = await R.soap('cm', 'GetProtocolInfo');
  assert.equal(pi.status, 200);
  assert.equal(pi.text, fixture(`dlna-protocolinfo-${profile}.xml`), `${profile}: GetProtocolInfo is the recorded Sink`);
  assert.equal(await R.transport(), 'NO_MEDIA_PRESENT');

  if (profile === 'sony') {
    const f = await R.set(embyStream, '');
    assert.equal(f.status, 500);
    assert.equal(f.text, fixture('dlna-fault-714.xml'), 'sony: empty CurrentURIMetaData -> 714, the fault fixture');
  }
  if (profile === 'samsung') {
    const f = await R.set(embyStream, didl({ url: embyStream }));
    assert.equal(f.text, fixture('dlna-fault-716.xml'), 'samsung: no DLNA.ORG flags -> 716, the fault fixture');
    const g = await R.set(embyStream, didl({ url: embyStream, flags: FLAGS, subs: true, captionFirst: false }));
    assert.equal(g.error, 714, 'samsung: sec:CaptionInfoEx not right after </res> -> 714');
  }
  const meta = didl({ url: embyStream, flags: FLAGS, subs: profile === 'samsung' });
  assert.equal((await R.set(embyStream, meta)).status, 200, `${profile}: SetAVTransportURI`);
  assert.equal((await R.avt('Play', { Speed: 1 })).status, 200, `${profile}: Play`);
  assert.ok(['PLAYING', 'TRANSITIONING'].includes(await R.transport()), `${profile}: PLAYING after Play`);
  let st = await R.state();
  assert.equal(st.meta, meta, `${profile}: the mock records the DIDL as sent`);
  assert.equal(st.fetched.status, 206, `${profile}: the renderer fetched the stream (Range)`);
  assert.equal(st.fetched.type, 'video/x-matroska');
  assert.equal(st.fetched.tokenInUrl, true, `${profile}: a token URL is flagged`);

  if (profile === 'sony') {
    const f = await R.set(embyStream, meta);
    assert.equal(f.text, fixture('dlna-fault-701.xml'), 'sony: SetAVTransportURI while PLAYING -> 701, the fault fixture');
    assert.equal((await R.avt('Stop')).status, 200);
    assert.equal((await R.set(embyStream, meta)).status, 200, 'sony: Stop then SetAVTransportURI recovers from 701');
    assert.equal((await R.avt('Play', { Speed: 1 })).status, 200);
    assert.equal(await R.transport(), 'PLAYING');
  }

  assert.equal((await R.avt('Seek', { Unit: 'REL_TIME', Target: '00:01:00' })).status, 200, `${profile}: Seek`);
  let pos = (await R.avt('GetPositionInfo')).out;
  assert.ok(hmsToS(pos.RelTime) >= 60 && hmsToS(pos.RelTime) < 63, `${profile}: RelTime after Seek (${pos.RelTime})`);
  assert.equal(pos.TrackDuration, '00:02:00', `${profile}: TrackDuration from MOCK_DURATION_S`);
  assert.equal(pos.TrackURI, embyStream);
  assert.equal((await R.avt('Seek', { Unit: 'TRACK_NR', Target: '1' })).error, 710, `${profile}: an unsupported seek unit -> 710`);
  assert.equal((await R.avt('Pause')).status, 200);
  assert.equal(await R.transport(), 'PAUSED_PLAYBACK');
  const frozen = (await R.avt('GetPositionInfo')).out.RelTime;
  await sleep(1100);
  assert.equal((await R.avt('GetPositionInfo')).out.RelTime, frozen, `${profile}: RelTime frozen while paused`);
  assert.equal((await R.avt('Play', { Speed: 1 })).status, 200);
  await sleep(1100);
  pos = (await R.avt('GetPositionInfo')).out;
  assert.ok(hmsToS(pos.RelTime) > hmsToS(frozen), `${profile}: RelTime advances while PLAYING`);

  assert.equal((await R.rc('SetVolume', { DesiredVolume: 150 })).error, 501, `${profile}: SetVolume 150 -> 501`);
  assert.equal((await R.rc('SetVolume', { DesiredVolume: 35 })).status, 200);
  assert.equal((await R.rc('GetVolume')).out.CurrentVolume, '35');
  assert.equal((await R.rc('SetMute', { DesiredMute: 1 })).status, 200);
  assert.equal((await R.rc('GetMute')).out.CurrentMute, '1');
  // Optional in AVTransport:1: only the sonos profile has it (cast-dlna-check drives that one).
  assert.equal((await R.avt('SetNextAVTransportURI', { NextURI: relayVideo, NextURIMetaData: '' })).error, 401, `${profile}: no SetNextAVTransportURI (401)`);
  assert.equal((await R.state()).nextUri, '', `${profile}: nothing queued`);

  assert.equal((await call(`${d.root}/Mock/End`, { method: 'POST' })).status, 204);
  assert.equal(await R.transport(), 'STOPPED', `${profile}: /Mock/End -> STOPPED`);
  st = await R.state();
  for (const a of ['GetProtocolInfo', 'SetAVTransportURI', 'Play', 'Seek', 'Pause', 'GetPositionInfo', 'GetTransportInfo', 'SetVolume', 'GetVolume', 'SetMute', 'SetNextAVTransportURI'])
    assert.ok(st.calls.some((c) => c.action === a), `${profile}: /Mock/State.calls records ${a}`);
  assert.equal(st.tokenHeaders, 0, `${profile}: no auth header reached the renderer`);

  if (profile === 'generic') {
    // The relay's token-free URL (CA-07 AC2, relay on).
    assert.equal((await R.set(relayVideo, didl({ url: relayVideo }))).status, 200);
    assert.equal((await R.avt('Play', { Speed: 1 })).status, 200);
    st = await R.state();
    assert.equal(st.fetched.tokenInUrl, false, 'generic: a relay URL carries no token');
    assert.ok([200, 206].includes(st.fetched.status), 'generic: the relay URL was fetched');
    // The media ends by itself at MOCK_DURATION_S.
    assert.equal((await R.avt('Seek', { Unit: 'REL_TIME', Target: '00:01:59' })).status, 200);
    await sleep(1300);
    assert.equal(await R.transport(), 'STOPPED', 'generic: STOPPED at the end of the media');
    // A URL outside loopback is refused without a connection; the renderer stays STOPPED.
    assert.equal((await R.set(OFF_LAN, didl({ url: OFF_LAN }))).status, 200);
    assert.equal((await R.avt('Play', { Speed: 1 })).status, 200);
    st = await R.state();
    assert.equal(st.fetched.status, 0);
    assert.match(st.fetched.error, /non-loopback/, 'generic: a non-loopback stream URL is refused');
    assert.equal(st.state, 'STOPPED');
    assert.equal(st.status, 'ERROR_OCCURRED');
    // Protocol slips a real renderer would trip on.
    assert.equal((await R.avt('GetTransportInfo', {}, { quoted: false })).status, 200, 'generic: an unquoted SOAPACTION is accepted (and logged)');
    assert.equal((await R.soap('avt', 'GetTransportInfo', { InstanceID: 1 })).error, 718, 'generic: InstanceID 1 -> 718');
    assert.equal((await R.soap('avt', 'Fly', { InstanceID: 0 })).error, 401, 'generic: an unknown action -> 401');
    await R.avt('GetTransportInfo', {}, { headers: { 'X-Emby-Token': 'secret' } });
    assert.equal((await R.state()).tokenHeaders, 1, 'generic: an auth header sent to the renderer is counted');
  }
  console.log(`ok 2 dlna ${profile}`);
}

// ---- 3. Cast ----
const c = castClient();
await c.opened;
c.send('receiver-0', CONNECTION, { type: 'CONNECT' });
c.send('receiver-0', HEARTBEAT, { type: 'PING' });
assert.ok(await c.next((p) => p.type === 'PONG'), 'cast: PING -> PONG');
c.send('receiver-0', RECEIVER, { type: 'GET_STATUS', requestId: 1 });
let p = await c.next((x) => x.type === 'RECEIVER_STATUS' && x.requestId === 1);
assert.deepEqual(p.status.applications, [], 'cast: no app running');
c.send('receiver-0', RECEIVER, { type: 'LAUNCH', appId: 'ZZZZ0000', requestId: 2 });
assert.ok(await c.next((x) => x.type === 'LAUNCH_ERROR' && x.requestId === 2), 'cast: an unknown appId -> LAUNCH_ERROR');
c.send('receiver-0', RECEIVER, { type: 'LAUNCH', appId: 'CC1AD845', requestId: 3 });
p = await c.next((x) => x.type === 'RECEIVER_STATUS' && x.requestId === 3);
const dmr = p.status.applications[0];
assert.equal(dmr.appId, 'CC1AD845');
assert.ok(dmr.sessionId && dmr.transportId, 'cast: LAUNCH gives sessionId and transportId');
c.send(dmr.transportId, MEDIA, { type: 'GET_STATUS', requestId: 4 });
assert.equal(await c.next((x) => x.requestId === 4, 300), null, 'cast: no answer to an app without a CONNECT to its transportId');
c.send(dmr.transportId, CONNECTION, { type: 'CONNECT' });

const load = (requestId, contentId, extra = {}) =>
  c.send(dmr.transportId, MEDIA, {
    type: 'LOAD',
    requestId,
    media: {
      contentId,
      contentType: 'video/mp4',
      streamType: 'BUFFERED',
      tracks: [
        { trackId: 1, type: 'TEXT', subtype: 'SUBTITLES', trackContentId: embyVtt, trackContentType: 'text/vtt' },
        { trackId: 2, type: 'TEXT', subtype: 'SUBTITLES', trackContentId: relayVtt, trackContentType: 'text/vtt' },
      ],
    },
    currentTime: 10,
    autoplay: true,
    activeTrackIds: [1],
    ...extra,
  });
load(5, embyStream);
p = await c.next((x) => x.type === 'MEDIA_STATUS' && x.requestId === 5, 6000);
assert.equal(p?.status[0].playerState, 'PLAYING', 'cast: LOAD -> MEDIA_STATUS PLAYING');
const msid = p.status[0].mediaSessionId;
let cs = (await call(`${castState}/Mock/State`)).json;
const [content, embyTrack, relayTrack] = cs.fetched.slice(-3);
assert.equal(content.status, 206, 'cast: the device fetched contentId');
assert.equal(content.tokenInUrl, true);
assert.equal(embyTrack.status, 200);
assert.equal(embyTrack.cors, false, 'cast: Emby Stream.vtt came back without CORS (AC6 model)');
assert.equal(relayTrack.cors, true, 'cast: the relay track came back with CORS');
assert.equal(relayTrack.tokenInUrl, false);
assert.ok(relaySeen.some((r) => r.url.endsWith('Stream.vtt') && r.origin === 'https://mock-cast'), 'cast: tracks are fetched with Origin: https://mock-cast');

const status = async (requestId) => {
  c.send(dmr.transportId, MEDIA, { type: 'GET_STATUS', requestId });
  return (await c.next((x) => x.type === 'MEDIA_STATUS' && x.requestId === requestId)).status[0];
};
const t1 = (await status(6)).currentTime;
await sleep(1100);
const t2 = (await status(7)).currentTime;
assert.ok(t1 >= 10 && t2 > t1, `cast: currentTime moves while PLAYING (${t1} -> ${t2})`);
const media = async (type, requestId, extra = {}) => {
  c.send(dmr.transportId, MEDIA, { type, requestId, mediaSessionId: msid, ...extra });
  return (await c.next((x) => x.requestId === requestId)) ?? {};
};
assert.equal((await media('PAUSE', 8)).status[0].playerState, 'PAUSED');
assert.equal((await media('SEEK', 9, { currentTime: 60 })).status[0].currentTime, 60);
assert.equal((await media('SET_VOLUME', 10, { volume: { level: 0.3 } })).status[0].volume.level, 0.3);
assert.deepEqual((await media('EDIT_TRACKS_INFO', 11, { activeTrackIds: [2] })).status[0].activeTrackIds, [2]);
assert.equal((await media('PLAY', 12)).status[0].playerState, 'PLAYING');
c.send(dmr.transportId, MEDIA, { type: 'PAUSE', requestId: 13, mediaSessionId: msid + 99 });
assert.equal((await c.next((x) => x.requestId === 13))?.type, 'INVALID_REQUEST', 'cast: a stale mediaSessionId -> INVALID_REQUEST');
assert.equal((await call(`${castState}/Mock/End`, { method: 'POST' })).status, 204);
p = await c.next((x) => x.type === 'MEDIA_STATUS' && x.status[0]?.playerState === 'IDLE');
assert.equal(p?.status[0].idleReason, 'FINISHED', 'cast: /Mock/End pushes IDLE / FINISHED');
// The relay's token-free URL, then a URL outside loopback (refused without a connection: LOAD_FAILED).
load(14, relayVideo);
p = await c.next((x) => x.type === 'MEDIA_STATUS' && x.requestId === 14, 6000);
cs = (await call(`${castState}/Mock/State`)).json;
const relayContent = cs.fetched.at(-3);
assert.equal(relayContent.tokenInUrl, false, 'cast: the relay contentId carries no token');
assert.ok([200, 206].includes(relayContent.status));
load(15, OFF_LAN);
assert.ok(await c.next((x) => x.type === 'LOAD_FAILED' && x.requestId === 15, 6000), 'cast: an unreachable contentId -> LOAD_FAILED');
cs = (await call(`${castState}/Mock/State`)).json;
assert.match(cs.fetched.at(-3).error, /non-loopback/, 'cast: a non-loopback contentId is refused');
console.log('ok 3 cast DMR (CC1AD845)');

// Jellyfin receiver: connectsdk.
c.send('receiver-0', RECEIVER, { type: 'LAUNCH', appId: 'F007D354', requestId: 20 });
p = await c.next((x) => x.type === 'RECEIVER_STATUS' && x.requestId === 20);
const jfApp = p.status.applications[0];
assert.equal(jfApp.appId, 'F007D354');
assert.ok(jfApp.namespaces.some((n) => n.name === CONNECTSDK), 'cast: the Jellyfin receiver lists com.connectsdk');
c.send(jfApp.transportId, CONNECTION, { type: 'CONNECT' });
const items = [
  { Id: '0f1e2d3c4b5a69788796a5b4c3d2e1f0', ServerId: 'jf', Name: 'One', Type: 'Episode', MediaType: 'Video', IsFolder: false },
  { Id: '1f1e2d3c4b5a69788796a5b4c3d2e1f0', ServerId: 'jf', Name: 'Two', Type: 'Episode', MediaType: 'Video', IsFolder: false },
];
const playNow = { command: 'PlayNow', options: { items, startIndex: 1, startPositionTicks: 300_000_000, mediaSourceId: items[1].Id, audioStreamIndex: 1, subtitleStreamIndex: 2 }, userId: 'u', deviceId: 'cast-mock-check', serverAddress: jf.root, serverId: 'jf', serverVersion: '12.2', receiverName: 'Mock Cast' };
c.send(jfApp.transportId, CONNECTSDK, { ...playNow, accessToken: undefined });
assert.equal(await c.next((x) => x.type === 'MEDIA_STATUS', 400), null, 'cast: connectsdk without accessToken fails (no MEDIA_STATUS)');
c.send(jfApp.transportId, CONNECTSDK, { ...playNow, accessToken: jf.token });
p = await c.next((x) => x.type === 'MEDIA_STATUS' && x.status[0]?.playerState === 'PLAYING');
assert.equal(p?.status[0].media.contentId, items[1].Id, 'cast: PlayNow plays items[startIndex]');
assert.ok(Math.abs(p.status[0].currentTime - 30) < 1, 'cast: PlayNow starts at startPositionTicks');
c.send(jfApp.transportId, CONNECTSDK, { command: 'PreviousTrack', options: {}, serverAddress: jf.root, accessToken: jf.token });
p = await c.next((x) => x.type === 'MEDIA_STATUS');
assert.equal(p?.status[0].media.contentId, items[0].Id, 'cast: PreviousTrack moves in the queue');
c.send(jfApp.transportId, CONNECTSDK, { command: 'SetSubtitleStreamIndex', options: { index: 3 }, serverAddress: jf.root, accessToken: jf.token });
await sleep(200);
cs = (await call(`${castState}/Mock/State`)).json;
const sdk = cs.connectsdk;
assert.deepEqual(sdk[0].missing, ['accessToken'], 'cast: the failed connectsdk message is recorded with what is missing');
assert.equal(sdk.filter((m) => m.ok && m.command === 'PlayNow')[0].options.items.length, 2, 'cast: PlayNow recorded with its queue');
assert.equal(typeof sdk.at(-1).options.index, 'number', 'cast: SetSubtitleStreamIndex recorded with a numeric index');
c.send('receiver-0', RECEIVER, { type: 'STOP', sessionId: jfApp.sessionId, requestId: 21 });
p = await c.next((x) => x.type === 'RECEIVER_STATUS' && x.requestId === 21);
assert.deepEqual(p.status.applications, [], 'cast: STOP ends the app');
console.log('ok 3 cast Jellyfin receiver (F007D354, connectsdk)');

// Heartbeat: the connection that never sent a PING is closed after 15 s.
const closedAt = await Promise.race([silentClosed, sleep(Math.max(0, silentAt + 18_000 - Date.now())).then(() => null)]);
assert.ok(closedAt, 'cast: no PING for 15 s closes the connection');
assert.ok(closedAt - silentAt >= 14_500, `cast: not before 15 s (${closedAt - silentAt} ms)`);
c.socket.destroy();
console.log(`ok 3 cast heartbeat closed after ${closedAt - silentAt} ms`);

// ---- 4. Logs: a bug list, and no contact outside loopback ----
await sleep(100);
const logs = Object.fromEntries([...Object.values(dlna), castProc, emby, jf].map((p) => [p.name, p.log.join('\n')]));
for (const [name, log] of Object.entries(logs)) {
  assert.doesNotMatch(log, /GUARD/, `${name}: no connection outside 127.0.0.1`);
  assert.doesNotMatch(log, /^ERROR /m, `${name}: no handler error`);
}
const tags = {
  'dlna-generic': ['UNQUOTED-SOAPACTION', 'TOKEN-HEADER', 'FAULT 718', 'FAULT 401', 'REFUSED', 'END media', 'FETCH 206'],
  'dlna-sony': ['FAULT 714', 'FAULT 701'],
  'dlna-samsung': ['FAULT 716', 'FAULT 714'],
  cast: ['LAUNCH-ERROR', 'NO-CONNECT', 'CONNECTSDK-INVALID', 'BAD-FRAME', 'HEARTBEAT-LOST', 'REFUSED', 'INVALID PAUSE'],
};
for (const [name, want] of Object.entries(tags)) for (const t of want) assert.ok(logs[name].includes(t), `${name}: the log tags ${t}`);
const elapsed = Date.now() - T0;
assert.ok(elapsed < 60_000, `the check runs in under 60 s (${elapsed} ms)`);
console.log(`ok 4 logs tag every quirk; no contact outside ${LOOPBACK}`);

relay.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\ncast-mock-check: all passed in ${(elapsed / 1000).toFixed(1)} s`);
process.exit(0);
