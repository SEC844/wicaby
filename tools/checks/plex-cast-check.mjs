// Casting a Plex item with the desktop senders (plex-spec PX-10), against tools/mock-server/mock-plex.mjs (in this
// process), mock-dlna (generic) and mock-cast, all on loopback, with the real PlexClient, Relay, DlnaCast and
// ChromecastCast:
//   DLNA      an h264 MKV direct plays: the renderer fetches the part through the relay (tokenInUrl:false) and the
//             PMS sees no token in any URL; a PGS subtitle the renderer cannot draw would need an HLS transcode,
//             which a DLNA TV does not play: refused with plex.errors.dlnaNeedsDirectPlay, never a wrong stream
//   Cast      the Default Media Receiver LOADs the HLS start.m3u8 through the relay; the mock fetches it with no
//             token in the URL, and no token is anywhere in the LOAD
// No mpv, nothing audible: the renderers only fetch bytes.
// Usage: node tools/checks/plex-cast-check.mjs [--verbose]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { MACHINE_ID, startMockPlex } from '../mock-server/mock-plex.mjs';

const repo = path.resolve(import.meta.dirname, '..', '..');
const VERBOSE = process.argv.includes('--verbose');
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|localhost)$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (c, m) => (assert.ok(c, m), passed++, VERBOSE && console.log(`  ok ${m}`));

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-plex-cast-'));
const srcOf = (p) => path.join(repo, 'apps/desktop/src', p).replace(/\\/g, '/');
const entry = path.join(tmp, 'entry.ts');
fs.writeFileSync(
  entry,
  `export { PlexClient } from '${srcOf('main/connection/plex-client.ts')}';
export { Relay } from '${srcOf('main/cast/relay.ts')}';
export { DlnaCast } from '${srcOf('main/cast/dlna-cast.ts')}';
export { ChromecastCast } from '${srcOf('main/cast/chromecast-cast.ts')}';
export { fetchDescription } from '${srcOf('main/cast/dlna.ts')}';
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

// ---- Mocks: the renderers as children (loopback only, as cast-dlna-check does) ----
const children = new Set();
process.on('exit', () => children.forEach((c) => c.kill()));
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const BOOT = `data:text/javascript,${encodeURIComponent(
  "import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){if(typeof a[0]==='number'&&(a.length===1||typeof a[1]==='function'))a.splice(1,0,'127.0.0.1');return l.apply(this,a)};const ok=(h)=>h===undefined||/^127\\./.test(h)||h==='::1'||h==='localhost';const c=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...a){let o=a[0];if(Array.isArray(o))o=o[0];const h=o&&typeof o==='object'?(o.path?undefined:o.host):a[1];if(!ok(h))throw new Error('GUARD: non-loopback connect to '+h);return c.apply(this,a)};",
)}`;
async function startChild(name, script, args, env, ready) {
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
  return log;
}
const json = async (url) => (loopbackUrl(url), (await fetch(url)).json());

// Only bytes are fetched, never decoded: a dummy file stands behind every part.
const video = path.join(tmp, 'video.mkv');
fs.writeFileSync(video, Buffer.alloc(256 * 1024, 0x1a));
const m = await startMockPlex({ port: 0, tvPort: 0, relayPort: 0, env: { MOCK_PLEX_VIDEO: video, MOCK_PLEX_SECOND: '0', MOCK_PLEX_TLS: '0' } });
const ports = { dlna: await freePort(), cast: await freePort(), castState: await freePort() };
await Promise.all([
  startChild('dlna', 'mock-dlna.mjs', [String(ports.dlna)], { MOCK_DLNA_PROFILE: 'generic' }, /^Mock DLNA renderer/),
  startChild('cast', 'mock-cast.mjs', [], { MOCK_CAST_PORT: String(ports.cast), MOCK_CAST_STATE_PORT: String(ports.castState) }, /^Mock Cast device/),
]);

const identity = { client: 'Wicaby', version: '0.0.0-check', deviceId: 'check-device-plex-cast', deviceName: 'check' };
const token = m.serverToken();
const client = new P.PlexClient(m.pms, identity, token, '1', { machineId: MACHINE_ID, userName: 'Wika', owner: true });
const film = (await client.request('GET', '/Users/1/Items/1000')).MediaSources;
const theatrical = film.find((s) => s.Name === 'Theatrical').Id;
const pgsIndex = (await client.request('GET', '/Users/1/Items/1004')).MediaSources[0].MediaStreams.find((x) => x.Codec === 'pgssub').Index;
const noTokenInUrl = (from) => m.state.calls.slice(from).every((x) => !('X-Plex-Token' in x.query));
const relay = new P.Relay();

try {
  // ---- DLNA ----
  const device = await P.fetchDescription(`http://127.0.0.1:${ports.dlna}/desc.xml`);
  ok(device?.avt, 'the mock renderer is described');
  const dlnaTarget = { key: `d:${device.udn}`, kind: 'dlna', section: 'dlna', name: device.name, detail: device.model, serverId: MACHINE_ID, commands: [], mediaTypes: ['Audio', 'Video'] };
  const dlna = (ended) => new P.DlnaCast({ api: client, userId: '1', device, target: dlnaTarget, relay, seed: true, deviceId: identity.deviceId, publish() {}, ended });
  const dlnaState = () => json(`http://127.0.0.1:${ports.dlna}/Mock/State`);
  let from = m.state.calls.length;
  const endedDirect = [];
  const d1 = dlna((k) => endedDirect.push(k));
  await d1.start({ itemIds: ['1000'], msid: theatrical, positionTicks: 0 }, null);
  const s1 = await dlnaState();
  ok(d1.status === 'playing' && !endedDirect.length, `DLNA: the h264 MKV direct plays (${d1.status}${endedDirect.length ? `, ended ${endedDirect}` : ''})`);
  ok(/^http:\/\/127\.0\.0\.1:\d+\/c\/[0-9a-f]{32}\/Videos\/1000\/stream\.mkv\?/.test(s1.uri), `DLNA: the renderer got a relay URL (${s1.uri.replace(/\?.*/, '?…')})`);
  ok([200, 206].includes(s1.fetched?.status) && s1.fetched.tokenInUrl === false, `DLNA: the renderer fetched the part through the relay, tokenInUrl=false (${s1.fetched?.status})`);
  ok(noTokenInUrl(from) && !s1.uri.includes(token) && m.state.calls.slice(from).some((x) => /^\/library\/parts\//.test(x.path)), 'DLNA: the relay asked the PMS for the part, the token as a header only');
  await d1.stop();
  from = m.state.calls.length;
  const endedBurn = [];
  const d2 = dlna((k) => endedBurn.push(k));
  await d2.start({ itemIds: ['1004'], sub: pgsIndex, positionTicks: 0 }, null);
  ok(endedBurn.includes('plex.errors.dlnaNeedsDirectPlay') && m.state.decisions.at(-1).result === 'transcode' && !m.state.calls.slice(from).some((x) => /start\.m3u8$/.test(x.path)), `DLNA: a PGS subtitle burned in needs an HLS transcode: refused with plex.errors.dlnaNeedsDirectPlay (${endedBurn})`);

  // ---- Chromecast (Default Media Receiver) ----
  from = m.state.calls.length;
  const castDevice = { id: 'mock-cast', name: 'Mock Cast', model: 'Chromecast', ip: '127.0.0.1', port: ports.cast, video: true };
  const castTarget = { key: 'c:mock-cast', kind: 'cast', section: 'chromecast', name: castDevice.name, detail: castDevice.model, serverId: MACHINE_ID, commands: [], mediaTypes: ['Audio', 'Video'] };
  const endedCast = [];
  const cc = new P.ChromecastCast({ api: client, userId: '1', device: castDevice, target: castTarget, relay, seed: true, deviceId: identity.deviceId, prefs: {}, server: { id: MACHINE_ID, version: '1.41.0' }, publish() {}, ended: (k) => endedCast.push(k) });
  await cc.start({ itemIds: ['1000'], msid: theatrical, positionTicks: 0 }, null);
  const cs = await json(`http://127.0.0.1:${ports.castState}/Mock/State`);
  const load = cs.calls.findLast((c) => c.type === 'LOAD')?.data;
  ok(cc.status === 'playing' && cs.app?.appId === 'CC1AD845', `Cast: playing on the Default Media Receiver (${cc.status}${endedCast.length ? `, ended ${endedCast}` : ''})`);
  ok(/^http:\/\/127\.0\.0\.1:\d+\/c\/[0-9a-f]{32}\/video\/:\/transcode\/universal\/start\.m3u8\?/.test(load?.media?.contentId ?? ''), `Cast: LOAD of the HLS start.m3u8 through the relay (${(load?.media?.contentId ?? '').replace(/\?.*/, '?…')})`);
  const content = cs.fetched.findLast((f) => f.kind === 'content');
  ok(content?.status === 200 && content.tokenInUrl === false, `Cast: the device fetched start.m3u8 through the relay, tokenInUrl=false (${content?.status})`);
  ok(!JSON.stringify(load).includes(token) && !/X-Plex-Token/i.test(JSON.stringify(load)) && noTokenInUrl(from), 'Cast: no token anywhere in the LOAD or in a PMS URL');
  await cc.stop();

  const bad = m.state.tags.filter((t) => ['UNMAPPED', 'TOKEN-IN-URL', 'NO-CLIENT-ID', 'NO-TOKEN', 'DUP-STOPPED', 'DUP-SCROBBLE', 'ACCOUNT-TOKEN-ON-PMS'].includes(t));
  ok(bad.length === 0, `mock tags: none of UNMAPPED, TOKEN-IN-URL, NO-CLIENT-ID, DUP-STOPPED, DUP-SCROBBLE (${bad.join(', ') || 'none'})`);
} finally {
  relay.shutdown();
  await m.close();
  children.forEach((c) => c.kill());
}
console.log(`plex-cast-check: ok (${passed} checks)`);
process.exit(0);
