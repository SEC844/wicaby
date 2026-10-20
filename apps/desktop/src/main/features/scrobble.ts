import { EventEmitter } from 'node:events';
import { app, net } from 'electron';
import type { ScrobbleState } from '../../shared/contract';
import type { BaseItem } from '../../shared/models';
import { JsonStore } from '../core/json-store';
import { logger } from '../core/log';
import type { CredentialVault } from '../core/vault';
import { t } from '../i18n';
import { LASTFM_API, LastfmClient, listenBody, LISTENBRAINZ_API, ListenBrainzClient, ScrobbleError, shouldScrobble, trackInfo, type TrackInfo } from './scrobble-client';

const log = logger.scope('scrobble');

// Vault entries. ListenBrainz: userName = LB user, token = user token. Last.fm: userId = API key,
// userName = Last.fm user ('' until authorized), token = JSON of LastfmSecrets. Nothing secret in settings or the log.
const LB_KEY = 'scrobble:listenbrainz';
const LASTFM_KEY = 'scrobble:lastfm';
// Listens that could not be sent wait here (oldest dropped past the cap) and are sent again later.
const QUEUE_CAP = 500;
const RETRY_MS = 15 * 60_000;
// Last.fm web auth: the token lives 60 min; the user is given this long to allow it.
const AUTH_POLL_MS = 3000;
const AUTH_WAIT_MS = 10 * 60_000;
const LB_TOKEN_RE = /^[A-Za-z0-9-]{8,128}$/;
const LASTFM_KEY_RE = /^[A-Za-z0-9]{16,64}$/;

type Service = 'listenbrainz' | 'lastfm';

interface LastfmSecrets {
  secret: string;
  sk?: string;
}

export interface QueuedListen {
  to: Service;
  // Unix seconds, the start of the listen.
  at: number;
  info: TrackInfo;
}

interface Playing {
  id: string;
  info: TrackInfo;
  startedAt: number;
  listenedMs: number;
  anchor: { pos: number; at: number } | null;
}

// Music scrobbling from Wicaby itself, for every music source (servers, file sources, downloads): playing now on
// a track's start, then one listen once the standard rule is met (scrobble-client.ts shouldScrobble). The heard time
// counts playback only: a seek or a pause adds nothing. Off until the user connects a service.
export class ScrobbleService extends EventEmitter {
  private cur: Playing | null = null;
  private error: string | undefined;
  private auth: { token: string; url: string; timer: NodeJS.Timeout | null; until: number } | null = null;
  // Calls run one after the other: playing now before its listen, and the queue never sent twice at once.
  private chain: Promise<void> = Promise.resolve();
  private readonly queue: JsonStore<QueuedListen[]>;
  private readonly version = app.getVersion();
  // Development only: point both services at a mock.
  private readonly lbBase = (!app.isPackaged && process.env.WICABY_LISTENBRAINZ_URL) || LISTENBRAINZ_API;
  private readonly lastfmBase = (!app.isPackaged && process.env.WICABY_LASTFM_URL) || LASTFM_API;

  constructor(
    private readonly vault: CredentialVault,
    queueFile: string,
  ) {
    super();
    this.queue = new JsonStore<QueuedListen[]>(queueFile, []);
    if (!Array.isArray(this.queue.value)) this.queue.set([]);
    setInterval(() => this.flush(), RETRY_MS).unref();
    setTimeout(() => this.flush(), 30_000).unref();
  }

  private fetcher = (url: string, init: RequestInit) => net.fetch(url, init);

  private lb(): { user: string; token: string } | null {
    const c = this.vault.get(LB_KEY);
    return c?.token ? { user: c.userName, token: c.token } : null;
  }

  private lastfm(): { apiKey: string; user: string; secrets: LastfmSecrets } | null {
    const c = this.vault.get(LASTFM_KEY);
    if (!c) return null;
    try {
      return { apiKey: c.userId, user: c.userName, secrets: JSON.parse(c.token) as LastfmSecrets };
    } catch {
      return null;
    }
  }

  private lastfmClient(apiKey: string, secret: string): LastfmClient {
    return new LastfmClient(this.lastfmBase, apiKey, secret, this.fetcher);
  }

  state(): ScrobbleState {
    const l = this.lastfm();
    return {
      listenbrainz: { user: this.lb()?.user ?? null },
      lastfm: { apiKey: l?.apiKey ?? '', user: l?.secrets.sk ? l.user : null, authUrl: this.auth?.url ?? null },
      queued: this.queue.value.length,
      error: this.error,
    };
  }

