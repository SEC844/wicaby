import { EventEmitter } from 'node:events';
import { app, clipboard, Notification, session, type Session } from 'electron';
import { Channels, type TorrentAction, type TorrentAddRequest, type TorrentCertificate, type TorrentConfig, type TorrentLibraryLink, type TorrentsState, type TorrentTestResult } from '../../shared/contract';
import { ApiError } from '../connection/api-client';
import type { ConnectionManager } from '../connection/connection-manager';
import { userItems } from '../connection/user-routes';
import { JsonStore } from '../core/json-store';
import { logger } from '../core/log';
import type { SettingsService } from '../core/settings';
import { onLanguageChange, t } from '../i18n';
import type { CredentialVault } from '../core/vault';
import type { WindowManager } from '../windows/window-manager';
import { applyMaindata, emptySync, findItem, isComplete, toTorrent, type LibraryItemLike } from './maindata';
import { QbitClient, QbitError } from './qbittorrent';

const log = logger.scope('torrents');

const VAULT_KEY = 'torrents:qbittorrent';
const FG_MS = 1500;
const BG_MS = 10_000;
// After a completion: look for the new item in the library at these delays (ms).
const FIND_DELAYS = [15_000, 45_000, 120_000, 300_000, 600_000];
export const MAGNET_RE = /^magnet:\?xt=urn:bt(ih|mh):[^\s]+$/i;
export const HASH_RE = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;

interface Available {
  serverId: string;
  libraryName: string;
  itemId: string;
}

interface TorrentsDoc {
  // hostname -> accepted certificate fingerprint (self-signed qBittorrent HTTPS).
  certs: Record<string, string>;
  available: Record<string, Available>;
}

type WatchMode = 'fg' | 'bg' | 'off';

// Owns the qBittorrent connection: incremental /sync/maindata polling while
// someone looks (or while completion features need it), completion
// notifications, library scans, and the magnet: hand-over.
export class TorrentService extends EventEmitter {
  private readonly store: JsonStore<TorrentsDoc>;
  private ses!: Session;
  private sessionSeq = 0;
  private client: QbitClient | null = null;
  private sync = emptySync();
  private state: TorrentsState = TorrentService.empty('unconfigured');
  private mode: WatchMode = 'off';
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  // Bumped on every reconnect so in-flight results of the old client are dropped.
  private generation = 0;
  // Unfinished hashes at the previous poll; null until the first sync, so
  // torrents already finished at startup do not notify.
  private incomplete: Set<string> | null = null;
  private untrusted = new Map<string, TorrentCertificate>();
  private pendingMagnet: string | null = null;
  private scanTimers = new Map<string, NodeJS.Timeout>();
  private configKey = '';
  private magnetHandler: boolean | null = null;
  // The error behind state.error, re-translated on a language switch.
  private failure: QbitError | null = null;

  constructor(
    file: string,
    private readonly settings: SettingsService,
    private readonly vault: CredentialVault,
    private readonly connection: ConnectionManager,
    private readonly windows: WindowManager,
  ) {
    super();
    this.store = new JsonStore<TorrentsDoc>(file, { certs: {}, available: {} });
    this.newSession();
    settings.on('change', () => this.onSettings());
    this.onSettings();
    onLanguageChange(() => {
      const f = this.failure;
      if (f?.key && this.state.error) this.set({ ...this.state, error: t(f.key, f.params) });
    });
  }

  private static empty(status: TorrentsState['status']): TorrentsState {
    return { status, torrents: [], categories: [], transfer: { dlSpeed: 0, upSpeed: 0, altSpeed: false } };
  }

  // Self-signed certificates pass only when the user accepted that exact
  // certificate for that host; anything else keeps Chromium's verdict.
  private verify = (req: Electron.Request, cb: (code: number) => void): void => {
    if (req.errorCode === 0) return cb(-3);
    const fingerprint = req.certificate.fingerprint;
    if (this.store.value.certs[req.hostname] === fingerprint) return cb(0);
    this.untrusted.set(req.hostname, {
      host: req.hostname,
      fingerprint,
      subject: req.certificate.subjectName,
      issuer: req.certificate.issuerName,
      error: req.verificationResult,
    });
    cb(-3);
  };

  private fetcher = (url: string, init: RequestInit) => this.ses.fetch(url, init);

  // In-memory partition: its own certificate rule, nothing persisted.
  private newSession(): void {
    this.ses = session.fromPartition(`wicaby-qbittorrent-${++this.sessionSeq}`);
    this.ses.setCertificateVerifyProc(this.verify);
  }

