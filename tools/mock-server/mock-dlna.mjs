// Mock DLNA/UPnP MediaRenderer (cast spec CA-06), so the DLNA senders (CA-07 desktop, CA-08 mobile) run with no TV.
//   node tools/mock-server/mock-dlna.mjs [port]          (default MOCK_DLNA_PORT or 8970, on MOCK_DLNA_HOST or 127.0.0.1)
//
// MOCK_DLNA_PROFILE=generic|sony|samsung (default generic) picks the device description and the GetProtocolInfo Sink,
// both served from tools/checks/fixtures/cast/ (the files the desktop and Android parser tests read):
// - generic: URLBase set, relative controlURLs; takes anything.
// - sony: no URLBase; SetAVTransportURI answers 701 while PLAYING (no Stop first) and 714 with empty CurrentURIMetaData.
// - samsung: no URLBase; 716 when the first <res> protocolInfo has no DLNA.ORG flags, and 714 when the DIDL carries
//   subtitles without sec:CaptionInfoEx right after the first </res>. [UNVERIFIED] both model the reported Samsung
//   quirks (cast spec §7), not a captured device.
// MOCK_DURATION_S (default 600) is the TrackDuration; RelTime advances in real time while PLAYING and the media ends
// (STOPPED) at that length.
//
// Routes: GET /desc.xml; SOAP POST /ctl/avt (SetAVTransportURI, SetNextAVTransportURI, Play, Pause, Stop, Seek,
// GetPositionInfo, GetTransportInfo, GetMediaInfo), /ctl/rc (GetVolume, SetVolume 0-100 else 501, GetMute, SetMute),
// /ctl/cm (GetProtocolInfo). Mock-only: POST /Mock/End (end of media), GET /Mock/State
// {calls[], uri, meta, fetched:{status, type, tokenInUrl}, state, relTime, volume, …}.
// Play first GETs the first 64 KB of the URI (tools/mock-server/probe.mjs): loopback URLs only, unless MOCK_DLNA_HOST
// is set by hand. A failed fetch leaves the renderer STOPPED, as a TV that cannot open the stream.
// MOCK_SSDP=1 also answers M-SEARCH on 239.255.255.250:1900 (best effort: the Windows SSDP service holds 1900; the
// checks use the senders' dev seed instead). Replies go to loopback senders only, unless MOCK_DLNA_HOST is set.
//
// Every call is logged; quirks a real renderer would trip on are tagged (FAULT, UNQUOTED-SOAPACTION, TOKEN-HEADER,
// REFUSED, UNMAPPED), so a run's log reads as a bug list.
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { probe } from './probe.mjs';

const OPEN = Boolean(process.env.MOCK_DLNA_HOST);
const HOST = process.env.MOCK_DLNA_HOST || '127.0.0.1';
const PORT = Number(process.argv[2] ?? process.env.MOCK_DLNA_PORT ?? 8970);
const PROFILE = process.env.MOCK_DLNA_PROFILE || 'generic';
const DURATION = Number(process.env.MOCK_DURATION_S || 600);
if (!['generic', 'sony', 'samsung'].includes(PROFILE)) throw new Error(`MOCK_DLNA_PROFILE=${PROFILE}: generic, sony or samsung`);

const FX = path.resolve(import.meta.dirname, '../checks/fixtures/cast');
const BASE = `http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`;
const DESC = fs.readFileSync(path.join(FX, `dlna-desc-${PROFILE}.xml`), 'utf8').replace('http://127.0.0.1:8970/', `${BASE}/`);
const PROTOCOL_INFO = fs.readFileSync(path.join(FX, `dlna-protocolinfo-${PROFILE}.xml`), 'utf8');
const NAME = /<friendlyName>([^<]*)</.exec(DESC)[1];
const UDN = /<UDN>([^<]*)</.exec(DESC)[1];

const SERVICES = { avt: 'AVTransport', rc: 'RenderingControl', cm: 'ConnectionManager' };
const ENV_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>';
const ENV_TAIL = '</s:Body></s:Envelope>\n';
// UPnP error descriptions (UPnP Device Architecture and AVTransport:1).
const ERRORS = { 401: 'Invalid Action', 402: 'Invalid Args', 501: 'Action Failed', 701: 'Transition not available', 710: 'Seek mode not supported', 711: 'Illegal seek target', 714: 'Illegal MIME-type', 716: 'Resource not found', 718: 'Invalid InstanceID' };

const xmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const xmlUnescape = (s) =>
  s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (m, n, d, h) => (d ? String.fromCodePoint(Number(d)) : h ? String.fromCodePoint(parseInt(h, 16)) : { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[n.toLowerCase()]));
