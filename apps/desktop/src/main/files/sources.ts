// File sources (file-sources-spec §2.1, §6, §7): the stored list, their credentials in the vault, the Test
// step, and one FilesClient session per source in the ConnectionManager. Local folders come only from the OS
// picker (D11); SMB is the Windows UNC path for now (the credential gateway of FS-11/12 is not built, and
// smb:// on Linux needs it too). Nothing here ever returns a password to the renderer.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FileProtocol, FileSourceInfo, FileSourceInput, FileTestResult, ServerInfo } from '../../shared/contract';
import { defaultName, displayUrl, parseSourceUrl, redactUrl, uncPath } from '../../shared/files/urls';
import type { ClientIdentity } from '../connection/api-client';
import { JsonStore } from '../core/json-store';
import { logger } from '../core/log';
import type { CredentialVault } from '../core/vault';
import { FilesError, type FilesBackend } from './backend';
import { LocalBackend } from './backend-local';
import { WebDavBackend } from './backend-webdav';
import { FilesClient } from './files-client';
import { LoopbackRelay } from './loopback';
import { PhotoIndex } from './photo-index';
import { PhotoThumbs } from './photo-thumbs';
import { ProgressStore } from './progress';
import type { PeerCert, TlsPolicy } from './tls-pin';

const log = logger.scope('files');

export interface StoredSource {
  id: string;
  name: string;
  protocol: FileProtocol;
  // file path (local), https://dav.example/media, smb://STORAGE/media: never with userinfo.
  url: string;
  tls?: TlsPolicy;
  hasCredentials: boolean;
  addedAt: number;
  // Imported from a settings file: nothing contacts it (no stat, no SMB logon, no TLS handshake) until the
  // user presses Connect, which runs the same test as the Add sheet (setCredentials).
  pending?: boolean;
  // A photo source (Settings > Photo sources): indexed, shown as a photo library (photo-index.ts).
  photos?: boolean;
}

interface SourcesDoc {
  v: 1;
  sources: StoredSource[];
}

// What a settings export carries: remote sources without credentials, never local folders.
export interface ExportedSource {
  name: string;
  protocol: 'webdav' | 'smb';
  url: string;
  tls?: TlsPolicy;
  photos?: boolean;
}

interface Secret {
  user: string;
  pass: string;
  domain?: string;
}

// The slice of ConnectionManager the sources use (connection-manager.ts putLocal/dropLocal).
export interface SessionHost {
  putLocal(info: ServerInfo, client: FilesClient, status: 'signed-in' | 'offline'): void;
  dropLocal(id: string): void;
}

const VAULT_PREFIX = 'files:';
const ID = /^[0-9a-f]{32}$/;
const TEST_TIMEOUT_MS = 15_000;

const short = (id: string) => id.slice(0, 6);

export class FileSources {
  private store: JsonStore<SourcesDoc>;
  private clients = new Map<string, FilesClient>();
  private status = new Map<string, 'signed-in' | 'offline'>();
  // Paths the OS picker returned this run: the only local folders add() accepts.
  private picked = new Set<string>();
  // Certificates shown to the user by test(), by origin: a pin must match one of them.
  private shown = new Map<string, PeerCert>();
  readonly relay = new LoopbackRelay();
  private readonly thumbs: PhotoThumbs;

  constructor(
    private readonly dir: string,
    private readonly vault: CredentialVault,
    private readonly identity: ClientIdentity,
    private readonly host: SessionHost,
    private readonly platform: NodeJS.Platform = process.platform,
    // The photo map is on (Settings > Privacy): only then do photo sources hand coordinates to the page.
    private readonly photoMap: () => boolean = () => false,
  ) {
    this.thumbs = new PhotoThumbs(path.join(dir, 'photo-thumbs'));
    this.store = new JsonStore<SourcesDoc>(path.join(dir, 'sources.json'), { v: 1, sources: [] });
    const doc = this.store.value;
    if (!doc || !Array.isArray(doc.sources)) this.store.set({ v: 1, sources: [] });
    else doc.sources = doc.sources.filter((s) => s && ID.test(s.id) && ['local', 'webdav', 'smb'].includes(s.protocol) && typeof s.url === 'string');
  }

