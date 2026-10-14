// Mock Chromecast (cast spec CA-06), so the CASTV2 sender (CA-09) runs with no device.
//   node tools/mock-server/mock-cast.mjs
// TLS (CASTV2) on MOCK_CAST_PORT (default 18009), plain-HTTP state on MOCK_CAST_STATE_PORT (default 18010), both on
// MOCK_CAST_HOST or 127.0.0.1. The certificate is the TEST ONLY pair in tools/mock-server/fixtures/cast-tls/.
// Framing is apps/desktop/src/main/cast/castv2-codec.ts itself (transpiled by esbuild at start), so sender and mock
// are both checked against tools/checks/fixtures/cast/castv2-vectors.json, not against each other.
//
// Namespaces (urn:x-cast:com.google.cast.*):
// - tp.connection: CONNECT, CLOSE. Messages to an app's transportId need a CONNECT to it first (else NO-CONNECT).
// - tp.heartbeat: PING -> PONG. No PING for 15 s closes the connection (MOCK_CAST_HEARTBEAT_S).
// - receiver: LAUNCH {appId} -> RECEIVER_STATUS (sessionId, transportId); GET_STATUS; STOP; SET_VOLUME;
//   an appId other than CC1AD845 (Default Media Receiver), F007D354 or 6F511C87 (Jellyfin) -> LAUNCH_ERROR.
// - media: LOAD GETs the first 64 KB of contentId and of each tracks[].trackContentId with "Origin: https://mock-cast"
//   and records whether Access-Control-Allow-Origin came back (tools/mock-server/probe.mjs; loopback URLs only unless
//   MOCK_CAST_HOST is set), then MEDIA_STATUS PLAYING with a currentTime that moves; PLAY, PAUSE, SEEK, STOP,
//   GET_STATUS, EDIT_TRACKS_INFO, SET_VOLUME. MOCK_DURATION_S (default 600) when media.duration is absent.
// - com.connectsdk (Jellyfin receiver apps only): records every message; fails (CONNECTSDK-INVALID, no reply) when
//   command, serverAddress or accessToken is missing, as the receiver's maincontroller.ts; PlayNow, NextTrack and
//   PreviousTrack answer through the media namespace so the sender can mirror.
// MOCK_CAST_AUDIO_ONLY=1: a speaker or speaker group (no video output): a LOAD whose contentType is not audio/* fails
// (LOAD_FAILED, tagged NO-VIDEO-OUT). LOAD also GETs metadata.images[0].url (the cover, kind 'image'), as a device
// with a screen or the Google Home app would; it never decides the load.
// Mock-only (state port): GET /Mock/State {connections, app, volume, media, calls[], fetched[], connectsdk[]},
// POST /Mock/End (the media finishes: IDLE / FINISHED).
// Every message is logged; quirks are tagged (NO-CONNECT, CONNECTSDK-INVALID, LAUNCH-ERROR, REFUSED, UNMAPPED).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import tls from 'node:tls';
import { transformSync } from 'esbuild';
import { probe } from './probe.mjs';

const here = import.meta.dirname;
const codecSrc = fs.readFileSync(path.resolve(here, '../../apps/desktop/src/main/cast/castv2-codec.ts'), 'utf8');
const { encodeFrame, frameReader } = await import(`data:text/javascript,${encodeURIComponent(transformSync(codecSrc, { loader: 'ts', format: 'esm' }).code)}`);

const OPEN = Boolean(process.env.MOCK_CAST_HOST);
const HOST = process.env.MOCK_CAST_HOST || '127.0.0.1';
const PORT = Number(process.env.MOCK_CAST_PORT || 18009);
const STATE_PORT = Number(process.env.MOCK_CAST_STATE_PORT || 18010);
const HEARTBEAT_MS = Number(process.env.MOCK_CAST_HEARTBEAT_S || 15) * 1000;
const DURATION = Number(process.env.MOCK_DURATION_S || 600);
const ORIGIN = 'https://mock-cast';
const AUDIO_ONLY = process.env.MOCK_CAST_AUDIO_ONLY === '1';

const NS = 'urn:x-cast:com.google.cast.';
const CONNECTION = `${NS}tp.connection`;
const HEARTBEAT = `${NS}tp.heartbeat`;
const RECEIVER = `${NS}receiver`;
const MEDIA = `${NS}media`;
const CONNECTSDK = 'urn:x-cast:com.connectsdk';
const APPS = { CC1AD845: 'Default Media Receiver', F007D354: 'Jellyfin', '6F511C87': 'Jellyfin (Unstable)' };
const JELLYFIN_APPS = new Set(['F007D354', '6F511C87']);

