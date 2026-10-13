import { caps } from '../../shared/server-caps';
import { EventEmitter } from 'node:events';
import { app, net } from 'electron';
import type { TraktServer, TraktState } from '../../shared/contract';
import type { BaseItem } from '../../shared/models';
import type { ConnectionManager } from '../connection/connection-manager';
import { logger } from '../core/log';
import type { SettingsService } from '../core/settings';
import type { CredentialVault } from '../core/vault';
import { t } from '../i18n';
import { hasTraktPlugin, scrobbleBody, TRAKT_API, TraktClient, TraktError, type ScrobbleAction, type Tokens } from './trakt-client';

const log = logger.scope('trakt');

// Vault entry: userId = client id, userName = Trakt username ('' until authorized),
// token = JSON of Secrets. Nothing secret goes to settings or to the log.
const VAULT_KEY = 'trakt:account';
// A token this close to its expiry is refreshed before use.
const REFRESH_MARGIN_MS = 10 * 60_000;

interface Secrets {
  secret: string;
  access?: string;
  refresh?: string;
  expiresAt?: number;
}

const CLIENT_RE = /^[A-Za-z0-9_-]{8,128}$/;

// Client-side Trakt scrobbling: the user's own Trakt application (client id + secret),
// authorized with the device-code flow; start/pause/stop follow the playback reports.
// A server that runs the Trakt plugin already scrobbles: it is skipped when detected
// (admins can read the plugin list) or when the user turned it off (settings.trakt.offServers).
export class TraktService extends EventEmitter {
  private pending: TraktState['pending'] = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private error: string | undefined;
  private plugins = new Map<string, boolean | null>();
  // Calls run one after the other: start, pause and stop reach Trakt in order, and a refresh happens once.
  private chain: Promise<void> = Promise.resolve();
  // Development only: WICABY_TRAKT_URL points at tools/mock-server/mock-trakt.mjs.
  private readonly base = (!app.isPackaged && process.env.WICABY_TRAKT_URL) || TRAKT_API;

  constructor(
    private readonly vault: CredentialVault,
    private readonly settings: SettingsService,
    private readonly connection: ConnectionManager,
  ) {
    super();
    // A new sign-in may be another user with other rights: detect again.
    connection.on('session', () => this.plugins.clear());
  }

  private account(): { clientId: string; user: string; secrets: Secrets } | null {
    const c = this.vault.get(VAULT_KEY);
    if (!c) return null;
    try {
      return { clientId: c.userId, user: c.userName, secrets: JSON.parse(c.token) as Secrets };
    } catch {
      return null;
    }
  }

  private save(clientId: string, user: string, secrets: Secrets): Promise<void> {
    return this.vault.set(VAULT_KEY, { userId: clientId, userName: user, token: JSON.stringify(secrets) });
  }

  private client(clientId: string): TraktClient {
    return new TraktClient(this.base, clientId, (url, init) => net.fetch(url, init));
  }

  // Whether the server runs the Trakt plugin; null when its plugin list cannot be read.
  private async detect(serverId: string): Promise<boolean | null> {
    if (this.plugins.has(serverId)) return this.plugins.get(serverId)!;
    const api = this.connection.onlineApi(serverId);
    if (!api) return null;
    let found: boolean | null = null;
    if (this.connection.sessionFor(serverId)?.user?.isAdmin) {
      found = await api.get<unknown>('/Plugins').then(hasTraktPlugin, () => null);
    }
    this.plugins.set(serverId, found);
    return found;
  }

  async state(): Promise<TraktState> {
    const a = this.account();
    // File sources never scrobble (server-caps.ts castSend: nothing of theirs leaves the machine).
    const sessions = this.connection.session.sessions.filter((s) => s.status === 'signed-in' && caps(s.server.kind).castSend);
    const servers: TraktServer[] = await Promise.all(sessions.map(async (s) => ({ serverId: s.server.id, name: s.server.name, plugin: await this.detect(s.server.id) })));
    return { clientId: a?.clientId ?? '', user: a?.secrets.access ? a.user : null, pending: this.pending, error: this.error, servers };
  }

  private publish(): void {
    void this.state().then((s) => this.emit('state', s));
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pending = null;
  }