const hms = (s) => {
  const t = Math.max(0, Math.floor(s));
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const parseHms = (s) => {
  const m = /^(\d+):([0-5]\d):([0-5]\d)(\.\d+)?$/.exec(String(s).trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4] ?? 0) : null;
};

// ---- Renderer state ----
const r = { state: 'NO_MEDIA_PRESENT', status: 'OK', uri: '', meta: '', nextUri: '', nextMeta: '', pos: 0, since: 0, volume: 20, muted: false, fetched: null };
const calls = [];
let tokenHeaders = 0;

const relTime = () => Math.min(DURATION, r.pos + (r.state === 'PLAYING' ? (Date.now() - r.since) / 1000 : 0));
function setState(state) {
  r.pos = relTime();
  r.since = Date.now();
  r.state = state;
}
// The media ends by itself at MOCK_DURATION_S (evaluated on every request, no timer).
function tick() {
  if (r.state === 'PLAYING' && relTime() >= DURATION) {
    setState('STOPPED');
    console.log(`END media reached ${hms(DURATION)}: STOPPED`);
  }
}

class UpnpError extends Error {
  constructor(code, why) {
    super(why ?? ERRORS[code]);
    this.code = code;
  }
}

function needMedia() {
  if (!r.uri) throw new UpnpError(701, 'no media (SetAVTransportURI first)');
}

const firstResInfo = (didl) => /<res\b[^>]*\bprotocolInfo="([^"]*)"/.exec(didl)?.[1] ?? '';
const hasSubtitles = (didl) => /pv:subtitleFileUri|sec:CaptionInfo|text\/srt|smi\/caption/i.test(didl);

const actions = {
  avt: {
    async SetAVTransportURI(a) {
      const uri = a.CurrentURI ?? '';
      const meta = a.CurrentURIMetaData ?? '';
      if (!uri) throw new UpnpError(402, 'CurrentURI is empty');
      if (PROFILE === 'sony' && r.state === 'PLAYING') throw new UpnpError(701, 'sony: SetAVTransportURI while PLAYING, send Stop first');
      if (PROFILE === 'sony' && !meta.trim()) throw new UpnpError(714, 'sony: CurrentURIMetaData is empty');
      if (PROFILE === 'samsung') {
        if (!/DLNA\.ORG_/.test(firstResInfo(meta))) throw new UpnpError(716, 'samsung: <res> protocolInfo has no DLNA.ORG flags');
        const end = meta.indexOf('</res>');
        if (hasSubtitles(meta) && !(end >= 0 && /^\s*<sec:CaptionInfoEx\b/.test(meta.slice(end + 6)))) throw new UpnpError(714, 'samsung: sec:CaptionInfoEx must come right after the first </res>');
      }
      Object.assign(r, { uri, meta, fetched: null, pos: 0, since: Date.now(), state: 'STOPPED', status: 'OK' });
      return {};
    },
    SetNextAVTransportURI(a) {
      r.nextUri = a.NextURI ?? '';
      r.nextMeta = a.NextURIMetaData ?? '';
      return {};
    },
    async Play(a) {
      needMedia();
      if (r.state === 'PAUSED_PLAYBACK') {
        setState('PLAYING');
        return {};
      }
      if (r.state === 'PLAYING') return {};
      if (a.Speed && a.Speed !== '1') console.log(`NOTE Play Speed=${a.Speed} (renderers expect 1)`);
      setState('TRANSITIONING');
      r.fetched = await probe(r.uri, { open: OPEN });
      const ok = r.fetched.status >= 200 && r.fetched.status < 300;
      console.log(`${ok ? 'FETCH' : 'FETCH-FAILED'} ${r.fetched.status} ${r.fetched.type ?? '-'} ${r.fetched.bytes} B tokenInUrl=${r.fetched.tokenInUrl}${r.fetched.error ? ` (${r.fetched.error})` : ''}${r.fetched.error?.includes('refused') ? ' REFUSED' : ''}`);
      r.pos = r.pos >= DURATION ? 0 : r.pos;
      if (ok) setState('PLAYING');
      else {
        setState('STOPPED');
        r.status = 'ERROR_OCCURRED';
      }
      return {};
    },
    Pause() {
      if (r.state !== 'PLAYING') throw new UpnpError(701, `Pause in ${r.state}`);
      setState('PAUSED_PLAYBACK');
      return {};
    },
    Stop() {
      if (r.uri) setState('STOPPED');
      r.pos = 0;
      return {};
    },
    Seek(a) {
      needMedia();
      if (a.Unit !== 'REL_TIME' && a.Unit !== 'ABS_TIME') throw new UpnpError(710, `Unit ${a.Unit}`);
      const t = parseHms(a.Target);
      if (t === null || t > DURATION) throw new UpnpError(711, `Target ${a.Target}`);
      r.pos = t;
      r.since = Date.now();
      return {};
    },
    GetPositionInfo() {
      return {
        Track: r.uri ? 1 : 0,
        TrackDuration: r.uri ? hms(DURATION) : '00:00:00',
        TrackMetaData: r.meta,
        TrackURI: r.uri,
        RelTime: hms(relTime()),
        AbsTime: hms(relTime()),
        RelCount: 2147483647,
        AbsCount: 2147483647,
      };
    },
    GetTransportInfo() {
      return { CurrentTransportState: r.state, CurrentTransportStatus: r.status, CurrentSpeed: 1 };
    },
    GetMediaInfo() {
      return { NrTracks: r.uri ? 1 : 0, MediaDuration: hms(DURATION), CurrentURI: r.uri, CurrentURIMetaData: r.meta, NextURI: r.nextUri, NextURIMetaData: r.nextMeta, PlayMedium: 'NETWORK', RecordMedium: 'NOT_IMPLEMENTED', WriteStatus: 'NOT_IMPLEMENTED' };
    },
  },
  rc: {
    GetVolume() {
      return { CurrentVolume: r.volume };
    },
    SetVolume(a) {
      const v = Number(a.DesiredVolume);
      if (!/^\d+$/.test(String(a.DesiredVolume ?? '').trim()) || v > 100) throw new UpnpError(501, `DesiredVolume ${a.DesiredVolume} outside 0-100`);
      r.volume = v;
      return {};
    },
    GetMute() {
      return { CurrentMute: r.muted ? 1 : 0 };
    },
    SetMute(a) {
      if (!/^(0|1|true|false)$/i.test(String(a.DesiredMute ?? ''))) throw new UpnpError(402, `DesiredMute ${a.DesiredMute}`);
      r.muted = /^(1|true)$/i.test(a.DesiredMute);
      return {};
    },
  },
  cm: {
    GetProtocolInfo() {
      return null; // the recorded reply is served as is
    },
  },
};