  private publish(): void {
    this.emit('state', this.state());
  }

  private failMessage(err: unknown): string {
    return t('errors.scrobble.failed', { error: err instanceof Error ? err.message : String(err) });
  }

  // ---- ListenBrainz ----

  async connectListenBrainz(token: string): Promise<ScrobbleState> {
    token = token.trim();
    if (!LB_TOKEN_RE.test(token)) throw new Error(t('errors.scrobble.invalidToken'));
    this.error = undefined;
    let user: string | null;
    try {
      user = await new ListenBrainzClient(this.lbBase, this.fetcher).validate(token);
    } catch (err) {
      if (err instanceof ScrobbleError && err.auth) throw new Error(t('errors.scrobble.invalidToken'));
      this.error = this.failMessage(err);
      return this.state();
    }
    if (user === null) throw new Error(t('errors.scrobble.invalidToken'));
    await this.vault.set(LB_KEY, { userId: '', userName: user, token });
    log.info(`ListenBrainz connected as ${user || 'an unknown user'}`);
    return this.state();
  }

  async disconnectListenBrainz(): Promise<ScrobbleState> {
    this.error = undefined;
    await this.vault.delete(LB_KEY);
    this.drop('listenbrainz');
    return this.state();
  }

  // ---- Last.fm (web auth: auth.getToken, the user allows it on last.fm, auth.getSession) ----

  async connectLastfm(apiKey: string, secret: string): Promise<ScrobbleState> {
    apiKey = apiKey.trim();
    secret = secret.trim();
    const prev = this.lastfm();
    // An empty secret keeps the stored one for the same API key.
    secret ||= prev?.apiKey === apiKey ? prev.secrets.secret : '';
    if (!LASTFM_KEY_RE.test(apiKey) || !LASTFM_KEY_RE.test(secret)) throw new Error(t('errors.scrobble.invalidKey'));
    this.cancelAuth();
    this.error = undefined;
    await this.vault.set(LASTFM_KEY, { userId: apiKey, userName: '', token: JSON.stringify({ secret }) });
    const client = this.lastfmClient(apiKey, secret);
    let token: string;
    try {
      token = await client.getToken();
    } catch (err) {
      this.error = err instanceof ScrobbleError && err.auth ? t('errors.scrobble.invalidKey') : this.failMessage(err);
      return this.state();
    }
    const auth = { token, url: client.authUrl(token), timer: null as NodeJS.Timeout | null, until: Date.now() + AUTH_WAIT_MS };
    this.auth = auth;
    const poll = async () => {
      auth.timer = null;
      if (this.auth !== auth) return;
      if (Date.now() > auth.until) return this.authFailed(t('errors.scrobble.expired'));
      try {
        const s = await client.getSession(token);
        if (this.auth !== auth) return;
        if (!s) {
          auth.timer = setTimeout(() => void poll(), AUTH_POLL_MS);
          return;
        }
        this.auth = null;
        await this.vault.set(LASTFM_KEY, { userId: apiKey, userName: s.name, token: JSON.stringify({ secret, sk: s.key }) });
        log.info(`Last.fm connected as ${s.name || 'an unknown user'}`);
        this.publish();
      } catch (err) {
        if (this.auth === auth) this.authFailed(err instanceof ScrobbleError && err.code === 15 ? t('errors.scrobble.expired') : this.failMessage(err));
      }
    };
    auth.timer = setTimeout(() => void poll(), AUTH_POLL_MS);
    return this.state();
  }

  private authFailed(message: string): void {
    this.cancelAuth();
    this.error = message;
    log.warn('Last.fm authorization failed');
    this.publish();
  }

  private cancelAuth(): void {
    if (this.auth?.timer) clearTimeout(this.auth.timer);
    this.auth = null;
  }

  cancelLastfm(): ScrobbleState {
    this.cancelAuth();
    this.error = undefined;
    return this.state();
  }

  async disconnectLastfm(): Promise<ScrobbleState> {
    this.cancelAuth();
    this.error = undefined;
    await this.vault.delete(LASTFM_KEY);
    this.drop('lastfm');
    return this.state();
  }

  // ---- Playback ----

