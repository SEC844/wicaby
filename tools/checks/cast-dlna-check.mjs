// Self-check for the desktop DLNA sender and LAN stream relay (docs/specs/cast-spec.md CA-07).
// - pure: the SSDP reply parser and the LOCATION rule (a forged reply to 8.8.8.8 or another host is ignored),
//   isLanAddress / isLanInterface / localAddressFor, description parsing on the three recorded profiles (URLBase or
//   LOCATION, controlURL kept on LOCATION's host and port, no entity expansion), the DIDL and double-escaping
//   goldens (fixtures/cast/dlna-didl.json), the Sink -> profile goldens (fixtures/cast/profiles.json), the relay
//   allow-list (Emby numeric ids and mediasource_<n> included) and its remote-address rule;
// - against mock Jellyfin, mock Emby and mock-dlna (generic, sony, samsung) on loopback, with the real
//   ConnectionManager and CastManager, the renderers found through the dev seed (WICABY_DLNA_SEED), never SSDP, and
//   a fake local player (no mpv, nothing audible): AC 1 picker rows within 3 s; AC 2 direct stream through the
//   relay (tokenInUrl:false), sony's 701 recovered, samsung's 716 retried with the DLNA.ORG flags, relay off ->
//   ApiKey (Jellyfin); AC 3 progress with the cast's PlaySessionId, /Mock/End -> Stopped and the bar closes; AC 4 a
//   seek on a transcode restarts with StartTimeTicks and reports StartTimeTicks + RelTime; AC 5 the relay answers
//   403 to another IP and to a path off the list, 404 to an ended nonce; AC 8 local playback stops the cast first;
//   AC 9 an Emby cast through the relay with numeric and mediasource_ paths.
// Nothing leaves 127.0.0.1: the electron stub's fetch and request refuse any other host, outgoing TCP and UDP to a
// non-loopback address throw, and SSDP searches on no interface.
// Usage: node tools/checks/cast-dlna-check.mjs [--verbose]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const T0 = Date.now();
const repo = path.resolve(import.meta.dirname, '..', '..');
const FX = path.join(import.meta.dirname, 'fixtures', 'cast');
const fixture = (name) => fs.readFileSync(path.join(FX, name), 'utf8');
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