  // Every stored source but a pending import is a session at once; reachability is checked in the background.
  start(): void {
    for (const s of this.store.value.sources) if (!s.pending) this.attach(s);
  }

  list(): FileSourceInfo[] {
    return this.store.value.sources.map((s) => this.info(s));
  }

  client(id: string): FilesClient | undefined {
    return this.clients.get(id);
  }

  private info(s: StoredSource): FileSourceInfo {
    const photos = s.photos ? (this.clients.get(s.id)?.photos?.status ?? { state: 'error' as const, count: 0 }) : undefined;
    return { id: s.id, name: s.name, protocol: s.protocol, display: displayUrl(s.url), ...(isPlainHttp(s) ? { http: true } : {}), hasCredentials: s.hasCredentials, tls: s.tls?.mode, status: s.pending ? 'pending' : (this.status.get(s.id) ?? 'signed-in'), ...(photos ? { photos } : {}) };
  }

  private serverInfo(s: StoredSource): ServerInfo {
    return { id: s.id, name: s.name, kind: 'files', version: '', hasToken: true, files: { protocol: s.protocol, display: displayUrl(s.url), ...(s.photos ? { photos: true } : {}) } };
  }

  private secret(id: string): Secret | null {
    const c = this.vault.get(VAULT_PREFIX + id);
    return c?.userId ? { user: c.userId, pass: c.token, domain: c.userName || undefined } : null;
  }

  private backendFor(s: Pick<StoredSource, 'protocol' | 'url' | 'tls'>, secret: Secret | null): FilesBackend {
    if (s.protocol === 'local') return new LocalBackend(s.url, this.platform);
    if (s.protocol === 'webdav') return new WebDavBackend(s.url, secret ? { user: secret.user, pass: secret.pass } : null, s.tls);
    // shortcut: SMB is the Windows UNC path with the session's own credentials; stored SMB credentials and
    // smb:// on Linux need the go-smb2 gateway of FS-11/FS-12 (not built yet).
    const unc = this.platform === 'win32' && !secret ? uncPath(s.url) : null;
    if (!unc) throw new FilesError('unsupported', 501);
    return new LocalBackend(unc, this.platform);
  }

  private attach(s: StoredSource): void {
    let backend: FilesBackend;
    try {
      backend = this.backendFor(s, s.hasCredentials ? this.secret(s.id) : null);
    } catch (err) {
      log.warn(`source ${short(s.id)} cannot start: ${String(err)}`);
      return;
    }
    const progress = new ProgressStore(path.join(this.dir, `progress-${s.id}.json`));
    const photos = s.photos ? new PhotoIndex(backend, path.join(this.dir, `photos-${s.id}.json`), s.id, this.thumbs, this.photoMap) : undefined;
    const client = new FilesClient({ id: s.id, name: s.name, protocol: s.protocol }, backend, progress, this.identity, this.relay, photos);
    this.clients.set(s.id, client);
    this.status.set(s.id, 'signed-in');
    this.host.putLocal(this.serverInfo(s), client, 'signed-in');
    void this.recheck(s.id);
  }

  // Offline when the root cannot be listed; back once it can (network-watch calls this again).
  async recheck(id: string): Promise<void> {
    const client = this.clients.get(id);
    const s = this.store.value.sources.find((x) => x.id === id);
    if (!client || !s) return;
    const ok = await withTimeout(client.backend.stat(''), TEST_TIMEOUT_MS).then(
      () => true,
      (err) => (log.info(`source ${short(id)} not reachable: ${err instanceof FilesError ? err.code : 'error'}`), false),
    );
    const next = ok ? 'signed-in' : 'offline';
    if (this.clients.get(id) !== client || this.status.get(id) === next) return;
    this.status.set(id, next);
    this.host.putLocal(this.serverInfo(s), client, next);
  }

