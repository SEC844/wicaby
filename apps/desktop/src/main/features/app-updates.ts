import { EventEmitter } from 'node:events';
import { app, net, shell } from 'electron';
import { RELEASES_LATEST_API, releaseUpdate, trimRelease, type InstallKind } from '../../shared/app-update';
import type { AppUpdateState } from '../../shared/contract';
import { JsonStore } from '../core/json-store';
import { logger } from '../core/log';
import type { SettingsService } from '../core/settings';

const log = logger.scope('updates');
const FIRST_CHECK_MS = 30_000;
const EVERY_MS = 24 * 60 * 60 * 1000;

// etag + the trimmed last 200 answer: a 304 costs nothing against GitHub's 60 requests/hour.
interface Cache {
  etag?: string;
  release?: unknown;
  // "Later": the version whose notice stays hidden.
  dismissed?: string;
}

// Tells the user a newer Wicaby is on GitHub Releases; it never downloads or installs anything.
// shortcut: notice + browser download only (the exe is unsigned), move to electron-updater once builds are signed.
export class AppUpdates extends EventEmitter {
  private cache: JsonStore<Cache>;
  private value: AppUpdateState = { status: 'idle', update: null, dismissed: false };
  private running: Promise<AppUpdateState> | null = null;

  constructor(
    file: string,
    private readonly settings: SettingsService,
    private readonly current: string,
    private readonly kind: InstallKind,
  ) {
    super();
    this.cache = new JsonStore<Cache>(file, {});
  }

  get state(): AppUpdateState {
    return this.value;
  }

  // ~30 s after start, then every 24 h, while "Check for updates automatically" is on. Never blocks start-up.
  start(): void {
    const tick = () => {
      if (this.settings.value.updates.autoCheck) void this.check();
    };
    setTimeout(tick, FIRST_CHECK_MS).unref();
    setInterval(tick, EVERY_MS).unref();
  }

  // manual (Settings): a version put off with "Later" shows its notice again.
  check(manual = false): Promise<AppUpdateState> {
    if (manual && this.cache.value.dismissed) this.cache.update((c) => ({ ...c, dismissed: undefined }));
    this.running ??= this.run().finally(() => (this.running = null));
    return this.running;
  }

  private async run(): Promise<AppUpdateState> {
    // Offline: nothing to ask, nothing to say. A failed check keeps the update found before.
    if (!net.isOnline()) return this.set({ status: 'offline' });
    this.set({ status: 'checking' });
    try {
      const c = this.cache.value;
      const res = await net.fetch(RELEASES_LATEST_API, {
        headers: {
          'User-Agent': `Wicaby/${app.getVersion()} (+https://github.com/WicaebethTheo/wicaby)`,
          Accept: 'application/vnd.github+json',
          ...(c.etag && c.release ? { 'If-None-Match': c.etag } : {}),
        },
        // Our own ETag, not Chromium's HTTP cache.
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
      let release = c.release;
      if (res.status === 200) {
        release = trimRelease(await res.json());
        const etag = res.headers.get('etag') ?? undefined;
        this.cache.update((x) => ({ ...x, etag, release }));
      } else if (res.status !== 304) {
        // 404 (no release yet), 403/429 (rate limit): not worth a word.
        log.info(`latest release: HTTP ${res.status}`);
        return this.set({ status: 'error' });
      }
      const update = releaseUpdate(release, this.current, this.kind);
      if (update) log.info(`Wicaby ${update.version} is available`);
      return this.set({ status: update ? 'available' : 'current', update });
    } catch (err) {
      log.info(`update check failed: ${err instanceof Error ? err.message : String(err)}`);
      return this.set({ status: net.isOnline() ? 'error' : 'offline' });
    }
  }

  // Only the URLs releaseUpdate() validated (github.com/WicaebethTheo/wicaby/releases/…).
  async open(target: 'notes' | 'download'): Promise<void> {
    const u = this.value.update;
    if (u) await shell.openExternal(target === 'notes' ? u.notesUrl : u.downloadUrl);
  }

  dismiss(): AppUpdateState {
    const v = this.value.update?.version;
    if (v) this.cache.update((c) => ({ ...c, dismissed: v }));
    return this.set({});
  }

  flush(): void {
    this.cache.flush();
  }

  private set(patch: Partial<AppUpdateState>): AppUpdateState {
    const next = { ...this.value, ...patch };
    next.dismissed = !!next.update && next.update.version === this.cache.value.dismissed;
    this.value = next;
    this.emit('state', next);
    return next;
  }
}
