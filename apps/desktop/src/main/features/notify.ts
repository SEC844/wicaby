import { Notification } from 'electron';
import { Channels } from '../../shared/contract';
import type { BaseItem, ItemsResult } from '../../shared/models';
import type { ConnectionManager } from '../connection/connection-manager';
import type { SocketMessage } from '../connection/server-socket';
import { markPlayed, userItems, userResume } from '../connection/user-routes';
import { logger } from '../core/log';
import type { SettingsService } from '../core/settings';
import type { DownloadManager, DownloadRecord } from '../downloads/download-manager';
import { t } from '../i18n';
import type { PlaybackService } from '../playback/playback-service';
import type { WindowManager } from '../windows/window-manager';

const log = logger.scope('notify');

export interface NotifierDeps {
  connection: ConnectionManager;
  downloads: DownloadManager;
  settings: SettingsService;
  windows: WindowManager;
  playback: PlaybackService;
  icon?: string;
}

// A toast button (Windows action): runs in main instead of the click's navigation.
export interface ToastAction {
  text: string;
  run: () => unknown;
}

// Coalescing windows: a season finishing or a library scan gives one toast, not twenty.
const DOWNLOAD_BATCH_MS = 4_000;
const LIBRARY_BATCH_MS = 20_000;
// At most this many toasts per minute, and one per series every 30 minutes.
const MAX_PER_MINUTE = 4;
const SERIES_COOLDOWN_MS = 30 * 60_000;

const episodeLabel = (e: BaseItem) =>
  e.ParentIndexNumber !== undefined && e.IndexNumber !== undefined
    ? t('main.notify.episodeLabel', { season: e.ParentIndexNumber, episode: e.IndexNumber, name: e.Name })
    : e.Name;