  recheckAll(): Promise<void> {
    return Promise.all([...this.clients.keys()].filter((id) => this.status.get(id) === 'offline').map((id) => this.recheck(id))).then(() => undefined);
  }

  private detach(id: string): void {
    const c = this.clients.get(id);
    // Relay tokens die with the session: none keeps reading with removed or replaced credentials.
    if (c) this.relay.releaseBackend(c.backend);
    (c?.backend as { close?: () => void } | undefined)?.close?.();
    c?.progress.flush();
    c?.photos?.flush();
    this.clients.delete(id);
    this.status.delete(id);
    this.host.dropLocal(id);
  }

  rememberPicked(p: string): void {
    this.picked.add(path.resolve(p));
  }

  // The input as a source to store (no id yet), or a test result explaining why not.
  private normalise(input: FileSourceInput): { source: Omit<StoredSource, 'id' | 'addedAt' | 'hasCredentials' | 'name'>; secret: Secret | null } | FileTestResult {
    if (!input || typeof input !== 'object' || typeof input.url !== 'string' || input.url.length > 2048) return { code: 'invalid' };
    const user = typeof input.user === 'string' ? input.user.slice(0, 256) : '';
    const pass = typeof input.pass === 'string' ? input.pass.slice(0, 1024) : '';
    const domain = typeof input.domain === 'string' && input.domain ? input.domain.slice(0, 256) : undefined;
    const photos = input.photos === true ? { photos: true } : {};
    if (input.protocol === 'local') {
      const p = path.resolve(input.url);
      if (!this.picked.has(p)) return { code: 'invalid' };
      return { source: { protocol: 'local', url: p, ...photos }, secret: null };
    }
    const parsed = parseSourceUrl(input.url);
    if (!parsed || parsed.protocol !== input.protocol) return { code: 'invalid' };
    const u = user || parsed.user || '';
    const secret = u ? { user: u, pass: pass || parsed.pass || '', ...(domain ? { domain } : {}) } : null;
    if (parsed.protocol === 'smb') return { source: { protocol: 'smb', url: parsed.url, ...photos }, secret };
    let tls: TlsPolicy = { mode: 'verify' };
    if (parsed.url.startsWith('http://')) {
      if (!input.insecure) return { code: 'insecure' };
      tls = { mode: 'insecure-http' };
    } else if (typeof input.pin === 'string' && input.pin) {
      const cert = this.shown.get(new URL(parsed.url).origin);
      if (!cert || cert.sha256.replace(/:/g, '').toLowerCase() !== input.pin.replace(/:/g, '').toLowerCase()) return { code: 'invalid' };
      tls = { mode: 'pin', sha256: cert.sha256, subject: cert.subject, notAfter: cert.validTo };
    }
    return { source: { protocol: 'webdav', url: parsed.url, tls, ...photos }, secret };
  }

  private async probe(source: Pick<StoredSource, 'protocol' | 'url' | 'tls'>, secret: Secret | null): Promise<FileTestResult> {
    let backend: FilesBackend;
    try {
      backend = this.backendFor(source, secret);
    } catch (err) {
      return { code: err instanceof FilesError && err.code !== 'tooLarge' ? err.code : 'invalid' };
    }
    try {
      const entries = await withTimeout(backend.list(''), TEST_TIMEOUT_MS);
      return { code: 'ok', count: entries.length };
    } catch (err) {
      const code = err instanceof FilesError && err.code !== 'tooLarge' ? err.code : 'offline';
      log.info(`test of ${source.protocol} ${redactUrl(source.url).replace(/\/\/([^/]+).*/, '//$1/…')}: ${code}`);
      if ((code === 'certUntrusted' || code === 'certChanged') && backend instanceof WebDavBackend) {
        const cert = (err as FilesError).cert ?? (await backend.peek().catch(() => undefined));
        if (cert) {
          this.shown.set(new URL(source.url).origin, cert);
          return { code, cert: { sha256: cert.sha256, subject: cert.subject, issuer: cert.issuer, validFrom: cert.validFrom, validTo: cert.validTo, pinned: (err as FilesError).cert?.pinned } };
        }
      }
      return { code };
    } finally {
      (backend as { close?: () => void }).close?.();
    }
  }