// ---- SOAP ----
function soapArgs(xml) {
  const body = /<(?:\w+:)?Body\b[^>]*>([\s\S]*)<\/(?:\w+:)?Body>/.exec(xml)?.[1] ?? '';
  const m = /<(?:(\w+):)?(\w+)\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\1:)?\2>)/.exec(body);
  if (!m) return null;
  const args = {};
  for (const a of (m[3] ?? '').matchAll(/<(\w+)\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1>)/g)) args[a[1]] = xmlUnescape(a[2] ?? '');
  return { action: m[2], args };
}

const soapReply = (svc, action, out) =>
  `${ENV_HEAD}<u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${SERVICES[svc]}:1">${Object.entries(out)
    .map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`)
    .join('')}</u:${action}Response>${ENV_TAIL}`;
const soapFault = (code) =>
  `${ENV_HEAD}<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${ERRORS[code]}</errorDescription></UPnPError></detail></s:Fault>${ENV_TAIL}`;

async function readBody(req, cap) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > cap) throw new Error(`body over ${cap} bytes`);
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res, status, body, type = 'text/xml; charset="utf-8"') {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), Server: `Wicaby-mock UPnP/1.0 DLNADOC/1.50 ${PROFILE}` });
  res.end(body);
}

async function soap(req, res, svc) {
  const head = String(req.headers.soapaction ?? '');
  if (head && !/^".*"$/.test(head)) console.log(`UNQUOTED-SOAPACTION ${head} (Sony and others reject it)`);
  const [, ns, headAction] = /^"?([^#"]*)#([^"]*)"?$/.exec(head) ?? [];
  let parsed;
  try {
    parsed = soapArgs(await readBody(req, 256 * 1024));
  } catch (e) {
    console.log(`REJECTED ${svc}: ${e.message}`);
    return send(res, 413, '');
  }
  const action = parsed?.action ?? headAction ?? '?';
  const call = { at: Date.now(), service: svc, action, args: parsed?.args ?? {}, status: 200 };
  if (req.headers.authorization || req.headers['x-emby-token'] || req.headers['x-emby-authorization']) {
    tokenHeaders++;
    call.tokenHeader = true;
    console.log(`TOKEN-HEADER ${svc}#${action}: the renderer received an auth header (it must never see the server token)`);
  }
  calls.push(call);
  tick();
  try {
    if (ns !== `urn:schemas-upnp-org:service:${SERVICES[svc]}:1` || headAction !== action) throw new UpnpError(401, `SOAPACTION ${head || '(none)'} does not match ${SERVICES[svc]}#${action}`);
    const fn = actions[svc][action];
    if (!fn) throw new UpnpError(401, `unknown action ${action}`);
    if ('InstanceID' in call.args ? call.args.InstanceID !== '0' : svc !== 'cm') throw new UpnpError(718, `InstanceID ${call.args.InstanceID ?? '(missing)'}`);
    const out = await fn(call.args);
    console.log(`${SERVICES[svc]}#${action} ${summary(call.args)} -> 200 ${r.state}`);
    return send(res, 200, out === null ? PROTOCOL_INFO : soapReply(svc, action, out));
  } catch (e) {
    if (!(e instanceof UpnpError)) throw e;
    call.status = 500;
    call.error = e.code;
    console.log(`FAULT ${e.code} ${SERVICES[svc]}#${action}: ${e.message}`);
    return send(res, 500, soapFault(e.code));
  }
}
const summary = (a) =>
  Object.entries(a)
    .filter(([k]) => k !== 'InstanceID')
    .map(([k, v]) => `${k}=${k.endsWith('MetaData') ? `(${v.length} chars)` : v}`)
    .join(' ');

