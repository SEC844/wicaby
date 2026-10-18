import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { net, shell } from 'electron';
import enMain from '../../renderer/locales/en/main.json';
import frMain from '../../renderer/locales/fr/main.json';
import type { DownloadEntry } from '../../shared/contract';
import { formatMessage, type Lang } from '../../shared/i18n-core';
import type { BaseItem, ItemsResult, MediaSource } from '../../shared/models';
import { fetchFollowing } from '../connection/api-client';
import type { ConnectionManager } from '../connection/connection-manager';
import { postUserData, userItem, userItems } from '../connection/user-routes';
import { JsonStore } from '../core/json-store';
import { logger } from '../core/log';
import type { SettingsService } from '../core/settings';
import { setTaskbarProgress } from '../features/taskbar';
import { onLanguageChange, t } from '../i18n';
import type { WindowManager } from '../windows/window-manager';
import { rangeBody } from '../comics/zip';
import { assertInside, buildTargetPath, type FolderName, isInside, legacyRoot, safeExt, ZONE_INTERNET } from './download-path';

const log = logger.scope('downloads');

// Folder names in every language, to recognise records saved before `root` was.
const FOLDERS_BY_LANG: Record<Lang, Record<string, string>> = { fr: frMain.downloads.folders, en: enMain.downloads.folders };
const LEGACY_FOLDERS: FolderName[] = (['fr', 'en'] as const).map((lang) => (k, params) => formatMessage(FOLDERS_BY_LANG[lang][k] ?? k, params, lang));

function removeInside(root: string, file: string): void {
  // Never delete outside the downloads folder, whatever the stored record says.
  if (isInside(root, file)) fs.rmSync(file, { force: true });
  else log.warn(`not removing a file outside the downloads folder: ${file}`);
}

export interface DownloadRecord extends DownloadEntry {
  item: BaseItem;
  mediaSourceId?: string;
  // Downloads folder filePath was built under: files are only ever written or
  // removed inside it (the setting may change while records live on).
  root?: string;
}

// Errors Wicaby itself raises are stored as their catalogue key, so the list
// follows a language switch; anything else (HTTP status, OS error) is kept as is.
const FORBIDDEN = 'errors.downloads.forbidden';
const POSTER_MAX_BYTES = 15 * 1024 * 1024;
const LEGACY_ERRORS: Record<string, string> = { 'Téléchargement non autorisé pour cet utilisateur': FORBIDDEN }; // i18n-ignore
const errorText = (e: string | undefined) => (e && (e === FORBIDDEN || LEGACY_ERRORS[e]) ? t(LEGACY_ERRORS[e] ?? e) : e);

interface PendingUserData {
  serverId: string;
  userId: string;
  itemId: string;
  positionTicks: number;
  played: boolean;
  at: number;
}

interface DownloadsDoc {
  entries: DownloadRecord[];
  pending: PendingUserData[];
}

const PLAYABLE_TYPES = 'Movie,Episode,Audio,MusicVideo,Video';

// Offline copies, resumable with HTTP Range. Replaces Emby's BITS + server
// Sync API (Premiere only on Emby, absent on Jellyfin) with a client-side queue
// that works against either server.
export class DownloadManager extends EventEmitter {
  private store: JsonStore<DownloadsDoc>;
  private active = new Map<string, AbortController>();
  private emitTimer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(
    file: string,
    private readonly connection: ConnectionManager,
    private readonly settings: SettingsService,
    private readonly windows: WindowManager,
  ) {
    super();
    this.store = new JsonStore<DownloadsDoc>(file, { entries: [], pending: [] });
    // Downloads interrupted by a previous exit resume as queued.
    this.store.update((doc) => {
      doc.pending ??= [];
      for (const e of doc.entries) {
        if (e.status === 'downloading') e.status = 'queued';
        e.bytesPerSecond = 0;
      }
    });
    // Fires for every server's sign-in too: each signed-in server drives its own records.
    connection.on('session', (s: { status: string }) => {
      if (s.status === 'signed-in') {
        void this.flushPending();
        this.pump();
      }
    });
    onLanguageChange(() => this.changed());
  }

  list(): DownloadEntry[] {
    return this.store.value.entries.map(({ item: _item, mediaSourceId: _ms, root: _root, ...entry }) => (entry.error ? { ...entry, error: errorText(entry.error) } : entry));
  }

  get(id: string): DownloadRecord | undefined {
    return this.store.value.entries.find((e) => e.id === id);
  }

  findDone(itemId: string, serverId?: string): DownloadRecord | undefined {
    return this.store.value.entries.find(
      (e) => e.itemId === itemId && (!serverId || e.serverId === serverId) && e.status === 'done' && e.filePath && fs.existsSync(e.filePath),
    );
  }

