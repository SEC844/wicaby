import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { net } from 'electron';
import { RawBody } from '../connection/api-client';
import type { ConnectionManager } from '../connection/connection-manager';
import { t } from '../i18n';

// Item image upload (POST /Items/{id}/Images/{type}, base64 body, image content
// type, the same on Emby and Jellyfin) and the remote artwork preview proxy used
// by the metadata editor. Both are admin-only screens in the renderer; the
// server enforces the permission.

export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(['Primary', 'Backdrop', 'Logo', 'Thumb', 'Banner', 'Art', 'Disc']);

// Mime -> leading bytes, so a renamed file of another kind is refused here too.
const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/webp': (b) => String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP',
  'image/gif': (b) => String.fromCharCode(...b.subarray(0, 4)) === 'GIF8',
};

export async function uploadItemImage(
  connection: ConnectionManager,
  serverId: string | undefined,
  itemId: unknown,
  type: unknown,
  mime: unknown,
  data: unknown,
): Promise<void> {
  if (typeof itemId !== 'string' || !/^[\w-]{1,64}$/.test(itemId)) throw new Error(t('errors.images.invalidItem'));
  if (typeof type !== 'string' || !IMAGE_TYPES.has(type)) throw new Error(t('errors.images.typeRefused'));
  if (typeof mime !== 'string' || !SIGNATURES[mime]) throw new Error(t('errors.images.formatRefused'));
  if (!(data instanceof Uint8Array) || data.length < 16) throw new Error(t('errors.images.invalid'));
  if (data.length > UPLOAD_MAX_BYTES) throw new Error(t('errors.images.tooLarge'));
  if (!SIGNATURES[mime](data)) throw new Error(t('errors.images.notAnImage'));
  const api = connection.apiFor(serverId);
  const base64 = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
  await api.request('POST', `/Items/${itemId}/Images/${type}`, undefined, new RawBody(mime, base64), 120_000);
}

const PREVIEW_MAX_BYTES = 15 * 1024 * 1024;

// wicaby-media://remote-image/?u=<url>: artwork thumbnails from metadata providers
// (TMDb, TVDb, fanart.tv…). Jellyfin has no server-side proxy for them and the
// CSP keeps img-src closed to the web, so main fetches them, from the providers'
// image hosts only. Exact host names; a leading dot also allows subdomains.
const IMAGE_HOSTS = [
  'image.tmdb.org',
  'artworks.thetvdb.com',
  'thetvdb.com',
  'www.thetvdb.com',
  'assets.fanart.tv',
  'm.media-amazon.com', // OMDb posters
  'images.metahub.space',
  'www.theaudiodb.com',
  'r2.theaudiodb.com',
  'static.tvmaze.com',
  'coverartarchive.org', // MusicBrainz artwork; redirects to its archive.org mirrors
  '.archive.org',
];

export function allowedImageHost(host: string): boolean {
  const h = host.toLowerCase();
  // No trailing dot: "localhost." or "image.tmdb.org." never match.
  if (!h || h.endsWith('.')) return false;
  return IMAGE_HOSTS.some((a) => (a.startsWith('.') ? h.endsWith(a) && h.length > a.length : h === a));
}

// An allow-listed http(s) URL on the default port, without credentials.
export function providerUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const ok = (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.port && allowedImageHost(u.hostname);
  return ok ? u : null;
}

