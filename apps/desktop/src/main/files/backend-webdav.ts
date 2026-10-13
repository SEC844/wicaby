// WebDAV over http(s) with Basic auth (file-sources-spec §3.1, §7.3). PROPFIND Depth 1 lists a folder,
// GET serves files with Range. Requests are only ever built from the base URL plus the encoded relative path;
// the source's own agent enforces its TLS policy (tls-pin.ts) and a redirect is followed only on the same origin.
import http from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';
import { guardRel } from '../../shared/files/ids';
import { MAX_PROPFIND_BYTES, parseMultistatus } from '../../shared/files/propfind';
import { logger } from '../core/log';
import { filesError, MAX_ENTRIES, type FileEntry, type FilesBackend, type OpenResult } from './backend';
import { agentFor, isCertError, peekCertificate, PinMismatch, type TlsPolicy } from './tls-pin';

const log = logger.scope('files');

const CONNECT_MS = 5_000;
const LIST_MS = 15_000;
const MAX_CONCURRENT = 4;
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/><D:getlastmodified/></D:prop></D:propfind>';

export interface DavCredentials {
  user: string;
  pass: string;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Readable;
}

export class WebDavBackend implements FilesBackend {
  private readonly base: URL;
  private readonly agent: http.Agent | https.Agent;
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(
    baseUrl: string,
    private readonly creds: DavCredentials | null,
    private readonly tls: TlsPolicy | undefined,
  ) {
    this.base = new URL(baseUrl.replace(/\/+$/, ''));
    this.agent = this.base.protocol === 'https:' ? agentFor(tls) : new http.Agent({ keepAlive: true, maxSockets: MAX_CONCURRENT });
  }

  close(): void {
    this.agent.destroy();
  }

  urlOf(rel: string, dir = false): URL {
    if (guardRel(rel) === null) throw filesError('invalid');
    const path = rel.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const u = new URL(this.base.href);
    u.pathname = `${this.base.pathname.replace(/\/+$/, '')}/${path}${dir && path ? '/' : ''}`;
    return u;
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= MAX_CONCURRENT) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private send(method: string, url: URL, headers: Record<string, string>, body: string | undefined, timeoutMs: number, hops = 0): Promise<Reply> {
    const lib = url.protocol === 'https:' ? https : http;
    const auth = this.creds ? { Authorization: `Basic ${Buffer.from(`${this.creds.user}:${this.creds.pass}`, 'utf8').toString('base64')}` } : {};
    return new Promise<Reply>((resolve, reject) => {
      const req = lib.request(
        url,
        { method, agent: this.agent, headers: { ...headers, ...auth, ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) }, timeout: CONNECT_MS },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if (status >= 300 && status < 400 && location && hops < 3) {
            res.resume();
            let next: URL;
            try {
              next = new URL(location, url);
            } catch {
              return reject(filesError('notFound'));
            }
            // The credentials never follow a redirect to another origin.
            if (next.origin !== this.base.origin) return reject(filesError('notFound'));
            return resolve(this.send(method, next, headers, body, timeoutMs, hops + 1));
          }
          resolve({ status, headers: res.headers, body: res });
        },
      );
      // Listings get an overall deadline; a stream (timeoutMs 0) may idle while the player's cache is full.
      const timer = timeoutMs ? setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeoutMs) : undefined;
      req.on('response', (res) => {
        req.setTimeout(0);
        res.once('end', () => clearTimeout(timer)).once('close', () => clearTimeout(timer));
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(this.mapError(err));
      });
      req.end(body);
    });
  }

  private mapError(err: unknown): Error {
    if (err instanceof PinMismatch) return filesError('certChanged', { ...err.cert, pinned: this.tls?.mode === 'pin' ? this.tls.sha256 : undefined });
    if (isCertError(err)) return filesError('certUntrusted');
    if ((err as { status?: number })?.status) return err as Error;
    return filesError('offline');
  }

  // A 401 is wrong credentials, or a server that only offers Digest.
  private statusError(r: Reply): Error {
    r.body.resume();
    if (r.status === 401 || r.status === 403) {
      const challenge = String(r.headers['www-authenticate'] ?? '');
      return filesError(challenge && !/basic/i.test(challenge) && /digest/i.test(challenge) ? 'digestOnly' : 'auth');
    }
    if (r.status === 404 || r.status === 410) return filesError('notFound');
    return filesError('offline');
  }

  private async readBody(body: Readable, max: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of body) {
      size += (c as Buffer).length;
      if (size > max) {
        body.destroy();
        throw filesError('tooLarge');
      }
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
  }

  private async propfind(rel: string, depth: '0' | '1') {
    return this.slot(async () => {
      const r = await this.send('PROPFIND', this.urlOf(rel, true), { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, PROPFIND_BODY, LIST_MS);
      if (r.status !== 207) throw this.statusError(r);
      const xml = (await this.readBody(r.body, MAX_PROPFIND_BYTES)).toString('utf8');
      const listing = parseMultistatus(xml, this.base.href, rel);
      if (listing.dropped) log.warn(`webdav: ${listing.dropped} entr${listing.dropped === 1 ? 'y' : 'ies'} outside the folder dropped (HREF-ESCAPE)`);
      return listing;
    });
  }

  async list(rel: string): Promise<FileEntry[]> {
    return (await this.propfind(rel, '1')).entries.slice(0, MAX_ENTRIES);
  }

  async stat(rel: string): Promise<FileEntry> {
    const l = await this.propfind(rel, '0');
    if (!l.self) throw filesError('notFound');
    return l.self;
  }

  async read(rel: string, maxBytes: number): Promise<Buffer> {
    return this.slot(async () => {
      const r = await this.send('GET', this.urlOf(rel), {}, undefined, LIST_MS);
      if (r.status !== 200) throw this.statusError(r);
      return this.readBody(r.body, maxBytes);
    });
  }

  // Streams are not slotted: a playing file must not wait behind listings (and holds its socket).
  async open(rel: string, range: string | undefined, head = false): Promise<OpenResult> {
    const r = await this.send(head ? 'HEAD' : 'GET', this.urlOf(rel), range ? { Range: range } : {}, undefined, 0);
    if (r.status !== 200 && r.status !== 206 && r.status !== 416) throw this.statusError(r);
    const headers: Record<string, string> = {};
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
      const v = r.headers[h];
      if (typeof v === 'string') headers[h.replace(/(^|-)([a-z])/g, (_m, d: string, c: string) => d + c.toUpperCase())] = v;
    }
    const size = Number(/\/(\d+)$/.exec(headers['Content-Range'] ?? '')?.[1] ?? headers['Content-Length'] ?? 0);
    if (head) r.body.resume();
    return { status: r.status as OpenResult['status'], size, headers, body: head ? null : r.body };
  }

  // The leaf certificate, for the "trust this certificate" prompt.
  peek() {
    return peekCertificate(this.base.hostname, Number(this.base.port) || 443);
  }
}