// ---- Device state (one device, every connection sees it) ----
const dev = { app: null, volume: { level: 1, muted: false }, media: null };
const calls = [];
const fetched = [];
const connectsdk = [];
const conns = new Set();
let nextTransport = 1;
let nextMediaSession = 1;

function currentTime() {
  const m = dev.media;
  if (!m) return 0;
  return Math.min(m.duration, m.pos + (m.playerState === 'PLAYING' ? (Date.now() - m.since) / 1000 : 0));
}
function setPlayer(playerState, idleReason) {
  const m = dev.media;
  m.pos = currentTime();
  m.since = Date.now();
  m.playerState = playerState;
  m.idleReason = idleReason;
}
// The media finishes by itself at its duration (evaluated whenever a status is built).
function tick() {
  if (dev.media?.playerState === 'PLAYING' && currentTime() >= dev.media.duration) {
    setPlayer('IDLE', 'FINISHED');
    console.log('END media finished');
    broadcastMedia();
  }
}

const receiverStatus = () => ({
  applications: dev.app
    ? [{ appId: dev.app.appId, displayName: APPS[dev.app.appId], sessionId: dev.app.sessionId, transportId: dev.app.transportId, statusText: 'Ready To Cast', isIdleScreen: false, namespaces: [{ name: MEDIA }, ...(JELLYFIN_APPS.has(dev.app.appId) ? [{ name: CONNECTSDK }] : [])] }]
    : [],
  volume: { ...dev.volume, controlType: 'attenuation', stepInterval: 0.05 },
});
function mediaStatus() {
  const m = dev.media;
  if (!m) return [];
  return [
    {
      mediaSessionId: m.mediaSessionId,
      playbackRate: 1,
      playerState: m.playerState,
      ...(m.idleReason ? { idleReason: m.idleReason } : {}),
      currentTime: Math.round(currentTime() * 1000) / 1000,
      supportedMediaCommands: 12303,
      volume: { ...dev.volume },
      activeTrackIds: m.activeTrackIds,
      media: { contentId: m.contentId, contentType: m.contentType, streamType: m.streamType, duration: m.duration, tracks: m.tracks, ...(m.customData ? { customData: m.customData } : {}) },
      ...(m.queue ? { items: m.queue.items, currentItemIndex: m.queue.index } : {}),
    },
  ];
}

function send(c, source, destination, namespace, payload) {
  if (c.socket.destroyed) return;
  c.socket.write(encodeFrame({ source, destination, namespace, data: JSON.stringify(payload) }));
}
// Replies go to the asker; changes are also pushed (destination "*") to every connection attached to the app.
function sendReceiverStatus(c, to, requestId = 0) {
  send(c, 'receiver-0', to, RECEIVER, { type: 'RECEIVER_STATUS', requestId, status: receiverStatus() });
}
function broadcastMedia(except, requestId = 0) {
  if (!dev.app) return;
  for (const c of conns) if (c !== except && c.virtual.has(dev.app.transportId)) send(c, dev.app.transportId, '*', MEDIA, { type: 'MEDIA_STATUS', requestId, status: mediaStatus() });
}
function replyMedia(c, to, requestId) {
  send(c, dev.app.transportId, to, MEDIA, { type: 'MEDIA_STATUS', requestId, status: mediaStatus() });
  broadcastMedia(c);
}

function stopApp() {
  if (dev.app) console.log(`APP stopped ${dev.app.appId}`);
  dev.app = null;
  dev.media = null;
}

