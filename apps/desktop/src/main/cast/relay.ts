// The LAN stream relay (cast-spec CA-07): the renderer fetches http://<this PC>:<port>/c/<nonce>/<server path> and
// never sees a token; the relay adds the server's header auth (fetchFromServer, shared with wicaby-media://api).
// One listener on the address that shares the renderer's subnet, opened by the first cast, closed with the last
// one or after 30 min without a request. Per cast: a 128-bit nonce, the renderer's IP only, an allow-listed path,
// GET/HEAD, at most 4 upstream requests at a time. Logs show the nonce's first 4 characters only.
import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { powerSaveBlocker } from 'electron';
import type { ApiClient } from '../connection/api-client';
import { stripTokenParams } from '../connection/api-client';
import { logger } from '../core/log';
import { apiPathRefused, fetchFromServer } from '../protocols';

const log = logger.scope('relay');

// Emby item ids are digits, its MediaSourceIds can be mediasource_<n>; Jellyfin's are 32 hex (§8).
// A song's cover (the Primary image of the track or its album) goes too, for the device's screen and app.
const ALLOWED = /^\/((Videos|Audio)\/[A-Za-z0-9_-]{1,64}\/(stream(\.\w+)?|master\.m3u8|main\.m3u8|hls1?\/[\w./-]+|[A-Za-z0-9_-]{1,64}\/Subtitles\/\d+\/(0\/)?Stream\.(vtt|srt))|Items\/[A-Za-z0-9_-]{1,64}\/Images\/Primary)$/i;

// A server path the relay forwards: the allow-list, and no dot segment, encoded slash or backslash.
// Plex (plex-spec §8): the transcoder's HLS (start.m3u8, then its session playlist and segments) and sidecar subtitles.
const PLEX_ALLOWED = /^\/(video\/:\/transcode\/universal\/(start\.m3u8|session\/[\w-]{1,64}\/base\/(index\.m3u8|\d{1,6}\.ts))|library\/streams\/\d{1,12})$/;

export const relayPathAllowed = (path: string): boolean => (ALLOWED.test(path) || PLEX_ALLOWED.test(path)) && !apiPathRefused(`wicaby-media://api${path}`);

const bare = (ip: string | undefined) => (ip ?? '').replace(/^::ffff:/i, '');
// Only the renderer the cast went to.
export const relayRemoteAllowed = (remote: string | undefined, renderer: string): boolean => bare(remote) !== '' && bare(remote) === bare(renderer);

// Response headers the renderer gets.
const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'access-control-allow-origin', 'access-control-expose-headers'];

interface Entry {
  renderer: string;
  api: ApiClient;
  inflight: number;
  // A request from the renderer reached the relay (a firewall that blocks it shows as none: cast.error.relayBlocked).
  seen: boolean;
}

export class Relay {
  static idleMs = 30 * 60_000;
  static maxInflight = 4;

  private server: http.Server | null = null;
  private host = '';
  private port = 0;
  private entries = new Map<string, Entry>();
  private idle: NodeJS.Timeout | null = null;
  private blocker: number | null = null;

  // A cast's base URL (http://<host>:<port>/c/<nonce>), on `host`: this PC's address on the renderer's subnet.
  async open(host: string, renderer: string, api: ApiClient): Promise<{ base: string; nonce: string }> {
    if (this.server && this.host !== host) this.shutdown();
    if (!this.server) await this.listen(host);
    const nonce = crypto.randomBytes(16).toString('hex');
    this.entries.set(nonce, { renderer, api, inflight: 0, seen: false });
    if (this.blocker === null) this.blocker = powerSaveBlocker.start('prevent-app-suspension');
    this.touch();
    return { base: `http://${host.includes(':') ? `[${host}]` : host}:${this.port}/c/${nonce}`, nonce };
  }

  seen(nonce: string): boolean {
    return this.entries.get(nonce)?.seen ?? false;
  }

  // The cast ended: its URLs answer 404 from now on; the last one closes the listener.
  close(nonce: string): void {
    this.entries.delete(nonce);
    if (this.entries.size === 0) this.shutdown();
  }

  shutdown(): void {
    this.entries.clear();
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = null;
    if (this.blocker !== null && powerSaveBlocker.isStarted(this.blocker)) powerSaveBlocker.stop(this.blocker);
    this.blocker = null;
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => (log.info('idle for 30 min: closed'), this.shutdown()), Relay.idleMs);
    this.idle.unref();
  }

  private listen(host: string): Promise<void> {
    const server = http.createServer((req, res) => void this.handle(req, res));
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => {
        server.off('error', reject);
        server.on('error', (err) => log.warn('relay error', err));
        this.server = server;
        this.host = host;
        this.port = (server.address() as { port: number }).port;
        log.info(`listening on ${host}:${this.port}`);
        resolve();
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const end = (status: number) => {
      res.writeHead(status, { 'Content-Length': '0' });
      res.end();
    };
    const m = /^\/c\/([0-9a-f]{32})(\/[^?#]*)(\?[^#]*)?$/.exec(req.url ?? '');
    const tag = m ? `/c/${m[1].slice(0, 4)}…` : '/c/?';
    const entry = m ? this.entries.get(m[1]) : undefined;
    if (!m || !entry) return (log.debug(`${req.method} ${tag} 404`), end(404));
    if (!relayRemoteAllowed(req.socket.remoteAddress, entry.renderer)) return (log.warn(`${tag} from ${bare(req.socket.remoteAddress)}: 403 (not the renderer)`), end(403));
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(405);
    if (!relayPathAllowed(m[2])) return (log.warn(`${tag} path outside the allow-list: 403`), end(403));
    if (entry.inflight >= Relay.maxInflight) return end(503);
    entry.seen = true;
    entry.inflight++;
    this.touch();
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    try {
      const up = await fetchFromServer(entry.api, stripTokenParams(m[2] + (m[3] ?? '')), req.method, (h) => {
        const v = req.headers[h];
        return typeof v === 'string' ? v : null;
      });
      const headers: Record<string, string> = {};
      for (const h of PASS) {
        const v = up.headers.get(h);
        if (v) headers[h] = v;
      }
      log.debug(`${req.method} ${tag} ${up.status}`);
      res.writeHead(up.status, headers);
      if (!up.body || req.method === 'HEAD') {
        void up.body?.cancel();
        res.end();
        return;
      }
      const body = Readable.fromWeb(up.body as import('node:stream/web').ReadableStream, { signal: ac.signal });
      await new Promise<void>((resolve) => {
        body.on('error', () => resolve());
        res.on('close', () => resolve());
        body.pipe(res);
      });
    } catch (err) {
      log.warn(`${tag} upstream failed`, err);
      if (!res.headersSent) end(502);
      else res.destroy();
    } finally {
      entry.inflight--;
    }
  }
}
