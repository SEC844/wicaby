// The loopback relay that hands WebDAV files to mpv (file-sources-spec D6, §5.1): mpv never sees a password
// and the source's TLS pin applies to playback too. It binds 127.0.0.1 only and serves
// /<token>/<n>: a 128-bit token per play, mapping to that file (n = 0) and its sidecar subtitles (1…).
// GET and HEAD with Range only. A token goes when its play stops or is replaced (FilesClient), when its
// source is removed or its credentials change (releaseBackend), or after 30 minutes with no request and no
// open response; the listener goes after 30 minutes with none of either.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { logger } from '../core/log';
import type { FilesBackend } from './backend';

const log = logger.scope('files');
const IDLE_MS = 30 * 60_000;

interface Play {
  backend: FilesBackend;
  rels: string[];
  used: number;
  // Responses still streaming: cut when the play is released.
  open: Set<http.ServerResponse>;
}

export class LoopbackRelay {
  private server: http.Server | null = null;
  private port = 0;
  private plays = new Map<string, Play>();
  private idle: NodeJS.Timeout | null = null;

  // http://127.0.0.1:<port>/<token>/<n> for each rel, in order.
  async register(backend: FilesBackend, rels: string[]): Promise<string[]> {
    await this.listen();
    const token = randomBytes(16).toString('hex');
    this.plays.set(token, { backend, rels, used: Date.now(), open: new Set() });
    this.touch();
    log.info(`relay: play ${token.slice(0, 4)}… with ${rels.length - 1} subtitle(s)`);
    return rels.map((_, i) => `http://127.0.0.1:${this.port}/${token}/${i}`);
  }

  // The play behind a URL register() returned: its token answers 404 from now on.
  release(url: string): void {
    const token = /^http:\/\/127\.0\.0\.1:\d+\/([0-9a-f]{32})\//.exec(url)?.[1];
    if (token) this.drop(token);
  }

  // Every play reading through this backend: its source was removed or its credentials changed.
  releaseBackend(backend: FilesBackend): void {
    for (const [token, play] of this.plays) if (play.backend === backend) this.drop(token);
  }

  private drop(token: string): void {
    const play = this.plays.get(token);
    if (!play) return;
    this.plays.delete(token);
    for (const res of play.open) res.destroy();
    log.info(`relay: play ${token.slice(0, 4)}… released`);
  }

  get address(): AddressInfo | null {
    return (this.server?.address() as AddressInfo | null) ?? null;
  }

  private find(token: string): Play | undefined {
    const want = Buffer.from(token);
    for (const [k, v] of this.plays) {
      const have = Buffer.from(k);
      if (have.length !== want.length || !timingSafeEqual(have, want)) continue;
      if (v.open.size === 0 && Date.now() - v.used > IDLE_MS) {
        this.plays.delete(k);
        return undefined;
      }
      return v;
    }
    return undefined;
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    // A long single GET (mpv reads a whole film on one connection) keeps the listener.
    this.idle = setTimeout(() => ([...this.plays.values()].some((p) => p.open.size) ? this.touch() : this.close()), IDLE_MS);
    this.idle.unref();
  }

  close(): void {
    this.plays.clear();
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = null;
  }

  private async listen(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.touch();
    const m = /^\/([0-9a-f]{32})\/(\d{1,3})$/.exec(req.url ?? '');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const play = m ? this.find(m[1]) : undefined;
    const rel = play?.rels[Number(m?.[2])];
    if (!play || rel === undefined) {
      res.writeHead(404).end();
      return;
    }
    play.used = Date.now();
    try {
      const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
      const r = await play.backend.open(rel, range, req.method === 'HEAD');
      // mpv dropped the request (a seek) while open() ran: 'close' already fired, so nothing else frees the stream.
      if (req.destroyed || res.destroyed) {
        r.body?.destroy();
        return;
      }
      res.writeHead(r.status, r.headers);
      if (!r.body) {
        res.end();
        return;
      }
      play.open.add(res);
      res.on('close', () => {
        play.open.delete(res);
        play.used = Date.now();
        r.body?.destroy();
      });
      r.body.pipe(res);
    } catch (err) {
      log.warn(`relay: ${m![1].slice(0, 4)}… failed`, err);
      if (!res.headersSent) res.writeHead((err as { status?: number }).status === 404 ? 404 : 502);
      res.end();
    }
  }
}