  async test(input: FileSourceInput): Promise<FileTestResult> {
    const n = this.normalise(input);
    return 'code' in n ? n : this.probe(n.source, n.secret);
  }

  async add(input: FileSourceInput): Promise<FileSourceInfo> {
    const n = this.normalise(input);
    if ('code' in n) throw new FilesError(n.code === 'ok' ? 'invalid' : n.code, 400);
    const result = await this.probe(n.source, n.secret);
    if (result.code !== 'ok') throw new FilesError(result.code, 400, result.cert);
    const id = randomBytes(16).toString('hex');
    const name = (typeof input.name === 'string' && input.name.trim().slice(0, 120)) || defaultName(n.source.url) || 'Files';
    const s: StoredSource = { id, name, ...n.source, hasCredentials: Boolean(n.secret), addedAt: Date.now() };
    if (n.secret) await this.vault.set(VAULT_PREFIX + id, { userId: n.secret.user, userName: n.secret.domain ?? '', token: n.secret.pass });
    this.store.update((d) => void d.sources.push(s));
    this.store.flush();
    log.info(`added ${s.protocol} ${s.photos ? 'photo ' : ''}source ${short(id)}`);
    this.attach(s);
    // A photo source starts its first scan now: Settings shows its progress.
    void this.clients.get(id)?.photos?.rescan().catch(() => undefined);
    return this.info(s);
  }

  async remove(id: string): Promise<void> {
    const s = this.store.value.sources.find((x) => x.id === id);
    if (!s) return;
    const progress = this.clients.get(id)?.progress;
    this.detach(id);
    progress?.destroy();
    fs.rmSync(path.join(this.dir, `progress-${id}.json`), { force: true });
    fs.rmSync(path.join(this.dir, `photos-${id}.json`), { force: true });
    if (this.vault.get(VAULT_PREFIX + id)) await this.vault.delete(VAULT_PREFIX + id);
    this.store.update((d) => void (d.sources = d.sources.filter((x) => x.id !== id)));
    this.store.flush();
    log.info(`removed source ${short(id)}`);
  }

  rename(id: string, name: string): FileSourceInfo {
    const s = this.store.value.sources.find((x) => x.id === id);
    const clean = typeof name === 'string' ? name.trim().slice(0, 120) : '';
    if (!s || !clean) throw new FilesError('invalid', 400);
    this.store.update(() => void (s.name = clean));
    const c = this.clients.get(id);
    if (c) {
      c.source.name = clean;
      this.host.putLocal(this.serverInfo(s), c, this.status.get(id) ?? 'signed-in');
    }
    return this.info(s);
  }

  // New credentials are tested first, then stored and the session rebuilt with them. An empty user keeps the
  // stored credentials (Save re-tests the source, which is how a changed certificate gets to the Trust card).
  // A plain http address needs the per-source acknowledgement (insecure) once, as in the Add sheet: an import
  // never carries it, so a settings file cannot send a password in cleartext on its own.
  async setCredentials(id: string, user: string, pass: string, domain?: string, insecure?: boolean): Promise<FileTestResult> {
    const s = this.store.value.sources.find((x) => x.id === id);
    if (!s || s.protocol === 'local' || typeof user !== 'string' || typeof pass !== 'string' || user.length > 256 || pass.length > 1024) return { code: 'invalid' };
    const http = isPlainHttp(s);
    if (http && s.tls?.mode !== 'insecure-http' && insecure !== true) return { code: 'insecure' };
    const tls: TlsPolicy | undefined = http ? { mode: 'insecure-http' } : s.tls;
    const secret: Secret | null = user ? { user, pass, ...(domain ? { domain: String(domain).slice(0, 256) } : {}) } : s.hasCredentials ? this.secret(id) : null;
    const result = await this.probe({ protocol: s.protocol, url: s.url, tls }, secret);
    if (result.code !== 'ok') return result;
    if (user && secret) await this.vault.set(VAULT_PREFIX + id, { userId: secret.user, userName: secret.domain ?? '', token: secret.pass });
    this.store.update(() => {
      s.hasCredentials = Boolean(secret);
      if (tls) s.tls = tls;
      delete s.pending;
    });
    this.store.flush();
    this.detach(id);
    this.attach(s);
    return result;
  }

