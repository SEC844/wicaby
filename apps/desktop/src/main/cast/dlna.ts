// DLNA/UPnP MediaRenderer control (cast-spec CA-07): the device description, SOAP actions, DIDL-Lite and the load
// sequence with the known renderer quirks (701, 714, 716). XML is read with regexes, never a DTD-aware parser (no
// XXE, no entity expansion). Nothing here ever sends a server token: the URLs it is given are relay or token URLs,
// and requests to the renderer carry no auth header.
import { net } from 'electron';

export interface DlnaDevice {
  location: string;
  // The renderer's IP (the LOCATION host): the relay serves it and nobody else.
  ip: string;
  udn: string;
  name: string;
  model: string;
  avt: string;
  rc?: string;
  cm?: string;
  // An audio renderer (Sonos, HEOS, an AV receiver…), by its maker and model: the picker's speaker icon, no videos.
  speaker?: boolean;
}

// shortcut: makers and words of audio-only renderers; read the Sink (no video MIME) at discovery if one is missed.
const SPEAKER = /sonos|heos|denon|marantz|bose|soundtouch|musiccast|yamaha|onkyo|pioneer|wiim|bluesound|linkplay|naim|audio|speaker|soundbar|receiver|\bavr\b/i;

export class UpnpError extends Error {
  constructor(readonly code: number) {
    super(`UPnP error ${code}`);
  }
}

