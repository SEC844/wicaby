import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { app, net, protocol, session } from 'electron';
import { APP_HOST, APP_SCHEME, MEDIA_SCHEME } from '../shared/contract';
import { remoteImage } from './admin/item-images';
import { fetchServer, isServerOrigin, resolveServerUrl, stripTokenParams, type ApiClient } from './connection/api-client';
import type { ConnectionManager } from './connection/connection-manager';
import { PlexClient } from './connection/plex-client';
import type { ComicService } from './comics/comic-service';
import { logger } from './core/log';
import { FilesClient } from './files/files-client';
import type { DownloadManager } from './downloads/download-manager';

const log = logger.scope('protocol');

// Must run before app 'ready'.
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

// Production CSP. The renderer never talks to the network directly: server
// calls go through IPC and media through wicaby-media://, so connect-src stays closed.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${MEDIA_SCHEME}:`,
  `media-src 'self' blob: data: ${MEDIA_SCHEME}:`,
  `connect-src 'self' ${MEDIA_SCHEME}:`,
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  // Item page trailers: YouTube's privacy-enhanced embed only.
  'frame-src https://www.youtube-nocookie.com',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges' };

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  // Chromium's Matroska support goes through its WebM parser.
  '.mkv': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

// wicaby-media:// answers the app's own pages only: app://wicaby, the dev server,
// or no Origin at all (<img>, <video> and other no-cors loads send none).
// A packaged build never honours the dev server (index.ts also clears the variable).
export function mediaOriginAllowed(origin: string | null, devUrl = app.isPackaged ? undefined : process.env.WICABY_DEV_URL): boolean {
  if (origin === null || origin === '') return true;
  if (origin === `${APP_SCHEME}://${APP_HOST}`) return true;
  if (!devUrl) return false;
  try {
    return origin === new URL(devUrl).origin;
  } catch {
    return false;
  }
}

// A wicaby-media://api request the handler refuses. Checked on the parsed URL (the one
// the handler routes on): exactly the host 'api', no userinfo or port, and a path that
// does not start with '//' (network path), has no dot segment once decoded and no
// encoded slash or backslash (no API route has one; other escapes are fine). Chromium already resolves '..' and '%2e%2e' in a standard scheme; this
// catches whatever survives that. Ids are validated where URLs are built
// (mediaApiUrl, lib/images.ts), so a hostile item id never gets this far as a path.
export function apiPathRefused(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  if (url.host !== 'api' || url.username || url.password || url.port) return true;
  // The parsed path, and the raw one too (whatever the authority) in case a caller hands
  // a URL nothing has normalised yet.
  const raw = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(rawUrl)?.[1] ?? '';
  return [url.pathname, raw].some((path) => {
    if (path.startsWith('//') || /%2f|%5c|\\/i.test(path)) return true;
    try {
      return /(^|\/)\.\.?(\/|$)/.test(decodeURIComponent(path));
    } catch {
      return true;
    }
  });
}

function isPlaylist(path: string, type: string | null): boolean {
  return /\.m3u8$/i.test(path) || /mpegurl/i.test(type ?? '');
}

// Token parameters removed from every URI of an HLS playlist (plain lines and URI="...").
export function stripPlaylistTokens(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('#')) return line.replace(/URI\s*=\s*"([^"]*)"/gi, (_m, uri: string) => `URI="${stripTokenParams(uri)}"`);
      return line.trim() ? stripTokenParams(line) : line;
    })
    .join('\n');
}

// A VOD playlist of a long film is a few MB at most; anything larger is refused, not held in memory.
export const MAX_PLAYLIST_BYTES = 16 * 1024 * 1024;

