import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { nativeImage, net } from 'electron';
import { comicPageFromTicks, TICKS_PER_MS, type ComicInfo, type ComicPage } from '../../shared/contract';
import type { BaseItem } from '../../shared/models';
import type { ConnectionManager } from '../connection/connection-manager';
import { userItem } from '../connection/user-routes';
import { logger } from '../core/log';
import { t } from '../i18n';
import type { DownloadManager } from '../downloads/download-manager';
import { parseComicInfo, type ComicMeta } from './comic-info';
import { imageSize } from './image-size';
import { coverEntry, httpSource, imageType, listEntries, listEntriesFrom, pageEntries, readEntry, readEntryFrom, readHeads, type ZipEntry } from './zip';

const log = logger.scope('comics');

const CACHE_CAP = 2 * 1024 ** 3;
// Thumbnails are decoded in main: 64 megapixels (256 MB of RGBA) at most.
const MAX_THUMB_PIXELS = 64 * 1024 * 1024;
const ARCHIVES = new Set(['cbz', 'zip']);
// Generated covers (comics the server has no Primary image for): card size, so the largest
// card (330 px) is sharp at 2x; "full" is what an admin uploads as the server's cover.
const COVER_HEIGHT = 660;
const COVER_FULL = 1500;
// At most this many covers are read at once; the others wait (and go if their card does).
const COVER_JOBS = 2;
const COVER_TIMEOUT = 20_000;
// A first page bigger than this is not a page worth a thumbnail.
const COVER_MAX_ENTRY = 30 * 1024 * 1024;
// Formats nativeImage cannot decode (WebP, AVIF…) are cached as they are, up to this size.
const COVER_MAX_RAW = 4 * 1024 * 1024;
const COVER_CACHE_CAP = 100 * 1024 * 1024;

function coverType(b: Buffer): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  return 'application/octet-stream';
}

// Item ids name cache files, so only the shapes Emby (digits) and Jellyfin (hex) use get through.
const ID = /^[A-Za-z0-9-]{1,64}$/;

interface Book {
  file: string;
  pages: ZipEntry[];
  dims: ComicPage[];
  meta: ComicMeta;
}

function archiveExt(item: BaseItem): string {
  const p = item.Path ?? item.MediaSources?.[0]?.Path ?? '';
  const ext = path.win32.extname(p).slice(1).toLowerCase();
  return ext || (item.Container ?? item.MediaSources?.[0]?.Container ?? '').split(',')[0].toLowerCase();
}