  private get cfg() {
    return this.settings.value.torrents;
  }

  private onSettings(): void {
    const t = this.cfg;
    if (t.magnetHandler !== this.magnetHandler) {
      this.magnetHandler = t.magnetHandler;
      this.registerMagnet(t.magnetHandler);
    }
    const key = `${t.url}\n${t.username}`;
    if (key !== this.configKey) {
      this.configKey = key;
      this.reconnect();
    } else this.schedule();
  }

  private registerMagnet(on: boolean): void {
    // A dev build would register electron.exe as the system magnet handler.
    if (!app.isPackaged) return;
    if (on && !app.isDefaultProtocolClient('magnet')) app.setAsDefaultProtocolClient('magnet');
    else if (!on && app.isDefaultProtocolClient('magnet')) app.removeAsDefaultProtocolClient('magnet');
  }

  // The password is bound to the address it was typed for: pointing the
  // settings at another host never sends it there.
  private password(url: string, username: string): string {
    const c = this.vault.get(VAULT_KEY);
    return c && c.userId === url && c.userName === username ? c.token : '';
  }

  private reconnect(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sync = emptySync();
    this.incomplete = null;
    const t = this.cfg;
    this.client = t.url ? new QbitClient(t.url, t.username, this.password(t.url, t.username), this.fetcher) : null;
    this.set(TorrentService.empty(t.url ? 'connecting' : 'unconfigured'));
    this.schedule(0);
  }

  private set(next: TorrentsState): void {
    if (!next.error) this.failure = null;
    this.state = next;
    this.emit('state', next);
  }

  getState(): TorrentsState {
    return this.state;
  }

  watch(mode: WatchMode): void {
    const wasIdle = this.timer === null && !this.polling;
    const faster = mode === 'fg' && this.mode !== 'fg';
    this.mode = mode;
    // Coming to the foreground refreshes at once instead of waiting out the slow timer.
    this.schedule(faster || wasIdle ? 0 : undefined);
  }

  private interval(): number | null {
    if (!this.client) return null;
    // Wrong password or untrusted certificate: wait for the user (and never
    // hammer the login, qBittorrent bans the IP after a few failures).
    if (this.state.status === 'auth' || this.state.status === 'certificate') return null;
    if (this.mode === 'fg') return this.state.status === 'offline' ? 5000 : FG_MS;
    const t = this.cfg;
    const needed = this.mode === 'bg' || t.notifyOnComplete || (t.scanOnComplete && t.libraryMap.length > 0);
    return needed ? BG_MS : null;
  }

  private schedule(delay?: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const every = this.interval();
    if (every === null || this.polling) return;
    this.timer = setTimeout(() => void this.poll(), delay ?? every);
  }

  private async poll(): Promise<void> {
    this.timer = null;
    const client = this.client;
    const gen = this.generation;
    if (!client) return;
    this.polling = true;
    try {
      if (!client.apiVersion) await client.connect();
      const res = await client.maindata(this.sync.rid);
      if (gen !== this.generation) return;
      if (res.full_update) this.pruneAvailable(Object.keys(res.torrents ?? {}));
      this.sync = applyMaindata(this.sync, res);
      this.detectCompletions();
      const changed = res.full_update || res.torrents || res.torrents_removed || res.categories || res.categories_removed || res.server_state;
      if (changed || this.state.status !== 'online') this.publish();
    } catch (err) {
      if (gen === this.generation) this.fail(err, client);
    } finally {
      this.polling = false;
      this.schedule(gen === this.generation ? undefined : 0);
    }
  }

  private fail(err: unknown, client: QbitClient): void {
    const e = err instanceof QbitError ? err : new QbitError(err instanceof Error ? err.message : String(err), 'offline');
    if (this.state.status !== 'offline' || e.kind !== 'offline') log.warn(`qBittorrent ${e.kind}: ${e.message}`);
    this.sync = emptySync();
    // Versions are re-read (and the login redone) on the next successful contact.
    client.apiVersion = '';
    const base = { ...TorrentService.empty('offline'), error: e.message };
    this.failure = e;
    if (e.kind === 'certificate') this.set({ ...base, status: 'certificate', certificate: this.untrusted.get(client.host) });
    else if (e.kind === 'auth' || e.kind === 'banned') this.set({ ...base, status: 'auth' });
    else this.set(base);
  }

