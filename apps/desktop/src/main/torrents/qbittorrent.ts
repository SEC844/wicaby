// Thin qBittorrent Web API v2 client (4.x and 5.x). The SID cookie is kept in
// memory and sent by hand, so it never lands in a cookie jar on disk.
import type { MeshPath, TorrentAction } from '../../shared/contract';
import type { Params } from '../../shared/i18n-core';
import { ensureRoute, routed } from '../connection/api-client';
import { t } from '../i18n';
import { versionAtLeast, type MaindataResponse } from './maindata';

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type QbitErrorKind = 'auth' | 'banned' | 'offline' | 'certificate' | 'http';

// The message is translated when thrown; key and params let the service
// translate it again when the language changes while the error is on screen.
export class QbitError extends Error {
  readonly key?: string;
  readonly params?: Params;

  constructor(
    message: string | { key: string; params?: Params },
    readonly kind: QbitErrorKind,
    readonly status = 0,
  ) {
    super(typeof message === 'string' ? message : t(message.key, message.params));
    if (typeof message !== 'string') {
      this.key = message.key;
      this.params = message.params;
    }
  }
}

type Form = URLSearchParams | FormData;

export class QbitClient {
  private cookie: string | null = null;
  private loggedIn = false;
  version = '';
  apiVersion = '';
  // How the last connect() reached qBittorrent (see ensureRoute).
  path: MeshPath = 'outside';

  constructor(
    readonly base: string,
    private readonly username: string,
    private readonly password: string,
    private readonly fetcher: Fetcher,
    private readonly timeoutMs = 10_000,
  ) {}

  get host(): string {
    return new URL(this.base).hostname;
  }

  // 5.0 (Web API 2.11) renamed pause/resume to stop/start.
  get v5(): boolean {
    return versionAtLeast(this.apiVersion, '2.11.0');
  }