  // Pins, for this stored source only, the certificate its last test showed (certUntrusted or certChanged from
  // setCredentials): the same rule as a pin in add(). Connect / Save then tests with it.
  trustCert(id: string, sha256: string): FileSourceInfo {
    const s = this.store.value.sources.find((x) => x.id === id);
    const cert = s?.protocol === 'webdav' ? this.shown.get(new URL(s.url).origin) : undefined;
    const norm = (x: string) => x.replace(/:/g, '').toLowerCase();
    if (!s || !cert || typeof sha256 !== 'string' || norm(cert.sha256) !== norm(sha256)) throw new FilesError('invalid', 400);
    this.store.update(() => void (s.tls = { mode: 'pin', sha256: cert.sha256, subject: cert.subject, notAfter: cert.validTo }));
    this.store.flush();
    if (this.clients.has(id)) {
      this.detach(id);
      this.attach(s);
    }
    return this.info(s);
  }

  refresh(id: string): void {
    const c = this.clients.get(id);
    c?.refresh();
    void c?.photos?.rescan().catch(() => undefined);
  }

  exportable(): ExportedSource[] {
    return this.store.value.sources.filter((s) => s.protocol !== 'local').map((s) => ({ name: s.name, protocol: s.protocol as 'webdav' | 'smb', url: s.url, ...(s.tls ? { tls: s.tls } : {}), ...(s.photos ? { photos: true } : {}) }));
  }

  // From a settings import: remote sources not already known, without credentials, pending until the user
  // connects them. Neither a pin nor the http acknowledgement is imported: the file does not choose which
  // certificate gets the password, nor that it travels in cleartext (Connect asks for the tick again).
  importSources(list: unknown): number {
    if (!Array.isArray(list)) return 0;
    let added = 0;
    for (const raw of list.slice(0, 50)) {
      const e = raw as Partial<ExportedSource>;
      const parsed = typeof e?.url === 'string' ? parseSourceUrl(e.url) : null;
      if (!parsed || parsed.protocol !== e.protocol || parsed.user || this.store.value.sources.some((s) => s.url === parsed.url)) continue;
      const tls: TlsPolicy | undefined = parsed.protocol === 'webdav' && !parsed.url.startsWith('http://') ? { mode: 'verify' } : undefined;
      const s: StoredSource = {
        id: randomBytes(16).toString('hex'),
        name: (typeof e.name === 'string' && e.name.trim().slice(0, 120)) || defaultName(parsed.url),
        protocol: parsed.protocol,
        url: parsed.url,
        ...(tls ? { tls } : {}),
        hasCredentials: false,
        addedAt: Date.now(),
        pending: true,
        ...(e.photos === true ? { photos: true } : {}),
      };
      this.store.update((d) => void d.sources.push(s));
      added++;
    }
    this.store.flush();
    return added;
  }

  flush(): void {
    this.store.flush();
    for (const c of this.clients.values()) (c.progress.flush(), c.photos?.flush());
  }

  shutdown(): void {
    this.flush();
    this.relay.close();
  }
}

function isPlainHttp(s: Pick<StoredSource, 'protocol' | 'url'>): boolean {
  return s.protocol === 'webdav' && s.url.startsWith('http://');
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new FilesError('offline', 504)), ms)))]).finally(() => clearTimeout(timer));
}