async function onReceiver(c, msg, p) {
  switch (p.type) {
    case 'LAUNCH': {
      if (!APPS[p.appId]) {
        console.log(`LAUNCH-ERROR unknown appId ${p.appId}`);
        return send(c, 'receiver-0', msg.source, RECEIVER, { type: 'LAUNCH_ERROR', requestId: p.requestId, reason: 'NOT_FOUND' });
      }
      stopApp();
      dev.app = { appId: p.appId, sessionId: crypto.randomUUID(), transportId: `web-${nextTransport++}` };
      console.log(`APP launched ${p.appId} (${APPS[p.appId]}) transportId=${dev.app.transportId}`);
      return sendReceiverStatus(c, msg.source, p.requestId);
    }
    case 'GET_STATUS':
      return sendReceiverStatus(c, msg.source, p.requestId);
    case 'STOP':
      if (dev.app && p.sessionId && p.sessionId !== dev.app.sessionId) console.log(`NOTE STOP for sessionId ${p.sessionId}, running ${dev.app.sessionId}`);
      stopApp();
      return sendReceiverStatus(c, msg.source, p.requestId);
    case 'SET_VOLUME':
      setVolume(p.volume);
      return sendReceiverStatus(c, msg.source, p.requestId);
    default:
      console.log(`UNMAPPED receiver ${p.type}`);
      return send(c, 'receiver-0', msg.source, RECEIVER, { type: 'INVALID_REQUEST', requestId: p.requestId, reason: 'INVALID_COMMAND' });
  }
}

function setVolume(v = {}) {
  if (typeof v.level === 'number' && v.level >= 0 && v.level <= 1) dev.volume.level = v.level;
  else if ('level' in v) console.log(`NOTE volume.level ${v.level} outside 0-1 ignored`);
  if (typeof v.muted === 'boolean') dev.volume.muted = v.muted;
}