  private async raw(path: string, method: 'GET' | 'POST', body?: Form): Promise<Response> {
    const origin = new URL(this.base).origin;
    // qBittorrent's CSRF check wants Referer/Origin to match its own host. Through the mesh forwarder they still
    // name the real address: the forwarder sends qBittorrent that Host (httputil SetURL), never 127.0.0.1.
    const headers: Record<string, string> = { Referer: `${origin}/`, Origin: origin };
    if (this.cookie) headers.Cookie = this.cookie;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = `${this.base}/api/v2/${path}`;
      const wire = routed(url);
      const res = await this.fetcher(wire, { method, headers, body, signal: controller.signal, credentials: 'omit', redirect: 'error' });
      // The forwarder answers 502 "mesh: …" when the routing peer cannot reach qBittorrent (qBittorrent never sends 502).
      if (wire !== url && res.status === 502) throw new QbitError({ key: 'errors.torrents.unreachable' }, 'offline', 502);
      return res;
    } catch (err) {
      if (err instanceof QbitError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) throw new QbitError({ key: 'errors.torrents.noResponse' }, 'offline');
      if (/ERR_CERT|ERR_SSL|certificate/i.test(msg)) throw new QbitError({ key: 'errors.torrents.certificate' }, 'certificate');
      throw new QbitError({ key: /ERR_CONNECTION_REFUSED/.test(msg) ? 'errors.torrents.nothingAtAddress' : 'errors.torrents.unreachable' }, 'offline');
    } finally {
      clearTimeout(timer);
    }
  }

  async login(): Promise<void> {
    this.cookie = null;
    const res = await this.raw('auth/login', 'POST', new URLSearchParams({ username: this.username, password: this.password }));
    const text = (await res.text()).trim();
    if (res.status === 403) throw new QbitError({ key: 'errors.torrents.banned' }, 'banned', 403);
    if (!res.ok || /^fails/i.test(text)) throw new QbitError({ key: 'errors.torrents.wrongCredentials' }, 'auth', res.status);
    // The cookie is SID on most builds but its name is configurable; keep the first pair as is.
    this.cookie = res.headers.get('set-cookie')?.match(/^\s*([^=;,\s]+=[^;,]*)/)?.[1] ?? null;
    this.loggedIn = true;
  }

  // Login + versions; also what "Tester la connexion" shows.
  async connect(): Promise<void> {
    // Direct, or through the mesh when the host is a peer or a routed-network host that does not answer directly.
    this.path = await ensureRoute(this.base);
    await this.login();
    this.version = (await this.text('app/version')).trim();
    this.apiVersion = (await this.text('app/webapiVersion')).trim();
  }

  private async call(path: string, body?: Form): Promise<Response> {
    if (!this.loggedIn) await this.login();
    const method = body ? 'POST' : 'GET';
    let res = await this.raw(path, method, body);
    // 403 = session expired (qBittorrent restarted, timeout): log in again once.
    if (res.status === 403) {
      await this.login();
      res = await this.raw(path, method, body);
    }
    if (res.ok) return res;
    const text = (await res.text().catch(() => '')).trim().slice(0, 200);
    if (res.status === 403) throw new QbitError({ key: 'errors.torrents.forbidden' }, 'auth', 403);
    if (res.status === 409 && /queue/i.test(text)) throw new QbitError({ key: 'errors.torrents.queueDisabled' }, 'http', 409);
    if (res.status === 409) throw new QbitError({ key: 'errors.torrents.unknownCategory' }, 'http', 409);
    if (res.status === 415) throw new QbitError({ key: 'errors.torrents.invalidFile' }, 'http', 415);
    if (res.status === 404) throw new QbitError({ key: 'errors.torrents.unsupported' }, 'http', 404);
    throw new QbitError(text ? { key: 'errors.torrents.serverSaid', params: { message: text } } : { key: 'errors.torrents.httpStatus', params: { status: res.status } }, 'http', res.status);
  }

  private async text(path: string, body?: Form): Promise<string> {
    return (await this.call(path, body)).text();
  }

  maindata(rid: number): Promise<MaindataResponse> {
    return this.call(`sync/maindata?rid=${rid}`).then((r) => r.json() as Promise<MaindataResponse>);
  }

  private post(path: string, fields: Record<string, string>): Promise<string> {
    return this.text(path, new URLSearchParams(fields));
  }

  async action(hashes: string[], action: TorrentAction, forceValue = true): Promise<void> {
    const h = hashes.join('|');
    const path = {
      pause: this.v5 ? 'torrents/stop' : 'torrents/pause',
      resume: this.v5 ? 'torrents/start' : 'torrents/resume',
      recheck: 'torrents/recheck',
      'force-start': 'torrents/setForceStart',
      'priority-up': 'torrents/increasePrio',
      'priority-down': 'torrents/decreasePrio',
      sequential: 'torrents/toggleSequentialDownload',
      'first-last': 'torrents/toggleFirstLastPiecePrio',
    }[action];
    await this.post(path, action === 'force-start' ? { hashes: h, value: String(forceValue) } : { hashes: h });
  }

  async remove(hashes: string[], deleteFiles: boolean): Promise<void> {
    await this.post('torrents/delete', { hashes: hashes.join('|'), deleteFiles: String(deleteFiles) });
  }

  async setCategory(hashes: string[], category: string): Promise<void> {
    await this.post('torrents/setCategory', { hashes: hashes.join('|'), category });
  }

  async toggleAltSpeed(): Promise<void> {
    await this.post('transfer/toggleSpeedLimitsMode', {});
  }

  async add(opts: { magnets: string[]; files: { name: string; data: Uint8Array }[]; category: string; savePath: string; paused: boolean; sequential: boolean }): Promise<void> {
    const form = new FormData();
    if (opts.magnets.length) form.append('urls', opts.magnets.join('\n'));
    for (const f of opts.files) form.append('torrents', new Blob([new Uint8Array(f.data)], { type: 'application/x-bittorrent' }), f.name);
    if (opts.category) form.append('category', opts.category);
    if (opts.savePath) form.append('savepath', opts.savePath);
    // 4.x reads `paused`, 5.x `stopped`; each ignores the other.
    form.append('paused', String(opts.paused));
    form.append('stopped', String(opts.paused));
    form.append('sequentialDownload', String(opts.sequential));
    const text = await this.text('torrents/add', form);
    if (/^fails/i.test(text.trim())) throw new QbitError({ key: 'errors.torrents.rejected' }, 'http', 200);
  }
}