// The body as text, or null past the cap.
export async function readPlaylist(res: Response): Promise<string | null> {
  if (Number(res.headers.get('content-length') ?? 0) > MAX_PLAYLIST_BYTES) {
    void res.body?.cancel();
    return null;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > MAX_PLAYLIST_BYTES) return null; // leaving the loop cancels the stream
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// A server path fetched for wicaby-media://api and for the cast relay (cast/relay.ts): resolveServerUrl drops any
// token parameter the request carries, the auth headers go to the server only (a redirect elsewhere, strm, Live TV
// or a CDN, is fetched again without them, never with a token parameter, and every later hop must be http(s): see
// fetchServer), HLS playlists lose the token in their URIs (Jellyfin's subtitle playlists carry it), CORS is "*".
export async function fetchFromServer(api: ApiClient, relWithQuery: string, reqMethod: string, header: (name: string) => string | null): Promise<Response> {
  // A Plex server: the Emby media path becomes its own (images, a play's part, BIF, subtitles), or 404.
  if (api instanceof PlexClient) {
    const mapped = await api.mediaPath(relWithQuery);
    if (!mapped) return new Response('Not found', { status: 404, headers: CORS });
    relWithQuery = mapped;
  }
  const target = resolveServerUrl(api, relWithQuery);
  if (!target) return new Response('Bad request', { status: 400, headers: CORS });
  const method = reqMethod === 'HEAD' ? 'HEAD' : 'GET';
  const plain: Record<string, string> = {};
  for (const h of ['range', 'accept', 'if-none-match', 'if-modified-since']) {
    const v = header(h);
    if (v) plain[h] = v;
  }
  let hop = await fetchServer(api, target, { method, headers: { ...plain, ...api.authHeaders() } });
  for (let n = 0; 'foreign' in hop && n < 5; n++) hop = await fetchServer({ address: hop.foreign }, hop.foreign, { method, headers: plain });
  if (!('response' in hop)) return new Response('Bad gateway', { status: 502, headers: CORS });
  const res = hop.response;
  const out = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) out.set(k, v);
  out.delete('set-cookie');
  if (res.status === 200 && method !== 'HEAD' && isPlaylist(relWithQuery.split('?')[0], res.headers.get('content-type'))) {
    const text = await readPlaylist(res);
    if (text === null) return new Response('Bad gateway', { status: 502, headers: CORS });
    const body = Buffer.from(stripPlaylistTokens(text), 'utf8');
    out.set('Content-Length', String(body.length));
    out.delete('content-encoding');
    return new Response(body, { status: 200, statusText: res.statusText, headers: out });
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

function serveFile(file: string, req: Request): Response {
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.get('range');
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, ...CORS } });
    const stream = fs.createReadStream(file, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        ...CORS,
      },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', ...CORS },
  });
}