// Windows toast notifications. Clicking one brings Wicaby forward on the item.
export class Notifier {
  private live = new Set<Notification>();
  private recent: number[] = [];
  private seriesShownAt = new Map<string, number>();
  private seenEpisodes = new Set<string>();
  private doneBatch: DownloadRecord[] = [];
  private doneTimer: NodeJS.Timeout | null = null;
  // Per server: item ids are only meaningful on the server that announced them.
  private addedBatch = new Map<string, Set<string>>();
  private addedTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: NotifierDeps) {
    deps.downloads.on('completed', (rec: DownloadRecord) => this.onDownloadDone(rec));
    deps.connection.on('server-message', (msg: SocketMessage, serverId: string) => {
      if (msg.MessageType === 'LibraryChanged') this.onLibraryChanged(msg.Data, serverId);
    });
  }

  // Returns false when throttled or unsupported.
  // `actions`: toast buttons (Windows and macOS); `onClick` runs after a click focuses Wicaby.
  show(opts: { title: string; body: string; route?: string; actions?: ToastAction[]; onClick?: () => void }): boolean {
    if (!Notification.isSupported()) return false;
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length >= MAX_PER_MINUTE) {
      log.info(`throttled: ${opts.title}`);
      return false;
    }
    this.recent.push(now);
    // Linux notification servers get no buttons from Electron: the click (route, onClick) is the action there.
    const actions = process.platform === 'linux' ? [] : (opts.actions ?? []);
    const n = new Notification({
      title: opts.title,
      body: opts.body,
      icon: this.deps.icon,
      silent: true,
      actions: actions.map((a) => ({ type: 'button', text: a.text })),
    });
    // Electron drops the click handler once the object is collected: hold it until it closes.
    this.live.add(n);
    const release = () => this.live.delete(n);
    const activate = () => {
      release();
      const { windows } = this.deps;
      windows.focusMain();
      if (opts.route) windows.send(windows.main, Channels.navigate, opts.route);
      opts.onClick?.();
    };
    n.on('click', activate);
    n.on('action', (e) => {
      release();
      Promise.resolve()
        .then(() => actions[e.actionIndex]?.run())
        .catch((err) => log.warn(`toast action failed: ${String(err)}`));
    });
    n.on('close', release);
    n.on('failed', (_e, error) => {
      release();
      log.warn(`notification failed: ${error}`);
    });
    n.show();
    return true;
  }

  // Shown once, the first time closing the window only hides it.
  trayHint(): void {
    const { settings } = this.deps;
    if (settings.value.windows.trayHintShown) return;
    settings.update({ windows: { trayHintShown: true } });
    this.show({
      title: t('main.notify.trayHintTitle'),
      body: t(process.platform === 'linux' ? 'main.notify.trayHintBodyLinux' : 'main.notify.trayHintBody'),
    });
  }

  private onDownloadDone(rec: DownloadRecord): void {
    if (!this.deps.settings.value.windows.notifyDownloads) return;
    this.doneBatch.push(rec);
    this.doneTimer ??= setTimeout(() => {
      this.doneTimer = null;
      const batch = this.doneBatch.splice(0);
      if (batch.length === 0 || !this.deps.settings.value.windows.notifyDownloads) return;
      if (batch.length > 1) {
        this.show({ title: t('main.notify.downloadsDone', { count: batch.length }), body: t('main.notify.availableOffline'), route: '/downloads' });
        return;
      }
      const r = batch[0];
      const online = this.deps.connection.isOnline(r.serverId);
      this.show({
        title: t('main.notify.downloadDone'),
        body: r.seriesName ? `${r.seriesName} · ${r.name}` : r.name,
        route: online ? `/item/${r.serverId}/${r.itemId}` : '/downloads',
      });
    }, DOWNLOAD_BATCH_MS);
  }

  private onLibraryChanged(data: unknown, serverId: string): void {
    if (!this.deps.settings.value.windows.notifyNewEpisodes) return;
    const added = (data as { ItemsAdded?: unknown } | null)?.ItemsAdded;
    if (!Array.isArray(added)) return;
    const batch = this.addedBatch.get(serverId) ?? new Set<string>();
    for (const id of added) if (typeof id === 'string' && id.length <= 64 && !this.seenEpisodes.has(`${serverId}:${id}`)) batch.add(id);
    if (batch.size === 0) return;
    this.addedBatch.set(serverId, batch);
    this.addedTimer ??= setTimeout(() => {
      this.addedTimer = null;
      const batches = [...this.addedBatch];
      this.addedBatch.clear();
      for (const [sid, ids] of batches) this.announceEpisodes([...ids].slice(0, 200), sid).catch((err) => log.debug(`new episodes: ${String(err)}`));
    }, LIBRARY_BATCH_MS);
  }

  // Series "in progress" = an episode to resume or a next-up episode. Next up is
  // read after the scan, so a series the user had caught up on counts too.
  private async followedSeries(serverId: string): Promise<Set<string>> {
    const { connection } = this.deps;
    const api = connection.apiFor(serverId);
    const userId = connection.userIdFor(serverId);
    const q = { IncludeItemTypes: 'Episode', Limit: 200, EnableImages: false, EnableUserData: false };
    const [resume, next] = await Promise.all([
      userResume<ItemsResult>(api, userId, q),
      api.get<ItemsResult>('/Shows/NextUp', { UserId: userId, Limit: 200, EnableImages: false, EnableUserData: false }),
    ]);
    return new Set([...(resume.Items ?? []), ...(next.Items ?? [])].map((i) => i.SeriesId).filter((id): id is string => Boolean(id)));
  }

  private async announceEpisodes(ids: string[], serverId: string): Promise<void> {
    const { connection, settings } = this.deps;
    if (!connection.isOnline(serverId) || !settings.value.windows.notifyNewEpisodes) return;
    const res = await userItems<ItemsResult>(connection.apiFor(serverId), connection.userIdFor(serverId), { Ids: ids.join(','), Fields: 'SeriesId' });
    const seen = (id: string) => this.seenEpisodes.has(`${serverId}:${id}`);
    const episodes = (res.Items ?? []).filter((i) => i.Type === 'Episode' && i.SeriesId && !i.UserData?.Played && !seen(i.Id));
    if (episodes.length === 0) return;
    for (const e of episodes) this.seenEpisodes.add(`${serverId}:${e.Id}`);
    if (this.seenEpisodes.size > 2000) this.seenEpisodes = new Set([...this.seenEpisodes].slice(-1000));

    const followed = await this.followedSeries(serverId);
    const now = Date.now();
    const bySeries = new Map<string, BaseItem[]>();
    for (const e of episodes) {
      const sid = e.SeriesId!;
      if (!followed.has(sid) || now - (this.seriesShownAt.get(sid) ?? 0) < SERIES_COOLDOWN_MS) continue;
      bySeries.set(sid, [...(bySeries.get(sid) ?? []), e]);
    }
    if (bySeries.size === 0) return;
    for (const sid of bySeries.keys()) this.seriesShownAt.set(sid, now);

    if (bySeries.size > 2) {
      const names = [...bySeries.values()].map((eps) => eps[0].SeriesName).filter(Boolean);
      this.show({ title: t('main.notify.newEpisodesAny'), body: names.join(', '), route: '/home' });
      return;
    }
    for (const [sid, eps] of bySeries) {
      const one = eps.length === 1;
      this.show({
        title: one ? t('main.notify.newEpisode') : t('main.notify.newEpisodes', { count: eps.length }),
        body: one ? `${eps[0].SeriesName ?? ''} · ${episodeLabel(eps[0])}` : (eps[0].SeriesName ?? ''),
        route: `/item/${serverId}/${one ? eps[0].Id : sid}`,
        actions: one ? this.episodeActions(serverId, eps[0].Id) : undefined,
      });
    }
  }

  // Play / Mark watched on a single new episode, against the server that announced it.
  private episodeActions(serverId: string, itemId: string): ToastAction[] {
    const { connection, playback, windows } = this.deps;
    return [
      {
        text: t('main.notify.play'),
        // The built-in player lives in the main window, which may be hidden in the tray.
        run: () => (windows.focusMain(), playback.play({ itemIds: [itemId], serverId })),
      },
      { text: t('main.notify.markWatched'), run: () => markPlayed(connection.apiFor(serverId), connection.userIdFor(serverId), itemId) },
    ];
  }
}