  private changed(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('change', this.list());
      this.updateTaskbar();
    }, 400);
  }

  private updateTaskbar(): void {
    const running = this.store.value.entries.filter((e) => e.status === 'downloading' || e.status === 'queued');
    if (running.length === 0) return setTaskbarProgress(this.windows.main, null);
    const total = running.reduce((s, e) => s + (e.totalBytes || 0), 0);
    const got = running.reduce((s, e) => s + e.receivedBytes, 0);
    setTaskbarProgress(this.windows.main, total > 0 ? got / total : 0);
  }

  async add(itemIds: string[], server?: string): Promise<void> {
    const api = this.connection.apiFor(server);
    const userId = this.connection.userIdFor(server);
    const serverId = server ?? this.connection.primaryId;
    if (!serverId) throw new Error(t('errors.downloads.noServer'));
    const items: BaseItem[] = [];
    for (const id of itemIds) {
      const item = await userItem<BaseItem>(api, userId, id);
      if (item.IsFolder) {
        const children = await userItems<ItemsResult>(api, userId, {
          ParentId: id,
          Recursive: true,
          IncludeItemTypes: PLAYABLE_TYPES,
          Fields: 'MediaSources,Overview,Path',
          SortBy: 'ParentIndexNumber,IndexNumber,SortName',
        });
        items.push(...children.Items);
      } else {
        items.push(item);
      }
    }
    this.store.update((doc) => {
      for (const item of items) {
        const id = `${serverId}:${item.Id}`;
        if (doc.entries.some((e) => e.id === id)) continue;
        doc.entries.push({
          id,
          serverId,
          itemId: item.Id,
          name: item.Name,
          type: item.Type,
          seriesName: item.SeriesName,
          seasonNumber: item.ParentIndexNumber,
          episodeNumber: item.IndexNumber,
          runTimeTicks: item.RunTimeTicks,
          status: 'queued',
          receivedBytes: 0,
          totalBytes: item.MediaSources?.[0]?.Size ?? 0,
          bytesPerSecond: 0,
          addedAt: Date.now(),
          item,
          mediaSourceId: item.MediaSources?.[0]?.Id,
        });
      }
    });
    log.info(`queued ${items.length} item(s)`);
    this.changed();
    this.pump();
  }

  // Every server field is sanitised in download-path.ts; the result is asserted inside root.
  private targetPath(rec: DownloadRecord, root: string): string {
    // Folder names follow the interface language at the time the download starts.
    return buildTargetPath(root, rec.item, this.source(rec), (k, params) => t(`main.downloads.folders.${k}`, params));
  }

  private source(rec: DownloadRecord): MediaSource | undefined {
    return rec.item.MediaSources?.find((m) => m.Id === rec.mediaSourceId) ?? rec.item.MediaSources?.[0];
  }

  // Folder the record's files were written under: stored since this build,
  // recovered from the path's layout for older records, else unknown.
  private rootOf(rec: DownloadRecord): string | undefined {
    return rec.root ?? legacyRoot(rec.filePath, rec.item, this.source(rec), LEGACY_FOLDERS);
  }

  private pump(): void {
    const online = new Set(this.connection.onlineIds());
    if (online.size === 0) return;
    const max = this.settings.value.downloads.maxConcurrent;
    for (const rec of this.store.value.entries) {
      if (this.active.size >= max) break;
      if (rec.status !== 'queued' || !online.has(rec.serverId) || this.active.has(rec.id)) continue;
      void this.run(rec);
    }
  }

  private async run(rec: DownloadRecord): Promise<void> {
    const controller = new AbortController();
    this.active.set(rec.id, controller);
    rec.status = 'downloading';
    rec.error = undefined;
    this.changed();
    try {
      // A stored path (possibly from an older build) is resumed only while it is
      // inside its known folder and carries an allowed extension.
      const known = this.rootOf(rec);
      if (rec.filePath && known && isInside(known, rec.filePath) && safeExt(path.extname(rec.filePath).slice(1))) {
        rec.root = known;
      } else {
        // An older build's partial file is dropped rather than left behind.
        if (rec.filePath && known) removeInside(known, `${rec.filePath}.part`);
        rec.root = this.settings.value.downloads.folder;
        rec.filePath = this.targetPath(rec, rec.root);
      }
      const root = rec.root;
      const final = rec.filePath;
      const part = `${final}.part`;
      assertInside(root, part);
      const api = this.connection.apiFor(rec.serverId);
      fs.mkdirSync(path.dirname(final), { recursive: true });
      const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
      const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {};
      // A strm or remote file can redirect elsewhere: the token stays with the server.
      const res = await fetchFollowing(api, api.url(`/Items/${rec.itemId}/Download`, { mediaSourceId: rec.mediaSourceId }), { method: 'GET', headers, auth: api.authHeaders(), signal: controller.signal });
      if (!res?.ok || !res.body) throw new Error(res?.status === 403 ? FORBIDDEN : `HTTP ${res?.status ?? 502}`);
      const resumed = res.status === 206;
      const length = Number(res.headers.get('content-length') ?? 0);
      rec.receivedBytes = resumed ? have : 0;
      rec.totalBytes = length ? rec.receivedBytes + length : rec.totalBytes;

      let windowBytes = 0;
      let windowStart = Date.now();
      const counter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          rec.receivedBytes += chunk.length;
          windowBytes += chunk.length;
          const now = Date.now();
          if (now - windowStart >= 1000) {
            rec.bytesPerSecond = Math.round((windowBytes * 1000) / (now - windowStart));
            windowBytes = 0;
            windowStart = now;
          }
          this.changed();
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as never), counter, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }), {
        signal: controller.signal,
      });
      assertInside(root, final);
      fs.renameSync(part, final);
      if (process.platform === 'win32') {
        // Fails on FAT and exFAT drives, which have no alternate streams.
        try {
          fs.writeFileSync(`${final}:Zone.Identifier`, ZONE_INTERNET);
        } catch {
          // Best effort: the file itself is complete.
        }
      }
      rec.posterPath = await this.fetchPoster(rec, final, root).catch(() => undefined);
      rec.status = 'done';
      rec.completedAt = Date.now();
      rec.bytesPerSecond = 0;
      log.info(`done: ${rec.name}`);
      // features/notify.ts shows the Windows notification (per-type toggle, throttled).
      this.emit('completed', rec);
    } catch (err) {
      rec.bytesPerSecond = 0;
      if (controller.signal.aborted) {
        if (rec.status === 'downloading') rec.status = 'paused';
      } else {
        rec.status = 'error';
        rec.error = err instanceof Error ? err.message : String(err);
        log.warn(`failed: ${rec.name}`, err);
      }
    } finally {
      this.active.delete(rec.id);
      this.store.update(() => undefined);
      this.changed();
      this.pump();
    }
  }

  private async fetchPoster(rec: DownloadRecord, mediaPath: string, root: string): Promise<string | undefined> {
    const api = this.connection.apiFor(rec.serverId);
    const it = rec.item;
    const imageId = it.Type === 'Episode' && it.SeriesId ? it.SeriesId : it.Id;
    // An image, read under a cap: a broken or hostile server cannot make main buffer an endless body.
    const res = await net.fetch(api.url(`/Items/${imageId}/Images/Primary`, { maxHeight: 600, quality: 90 }), { redirect: 'error', signal: AbortSignal.timeout(60_000) });
    if (!res.ok || !/^image\//i.test(res.headers.get('content-type') ?? '')) {
      void res.body?.cancel();
      return undefined;
    }
    const data = await rangeBody(res, POSTER_MAX_BYTES + 1);
    if (data.length > POSTER_MAX_BYTES) return undefined;
    const target = mediaPath.replace(/\.[^.]+$/, '.poster.jpg');
    assertInside(root, target);
    fs.writeFileSync(target, data);
    return target;
  }

  pause(id: string): void {
    const rec = this.get(id);
    if (!rec) return;
    rec.status = 'paused';
    this.active.get(id)?.abort();
    this.store.update(() => undefined);
    this.changed();
  }

  resume(id: string): void {
    const rec = this.get(id);
    if (!rec || rec.status === 'done') return;
    rec.status = 'queued';
    this.store.update(() => undefined);
    this.changed();
    this.pump();
  }

  remove(id: string): void {
    const rec = this.get(id);
    if (!rec) return;
    this.active.get(id)?.abort();
    const root = this.rootOf(rec);
    const files = [rec.filePath, rec.filePath && `${rec.filePath}.part`, rec.posterPath].filter((f): f is string => !!f);
    // A legacy path whose folder cannot be recovered was not built by
    // buildTargetPath (a hostile server's, under an older build): its files stay.
    if (root) for (const f of files) removeInside(root, f);
    else if (files.length) log.warn(`not removing files of a download whose folder is unknown: ${files.join(', ')}`);
    this.store.update((doc) => {
      doc.entries = doc.entries.filter((e) => e.id !== id);
    });
    this.changed();
  }

  reveal(id: string): void {
    const rec = this.get(id);
    if (rec?.filePath && fs.existsSync(rec.filePath)) return shell.showItemInFolder(rec.filePath);
    // openPath runs whatever it is given: the settings folder is only opened when it is a directory.
    const folder = this.settings.value.downloads.folder;
    if (fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) void shell.openPath(folder);
    else shell.showItemInFolder(folder);
  }

  // Watch state recorded while offline is replayed once the server is back.
  queueUserData(entry: PendingUserData): void {
    this.store.update((doc) => {
      doc.pending = doc.pending.filter((p) => !(p.serverId === entry.serverId && p.itemId === entry.itemId));
      doc.pending.push(entry);
    });
  }

  async flushPending(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const serverId of this.connection.onlineIds()) await this.flushServer(serverId);
    } finally {
      this.flushing = false;
    }
  }

  private async flushServer(serverId: string): Promise<void> {
    const api = this.connection.onlineApi(serverId);
    if (!api) return;
    const mine = this.store.value.pending.filter((p) => p.serverId === serverId);
    for (const p of mine) {
      try {
        await postUserData(api, p.userId, p.itemId, {
          PlaybackPositionTicks: p.played ? 0 : p.positionTicks,
          Played: p.played,
          LastPlayedDate: new Date(p.at).toISOString(),
        });
        this.store.update((doc) => {
          doc.pending = doc.pending.filter((x) => x !== p);
        });
      } catch (err) {
        log.warn('could not sync offline progress', err);
      }
    }
  }

  flush(): void {
    this.store.flush();
  }
}