  private publish(): void {
    const available = this.store.value.available;
    const s = this.sync.server;
    const num = (v: unknown) => (typeof v === 'number' ? v : 0);
    this.set({
      status: 'online',
      version: this.client?.version,
      apiVersion: this.client?.apiVersion,
      torrents: Object.entries(this.sync.torrents)
        .map(([hash, raw]) => {
          const t = toTorrent(hash, raw);
          const a = available[hash];
          if (a && this.connection.hasSession(a.serverId)) t.available = { libraryName: a.libraryName, itemId: a.itemId, serverId: a.serverId };
          return t;
        })
        .sort((a, b) => b.addedOn - a.addedOn),
      categories: Object.values(this.sync.categories).sort((a, b) => a.name.localeCompare(b.name)),
      transfer: {
        dlSpeed: num(s.dl_info_speed),
        upSpeed: num(s.up_info_speed),
        altSpeed: s.use_alt_speed_limits === true,
        freeSpace: typeof s.free_space_on_disk === 'number' ? s.free_space_on_disk : undefined,
      },
    });
  }

  private pruneAvailable(present: string[]): void {
    const keep = new Set(present);
    if (Object.keys(this.store.value.available).every((h) => keep.has(h))) return;
    this.store.update((doc) => {
      for (const h of Object.keys(doc.available)) if (!keep.has(h)) delete doc.available[h];
    });
  }

  private detectCompletions(): void {
    const now = new Set<string>();
    for (const [hash, raw] of Object.entries(this.sync.torrents)) if (!isComplete(raw)) now.add(hash);
    const before = this.incomplete;
    this.incomplete = now;
    if (!before) return;
    for (const hash of before) {
      const raw = this.sync.torrents[hash];
      if (!raw || now.has(hash)) continue;
      const t = toTorrent(hash, raw);
      this.completed(hash, t.name, t.category);
    }
  }

  // A category can feed a library on several servers; the first one signed in wins.
  private linkFor(category: string): TorrentLibraryLink | undefined {
    const online = this.connection.onlineIds();
    return category ? this.cfg.libraryMap.find((l) => l.category === category && online.includes(l.serverId)) : undefined;
  }

  private completed(hash: string, name: string, category: string): void {
    log.info(`completed: ${name}`);
    const link = this.linkFor(category);
    if (this.cfg.notifyOnComplete && Notification.isSupported()) {
      const n = new Notification({
        title: t('main.torrents.completedTitle'),
        body: link ? t('main.torrents.completedAddedTo', { name, library: link.libraryName }) : name,
        silent: true,
      });
      n.on('click', () => {
        this.windows.focusMain();
        this.windows.send(this.windows.main, Channels.navigate, '/downloads?tab=torrents');
      });
      n.show();
    }
    if (!link) return;
    if (this.cfg.scanOnComplete) this.queueScan(link);
    this.findInLibrary(hash, name, link, 0);
  }

  // Several torrents finishing together trigger one scan per library.
  private queueScan(link: TorrentLibraryLink): void {
    clearTimeout(this.scanTimers.get(link.libraryId));
    this.scanTimers.set(
      link.libraryId,
      setTimeout(() => {
        this.scanTimers.delete(link.libraryId);
        void this.scan(link);
      }, 5000),
    );
  }