// Test hooks: the next GetTransportInfo to `lieTo` answers STOPPED (a renderer that has not caught up yet);
// `blockedAt` takes Play and says PLAYING but never fetches (a firewall between the renderer and the relay).
const hooks = { lieTo: null, blockedAt: null, soap: [] };
globalThis.__castNet = {
  async fetch(url, init = {}) {
    loopbackUrl(url);
    const body = typeof init.body === 'string' ? init.body : '';
    const action = /#(\w+)"/.exec(init.headers?.SOAPACTION ?? '')?.[1];
    if (action) hooks.soap.push({ url, action });
    if (action === 'GetTransportInfo' && hooks.lieTo && url.startsWith(hooks.lieTo)) {
      hooks.lieTo = null;
      return new Response('<s:Envelope><s:Body><u:GetTransportInfoResponse><CurrentTransportState>STOPPED</CurrentTransportState></u:GetTransportInfoResponse></s:Body></s:Envelope>', { status: 200 });
    }
    if (hooks.blockedAt && url.startsWith(hooks.blockedAt) && (action === 'Play' || action === 'GetTransportInfo')) {
      return new Response(`<s:Envelope><s:Body><u:${action}Response>${action === 'Play' ? '' : '<CurrentTransportState>PLAYING</CurrentTransportState>'}</u:${action}Response></s:Body></s:Envelope>`, { status: 200 });
    }
    return fetch(url, { ...init, body: body || init.body });
  },
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-cast-dlna-'));
const src = (p) => path.join(repo, 'apps/desktop/src/main', p).replace(/\\/g, '/');
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `export * from '${src('cast/lan.ts')}';
export * from '${src('cast/ssdp.ts')}';
export * from '${src('cast/dlna.ts')}';
export * from '${src('cast/profiles.ts')}';
export { Relay, relayPathAllowed, relayRemoteAllowed } from '${src('cast/relay.ts')}';
export { DlnaCast } from '${src('cast/dlna-cast.ts')}';
export { CastManager, dlnaTarget } from '${src('cast/cast-manager.ts')}';
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

// ---- Pure ----
// SSDP replies and the LOCATION rule (AC 6).
{
  const reply = 'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\nLocation: http://192.168.1.20:52323/dmr.xml\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: uuid:abc::urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n';
  assert.deepEqual(C.parseSsdpReply(reply), { location: 'http://192.168.1.20:52323/dmr.xml', usn: 'uuid:abc::urn:schemas-upnp-org:device:MediaRenderer:1' });
  assert.equal(C.parseSsdpReply('NOTIFY * HTTP/1.1\r\nLOCATION: http://192.168.1.20/x\r\n\r\n'), null, 'only 200 replies');
  assert.equal(C.parseSsdpReply('HTTP/1.1 200 OK\r\nST: x\r\n\r\n'), null, 'no LOCATION');
  assert.equal(C.acceptLocation('http://192.168.1.20:52323/dmr.xml', '192.168.1.20'), 'http://192.168.1.20:52323/dmr.xml');
  assert.equal(C.acceptLocation('http://192.168.1.20:52323/dmr.xml', '::ffff:192.168.1.20'), 'http://192.168.1.20:52323/dmr.xml');
  for (const [loc, from, why] of [
    ['http://8.8.8.8/desc.xml', '8.8.8.8', 'a public host'],
    ['http://8.8.8.8/desc.xml', '192.168.1.20', 'forged: LOCATION on 8.8.8.8'],
    ['http://192.168.1.30/desc.xml', '192.168.1.20', 'forged: LOCATION on another LAN host'],
    ['http://router.lan/desc.xml', '192.168.1.20', 'a host name'],
    ['https://192.168.1.20/desc.xml', '192.168.1.20', 'not plain http'],
    ['http://user:pw@192.168.1.20/desc.xml', '192.168.1.20', 'credentials'],
    ['http://100.100.1.1/desc.xml', '100.100.1.1', 'the mesh'],
    ['http://127.0.0.1:8970/desc.xml', '127.0.0.1', 'loopback outside the dev seed'],
  ])
    assert.equal(C.acceptLocation(loc, from), null, why);
  assert.equal(C.acceptLocation('http://127.0.0.1:8970/desc.xml', '127.0.0.1', true), 'http://127.0.0.1:8970/desc.xml', 'the dev seed may be loopback');
  assert.deepEqual(C.seedLocations('http://127.0.0.1:8970/desc.xml, http://8.8.8.8/x.xml,junk', false), ['http://127.0.0.1:8970/desc.xml'], 'seeds: LAN or loopback only');
  assert.deepEqual(C.seedLocations('http://127.0.0.1:8970/desc.xml', true), [], 'a packaged build ignores the seed');
}
// LAN addresses and interfaces.
{
  for (const ip of ['192.168.50.5', '10.1.2.3', '172.16.0.1', '172.31.255.254', '169.254.10.1', 'fd00::1', 'fc12:3456::1', '::ffff:192.168.1.2']) assert.ok(C.isLanAddress(ip), ip);
  for (const ip of ['100.100.1.1', '100.64.0.1', '8.8.8.8', '127.0.0.1', '172.32.0.1', '::1', 'fd7a:115c:a1e0::1', '2001:db8::1', 'tv.local', 'localhost', '', '192.168.1']) assert.ok(!C.isLanAddress(ip), ip);
  assert.ok(C.isLanAddress('127.0.0.1', { loopback: true }), 'loopback for the dev seed');
  const v4 = (address, netmask = '255.255.255.0', internal = false) => ({ family: 'IPv4', address, netmask, internal });
  assert.ok(C.isLanInterface('Wi-Fi', v4('192.168.1.10')));
  assert.ok(!C.isLanInterface('Tailscale', v4('192.168.1.11')), 'a VPN adapter, whatever its address');
  assert.ok(!C.isLanInterface('wt0', v4('10.0.0.2')), 'NetBird');
  assert.ok(!C.isLanInterface('Ethernet 2', v4('100.101.1.1')), 'CGNAT');
  assert.ok(!C.isLanInterface('Loopback', v4('127.0.0.1', '255.0.0.0', true)), 'loopback');
  const ifaces = { 'Wi-Fi': [v4('192.168.1.10')], Ethernet: [v4('10.0.5.2', '255.255.0.0')], Loopback: [v4('127.0.0.1', '255.0.0.0', true)], Tailscale: [v4('100.90.1.2', '255.192.0.0')] };
  assert.deepEqual(C.lanInterfaces(ifaces), ['192.168.1.10', '10.0.5.2'], 'SSDP goes out on the LAN interfaces only');
  assert.equal(C.localAddressFor('192.168.1.42', ifaces), '192.168.1.10');
  assert.equal(C.localAddressFor('10.0.9.9', ifaces), '10.0.5.2');
  assert.equal(C.localAddressFor('127.0.0.1', ifaces), '127.0.0.1');
  assert.equal(C.localAddressFor('100.90.1.9', ifaces), null, 'never through the VPN adapter');
  assert.equal(C.localAddressFor('192.168.2.1', ifaces), null);
}
// Descriptions: the three recorded profiles, URLBase or LOCATION, same host and port, no entity expansion.
{
  const loc = 'http://127.0.0.1:8970/desc.xml';
  const g = C.parseDescription(fixture('dlna-desc-generic.xml'), loc);
  assert.deepEqual(g, { location: loc, ip: '127.0.0.1', udn: '5f9ec1b4-0c6a-4d5e-9a10-000000000001', name: 'Mock Renderer', model: 'Generic Renderer', avt: 'http://127.0.0.1:8970/ctl/avt', rc: 'http://127.0.0.1:8970/ctl/rc', cm: 'http://127.0.0.1:8970/ctl/cm' });
  const s = C.parseDescription(fixture('dlna-desc-sony.xml'), 'http://127.0.0.1:8970/sony/desc.xml');
  assert.deepEqual([s.name, s.model, s.avt, s.rc], ['Mock BRAVIA', 'BRAVIA (mock profile)', 'http://127.0.0.1:8970/ctl/avt', 'http://127.0.0.1:8970/ctl/rc'], 'sony: absolute controlURLs against LOCATION (no URLBase)');
  const sam = C.parseDescription(fixture('dlna-desc-samsung.xml'), 'http://192.168.1.20:9197/dmr/desc.xml');
  assert.deepEqual([sam.name, sam.avt, sam.ip], ['[TV] Mock Samsung', 'http://192.168.1.20:9197/dmr/ctl/avt', '192.168.1.20'], 'samsung: relative controlURLs against LOCATION');
  const otherBase = fixture('dlna-desc-generic.xml').replace('http://127.0.0.1:8970/', 'http://8.8.8.8:80/');
  assert.equal(C.parseDescription(otherBase, loc), null, 'a URLBase on another host takes the AVTransport away');
  const otherPort = fixture('dlna-desc-generic.xml').replace('<controlURL>ctl/avt</controlURL>', '<controlURL>http://127.0.0.1:9999/ctl/avt</controlURL>');
  assert.equal(C.parseDescription(otherPort, loc), null, 'a controlURL on another port is refused');
  const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY e SYSTEM "file:///C:/Windows/win.ini"><!ENTITY x "&e;&e;&e;">]>${fixture('dlna-desc-generic.xml').replace(/^<\?xml[^>]*>/, '').replace('<friendlyName>Mock Renderer</friendlyName>', '<friendlyName>&x;</friendlyName>')}`;
  assert.equal(C.parseDescription(xxe, loc).name, '&x;', 'entities are never expanded');
  assert.equal(C.dlnaTarget(g).key, 'd:5f9ec1b4-0c6a-4d5e-9a10-000000000001');
  assert.deepEqual(C.dlnaTarget({ ...g, rc: undefined }).commands, ['SetAudioStreamIndex', 'SetSubtitleStreamIndex'], 'no RenderingControl: no volume');
}
// DIDL and SOAP goldens; faults.
{
  const { cases } = JSON.parse(fixture('dlna-didl.json'));
  for (const c of cases) {
    assert.equal(C.didl(c.input), c.didl, `DIDL: ${c.name}`);
    assert.equal(C.soapEnvelope('AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURI: c.input.url, CurrentURIMetaData: C.didl(c.input) }), c.setAVTransportURI, `escaped twice: ${c.name}`);
  }
  const sub = cases.find((c) => c.input.subtitleUrl).didl;
  assert.match(sub, /<\/res><sec:CaptionInfoEx sec:type="srt">/, 'sec:CaptionInfoEx right after the first </res>');
  assert.ok(!cases.some((c) => /api_key|ApiKey/.test(c.input.title)), 'no token in titles');
  for (const code of [701, 714, 716]) {
    assert.throws(() => C.parseSoapReply(500, fixture(`dlna-fault-${code}.xml`)), (e) => e instanceof C.UpnpError && e.code === code, `fault ${code}`);
  }
  assert.deepEqual(C.parseSoapReply(200, '<s:Envelope><s:Body><u:GetPositionInfoResponse xmlns:u="x"><RelTime>0:01:02</RelTime><TrackURI>http://a/b?c=1&amp;d=2</TrackURI><TrackMetaData/></u:GetPositionInfoResponse></s:Body></s:Envelope>'), { RelTime: '0:01:02', TrackURI: 'http://a/b?c=1&d=2', TrackMetaData: '' });
  assert.equal(C.parseHms('1:02:03.500'), 3723.5);
  assert.ok(Number.isNaN(C.parseHms('NOT_IMPLEMENTED')));
}
// Profiles: the Sink goldens.
{
  const f = JSON.parse(fixture('profiles.json'));
  const sinkOf = (x) => (x.sinkFixture ? /<Sink>([^<]*)<\/Sink>/.exec(fixture(x.sinkFixture))[1] : x.sink);
  for (const d of f.dlna) assert.deepEqual(C.dlnaProfile(sinkOf(d), d.model), d.expected, `dlnaProfile ${d.name}`);
  for (const m of f.mimes) assert.equal(C.mimeFor(m.container, m.audio, sinkOf(m)), m.expected, `mimeFor ${m.container} ${m.sinkFixture ?? 'no sink'}`);
  for (const c of f.cast) assert.deepEqual(C.castProfile(c.model, c.prefs, c.server), c.expected, `castProfile ${c.model} ${c.server}`);
  const all = JSON.stringify(f.dlna.map((d) => d.expected.TranscodingProfiles));
  assert.ok(!/hls/i.test(all), 'DLNA never transcodes to HLS');
}
// Relay allow-list (AC 5, AC 9) and remote address.
{
  for (const p of [
    '/Videos/12345/stream.mkv',
    '/Videos/12345/mediasource_12345/Subtitles/2/Stream.srt',
    '/Videos/12345/mediasource_12345/Subtitles/2/Stream.vtt',
    '/Videos/0f1e2d3c4b5a69788796a5b4c3d2e1f0/0f1e2d3c4b5a69788796a5b4c3d2e1f0/Subtitles/3/0/Stream.vtt',
    '/videos/abc/stream',
    '/Videos/movie-0/master.m3u8',
    '/Videos/1/hls1/main/0.ts',
    '/Audio/77/stream.mp3',
  ])
    assert.ok(C.relayPathAllowed(p), `allowed: ${p}`);
  for (const p of ['/System/Info', '/Users/1/Items', '/Items/1/Download', '/Videos/1/../../System/Info', '/Videos/1/hls/../../../System/Info', '/Videos/1/hls/%2e%2e/x', '/Videos/1/hls/a%2fb', '/Videos/1/stream.mkv/x', '/Videos/a b/stream', '//evil/Videos/1/stream'])
    assert.ok(!C.relayPathAllowed(p), `refused: ${p}`);
  assert.ok(C.relayRemoteAllowed('::ffff:192.168.1.5', '192.168.1.5'));
  assert.ok(!C.relayRemoteAllowed('192.168.1.6', '192.168.1.5'));
  assert.ok(!C.relayRemoteAllowed(undefined, '192.168.1.5'));
}
console.log(`ok pure: SSDP, LAN, descriptions, DIDL, profiles, relay rules (${Date.now() - T0} ms)`);

// ---- Mocks (loopback only) ----
const children = new Set();
process.on('exit', () => children.forEach((c) => c.kill()));
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
// Binds the server mocks to 127.0.0.1 and kills any non-loopback connect they try (as cast-mock-check does).
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
  return { log };
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
// GET from a chosen local address; resolves with the status, or the error code.
const httpGet = (url, localAddress) =>
  new Promise((resolve) => {
    loopbackUrl(url);
    const req = http.get(url, { localAddress, headers: { Range: 'bytes=0-1023' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', (e) => resolve(e.code));
  });

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
// PlaybackService as the cast manager sees it. play() does what PlaybackService.play does first: beforePlay
// (index.ts wires it to stopSenderReported), then its own Playing report.
class FakeLocal {
  log = [];
  snapshot = null;
  beforePlay = null;
  onStop = null;
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
    await this.onStop?.();
    this.snapshot = null;
  }
  async play(req) {
    this.log.push('play');
    this.played = req;
    await this.beforePlay?.();
    await this.api().post('/Sessions/Playing', undefined, { ItemId: req.itemIds[0], MediaSourceId: req.itemIds[0], PlaySessionId: 'local-play', PlayMethod: 'DirectPlay', PositionTicks: 0 });
  }
}

try {
  const video = path.join(tmp, 'video.mkv');
  fs.writeFileSync(video, Buffer.alloc(512 * 1024, 0x1a)); // only its bytes are fetched, never decoded
  const ports = { jf: await freePort(), emby: await freePort(), generic: await freePort(), sony: await freePort(), samsung: await freePort() };
  const [, , ...dl] = await Promise.all([
    startMock('jellyfin', 'mock-jellyfin.mjs', [String(ports.jf), video], {}, /^Mock Jellyfin/),
    startMock('emby', 'mock-emby.mjs', [String(ports.emby), video], {}, /^Mock Emby/),
    ...['generic', 'sony', 'samsung'].map((p) => startMock(`dlna-${p}`, 'mock-dlna.mjs', [String(ports[p])], { MOCK_DLNA_PROFILE: p }, /^Mock DLNA renderer/)),
  ]);
  const rootOf = (p) => `http://127.0.0.1:${ports[p]}`;
  process.env.WICABY_DLNA_SEED = ['generic', 'sony', 'samsung'].map((p) => `${rootOf(p)}/desc.xml`).join(',');
  const dlnaState = (p) => json(`${rootOf(p)}/Mock/State`);
  const reports = async () => (await json(`${rootOf('jf')}/Mock/State`)).reports;

  async function desktop(kind, deviceId) {
    const base = kind === 'jf' ? rootOf('jf') : `${rootOf('emby')}`;
    const m = new C.ConnectionManager(path.join(tmp, `servers-${deviceId}.json`), new FakeVault(), { client: 'Wicaby', version: '0.2.0', deviceId, deviceName: 'pc-a' });
    const info = await m.add(base);
    await m.select(info.id);
    await m.login('Wika', 'wicaby', info.id);
    const api = () => m.onlineApi(info.id);
    const local = new FakeLocal(api);
    const toasts = [];
    const settings = { value: { cast: { discovery: true, relay: true } } };
    const cast = new C.CastManager({ connection: m, local, deviceId, notify: (k, message) => toasts.push({ kind: k, message }), settings });
    local.beforePlay = () => cast.stopSenderReported();
    // PlaybackInfo calls, as sent.
    const pbi = [];
    const client = api();
    const post = client.post.bind(client);
    client.post = (p, q, b) => (/\/PlaybackInfo$/.test(p) && pbi.push({ path: p, query: q, body: b }), post(p, q, b));
    return { m, serverId: info.id, local, toasts, cast, settings, pbi, api };
  }

  assert.equal(C.DlnaCast.progressMs, 10_000, 'progress every 10 s');
  assert.equal(C.DlnaCast.pingMs, 30_000, 'ping every 30 s while transcoding');
  assert.equal(C.DlnaCast.confirmMs, 8000, 'relay blocked after 8 s');
  C.DlnaCast.progressMs = 700;

  const A = await desktop('jf', 'desk-dlna');
  // ---- AC 1: the picker lists the seeded renderers within 3 s ----
  const t1 = Date.now();
  let firstMock = null;
  A.cast.on('targets', (list) => firstMock === null && list.some((r) => r.kind === 'dlna' && r.name === 'Mock Renderer') && (firstMock = Date.now() - t1));
  const rows = await A.cast.targets('movie-0', A.serverId);
  const key = (name) => rows.find((r) => r.kind === 'dlna' && r.name === name)?.key;
  assert.ok(firstMock !== null && firstMock <= 3000, `"Mock Renderer" listed within 3 s (${firstMock} ms)`);
  assert.deepEqual(rows.filter((r) => r.kind === 'dlna').map((r) => [r.section, r.name]).sort(), [['dlna', 'Mock BRAVIA'], ['dlna', 'Mock Renderer'], ['dlna', '[TV] Mock Samsung']], 'three DLNA rows in the DLNA section');
  assert.ok(!rows.some((r) => r.kind === 'dlna' && r.deviceId), 'no session fields on direct rows');
  assert.ok(!(await A.cast.targets('ch-1', A.serverId)).some((r) => r.kind === 'dlna'), 'a channel lists no direct DLNA row');
  console.log(`ok AC1 picker: Mock Renderer in ${firstMock} ms`);
  await A.cast.targets('movie-0', A.serverId);

  // ---- AC 2 + 3 (generic, relay on): a handoff from the player, direct stream, progress, end of media ----
  {
    A.local.snapshot = { serverId: A.serverId, itemIds: ['movie-0'], startIndex: 0, positionTicks: 600 * TICKS, msid: 'movie-0-1080', audio: 1, sub: -1, live: false, policy: 'mbb' };
    let reportsAtStop = null;
    A.local.onStop = async () => (reportsAtStop = (await reports()).length);
    await A.cast.start(key('Mock Renderer'));
    const st = A.cast.state;
    assert.equal(st?.status, 'playing', 'casting to generic');
    assert.equal(st.target.kind, 'dlna');
    assert.ok(A.cast.senderReported, 'a DLNA cast is sender-reported (quit prompt)');
    assert.deepEqual(A.local.log, ['pause', 'stop'], 'local pauses once the renderer took it, stops once it plays');
    const d = await dlnaState('generic');
    assert.match(d.uri, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/c/[0-9a-f]{32}/Videos/movie-0/stream\\.mkv\\?Static=true&MediaSourceId=movie-0-1080&PlaySessionId=\\w+&DeviceId=desk-dlna$`), 'a direct stream through the relay');
    assert.ok([200, 206].includes(d.fetched.status), `renderer fetched ${d.fetched.status}`);
    assert.equal(d.fetched.tokenInUrl, false, 'AC 2: no token in the URL (relay)');
    assert.equal(d.tokenHeaders, 0, 'no auth header to the renderer');
    assert.ok(!/api_?key|token/i.test(d.meta.replace(/PlaySessionId/g, '')), 'no token in the DIDL');
    assert.equal(A.pbi.at(-1).body.MaxStreamingBitrate, 40_000_000, '40 Mbps for DLNA');
    assert.equal(A.pbi.at(-1).body.DeviceProfile.Name, 'Wicaby DLNA (Generic Renderer)', "the renderer's profile");
    const psid = new URL(d.uri).searchParams.get('PlaySessionId');
    const r0 = await reports();
    const start = r0.findIndex((r) => r.kind === 'start' && r.PlaySessionId === psid);
    assert.ok(start >= 0, 'Playing reported with the cast PlaySessionId');
    assert.ok(reportsAtStop !== null && start >= reportsAtStop, 'the local Stopped went out before the cast Playing');
    assert.deepEqual(r0[start].missing, []);
    assert.equal(r0[start].PlayMethod, 'DirectStream');
    assert.ok(Math.abs(r0[start].PositionTicks - 600 * TICKS) < 5 * TICKS, 'Playing at the handoff position');
    // AC 3: progress with the cast's PlaySessionId (every DlnaCast.progressMs, 10 s by default), then /Mock/End.
    await until(async () => (await reports()).filter((r) => r.kind === 'progress' && r.PlaySessionId === psid).length >= 2, 4000, 'progress reports');
    await A.cast.control({ type: 'pause' });
    assert.equal((await dlnaState('generic')).state, 'PAUSED_PLAYBACK');
    assert.ok((await reports()).some((r) => r.kind === 'progress' && r.EventName === 'Pause' && r.IsPaused === true), 'Pause reported');
    await A.cast.control({ type: 'resume' });
    await A.cast.control({ type: 'seek', positionTicks: 900 * TICKS });
    assert.equal((await dlnaState('generic')).calls.findLast((c) => c.action === 'Seek').args.Target, '00:15:00', 'a direct stream seeks in place (REL_TIME)');
    await A.cast.control({ type: 'volume', value: 35 });
    assert.equal((await dlnaState('generic')).volume, 35, 'RenderingControl SetVolume');
    await A.cast.control({ type: 'mute', value: true });
    assert.equal((await dlnaState('generic')).muted, true);
    await until(() => Math.abs(A.cast.state.positionTicks - 900 * TICKS) < 3 * TICKS && A.cast.state.volume === 35, 3000, 'polls mirror the renderer');
    const nonceUrl = (await dlnaState('generic')).uri;
    // AC 5: another IP, a path off the list (403), while the cast plays.
    const other = await httpGet(nonceUrl, '127.0.0.2');
    assert.equal(other, 403, `another IP gets 403 (got ${other})`);
    assert.equal(await httpGet(nonceUrl.replace(/\/Videos\/.*$/, '/System/Info'), '127.0.0.1'), 403, 'a path outside the allow-list gets 403');
    assert.equal(await httpGet(nonceUrl.replace(/\/c\/[0-9a-f]{32}\//, `/c/${'0'.repeat(32)}/`), '127.0.0.1'), 404, 'an unknown nonce gets 404');
    assert.equal(globalThis.__blocks, 1, 'the PC stays awake while relaying');
    await fetch(`${rootOf('generic')}/Mock/End`, { method: 'POST' });
    await until(() => A.cast.state === null, 4000, 'the bar closes after /Mock/End');
    const stopped = (await reports()).findLast((r) => r.kind === 'stopped');
    assert.equal(stopped?.PlaySessionId, psid, 'AC 3: Stopped with the cast PlaySessionId');
    const after = await httpGet(nonceUrl, '127.0.0.1');
    assert.ok(after === 404 || after === 'ECONNREFUSED', `the ended cast's URL is gone (${after})`);
    assert.equal(globalThis.__blocks, 0, 'the power blocker is released');
    console.log('ok AC2/AC3/AC5 generic: relayed direct stream, progress, pause, seek, volume, 403s, end of media');
  }

  // ---- AC 2 (sony): 701 recovered by itself ----
  {
    // The renderer is still PLAYING something else, but its first GetTransportInfo says STOPPED.
    const raw = (action, args) =>
      fetch(`${rootOf('sony')}/ctl/avt`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"urn:schemas-upnp-org:service:AVTransport:1#${action}"` },
        body: C.soapEnvelope('AVTransport', action, { InstanceID: 0, ...args }),
      });
    // PLAYING a URL it can fetch (its own /desc.xml).
    await raw('SetAVTransportURI', { CurrentURI: `${rootOf('sony')}/desc.xml`, CurrentURIMetaData: C.didl({ title: 'x', audio: false, url: 'u', mime: 'video/x-matroska' }) });
    await raw('Play', { Speed: 1 });
    assert.equal((await dlnaState('sony')).state, 'PLAYING');
    hooks.lieTo = rootOf('sony');
    await A.cast.start(key('Mock BRAVIA'), { itemIds: ['movie-0'], msid: 'movie-0-1080', positionTicks: 0 });
    assert.equal(A.cast.state?.status, 'playing', 'casting to sony');
    const s = await dlnaState('sony');
    const sets = s.calls.filter((c) => c.action === 'SetAVTransportURI').slice(-2);
    assert.deepEqual(sets.map((c) => c.error ?? 200), [701, 200], '701, then accepted');
    const i = s.calls.lastIndexOf(sets[0]);
    assert.equal(s.calls[i + 1].action, 'Stop', 'Stop between the two');
    assert.ok([200, 206].includes(s.fetched.status) && s.fetched.tokenInUrl === false, 'sony fetched through the relay');
    await A.cast.stop();
    assert.equal(A.cast.state, null);
    assert.equal((await dlnaState('sony')).state, 'STOPPED', '"Arrêter la diffusion" stops the renderer');
    console.log('ok AC2 sony: 701 recovered');
  }

  // ---- AC 2 (samsung): 716 retried with the DLNA.ORG flags ----
  {
    await A.cast.start(key('[TV] Mock Samsung'), { itemIds: ['movie-0'], msid: 'movie-0-1080' });
    assert.equal(A.cast.state?.status, 'playing', 'casting to samsung');
    const s = await dlnaState('samsung');
    assert.deepEqual(s.calls.filter((c) => c.action === 'SetAVTransportURI').map((c) => c.error ?? 200), [716, 200]);
    assert.match(s.meta, /DLNA\.ORG_OP=01;DLNA\.ORG_CI=0;DLNA\.ORG_FLAGS=0170/, 'direct-stream flags');
    assert.match(s.meta, /protocolInfo="http-get:\*:video\/x-mkv:/, "the MIME from samsung's Sink");
    await A.cast.stop();
    console.log('ok AC2 samsung: 716 retried with flags');
  }

  // ---- AC 4: a seek on a transcode restarts with StartTimeTicks ----
  {
    await A.cast.targets('movie-0', A.serverId);
    // No version asked: the 60 Mbps 4K source is over 40 Mbps, the mock transcodes.
    await A.cast.start(key('Mock Renderer'), { itemIds: ['movie-0'], positionTicks: 100 * TICKS });
    assert.equal(A.cast.state?.status, 'playing');
    const first = await dlnaState('generic');
    assert.match(first.uri, /\/c\/[0-9a-f]{32}\/Videos\/movie-0\/stream\?/, 'the TranscodingUrl through the relay');
    assert.equal(first.fetched.tokenInUrl, false);
    await A.cast.control({ type: 'seek', positionTicks: 1200 * TICKS });
    const last = A.pbi.at(-1);
    assert.equal(last.body.StartTimeTicks, 1200 * TICKS, 'a new PlaybackInfo with StartTimeTicks');
    const second = await dlnaState('generic');
    assert.notEqual(second.uri, first.uri, 'reloaded');
    assert.ok(second.relTime < 5, 'the transcode starts at 0 on the renderer');
    await sleep(2200);
    const pos = A.cast.state.positionTicks;
    const rel = (await dlnaState('generic')).relTime;
    assert.ok(Math.abs(pos - (1200 + rel) * TICKS) < 2 * TICKS, `position = StartTimeTicks + RelTime (${pos / TICKS} s vs ${1200 + rel} s)`);
    await until(async () => (await reports()).some((r) => r.kind === 'progress' && r.PlayMethod === 'Transcode' && r.PositionTicks >= 1200 * TICKS), 3000, 'progress from StartTimeTicks + RelTime');
    // AC 5: the URL of the cast before the restart answers 404.
    assert.equal(await httpGet(first.uri, '127.0.0.1'), 404, 'an ended nonce gets 404');
    await A.cast.control({ type: 'audio', index: 2 });
    assert.equal(A.pbi.at(-1).body.AudioStreamIndex, 2, 'a track change is a restart');
    // ---- AC 8: local playback while the cast is active stops it first ----
    await A.local.play({ itemIds: ['movie-2'], serverId: A.serverId });
    const tail = (await reports()).slice(-4);
    const stopAt = tail.findIndex((x) => x.kind === 'stopped' && x.PlayMethod === 'Transcode');
    const localAt = tail.findIndex((x) => x.kind === 'start' && x.PlaySessionId === 'local-play');
    assert.ok(stopAt >= 0 && localAt > stopAt, `the cast's Stopped before the new local Playing (${JSON.stringify(tail.map((x) => x.kind + ':' + x.PlaySessionId))})`);
    assert.equal(A.cast.state, null, 'the cast ended');
    console.log('ok AC4/AC8: transcode seek restarts, StartTimeTicks + RelTime, local play stops the cast first');
  }

  // ---- AC 7 (the automatable half): nobody reaches the relay within 8 s of Play -> relayBlocked, never a token ----
  {
    C.DlnaCast.confirmMs = 1500;
    hooks.blockedAt = rootOf('generic');
    A.toasts.length = 0;
    A.local.log = [];
    A.local.snapshot = { serverId: A.serverId, itemIds: ['movie-0'], startIndex: 0, positionTicks: 60 * TICKS, msid: 'movie-0-1080', live: false, policy: 'mbb' };
    await A.cast.start(key('Mock Renderer'));
    hooks.blockedAt = null;
    C.DlnaCast.confirmMs = 8000;
    assert.equal(A.cast.state, null, 'no cast');
    assert.deepEqual(A.local.log, ['pause', 'resume'], 'the player resumes here');
    assert.ok(A.toasts.some((t) => t.kind === 'error' && t.message.includes('pare-feu') && t.message.includes('Mock Renderer')), `cast.error.relayBlocked (${JSON.stringify(A.toasts)})`);
    const d = await dlnaState('generic');
    assert.ok(!/ApiKey|api_key/.test(d.uri), 'no silent token fallback');
    assert.equal(d.calls.at(-1).action, 'Stop', 'the renderer is told to stop');
    console.log('ok AC7 relay blocked: cast.error.relayBlocked, player resumed');
  }

  // ---- AC 2 (relay off, Jellyfin): ApiKey, never api_key ----
  {
    A.settings.value.cast.relay = false;
    await A.cast.targets('movie-0', A.serverId);
    await A.cast.start(key('Mock Renderer'), { itemIds: ['movie-0'], msid: 'movie-0-1080' });
    assert.equal(A.cast.state?.status, 'playing');
    const d = await dlnaState('generic');
    assert.ok(d.uri.startsWith(`${rootOf('jf')}/Videos/movie-0/stream.mkv?`), 'the server address itself');
    assert.equal(d.fetched.tokenInUrl, true);
    assert.match(d.uri, /[?&]ApiKey=/, 'ApiKey on Jellyfin');
    assert.doesNotMatch(d.uri, /api_key/, 'never api_key on Jellyfin');
    assert.ok([200, 206].includes(d.fetched.status), `Jellyfin accepted the ApiKey URL (${d.fetched.status})`);
    assert.ok(!d.meta.includes('ApiKey=') || d.meta.includes(d.uri.replace(/&/g, '&amp;')), 'the token only inside the stream URL');
    await A.cast.stop();
    A.settings.value.cast.relay = true;
    console.log('ok AC2 relay off: ApiKey');
  }
  A.cast.dispose();
  for (const c of A.m.conns.values()) c.socket?.close();

  // ---- AC 9: Emby through the relay; numeric ids and mediasource_<n> ----
  {
    const E = await desktop('emby', 'desk-dlna-emby');
    const list = await E.cast.targets('movie-0', E.serverId);
    const k = list.find((r) => r.name === 'Mock Renderer').key;
    await E.cast.start(k, { itemIds: ['movie-0'], msid: 'movie-0-1080' });
    assert.equal(E.cast.state?.status, 'playing', 'casting from Emby');
    const d = await dlnaState('generic');
    assert.ok([200, 206].includes(d.fetched.status) && d.fetched.tokenInUrl === false, 'Emby stream through the relay');
    const base = d.uri.replace(/\/Videos\/.*$/, '');
    assert.equal(await httpGet(`${base}/Videos/12345/stream.mkv?Static=true&MediaSourceId=mediasource_12345`, '127.0.0.1'), 206, 'numeric Emby id through the relay');
    const sub = await fetch(`${base}/Videos/12345/mediasource_12345/Subtitles/2/Stream.srt`);
    assert.equal(sub.status, 200, 'mediasource_ subtitle path through the relay');
    assert.equal(sub.headers.get('access-control-allow-origin'), '*', 'the relay adds CORS for Cast');
    await sub.text();
    await E.cast.stop();
    E.cast.dispose();
    for (const c of E.m.conns.values()) c.socket?.close();
    console.log('ok AC9 Emby: numeric and mediasource_ paths relayed');
  }
  assert.ok(!hooks.soap.some((s) => !LOOPBACK.test(new URL(s.url).hostname)), 'every SOAP call went to loopback');
  assert.ok(dl.every((x) => !x.log.some((l) => /TOKEN-HEADER|UNQUOTED-SOAPACTION/.test(l))), 'no renderer saw an auth header or an unquoted SOAPACTION');
} finally {
  for (const c of children) c.kill();
}

// AC 8 wiring: PlaybackService.play runs beforePlay first, and index.ts points it at the cast manager.
{
  const ps = fs.readFileSync(path.join(repo, 'apps/desktop/src/main/playback/playback-service.ts'), 'utf8');
  const play = ps.slice(ps.indexOf('  async play(req: PlayRequest)'));
  assert.ok(play.indexOf('await this.beforePlay?.()') > 0 && play.indexOf('await this.beforePlay?.()') < play.indexOf('this.reports.stopped()'), 'play() stops a sender-reported cast before anything else reports');
  assert.match(fs.readFileSync(path.join(repo, 'apps/desktop/src/main/index.ts'), 'utf8'), /playback\.beforePlay = \(\) => cast\.stopSenderReported\(\)/);
}
console.log(`cast-dlna-check: OK (${((Date.now() - T0) / 1000).toFixed(1)} s)`);
process.exit(0);