// fetch=false: the Jellyfin receiver plays an item id and fetches its stream from serverAddress itself (not mocked).
async function load(media, { currentTime: start = 0, autoplay = true, activeTrackIds = [], customData, queue, fetch = true } = {}) {
  const tracks = Array.isArray(media.tracks) ? media.tracks : [];
  const image = media.metadata?.images?.[0]?.url;
  const probes = fetch ? [media.contentId, ...tracks.map((t) => t.trackContentId), image].filter(Boolean) : [];
  const results = [];
  for (const url of probes) {
    const res = await probe(url, { open: OPEN, headers: { Origin: ORIGIN } });
    const entry = { url, status: res.status, type: res.type, cors: Boolean(res.cors), allowOrigin: res.cors, tokenInUrl: res.tokenInUrl, bytes: res.bytes, error: res.error, kind: url === media.contentId ? 'content' : url === image ? 'image' : 'track' };
    fetched.push(entry);
    results.push(entry);
    console.log(`FETCH ${entry.kind} ${res.status} ${res.type ?? '-'} cors=${res.cors ?? 'none'} tokenInUrl=${res.tokenInUrl}${res.error ? ` (${res.error})${res.error.includes('refused') ? ' REFUSED' : ''}` : ''}`);
  }
  const content = results[0];
  const ok = (!content || (content.status >= 200 && content.status < 300)) && !(AUDIO_ONLY && !/^audio\//i.test(media.contentType ?? ''));
  dev.media = {
    mediaSessionId: nextMediaSession++,
    contentId: media.contentId,
    contentType: media.contentType,
    streamType: media.streamType ?? 'BUFFERED',
    duration: typeof media.duration === 'number' ? media.duration : DURATION,
    tracks,
    customData,
    queue,
    activeTrackIds,
    pos: Number(start) || 0,
    since: Date.now(),
    playerState: ok ? (autoplay === false ? 'PAUSED' : 'PLAYING') : 'IDLE',
    idleReason: ok ? undefined : 'ERROR',
  };
  return ok;
}

async function onMedia(c, msg, p) {
  const m = dev.media;
  const checkSession = () => {
    if (m && p.mediaSessionId === m.mediaSessionId) return true;
    console.log(`INVALID ${p.type}: mediaSessionId ${p.mediaSessionId} (current ${m?.mediaSessionId ?? 'none'})`);
    send(c, dev.app.transportId, msg.source, MEDIA, { type: 'INVALID_REQUEST', requestId: p.requestId, reason: 'INVALID_MEDIA_SESSION_ID' });
    return false;
  };
  switch (p.type) {
    case 'LOAD': {
      if (!p.media?.contentId) {
        console.log('INVALID LOAD without media.contentId');
        return send(c, dev.app.transportId, msg.source, MEDIA, { type: 'INVALID_REQUEST', requestId: p.requestId, reason: 'INVALID_PARAMS' });
      }
      if (p.media.hlsVideoSegmentFormat) console.log(`NOTE hlsVideoSegmentFormat=${p.media.hlsVideoSegmentFormat}`);
      if (AUDIO_ONLY && !/^audio\//i.test(p.media.contentType ?? '')) console.log(`NO-VIDEO-OUT LOAD of ${p.media.contentType} on a speaker`);
      const ok = await load(p.media, { currentTime: p.currentTime, autoplay: p.autoplay, activeTrackIds: p.activeTrackIds, customData: p.customData });
      if (!ok) send(c, dev.app.transportId, msg.source, MEDIA, { type: 'LOAD_FAILED', requestId: p.requestId });
      return replyMedia(c, msg.source, p.requestId);
    }
    case 'GET_STATUS':
      return send(c, dev.app.transportId, msg.source, MEDIA, { type: 'MEDIA_STATUS', requestId: p.requestId, status: mediaStatus() });
    case 'PLAY':
      if (!checkSession()) return;
      if (m.playerState === 'PAUSED') setPlayer('PLAYING');
      return replyMedia(c, msg.source, p.requestId);
    case 'PAUSE':
      if (!checkSession()) return;
      if (m.playerState === 'PLAYING') setPlayer('PAUSED');
      return replyMedia(c, msg.source, p.requestId);
    case 'SEEK':
      if (!checkSession()) return;
      setPlayer(p.resumeState === 'PLAYBACK_PAUSE' ? 'PAUSED' : p.resumeState === 'PLAYBACK_START' ? 'PLAYING' : m.playerState);
      if (typeof p.currentTime === 'number') m.pos = Math.max(0, Math.min(m.duration, p.currentTime));
      else if (typeof p.relativeTime === 'number') m.pos = Math.max(0, Math.min(m.duration, m.pos + p.relativeTime));
      return replyMedia(c, msg.source, p.requestId);
    case 'STOP':
      if (!checkSession()) return;
      setPlayer('IDLE', 'CANCELLED');
      replyMedia(c, msg.source, p.requestId);
      dev.media = null;
      return;
    case 'EDIT_TRACKS_INFO':
      if (!checkSession()) return;
      if (Array.isArray(p.activeTrackIds)) m.activeTrackIds = p.activeTrackIds;
      return replyMedia(c, msg.source, p.requestId);
    case 'SET_VOLUME':
      if (!checkSession()) return;
      setVolume(p.volume);
      return replyMedia(c, msg.source, p.requestId);
    default:
      console.log(`UNMAPPED media ${p.type}`);
      return send(c, dev.app.transportId, msg.source, MEDIA, { type: 'INVALID_REQUEST', requestId: p.requestId, reason: 'INVALID_COMMAND' });
  }
}

// The Jellyfin receiver (jellyfin-chromecast maincontroller.ts): it needs command, serverAddress and accessToken.
async function onConnectSdk(c, msg, p) {
  const missing = ['command', 'serverAddress', 'accessToken'].filter((k) => p[k] === undefined || p[k] === null || p[k] === '');
  connectsdk.push({ at: Date.now(), ...p, ok: missing.length === 0, ...(missing.length ? { missing } : {}) });
  if (missing.length) return console.log(`CONNECTSDK-INVALID ${p.command ?? '(no command)'}: missing ${missing.join(', ')}`);
  console.log(`CONNECTSDK ${p.command} serverAddress=${p.serverAddress}${p.options?.index !== undefined ? ` index=${JSON.stringify(p.options.index)}` : ''}`);
  const o = p.options ?? {};
  switch (p.command) {
    case 'PlayNow':
    case 'PlayLast':
    case 'PlayNext': {
      const items = Array.isArray(o.items) ? o.items : [];
      const index = Math.max(0, Math.min(items.length - 1, Number(o.startIndex) || 0));
      if (!items.length) return console.log(`CONNECTSDK-INVALID ${p.command}: no options.items`);
      await load({ contentId: items[index].Id, contentType: 'video/mp4', streamType: 'BUFFERED' }, { currentTime: (Number(o.startPositionTicks) || 0) / 1e7, queue: { items, index }, fetch: false });
      return broadcastMedia();
    }
    case 'NextTrack':
    case 'PreviousTrack': {
      const q = dev.media?.queue;
      if (!q) return;
      const index = q.index + (p.command === 'NextTrack' ? 1 : -1);
      if (index < 0 || index >= q.items.length) return console.log(`NOTE ${p.command} at the end of the queue`);
      await load({ contentId: q.items[index].Id, contentType: 'video/mp4' }, { queue: { items: q.items, index }, fetch: false });
      return broadcastMedia();
    }
    default:
      return undefined; // recorded only (SetAudioStreamIndex, SetSubtitleStreamIndex, …)
  }
}

async function onMessage(c, msg) {
  let p;
  try {
    p = JSON.parse(msg.data);
  } catch {
    return console.log(`BAD-JSON ${msg.namespace} from ${msg.source}`);
  }
  calls.push({ at: Date.now(), from: msg.source, to: msg.destination, namespace: msg.namespace, type: p.type ?? p.command, data: p });
  if (msg.namespace !== HEARTBEAT) console.log(`<- ${msg.source} -> ${msg.destination} ${msg.namespace.replace(NS, '')} ${p.type ?? p.command ?? ''}`);
  tick();
  if (msg.namespace === CONNECTION) {
    if (p.type === 'CONNECT') c.virtual.add(msg.destination);
    else if (p.type === 'CLOSE') c.virtual.delete(msg.destination);
    return;
  }
  if (msg.namespace === HEARTBEAT) {
    if (p.type === 'PING') {
      c.lastPing = Date.now();
      send(c, msg.destination, msg.source, HEARTBEAT, { type: 'PONG' });
    }
    return;
  }
  if (!c.virtual.has(msg.destination)) return console.log(`NO-CONNECT ${msg.namespace} to ${msg.destination} without a CONNECT (ignored, as a device would)`);
  if (msg.destination === 'receiver-0' && msg.namespace === RECEIVER) return onReceiver(c, msg, p);
  if (!dev.app || msg.destination !== dev.app.transportId) return console.log(`UNMAPPED ${msg.namespace} to ${msg.destination} (no such app)`);
  if (msg.namespace === MEDIA) return onMedia(c, msg, p);
  if (msg.namespace === CONNECTSDK && JELLYFIN_APPS.has(dev.app.appId)) return onConnectSdk(c, msg, p);
  console.log(`UNMAPPED ${msg.namespace} for app ${dev.app.appId}`);
}

const fx = path.join(here, 'fixtures/cast-tls');
tls
  .createServer({ key: fs.readFileSync(path.join(fx, 'key.pem')), cert: fs.readFileSync(path.join(fx, 'cert.pem')) }, (socket) => {
    const c = { socket, virtual: new Set(), lastPing: Date.now(), peer: `${socket.remoteAddress}:${socket.remotePort}` };
    conns.add(c);
    console.log(`TLS connection from ${c.peer}`);
    // Messages are handled one at a time, in order (LOAD awaits its fetches).
    let chain = Promise.resolve();
    const read = frameReader((msg) => {
      chain = chain.then(() => onMessage(c, msg)).catch((e) => console.log(`ERROR ${e.stack ?? e}`));
    });
    socket.on('data', (chunk) => {
      try {
        read(chunk);
      } catch (e) {
        console.log(`BAD-FRAME from ${c.peer}: ${e.message} (connection closed)`);
        socket.destroy();
      }
    });
    const hb = setInterval(() => {
      if (Date.now() - c.lastPing < HEARTBEAT_MS) return;
      console.log(`HEARTBEAT-LOST no PING from ${c.peer} for ${HEARTBEAT_MS / 1000} s (connection closed)`);
      socket.destroy();
    }, 250);
    socket.on('error', () => {});
    socket.on('close', () => {
      clearInterval(hb);
      conns.delete(c);
      console.log(`TLS closed ${c.peer}`);
    });
  })
  .on('tlsClientError', (e) => console.log(`TLS handshake failed: ${e.message}`))
  .listen(PORT, HOST, () => {
    http
      .createServer((req, res) => {
        const p = new URL(req.url, 'http://mock').pathname;
        const json = (status, body) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(body === undefined ? '' : JSON.stringify(body));
        };
        tick();
        if (p === '/Mock/State') return json(200, { connections: [...conns].map((c) => ({ peer: c.peer, virtual: [...c.virtual] })), app: dev.app, volume: dev.volume, media: mediaStatus()[0] ?? null, calls, fetched, connectsdk });
        if (req.method === 'POST' && p === '/Mock/End') {
          if (dev.media) {
            setPlayer('IDLE', 'FINISHED');
            broadcastMedia();
          }
          console.log('MOCK end of media');
          return json(204);
        }
        console.log(`UNMAPPED state ${req.method} ${p}`);
        return json(404, { error: 'not found' });
      })
      .listen(STATE_PORT, HOST, () => console.log(`Mock Cast ${AUDIO_ONLY ? 'speaker' : 'device'} on tls://${HOST}:${PORT} (state http://${HOST}:${STATE_PORT}/Mock/State)`));
  });