  private async scan(link: TorrentLibraryLink): Promise<void> {
    const api = this.connection.onlineApi(link.serverId);
    if (!api) return;
    try {
      // Per-library refresh, as the server dashboard's "Analyser" does.
      await api.post(`/Items/${link.libraryId}/Refresh`, { Recursive: true, MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', ReplaceAllMetadata: false, ReplaceAllImages: false });
      log.info(`library scan started: ${link.libraryName}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        await api.post('/Library/Refresh').then(
          () => log.info('full library scan started'),
          (e: unknown) => log.warn('library scan failed', e),
        );
      } else log.warn(`library scan failed (${err instanceof ApiError ? err.status : '?'}): scanning needs an administrator account`, err);
    }
  }

  private findInLibrary(hash: string, name: string, link: TorrentLibraryLink, attempt: number): void {
    const prev = attempt === 0 ? 0 : FIND_DELAYS[attempt - 1];
    setTimeout(async () => {
      if (this.store.value.available[hash]) return;
      const api = this.connection.onlineApi(link.serverId);
      const userId = api?.userId;
      if (api && userId) {
        try {
          const res = await userItems<{ Items?: LibraryItemLike[] }>(api, userId, {
            ParentId: link.libraryId,
            Recursive: true,
            IncludeItemTypes: 'Movie,Episode,Video,Audio,MusicVideo',
            SortBy: 'DateCreated',
            SortOrder: 'Descending',
            Fields: 'Path',
            Limit: 60,
          });
          const hit = findItem(name, res.Items ?? []);
          if (hit) {
            log.info(`"${name}" is in ${link.libraryName} (${hit.Id})`);
            this.store.update((doc) => {
              doc.available[hash] = { serverId: link.serverId, libraryName: link.libraryName, itemId: hit.Id };
            });
            if (this.state.status === 'online') this.publish();
            return;
          }
        } catch (err) {
          log.warn('library lookup failed', err);
        }
      }
      if (attempt + 1 < FIND_DELAYS.length) this.findInLibrary(hash, name, link, attempt + 1);
    }, FIND_DELAYS[attempt] - prev);
  }

  // ---- IPC-facing operations ----

  private live(): QbitClient {
    if (!this.client || this.state.status !== 'online') throw new Error(t('errors.torrents.notConnected'));
    return this.client;
  }

  private async afterChange<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    } finally {
      this.schedule(250);
    }
  }

  async test(c: TorrentConfig): Promise<TorrentTestResult> {
    const password = c.password ?? this.password(c.url, c.username);
    const client = new QbitClient(c.url, c.username, password, this.fetcher);
    try {
      await client.connect();
      return { ok: true, version: client.version, apiVersion: client.apiVersion, via: client.path === 'mesh' ? 'mesh' : 'direct' };
    } catch (err) {
      const e = err instanceof QbitError ? err : new QbitError(String(err), 'offline');
      return { ok: false, error: e.message, certificate: e.kind === 'certificate' ? this.untrusted.get(client.host) : undefined, path: e.kind === 'offline' ? client.path : undefined };
    }
  }

  async configure(c: TorrentConfig): Promise<TorrentTestResult> {
    if (c.password !== undefined) await this.vault.set(VAULT_KEY, { userId: c.url, userName: c.username, token: c.password });
    const result = await this.test(c);
    // Force a reconnect even when only the password changed.
    this.configKey = '';
    this.settings.update({ torrents: { url: c.url, username: c.username } });
    return result;
  }

  async forget(): Promise<void> {
    await this.vault.delete(VAULT_KEY);
    this.settings.update({ torrents: { url: '', username: '' } });
  }

  trustCertificate(host: string, fingerprint: string): void {
    const seen = this.untrusted.get(host);
    if (!seen || seen.fingerprint !== fingerprint) throw new Error(t('errors.torrents.unknownCertificate'));
    this.store.update((doc) => {
      doc.certs[host] = fingerprint;
    });
    this.untrusted.delete(host);
    // Drop the cached verdict and the failed connections.
    // Chromium caches the rejected verdict; a fresh partition starts clean.
    void this.ses.closeAllConnections();
    this.newSession();
    log.info(`certificate accepted for ${host}`);
    if (this.client?.host === host) this.reconnect();
  }

  add(req: TorrentAddRequest): Promise<void> {
    return this.afterChange(this.live().add(req));
  }

  action(hashes: string[], action: TorrentAction): Promise<void> {
    // Force start toggles: on unless the first selected torrent is already forced.
    const forced = action === 'force-start' && this.sync.torrents[hashes[0]]?.force_start === true;
    return this.afterChange(this.live().action(hashes, action, !forced));
  }

  remove(hashes: string[], deleteFiles: boolean): Promise<void> {
    return this.afterChange(this.live().remove(hashes, deleteFiles));
  }

  setCategory(hashes: string[], category: string): Promise<void> {
    return this.afterChange(this.live().setCategory(hashes, category));
  }

  toggleAltSpeed(): Promise<void> {
    return this.afterChange(this.live().toggleAltSpeed());
  }

  async clipboardMagnet(): Promise<string | null> {
    const text = (await clipboard.readText()).trim();
    return text.length <= 8192 && MAGNET_RE.test(text) ? text : null;
  }

  // Windows hands magnet: links over as a command-line argument.
  handleArgv(argv: string[]): boolean {
    const link = argv.find((a) => a.length <= 8192 && MAGNET_RE.test(a));
    if (!link) return false;
    this.pendingMagnet = link;
    this.windows.focusMain();
    this.windows.send(this.windows.main, Channels.navigate, '/downloads?tab=torrents');
    this.windows.send(this.windows.main, Channels.torrentsMagnet, null);
    return true;
  }

  takeMagnet(): string | null {
    const m = this.pendingMagnet;
    this.pendingMagnet = null;
    return m;
  }

  flush(): void {
    this.store.flush();
  }
}