export const xmlEscape = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const xmlUnescape = (s: string): string =>
  s.replace(/&(lt|gt|quot|apos|amp|#(\d{1,7})|#x([0-9a-f]{1,6}));/gi, (_m, n: string, d?: string, h?: string) => {
    const code = d ? Number(d) : h ? parseInt(h, 16) : -1;
    if (code >= 0) return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    return { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[n.toLowerCase()]!;
  });

// The text of the first <name> element (any namespace prefix), unescaped.
const tag = (xml: string, name: string): string | undefined => {
  const v = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([^<]*)</(?:[\\w-]+:)?${name}>`, 'i').exec(xml)?.[1];
  return v === undefined ? undefined : xmlUnescape(v).trim();
};

// Reads at most `cap` bytes; more is an error, not a truncation.
async function capped(res: Response, cap: number): Promise<string> {
  if (Number(res.headers.get('content-length') ?? 0) > cap) {
    void res.body?.cancel();
    throw new Error(`reply over ${cap} bytes`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > cap) throw new Error(`reply over ${cap} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function get(url: string, init: RequestInit, timeoutMs: number, cap: number): Promise<{ status: number; text: string }> {
  const res = await net.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, text: await capped(res, cap) };
}

// The renderer from its description. controlURLs resolve against URLBase, or LOCATION without one, and must stay
// on LOCATION's host and port (a forged description cannot aim SOAP elsewhere). Null without an AVTransport.
export function parseDescription(xml: string, location: string): DlnaDevice | null {
  const loc = new URL(location);
  const base = tag(xml, 'URLBase') || location;
  const services = [...xml.matchAll(/<(?:[\w-]+:)?service\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?service>/gi)].map((m) => m[1]);
  const control = (type: string): string | undefined => {
    const s = services.find((x) => new RegExp(`:service:${type}:\\d`, 'i').test(tag(x, 'serviceType') ?? ''));
    const rel = s && tag(s, 'controlURL');
    if (rel === undefined) return undefined;
    try {
      const u = new URL(rel, new URL(base, location));
      return u.protocol === 'http:' && u.host === loc.host && !u.username && !u.password ? u.href : undefined;
    } catch {
      return undefined;
    }
  };
  const avt = control('AVTransport');
  const udn = (tag(xml, 'UDN') ?? '').replace(/^uuid:/i, '');
  if (!avt || !/^[\w.:-]{1,128}$/.test(udn)) return null;
  const speaker = SPEAKER.test(`${tag(xml, 'manufacturer') ?? ''} ${tag(xml, 'modelName') ?? ''}`);
  return {
    location: loc.href,
    ip: loc.hostname.replace(/^\[|\]$/g, ''),
    udn,
    name: (tag(xml, 'friendlyName') || udn).slice(0, 100),
    model: (tag(xml, 'modelName') ?? '').slice(0, 100),
    avt,
    rc: control('RenderingControl'),
    cm: control('ConnectionManager'),
    ...(speaker ? { speaker } : {}),
  };
}

// 64 KB, 3 s, no redirect.
export async function fetchDescription(location: string): Promise<DlnaDevice | null> {
  const r = await get(location, {}, 3000, 64 * 1024);
  return r.status === 200 ? parseDescription(r.text, location) : null;
}

const SERVICE = { avt: 'AVTransport', rc: 'RenderingControl', cm: 'ConnectionManager' } as const;

export function soapEnvelope(service: string, action: string, args: Record<string, string | number>): string {
  const body = Object.entries(args)
    .map(([k, v]) => `<${k}>${xmlEscape(String(v))}</${k}>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">${body}</u:${action}></s:Body></s:Envelope>`;
}

// The out arguments of a SOAP reply, or the UPnPError of a fault.
export function parseSoapReply(status: number, xml: string): Record<string, string> {
  if (status !== 200) {
    const code = Number(tag(xml, 'errorCode'));
    throw Number.isInteger(code) && code > 0 ? new UpnpError(code) : new Error(`SOAP HTTP ${status}`);
  }
  const inner = /<(?:[\w-]+:)?\w+Response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?\w+Response>/i.exec(xml)?.[1] ?? '';
  return Object.fromEntries([...inner.matchAll(/<(\w+)\b[^>]*?(?:\/>|>([^<]*)<\/\1>)/g)].map((m) => [m[1], xmlUnescape(m[2] ?? '')]));
}

// A quoted SOAPACTION (Sony rejects it unquoted), InstanceID first, 5 s, 16 KB.
export async function soap(dev: DlnaDevice, svc: keyof typeof SERVICE, action: string, args: Record<string, string | number> = {}): Promise<Record<string, string>> {
  const url = dev[svc];
  if (!url) throw new UpnpError(401);
  const service = SERVICE[svc];
  const r = await get(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"urn:schemas-upnp-org:service:${service}:1#${action}"`, Pragma: 'no-cache' },
      body: soapEnvelope(service, action, svc === 'cm' ? args : { InstanceID: 0, ...args }),
    },
    5000,
    16 * 1024,
  );
  return parseSoapReply(r.status, r.text);
}

export const hms = (sec: number): string => {
  const t = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

// "h:mm:ss[.fff]" → seconds; NaN for NOT_IMPLEMENTED and the like.
export const parseHms = (s: string | undefined): number => {
  const m = /^(\d+):([0-5]?\d):([0-5]?\d)(\.\d+)?$/.exec((s ?? '').trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4] ?? 0) : NaN;
};

export const DLNA_FLAGS = {
  direct: 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
  transcode: 'DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000',
};

export interface DidlInput {
  title: string;
  audio: boolean;
  url: string;
  mime: string;
  durationSec?: number;
  // The fourth protocolInfo field: '*' first, the DLNA.ORG flags on a retry.
  flags?: string;
  // A text subtitle the renderer fetches itself (srt).
  subtitleUrl?: string;
  // A song: who, which album, its number there and the cover URL (relay or LAN), shown by the renderer and its app.
  artist?: string;
  album?: string;
  track?: number;
  artUrl?: string;
}

// One item. A subtitle goes three ways at once (all harmless together): sec:CaptionInfoEx right after the first
// <res> (Samsung), a text/srt <res>, and pv:subtitleFileUri. Every value is XML-escaped here; soap() escapes the
// whole document again as CurrentURIMetaData.
export function didl(d: DidlInput): string {
  const e = xmlEscape;
  const dur = d.durationSec && d.durationSec > 0 ? ` duration="${hms(d.durationSec).replace(/^0(\d)/, '$1')}.000"` : '';
  const sub = d.subtitleUrl;
  const pv = sub ? ` pv:subtitleFileUri="${e(sub)}" pv:subtitleFileType="srt"` : '';
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:sec="http://www.sec.co.kr/" xmlns:pv="http://www.pv.com/pvns/">' +
    `<item id="0" parentID="-1" restricted="1"><dc:title>${e(d.title)}</dc:title><upnp:class>${d.audio ? 'object.item.audioItem.musicTrack' : 'object.item.videoItem'}</upnp:class>` +
    (d.artist ? `<upnp:artist>${e(d.artist)}</upnp:artist><dc:creator>${e(d.artist)}</dc:creator>` : '') +
    (d.album ? `<upnp:album>${e(d.album)}</upnp:album>` : '') +
    (d.track ? `<upnp:originalTrackNumber>${d.track}</upnp:originalTrackNumber>` : '') +
    (d.artUrl ? `<upnp:albumArtURI xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/" dlna:profileID="JPEG_TN">${e(d.artUrl)}</upnp:albumArtURI>` : '') +
    `<res protocolInfo="http-get:*:${e(d.mime)}:${e(d.flags ?? '*')}"${dur}${pv}>${e(d.url)}</res>` +
    (sub ? `<sec:CaptionInfoEx sec:type="srt">${e(sub)}</sec:CaptionInfoEx><res protocolInfo="http-get:*:text/srt:*">${e(sub)}</res>` : '') +
    '</item></DIDL-Lite>'
  );
}

// GetTransportInfo, Stop if PLAYING, SetAVTransportURI, Play(1). 714/716: once more with the DLNA.ORG flags;
// 701: Stop, then once more.
export async function load(dev: DlnaDevice, d: DidlInput, transcode: boolean): Promise<void> {
  const state = (await soap(dev, 'avt', 'GetTransportInfo')).CurrentTransportState;
  if (state === 'PLAYING') await soap(dev, 'avt', 'Stop');
  const set = (x: DidlInput) => soap(dev, 'avt', 'SetAVTransportURI', { CurrentURI: x.url, CurrentURIMetaData: didl(x) });
  let flags = false;
  let stopped = false;
  for (;;) {
    try {
      await set(flags ? { ...d, flags: transcode ? DLNA_FLAGS.transcode : DLNA_FLAGS.direct } : d);
      break;
    } catch (err) {
      const code = err instanceof UpnpError ? err.code : 0;
      if ((code === 714 || code === 716) && !flags) flags = true;
      else if (code === 701 && !stopped) {
        stopped = true;
        await soap(dev, 'avt', 'Stop');
      } else throw err;
    }
  }
  await soap(dev, 'avt', 'Play', { Speed: 1 });
}

// The Sink of GetProtocolInfo; empty when the renderer has no ConnectionManager or does not answer.
export async function sinkOf(dev: DlnaDevice): Promise<string> {
  if (!dev.cm) return '';
  return (await soap(dev, 'cm', 'GetProtocolInfo').catch(() => ({}) as Record<string, string>)).Sink ?? '';
}