// Loopback, private, link-local, CGNAT (Tailscale), multicast, reserved and unspecified ranges.
const NOT_PUBLIC = new BlockList();
for (const [net4, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  NOT_PUBLIC.addSubnet(net4, bits, 'ipv4');
for (const [net6, bits] of [
  ['::', 127], // :: and ::1
  ['64:ff9b:1::', 48],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  NOT_PUBLIC.addSubnet(net6, bits, 'ipv6');

// The eight 16-bit groups of a valid IPv6 address (zone id dropped, dotted tail converted).
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    s = s.slice(0, dotted.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (h: string) => (h ? h.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const groups = halves.length === 2 ? [...head, ...new Array<number>(Math.max(0, 8 - head.length - tail.length)).fill(0), ...tail] : head;
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

export function publicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return !NOT_PUBLIC.check(ip, 'ipv4');
  if (v !== 6) return false;
  const g = ipv6Groups(ip);
  if (!g) return false;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // IPv4 embedded in IPv6: the IPv4 address decides.
  if (zero(0, 5) && g[5] === 0xffff) return publicAddress(v4(g[6], g[7])); // ::ffff:a.b.c.d (mapped)
  if (zero(0, 6)) return false; // ::/96: ::, ::1 and the deprecated IPv4-compatible form
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return publicAddress(v4(g[6], g[7])); // NAT64 64:ff9b::/96
  if (g[0] === 0x2002) return publicAddress(v4(g[1], g[2])); // 6to4 2002:a.b.c.d::/48
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo: the client address is obfuscated
  return !NOT_PUBLIC.check(ip, 'ipv6');
}

export type HostLookup = (host: string) => Promise<{ address: string }[]>;
const systemLookup: HostLookup = (host) => lookup(host, { all: true, verbatim: true });

// Allow-listed, and every address the name resolves to is public: a provider
// name pointed at the LAN (or loopback) is refused.
export async function checkImageUrl(raw: string, resolve: HostLookup = systemLookup): Promise<URL | null> {
  const u = providerUrl(raw);
  if (!u) return null;
  try {
    const addresses = await resolve(u.hostname);
    return addresses.length > 0 && addresses.every((a) => publicAddress(a.address)) ? u : null;
  } catch {
    return null;
  }
}

// Raster formats only: an SVG can carry scripts and external references.
const PREVIEW_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']);
export function previewType(header: string): string | null {
  const type = header.split(';')[0].trim().toLowerCase();
  return PREVIEW_TYPES.has(type) ? type : null;
}

type Hop = { redirect: string } | { response: Response };

function fetchOnce(url: URL): Promise<Hop> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: Hop) => {
      if (!done) resolve(r);
      done = true;
    };
    const fail = (status: number, text: string) => finish({ response: new Response(text, { status }) });
    // Redirects are not followed here: the next hop is checked (allow-list and DNS)
    // like the first one, then fetched by a new request.
    const request = net.request({ url: url.toString(), redirect: 'manual' });
    request.setHeader('Accept', 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8');
    request.on('redirect', (_status, _method, location) => {
      finish({ redirect: location });
      request.abort();
    });
    request.on('response', (res) => {
      const type = previewType(String(res.headers['content-type'] ?? ''));
      if (res.statusCode !== 200 || !type || Number(res.headers['content-length'] ?? 0) > PREVIEW_MAX_BYTES) {
        request.abort();
        return fail(502, 'unavailable');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > PREVIEW_MAX_BYTES) {
          request.abort();
          fail(502, 'too large');
        } else chunks.push(chunk);
      });
      res.on('end', () =>
        finish({
          response: new Response(Buffer.concat(chunks), {
            status: 200,
            headers: { 'Content-Type': type, 'Cache-Control': 'max-age=3600', 'X-Content-Type-Options': 'nosniff' },
          }),
        }),
      );
      res.on('error', () => fail(502, 'unavailable'));
    });
    request.on('error', () => fail(502, 'unavailable'));
    request.on('abort', () => fail(502, 'unavailable'));
    request.end();
  });
}

export async function remoteImage(req: Request): Promise<Response> {
  let next = new URL(req.url).searchParams.get('u') ?? '';
  for (let hop = 0; hop <= 4; hop++) {
    const url = await checkImageUrl(next);
    if (!url) break;
    const r = await fetchOnce(url);
    if ('response' in r) return r.response;
    try {
      next = new URL(r.redirect, url).toString();
    } catch {
      break;
    }
  }
  return new Response('refused', { status: 403 });
}