const state = () => ({ profile: PROFILE, name: NAME, udn: UDN, calls, uri: r.uri, meta: r.meta, nextUri: r.nextUri, fetched: r.fetched, state: r.state, status: r.status, relTime: Math.round(relTime() * 10) / 10, duration: DURATION, volume: r.volume, muted: r.muted, tokenHeaders });

http
  .createServer(async (req, res) => {
    const p = new URL(req.url, BASE).pathname;
    try {
      if (req.method === 'GET' && p === '/desc.xml') {
        console.log('GET /desc.xml');
        return send(res, 200, DESC);
      }
      const svc = /^\/ctl\/(avt|rc|cm)$/.exec(p)?.[1];
      if (req.method === 'POST' && svc) return await soap(req, res, svc);
      if (p === '/Mock/State') {
        tick();
        return send(res, 200, JSON.stringify(state()), 'application/json');
      }
      if (req.method === 'POST' && p === '/Mock/End') {
        if (r.uri) {
          setState('STOPPED');
          r.pos = DURATION;
        }
        console.log(`MOCK end of media: ${r.state}`);
        return send(res, 204, '');
      }
      console.log(`UNMAPPED ${req.method} ${p}`);
      return send(res, 404, '');
    } catch (e) {
      console.log(`ERROR ${req.method} ${p}: ${e.stack ?? e}`);
      if (!res.headersSent) send(res, 500, '');
    }
  })
  .listen(PORT, HOST, () => console.log(`Mock DLNA renderer "${NAME}" (${PROFILE}) on ${BASE}/desc.xml`));

// ---- SSDP (best effort) ----
if (process.env.MOCK_SSDP === '1') {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', (e) => console.log(`SSDP unavailable: ${e.message}`));
  sock.on('message', (msg, from) => {
    const text = msg.toString('latin1');
    if (!/^M-SEARCH \* HTTP\/1\.1/i.test(text)) return;
    const st = /^ST:\s*(.+?)\s*$/im.exec(text)?.[1] ?? '';
    if (!['ssdp:all', 'upnp:rootdevice', 'urn:schemas-upnp-org:device:MediaRenderer:1', UDN].includes(st)) return;
    if (!OPEN && !/^127\./.test(from.address)) return console.log(`SSDP M-SEARCH from ${from.address} ignored (loopback only)`);
    const usn = st === UDN ? UDN : `${UDN}::${st === 'ssdp:all' ? 'urn:schemas-upnp-org:device:MediaRenderer:1' : st}`;
    const reply = `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\nLOCATION: ${BASE}/desc.xml\r\nSERVER: Wicaby-mock UPnP/1.0\r\nST: ${st === 'ssdp:all' ? 'urn:schemas-upnp-org:device:MediaRenderer:1' : st}\r\nUSN: ${usn}\r\n\r\n`;
    sock.send(reply, from.port, from.address);
    console.log(`SSDP M-SEARCH ${st} from ${from.address}:${from.port} -> LOCATION ${BASE}/desc.xml`);
  });
  sock.bind(1900, () => {
    try {
      sock.addMembership('239.255.255.250', OPEN ? undefined : '127.0.0.1');
      console.log('SSDP listening on 239.255.255.250:1900');
    } catch (e) {
      console.log(`SSDP membership failed: ${e.message}`);
    }
  });
}