  async connect(clientId: string, clientSecret: string): Promise<TraktState> {
    clientId = clientId.trim();
    clientSecret = clientSecret.trim();
    const prev = this.account();
    // An empty secret keeps the stored one for the same client id.
    const secret = clientSecret || (prev?.clientId === clientId ? prev.secrets.secret : '');
    if (!CLIENT_RE.test(clientId) || !CLIENT_RE.test(secret)) throw new Error(t('errors.trakt.invalidClient'));
    this.stopPolling();
    this.error = undefined;
    await this.save(clientId, '', { secret });
    const client = this.client(clientId);
    let code;
    try {
      code = await client.deviceCode();
    } catch (err) {
      this.error = t('errors.trakt.failed', { error: err instanceof Error ? err.message : String(err) });
      return this.state();
    }
    const expiresAt = Date.now() + code.expires_in * 1000;
    this.pending = { userCode: code.user_code, url: code.verification_url, expiresAt };
    let interval = Math.max(1, code.interval) * 1000;
    const poll = async () => {
      this.pollTimer = null;
      if (Date.now() > expiresAt) return this.fail('errors.trakt.expired');
      try {
        const r = await client.pollToken(code.device_code, secret);
        if (!this.pending || this.pending.userCode !== code.user_code) return;
        if (r === 'pending' || r === 'slow-down') {
          if (r === 'slow-down') interval += 1000;
          this.pollTimer = setTimeout(() => void poll(), interval);
          return;
        }
        const user = await client.username(r.access_token).catch(() => '');
        await this.save(clientId, user, { secret, ...fromTokens(r) });
        this.stopPolling();
        log.info(`authorized as ${user || 'an unknown user'}`);
        this.publish();
      } catch (err) {
        if (this.pending?.userCode !== code.user_code) return;
        const status = err instanceof TraktError ? err.status : 0;
        this.fail(status === 418 ? 'errors.trakt.denied' : status === 410 ? 'errors.trakt.expired' : 'errors.trakt.failed', err);
      }
    };
    this.pollTimer = setTimeout(() => void poll(), interval);
    return this.state();
  }

  private fail(key: string, err?: unknown): void {
    this.stopPolling();
    this.error = t(key, { error: err instanceof Error ? err.message : String(err ?? '') });
    log.warn(`authorization failed: ${err instanceof Error ? err.message : key}`);
    this.publish();
  }

  cancel(): Promise<TraktState> {
    this.stopPolling();
    this.error = undefined;
    return this.state();
  }

  async disconnect(): Promise<TraktState> {
    this.stopPolling();
    this.error = undefined;
    const a = this.account();
    if (a?.secrets.access) await this.client(a.clientId).revoke(a.secrets.access, a.secrets.secret).catch((err) => log.warn(`revoke failed: ${String(err)}`));
    await this.vault.delete(VAULT_KEY);
    return this.state();
  }

  // From the playback reports: start (and unpause), pause, stop. positionMs/durationMs
  // give the progress Trakt uses (a stop at 80 % or more marks the item watched).
  scrobble(action: ScrobbleAction, serverId: string | undefined, item: BaseItem, positionMs: number, durationMs: number): void {
    const a = this.account();
    if (!a?.secrets.access || !serverId || !caps(this.connection.sessionFor(serverId)?.server.kind).castSend) return;
    const body = scrobbleBody(item, durationMs > 0 ? (positionMs / durationMs) * 100 : 0);
    if (!body) return;
    this.chain = this.chain
      .then(async () => {
        if (this.settings.value.trakt.offServers.includes(serverId) || (await this.detect(serverId)) === true) return;
        await this.send(action, body);
      })
      .catch((err) => log.warn(`scrobble ${action} failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async send(action: ScrobbleAction, body: object, retried = false): Promise<void> {
    const a = this.account();
    if (!a?.secrets.access) return;
    const client = this.client(a.clientId);
    let s = a.secrets;
    if (!retried && s.refresh && (s.expiresAt ?? 0) - REFRESH_MARGIN_MS < Date.now()) s = await this.refresh(client, a.clientId, a.user, s);
    try {
      await client.scrobble(action, s.access!, body);
    } catch (err) {
      if (err instanceof TraktError && err.status === 401 && !retried && s.refresh) {
        await this.refresh(client, a.clientId, a.user, s);
        return this.send(action, body, true);
      }
      throw err;
    }
  }

  private async refresh(client: TraktClient, clientId: string, user: string, s: Secrets): Promise<Secrets> {
    try {
      const next = { secret: s.secret, ...fromTokens(await client.refresh(s.refresh!, s.secret)) };
      await this.save(clientId, user, next);
      return next;
    } catch (err) {
      // A refresh token Trakt no longer accepts: the user has to authorize again.
      if (err instanceof TraktError && (err.status === 400 || err.status === 401)) {
        await this.save(clientId, user, { secret: s.secret });
        this.error = t('errors.trakt.reauthorize');
        this.publish();
      }
      throw err;
    }
  }
}

function fromTokens(r: Tokens): Omit<Secrets, 'secret'> {
  return { access: r.access_token, refresh: r.refresh_token, expiresAt: (r.created_at ? r.created_at * 1000 : Date.now()) + r.expires_in * 1000 };
}