// CBZ reader backend: the archive is fetched once through /Items/{id}/File
// (or read from an offline copy), and pages are served from its central
// directory by wicaby-media://comic/<id>/<page>, so the token stays in main.
export class ComicService {
  private books = new Map<string, Book>();
  private opening = new Map<string, Promise<Book>>();
  private readonly coversDir: string;
  private coverJobs = 0;
  private coverQueue: (() => void)[] = [];
  private coverPending = new Map<string, Promise<Buffer | null>>();
  // Books without a usable first page, not tried again this session.
  private coverFailed = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly connection: ConnectionManager,
    private readonly downloads: DownloadManager,
    // "Taille maximale du cache des BD" (settings.system.comicCacheGb).
    private readonly capBytes: () => number = () => CACHE_CAP,
  ) {
    this.coversDir = path.join(dir, 'covers');
    // A fetch cut by a quit or crash leaves its .part; none is in use yet at startup.
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.part')) fs.rmSync(path.join(dir, f), { force: true });
    } catch {
      // no cache folder yet
    }
  }

  // Ids collide across servers: books and cache files are keyed by server too.
  private sid(serverId?: string): string {
    const sid = serverId ?? this.connection.primaryId ?? '';
    if (!ID.test(sid)) throw new Error(t('errors.comics.invalidServer'));
    return sid;
  }

  async open(itemId: string, serverId?: string): Promise<ComicInfo> {
    if (!ID.test(itemId)) throw new Error(t('errors.comics.invalidId'));
    const sid = this.sid(serverId);
    const item = await this.item(sid, itemId);
    const ext = archiveExt(item);
    if (ext && !ARCHIVES.has(ext)) throw new Error(t('errors.comics.unsupported'));
    const book = await this.book(sid, itemId);
    const start = item.UserData?.Played ? 0 : comicPageFromTicks(item.UserData?.PlaybackPositionTicks);
    return { pageCount: book.pages.length, title: item.Name, startPage: Math.min(start, book.pages.length - 1), pages: book.dims, meta: book.meta };
  }

  async page(itemId: string, index: number, thumb = false, serverId?: string): Promise<{ data: Buffer; type: string } | null> {
    if (!ID.test(itemId) || (serverId !== undefined && !ID.test(serverId))) return null;
    const book = await this.book(this.sid(serverId), itemId);
    const entry = book.pages[index];
    if (!entry) return null;
    const data = await readEntry(book.file, entry);
    const type = imageType(entry.name);
    // The scrubber strip would otherwise decode full-size pages; nativeImage reads PNG and JPEG only.
    // A page whose header claims huge dimensions (image bomb) is not decoded in
    // the main process; the renderer gets it as it would for the full-size view.
    const dims = thumb ? imageSize(data) : null;
    if (dims && dims[0] * dims[1] <= MAX_THUMB_PIXELS && (type === 'image/png' || type === 'image/jpeg')) {
      const img = nativeImage.createFromBuffer(data);
      if (!img.isEmpty()) return { data: img.resize({ height: 240, quality: 'good' }).toJPEG(80), type: 'image/jpeg' };
    }
    return { data, type };
  }

  // The first page as a cover, cached in <comic cache>/covers by server, item and version
  // (the item's Etag or DateCreated). Read from the local copy when there is one, else
  // with Range requests: the end of the archive and that one entry. null: no cover.
  async cover(itemId: string, version: string, full = false, serverId?: string, signal?: AbortSignal): Promise<{ data: Buffer; type: string } | null> {
    if (!ID.test(itemId) || (serverId !== undefined && !ID.test(serverId))) return null;
    const sid = this.sid(serverId);
    if (full) {
      const data = await this.coverSlot(signal, () => this.makeCover(sid, itemId, COVER_FULL, signal));
      return { data, type: coverType(data) };
    }
    const key = `${sid}-${itemId}-${createHash('sha1').update(version).digest('hex').slice(0, 12)}`;
    const file = path.join(this.coversDir, `${key}.cover`);
    try {
      const data = fs.readFileSync(file);
      const now = new Date();
      fs.utimesSync(file, now, now); // mtime is the LRU clock
      return { data, type: coverType(data) };
    } catch {
      // not generated yet
    }
    if (this.coverFailed.has(key)) return null;
    let pending = this.coverPending.get(key);
    if (!pending) {
      pending = this.coverSlot(signal, () => this.makeCover(sid, itemId, COVER_HEIGHT, signal))
        .then((data) => {
          this.saveCover(`${sid}-${itemId}-`, file, data);
          return data;
        })
        .catch((err: unknown) => {
          // A card scrolled away (or a slow server) is tried again next time; anything else is not.
          if (!signal?.aborted && (err as Error)?.name !== 'TimeoutError') this.coverFailed.add(key);
          log.debug(`no cover for ${itemId}`, err);
          return null;
        })
        .finally(() => this.coverPending.delete(key));
      this.coverPending.set(key, pending);
    }
    const data = await pending;
    return data ? { data, type: coverType(data) } : null;
  }

  // Runs [job] once fewer than COVER_JOBS covers are being read; a request cancelled while waiting never starts.
  private async coverSlot<T>(signal: AbortSignal | undefined, job: () => Promise<T>): Promise<T> {
    while (this.coverJobs >= COVER_JOBS) await new Promise<void>((r) => this.coverQueue.push(r));
    if (signal?.aborted) {
      this.coverQueue.shift()?.(); // pass the free slot on
      signal.throwIfAborted();
    }
    this.coverJobs++;
    try {
      return await job();
    } finally {
      this.coverJobs--;
      this.coverQueue.shift()?.();
    }
  }

  private async makeCover(sid: string, itemId: string, height: number, signal?: AbortSignal): Promise<Buffer> {
    const local = this.downloads.findDone(itemId, sid)?.filePath ?? this.books.get(`${sid}-${itemId}`)?.file;
    const pick = async (entries: ZipEntry[], load: (e: ZipEntry) => Promise<Buffer>) => {
      const e = coverEntry(entries);
      if (!e || e.size > COVER_MAX_ENTRY) throw new Error('no cover page');
      return load(e);
    };
    let data: Buffer;
    if (local && fs.existsSync(local)) {
      data = await pick(await listEntries(local), (e) => readEntry(local, e));
    } else {
      const api = this.connection.apiFor(sid);
      const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(COVER_TIMEOUT)]) : AbortSignal.timeout(COVER_TIMEOUT);
      // /File as the reader uses it; /Download (needs the download right) when it is refused.
      let route = 'File';
      const get = async (range: string): Promise<Response> => {
        const res = await net.fetch(api.url(`/Items/${itemId}/${route}`), { headers: { ...api.authHeaders(), Range: range }, signal: sig });
        if (route === 'Download' || ![401, 403, 404].includes(res.status)) return res;
        void res.body?.cancel();
        route = 'Download';
        return get(range);
      };
      const src = await httpSource(get);
      data = await pick(await listEntriesFrom(src), (e) => readEntryFrom(src, e));
    }
    const dims = imageSize(data);
    const type = coverType(data);
    if (dims && dims[0] * dims[1] <= MAX_THUMB_PIXELS && (type === 'image/png' || type === 'image/jpeg')) {
      const img = nativeImage.createFromBuffer(data);
      if (!img.isEmpty()) return img.resize({ height: Math.min(height, dims[1]), quality: 'good' }).toJPEG(85);
    }
    if (data.length > COVER_MAX_RAW) throw new Error('cover page too large to keep');
    return data;
  }

  // Older versions of the same cover go at once; the rest by LRU past COVER_CACHE_CAP.
  private saveCover(prefix: string, file: string, data: Buffer): void {
    try {
      fs.mkdirSync(this.coversDir, { recursive: true });
      fs.writeFileSync(file, data);
      const all = fs
        .readdirSync(this.coversDir)
        .map((f) => path.join(this.coversDir, f))
        .map((f) => ({ f, st: fs.statSync(f) }))
        .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      let total = 0;
      for (const { f, st } of all) {
        total += st.size;
        if (f !== file && (path.basename(f).startsWith(prefix) || total > COVER_CACHE_CAP)) fs.rmSync(f, { force: true });
      }
    } catch (err) {
      log.warn('could not cache a comic cover', err);
    }
  }

  async saveProgress(itemId: string, page: number, pageCount: number, serverId?: string): Promise<void> {
    if (!ID.test(itemId)) throw new Error(t('errors.comics.invalidId'));
    const sid = this.sid(serverId);
    const played = page >= pageCount - 1;
    const positionTicks = page * TICKS_PER_MS;
    const { user, server } = this.connection.sessionFor(sid) ?? {};
    const api = this.connection.onlineApi(sid);
    if (api && user) {
      // UserData only: a Sessions/Playing report on a runtime-less item makes the
      // server mark it played and zero the position. The server cannot derive a
      // percentage without a runtime, so it is sent here.
      const body = {
        PlaybackPositionTicks: played ? 0 : positionTicks,
        Played: played,
        PlayedPercentage: played ? 100 : (100 * (page + 1)) / pageCount,
        LastPlayedDate: new Date().toISOString(),
      };
      try {
        if (api.kind === 'jellyfin') {
          // 10.9+ route first; the per-user one is obsolete but still served by older servers.
          await api.post(`/UserItems/${itemId}/UserData`, undefined, body).catch(() => api.post(`/Users/${user.id}/Items/${itemId}/UserData`, undefined, body));
        } else await api.post(`/Users/${user.id}/Items/${itemId}/UserData`, undefined, body);
        return;
      } catch (err) {
        log.warn('could not save reading progress, queued', err);
      }
    }
    if (server && user) this.downloads.queueUserData({ serverId: server.id, userId: user.id, itemId, positionTicks, played, at: Date.now() });
  }

  private async item(sid: string, itemId: string): Promise<BaseItem> {
    const local = this.downloads.findDone(itemId, sid);
    const api = this.connection.onlineApi(sid);
    if (api) {
      try {
        return await userItem<BaseItem>(api, this.connection.userIdFor(sid), itemId);
      } catch (err) {
        if (!local) throw err;
      }
    }
    if (!local) throw new Error(t('errors.comics.notDownloaded'));
    return local.item;
  }

  private book(sid: string, itemId: string): Promise<Book> {
    const key = `${sid}-${itemId}`;
    const hit = this.books.get(key);
    if (hit && fs.existsSync(hit.file)) return Promise.resolve(hit);
    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.load(sid, itemId).finally(() => this.opening.delete(key));
      this.opening.set(key, pending);
    }
    return pending;
  }

  private async load(sid: string, itemId: string): Promise<Book> {
    const local = this.downloads.findDone(itemId, sid)?.filePath;
    const file = local ?? (await this.fetch(sid, itemId));
    let entries: ZipEntry[];
    try {
      entries = await listEntries(file);
    } catch (err) {
      log.warn(`not a zip archive: ${itemId}`, err);
      // A cached copy that does not parse would fail forever; drop it so a later open refetches.
      if (!local) fs.rmSync(file, { force: true });
      throw new Error(t('errors.comics.unsupported'));
    }
    let pages = pageEntries(entries);
    const infoEntry = entries.find((e) => /(^|[\\/])comicinfo\.xml$/i.test(e.name));
    const info = infoEntry ? parseComicInfo((await readEntry(file, infoEntry).catch(() => Buffer.alloc(0))).toString('utf8')) : { meta: {}, pages: [] };
    // ComicInfo's Page/@Image indexes the sorted image list; "Deleted" pages are ads or scanner credits.
    const byIndex = new Map(info.pages.map((p) => [p.image, p]));
    const kept = pages.map((_, i) => i).filter((i) => !byIndex.get(i)?.deleted);
    if (kept.length > 0) pages = kept.map((i) => pages[i]);
    if (pages.length === 0) throw new Error(t('errors.comics.noPages'));
    const heads = await readHeads(file, pages);
    const dims = pages.map((_, k): ComicPage => {
      const ci = byIndex.get(kept[k] ?? k);
      const [width, height] = imageSize(heads[k]) ?? [ci?.width ?? 0, ci?.height ?? 0];
      return ci?.double ? { width, height, double: true } : { width, height };
    });
    const book = { file, pages, dims, meta: info.meta };
    this.books.set(`${sid}-${itemId}`, book);
    return book;
  }

  private async fetch(sid: string, itemId: string): Promise<string> {
    const file = path.join(this.dir, `${sid}-${itemId}.cbz`);
    if (fs.existsSync(file)) {
      // mtime is the LRU clock.
      const now = new Date();
      fs.utimesSync(file, now, now);
      return file;
    }
    const api = this.connection.apiFor(sid);
    fs.mkdirSync(this.dir, { recursive: true });
    // /File is what the servers' own readers use and needs no download right; /Download does.
    let res = await net.fetch(api.url(`/Items/${itemId}/File`), { headers: api.authHeaders() });
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      void res.body?.cancel();
      res = await net.fetch(api.url(`/Items/${itemId}/Download`), { headers: api.authHeaders() });
    }
    if (!res.ok || !res.body) throw new Error(res.status === 403 ? t('errors.comics.notAllowed') : `HTTP ${res.status}`);
    const part = `${file}.part`;
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(part));
    fs.renameSync(part, file);
    this.prune(file);
    return file;
  }

  // Least recently opened archives go once the cache passes its cap.
  private prune(keep: string): void {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.cbz'))
      .map((f) => {
        const file = path.join(this.dir, f);
        return { file, st: fs.statSync(file) };
      })
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    let total = 0;
    for (const { file, st } of files) {
      total += st.size;
      if (total <= this.capBytes() || file === keep) continue;
      try {
        fs.rmSync(file, { force: true });
      } catch {
        continue; // still being read; next prune gets it
      }
      for (const [id, b] of this.books) if (b.file === file) this.books.delete(id);
    }
  }
}