export function handleProtocols(opts: { rendererDir: string; connection: ConnectionManager; downloads: DownloadManager; comics: ComicService; tiles?: (pathname: string) => Promise<Response> }): void {
  const root = path.resolve(opts.rendererDir);

  // YouTube refuses an embed whose page sends no Referer (error 153), and app:// pages send none.
  // Identify the app the way YouTube asks WebView hosts to: https://<app id>.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://www.youtube-nocookie.com/embed/*'] }, (details, cb) => {
    cb({ requestHeaders: { ...details.requestHeaders, Referer: 'https://com.wika.wicaby/' } });
  });

  // app://wicaby/ serves the built renderer. Unlike Emby's file:// origin it
  // is a real secure origin with its own CSP.
  protocol.handle(APP_SCHEME, async (req) => {
    const url = new URL(req.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.resolve(root, `.${rel}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    if (!file.endsWith('.html')) return res;
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(res.body, { status: 200, headers });
  });

  // wicaby-media://api/<serverId>/<path>  server API (images, streams, subtitles), auth added here;
  //                             without the server id, the primary server
  // wicaby-media://local/<id>  downloaded media file
  // wicaby-media://poster/<id> downloaded poster
  // wicaby-media://comic/<serverId>/<itemId>/<page> page image of an opened CBZ
  // wicaby-media://comic-cover/<serverId>/<itemId>?v=<version>[&full] first page of a CBZ without a server cover
  // wicaby-media://tile/<z>/<x>/<y> photo map tile, from the configured tile host only (photos/tiles.ts)
  // The renderer's api URLs carry no token (mediaApiUrl strips api_key/ApiKey and refuses
  // dot segments); the auth headers are added here, only for the server's own origin and
  // never carried across a redirect to another one (fetchServer).
  protocol.handle(MEDIA_SCHEME, async (req) => {
    const url = new URL(req.url);
    if (!mediaOriginAllowed(req.headers.get('origin'))) return new Response('Forbidden', { status: 403 });
    try {
      if (url.host === 'api') {
        if (apiPathRefused(req.url)) return new Response('Bad request', { status: 400, headers: CORS });
        // API paths never start with a server id (32 hex on Emby and Jellyfin, 40 on Plex: machineIdentifier).
        const first = url.pathname.split('/')[1] ?? '';
        const sid = opts.connection.hasSession(first) || /^(?:[0-9a-f]{32}|[0-9a-f]{40})$/i.test(first) ? first : undefined;
        const api = opts.connection.clientOf(sid);
        if (!api) return new Response('offline', { status: 503, headers: CORS });
        const rel = sid ? url.pathname.slice(first.length + 1) : url.pathname;
        // A file source answers from its backend (posters, the file for the HTML player, sidecar subtitles).
        if (api instanceof FilesClient) return await api.media(rel, req.method, req.headers.get('range') ?? undefined);
        if (!rel.startsWith('/') || rel.startsWith('//') || !isServerOrigin(api, rel)) return new Response('Bad request', { status: 400, headers: CORS });
        return await fetchFromServer(api, rel + url.search, req.method, (h) => req.headers.get(h));
      }
      if (url.host === 'remote-image') return await remoteImage(req);
      if (url.host === 'tile' && opts.tiles) return await opts.tiles(url.pathname);
      if (url.host === 'local' || url.host === 'poster') {
        const rec = opts.downloads.get(decodeURIComponent(url.pathname.slice(1)));
        const file = url.host === 'local' ? rec?.filePath : rec?.posterPath;
        if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404, headers: CORS });
        return serveFile(file, req);
      }
      if (url.host === 'comic') {
        const parts = url.pathname.slice(1).split('/').map(decodeURIComponent);
        const [sid, id = '', n = ''] = parts.length >= 3 ? parts : [undefined, ...parts];
        const page = /^\d{1,6}$/.test(n) ? await opts.comics.page(id, Number(n), url.searchParams.has('thumb'), sid) : null;
        if (!page) return new Response('Not found', { status: 404, headers: CORS });
        return new Response(new Uint8Array(page.data), {
          headers: { 'Content-Type': page.type, 'Content-Length': String(page.data.length), 'Cache-Control': 'private, max-age=86400', ...CORS },
        });
      }
      if (url.host === 'comic-cover') {
        const parts = url.pathname.slice(1).split('/').map(decodeURIComponent);
        const [sid, id = ''] = parts.length >= 2 ? parts : [undefined, ...parts];
        const v = url.searchParams.get('v') ?? '';
        const cover = v.length <= 200 ? await opts.comics.cover(id, v, url.searchParams.has('full'), sid, req.signal) : null;
        if (!cover) return new Response('Not found', { status: 404, headers: CORS });
        return new Response(new Uint8Array(cover.data), {
          headers: { 'Content-Type': cover.type, 'Content-Length': String(cover.data.length), 'Cache-Control': 'private, max-age=86400', ...CORS },
        });
      }
      return new Response('Not found', { status: 404, headers: CORS });
    } catch (err) {
      // A tile path is a place (z/x/y): never logged.
      log.warn(`media request failed: ${url.host}${url.host === 'tile' ? '' : url.pathname}`, err);
      return new Response('Bad gateway', { status: 502, headers: CORS });
    }
  });
}
