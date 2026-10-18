// IPTV playlists (M3U / M3U8 "extended"): the client-side IPTV sources of the IPTV sidebar group. Pure and erasable
// TypeScript, no runtime import; core/iptv/M3u.kt mirrors it (vectors: tools/checks/fixtures/iptv, iptv-check.mjs).
//
// Lenient on purpose: a malformed line is skipped and counted, never fatal. Only http(s) stream URLs are kept
// (rtmp, udp, rtp and file streams are dropped: the players are only handed web URLs).

export interface IptvChannel {
  // Stable across refreshes (tvg-id, name and group, never the URL: an Xtream URL carries rotating credentials).
  id: string;
  name: string;
  url: string;
  number: string;
  tvgId?: string;
  tvgName?: string;
  logo?: string;
  group?: string;
  radio?: boolean;
  userAgent?: string;
  referrer?: string;
}

export interface Playlist {
  // url-tvg / x-tvg-url of the #EXTM3U header (comma separated lists split), http(s) only.
  guides: string[];
  channels: IptvChannel[];
  skipped: number;
}

export const MAX_CHANNELS = 50_000;
const MAX_LINE = 64 * 1024;
const MAX_FIELD = 16 * 1024;

const HTTP = /^https?:\/\/[^\s]+$/i;
export const isWebUrl = (s: string): boolean => HTTP.test(s) && s.length <= 4096;

// key="value", key='value' or key=value (unquoted runs to the next space).
export function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const key = m[1].toLowerCase();
    if (!(key in out)) out[key] = (m[2] ?? m[3] ?? m[4] ?? '').trim().slice(0, MAX_FIELD);
  }
  return out;
}

// The comma that ends the attributes of #EXTINF: the first one outside quotes.
function titleComma(s: string): number {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === ',') return i;
  }
  return -1;
}

// FNV-1a, 2 × 32 bits: 16 hex characters, safe as a path segment and an item id.
export function stableId(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

const CHNO = /^\d{1,5}(?:\.\d{1,3})?$/;
const lastSegment = (url: string): string => decodeSafe(url.replace(/[?#].*$/s, '').replace(/\/+$/, '').split('/').pop() ?? '').replace(/\.(m3u8?|ts|mp4)$/i, '');

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function splitGuides(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(isWebUrl);
}

export function parseM3u(text: string): Playlist {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const guides: string[] = [];
  const channels: IptvChannel[] = [];
  let skipped = 0;
  let info: { attrs: Record<string, string>; title: string } | null = null;
  let opts: { userAgent?: string; referrer?: string } = {};
  let grp: string | undefined;
  const seen = new Map<string, number>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length > MAX_LINE) {
      skipped++;
      info = null;
      continue;
    }
    if (line.startsWith('#')) {
      const upper = line.slice(0, 12).toUpperCase();
      if (upper.startsWith('#EXTM3U')) {
        const a = parseAttrs(line.slice(7));
        for (const g of [...splitGuides(a['url-tvg']), ...splitGuides(a['x-tvg-url'])]) if (!guides.includes(g)) guides.push(g);
      } else if (upper.startsWith('#EXTINF:')) {
        // A second #EXTINF without a URL in between: the first one was malformed.
        if (info) skipped++;
        const body = line.slice(8);
        const comma = titleComma(body);
        info = comma < 0 ? { attrs: parseAttrs(body), title: '' } : { attrs: parseAttrs(body.slice(0, comma)), title: body.slice(comma + 1).trim() };
      } else if (upper.startsWith('#EXTVLCOPT:')) {
        const [k, ...rest] = line.slice(11).split('=');
        const raw = rest.join('=').trim().slice(0, 1024);
        // Sent as an HTTP header: a value with non-ASCII or control characters is dropped (as the Android twin does).
        const v = /^[\t\x20-\x7e]*$/.test(raw) ? raw : '';
        const key = k.trim().toLowerCase();
        if (v && key === 'http-user-agent') opts.userAgent = v;
        else if (v && (key === 'http-referrer' || key === 'http-referer')) opts.referrer = v;
      } else if (upper.startsWith('#EXTGRP:')) {
        grp = line.slice(8).trim().slice(0, MAX_FIELD) || undefined;
      }
      continue;
    }
    // A URL line closes the entry.
    const url = line;
    const entry = info;
    const o = opts;
    const g = grp;
    info = null;
    opts = {};
    grp = undefined;
    if (!isWebUrl(url)) {
      skipped++;
      continue;
    }
    if (channels.length >= MAX_CHANNELS) {
      skipped++;
      continue;
    }
    const a = entry?.attrs ?? {};
    const tvgName = a['tvg-name'] || undefined;
    const name = (entry?.title || tvgName || lastSegment(url) || `#${channels.length + 1}`).slice(0, 200);
    const group = (a['group-title'] || g || '').split(';')[0].trim() || undefined;
    const tvgId = a['tvg-id'] || undefined;
    const chno = a['tvg-chno'] || a['channel-number'] || a['tvg-num'] || '';
    const key = `${tvgId ?? ''}|${name}|${group ?? ''}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const ch: IptvChannel = { id: n === 1 ? stableId(key) : `${stableId(key)}-${n}`, name, url, number: CHNO.test(chno) ? chno : '' };
    if (tvgId) ch.tvgId = tvgId;
    if (tvgName) ch.tvgName = tvgName;
    const logo = a['tvg-logo'] || a['logo'];
    if (logo && (isWebUrl(logo) || /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/i.test(logo))) ch.logo = logo;
    if (group) ch.group = group;
    if (a['radio'] === 'true') ch.radio = true;
    if (o.userAgent) ch.userAgent = o.userAgent;
    if (o.referrer) ch.referrer = o.referrer;
    channels.push(ch);
  }
  if (info) skipped++;
  // No tvg-chno anywhere: the playlist order is the numbering.
  if (!channels.some((c) => c.number)) channels.forEach((c, i) => (c.number = String(i + 1)));
  return { guides, channels, skipped };
}