  // From the playback reports (playback-service 'report'): start (and unpause), pause, stop.
  report(action: 'start' | 'pause' | 'stop', item: BaseItem, positionMs: number, durationMs: number): void {
    const info = trackInfo(item);
    if (!info || (!this.lb() && !this.lastfm()?.secrets.sk)) {
      this.cur = null;
      return;
    }
    const now = Date.now();
    let c = this.cur?.id === item.Id ? this.cur : null;
    if (action === 'start') {
      if (!c) {
        c = this.cur = { id: item.Id, info, startedAt: Math.floor(now / 1000), listenedMs: 0, anchor: null };
        this.run(() => this.nowPlaying(info));
      }
      c.anchor = { pos: positionMs, at: now };
      return;
    }
    if (!c) return;
    // Heard: the position's progress, at most the time that passed (a seek forward is not listening).
    if (c.anchor) c.listenedMs += Math.max(0, Math.min(positionMs - c.anchor.pos, now - c.anchor.at));
    c.anchor = null;
    if (action !== 'stop') return;
    this.cur = null;
    if (!shouldScrobble(durationMs > 0 ? durationMs : (info.durationMs ?? 0), c.listenedMs)) return;
    const at = c.startedAt;
    this.run(() => this.listen(info, at));
  }

  private run(job: () => Promise<void>): void {
    this.chain = this.chain.then(job).catch((err) => log.warn(`scrobble failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async nowPlaying(info: TrackInfo): Promise<void> {
    const lb = this.lb();
    const fm = this.lastfm();
    // Playing now is never queued: late, it would be wrong.
    if (lb) await new ListenBrainzClient(this.lbBase, this.fetcher).submit(lb.token, listenBody(info, null, this.version)).catch((err) => this.sendFailed('listenbrainz', err));
    if (fm?.secrets.sk) await this.lastfmClient(fm.apiKey, fm.secrets.secret).nowPlaying(fm.secrets.sk, info).catch((err) => this.sendFailed('lastfm', err));
  }

  private async listen(info: TrackInfo, at: number): Promise<void> {
    let sent = false;
    for (const to of ['listenbrainz', 'lastfm'] as const) {
      const q: QueuedListen = { to, at, info };
      try {
        if (await this.send(q)) sent = true;
      } catch (err) {
        if (this.sendFailed(to, err)) this.enqueue(q);
      }
    }
    if (sent && this.queue.value.length) await this.drain();
  }

  // False: that service is not connected.
  private async send(q: QueuedListen): Promise<boolean> {
    if (q.to === 'listenbrainz') {
      const lb = this.lb();
      if (!lb) return false;
      await new ListenBrainzClient(this.lbBase, this.fetcher).submit(lb.token, listenBody(q.info, q.at, this.version));
      return true;
    }
    const fm = this.lastfm();
    if (!fm?.secrets.sk) return false;
    await this.lastfmClient(fm.apiKey, fm.secrets.secret).scrobble(fm.secrets.sk, q.info, q.at);
    return true;
  }

  // True when the listen is worth keeping for later (network, rate limit, server error, or a refused token the user
  // can fix by connecting again).
  private sendFailed(to: Service, err: unknown): boolean {
    const e = err instanceof ScrobbleError ? err : null;
    log.warn(`${to} failed: ${err instanceof Error ? err.message : String(err)}`);
    if (e?.auth) {
      this.error = t(to === 'lastfm' ? 'errors.scrobble.lastfmReauthorize' : 'errors.scrobble.listenbrainzReauthorize');
      this.publish();
    }
    return !e || e.retry || e.auth;
  }

  private enqueue(q: QueuedListen): void {
    this.queue.set([...this.queue.value, q].slice(-QUEUE_CAP));
    this.publish();
  }

  private drop(to: Service): void {
    this.queue.set(this.queue.value.filter((q) => q.to !== to));
  }

  // Quit: the listen of the final 'stop' still being sent (briefly), then the queue on disk.
  async shutdown(): Promise<void> {
    await Promise.race([this.chain, new Promise((r) => setTimeout(r, 2000))]);
    this.queue.flush();
  }

  // Sends the waiting listens, oldest first; a service stops at its first failure worth retrying.
  flush(): void {
    if (this.queue.value.length) this.run(() => this.drain());
  }

  private async drain(): Promise<void> {
    const before = this.queue.value.length;
    const stalled = new Set<Service>();
    for (const q of [...this.queue.value]) {
      if (stalled.has(q.to)) continue;
      try {
        if (!(await this.send(q))) continue;
      } catch (err) {
        if (this.sendFailed(q.to, err)) {
          stalled.add(q.to);
          continue;
        }
      }
      this.queue.set(this.queue.value.filter((x) => x !== q));
    }
    if (this.queue.value.length !== before) this.publish();
  }
}
