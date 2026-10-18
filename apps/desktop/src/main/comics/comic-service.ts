import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';
import { comicPageFromTicks, TICKS_PER_MS, type ComicInfo, type ComicPage } from '../../shared/contract';
import type { BaseItem } from '../../shared/models';
import { fetchFollowing } from '../connection/api-client';
import type { ConnectionManager } from '../connection/connection-manager';
import { userItem } from '../connection/user-routes';
import { logger } from '../core/log';
import { t } from '../i18n';
import type { DownloadManager } from '../downloads/download-manager';
import { archiveError, runArchiveJob, type ArchiveJob, type ArchiveResult } from './archive-job';
import { MAX_COMIC_INFO, parseComicInfo, type ComicMeta } from './comic-info';
import { download } from './download';
import { archiveName, epubPackage, epubPageImage, epubRootfile, formatOfExt, isTextBook, sniff } from './formats';
import { imageSize } from './image-size';
import type { PdfPages } from './pdf-pages';
import { coverEntry, httpSource, imageType, inFlightLimited, listEntries, listEntriesFrom, MAX_CD_SIZE, MAX_ENTRY_SIZE, pageEntries, rangeBody, readEntry, readEntryFrom, readHeads, type RangeFetch, type ZipEntry } from './zip';

const log = logger.scope('comics');

const CACHE_CAP = 2 * 1024 ** 3;
// A sanity cap on one book, not the cache size: the book just opened may exceed a small cache (prune keeps it).
const MAX_BOOK = 8 * 1024 ** 3;
// Thumbnails are decoded in main: 64 megapixels (256 MB of RGBA) at most.
const MAX_THUMB_PIXELS = 64 * 1024 * 1024;
// RAR, 7z and tar books are read whole into the archive worker's WebAssembly memory (2 GiB at most).
// shortcut: in-memory libarchive-wasm, so bigger books get errors.comics.tooLarge; a libarchive >= 3.8 WASM build with read callbacks would stream them.
const MAX_WASM_ARCHIVE = 1024 ** 3;
// Entries walked in one archive: as many as a 16 MiB ZIP central directory holds (MAX_CD_SIZE / 80 bytes).
const MAX_ARCHIVE_ENTRIES = MAX_CD_SIZE / 80;
// Page header bytes read for sizes, per page and for the whole book (as zip.ts readHeads).
const HEAD_BYTES = 64 * 1024;
const MAX_HEADS_TOTAL = 128 * 1024 * 1024;
// The most one comic-file request (pdf.js asks 256 KiB at a time) returns.
const MAX_FILE_RANGE = 16 * 1024 * 1024;
// A remote RAR or tar cover is the best page among the entries inside this first slice of the file
// (archivers store entries in name order, so page 1 is near the start).
// shortcut: a cover past the first 8 MiB, or any remote 7z cover (its index is at the end), shows the placeholder; read the end and seek when that matters.
const COVER_PREFIX = 8 * 1024 * 1024;
// A local RAR, 7z or tar up to this size is walked whole for its cover; a bigger one gives its first 8 MiB.
const COVER_LOCAL_WHOLE = 256 * 1024 * 1024;
// PDF pages are drawn this many pixels high (thumbnails 240).
// shortcut: a fixed height, so a scan finer than this is shown slightly softer; pass the window height when it matters.
const PDF_PAGE_HEIGHT = 2400;
// EPUB spine documents read at most (each one is a page).
const MAX_SPINE = 10_000;
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
// A book download with no byte for this long is given up.
const FETCH_IDLE = 60_000;
// The covers folder is listed and sized once every this many new covers.
const COVER_PRUNE_EVERY = 20;

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
  // The archive or PDF, or the folder an archive was extracted to.
  file: string;
  count: number;
  read(index: number): Promise<Buffer>;
  // Page names for imageType (archives).
  name(index: number): string;
  dims: ComicPage[];
  meta: ComicMeta;
  // PDF books: the wicaby-media://comic-file URL the page renderer reads.
  pdf?: string;
}

// A page of a book whose bytes are a file in an extraction folder.
interface DirPage {
  name: string;
  file: string;
}

const isDir = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

async function fileHead(file: string, length = 1024): Promise<Buffer> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// A failure of the network or the server (tried again later), not of the book.
function transientError(err: unknown): boolean {
  const e = err as { name?: string; status?: unknown; message?: unknown } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'TypeError') return true;
  if (typeof e?.status === 'number' && (e.status === 0 || e.status >= 500)) return true;
  return typeof e?.message === 'string' && /^net::|^(timeout|aborted)$/i.test(e.message);
}

// What a failed archive read tells the user.
function bookError(err: unknown): Error {
  const code = (err as { code?: string }).code;
  if (code === 'encrypted') return new Error(t('errors.comics.encrypted'));
  if (code === 'tooLarge') return new Error(t('errors.comics.tooLarge'));
  if (code === 'textBook') return new Error(t('errors.comics.textBook'));
  if (code === 'noPages') return new Error(t('errors.comics.noPages'));
  return new Error(t('errors.comics.unsupported'));
}

// EPUB: the spine documents' images in reading order. coverOnly: the cover (the manifest's
// cover-image, else page 1) without reading the rest of the spine (a cover read with Range requests).
async function epubBook(entries: ZipEntry[], read: (e: ZipEntry) => Promise<Buffer>, coverOnly = false): Promise<{ pages: ZipEntry[]; title?: string; cover?: ZipEntry }> {
  const byName = new Map(entries.map((e) => [e.name, e]));
  // A stored entry reads compressedSize bytes whatever size it declares: both are capped, and the spine
  // reads share one budget (a hostile book repeating one huge document must not stall main).
  let budget = 64 * 1024 * 1024;
  const text = async (name: string, metered = false) => {
    const e = byName.get(name);
    if (!e || e.size > MAX_COMIC_INFO * 4 || e.compressedSize > MAX_COMIC_INFO * 4 || (metered && budget <= 0)) return null;
    if (metered) budget -= Math.max(e.size, e.compressedSize);
    return (await read(e)).toString('utf8');
  };
  const rootfile = epubRootfile((await text('META-INF/container.xml')) ?? '');
  const opf = rootfile ? await text(rootfile) : null;
  if (!rootfile || !opf) throw archiveError('corrupt', 'no EPUB package');
  const pkg = epubPackage(opf, rootfile);
  const coverByManifest = pkg.cover ? byName.get(pkg.cover) : undefined;
  if (coverOnly && coverByManifest) return { pages: [], cover: coverByManifest };
  const pages: ZipEntry[] = [];
  const spine = [...new Set(pkg.spine)].slice(0, MAX_SPINE);
  for (const doc of spine) {
    const xhtml = await text(doc, true);
    const img = xhtml ? epubPageImage(xhtml, doc, pkg.fixedLayout) : null;
    const e = img ? byName.get(img) : undefined;
    if (e) pages.push(e);
    if (coverOnly && e) return { pages, cover: e };
  }
  if (isTextBook(spine.length, pages.length)) throw Object.assign(new Error('text book'), { code: 'textBook' });
  // DRM: pages listed in encryption.xml cannot be shown (fonts obfuscated there are fine).
  const enc = await text('META-INF/encryption.xml');
  if (enc && pages.some((p) => enc.includes(p.name.slice(p.name.lastIndexOf('/') + 1)))) throw archiveError('encrypted');
  return { pages, title: pkg.title, cover: coverByManifest ?? pages[0] };
}

function archiveExt(item: BaseItem): string {
  const p = item.Path ?? item.MediaSources?.[0]?.Path ?? '';
  const ext = path.win32.extname(p).slice(1).toLowerCase();
  return ext || (item.Container ?? item.MediaSources?.[0]?.Container ?? '').split(',')[0].toLowerCase();
}

// Where the archive worker and the PDF page renderer come from (index.ts; the checks pass their own).
export interface ComicEngines {
  // The bundled archive-worker.cjs source (started with eval: it may sit inside app.asar) and libarchive.wasm.
  archiveWorker: () => { script: string | URL; evaluate: boolean; wasm?: Uint8Array };
  pdf: Pick<PdfPages, 'info' | 'render'>;
}

// Comic reader backend: the book is fetched once through /Items/{id}/File (or read from an
// offline copy) and its pages are served by wicaby-media://comic/<id>/<page>, so the token stays
// in main. CBZ and EPUB pages come from the ZIP central directory, RAR, 7z and tar books are
// extracted once into <cache>/<sid>-<id>.d (RAR and solid 7z only read in order), and PDF pages
// are drawn by pdf-pages.ts.
export class ComicService {
  private books = new Map<string, Book>();
  private opening = new Map<string, Promise<Book>>();
  private readonly coversDir: string;
  private coverJobs = 0;
  private coverQueue: (() => void)[] = [];
  private coverPending = new Map<string, Promise<Buffer | null>>();
  // Books without a usable first page, not tried again this session.
  private coverFailed = new Set<string>();
  private coverWrites = 0;

  constructor(
    private readonly dir: string,
    private readonly connection: ConnectionManager,
    private readonly downloads: DownloadManager,
    // "Taille maximale du cache des BD" (settings.system.comicCacheGb).
    private readonly capBytes: () => number = () => CACHE_CAP,
    private readonly engines?: ComicEngines,
  ) {
    this.coversDir = path.join(dir, 'covers');
    // A fetch or extraction cut by a quit or crash leaves its .part; none is in use yet at startup.
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.part')) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
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
    // A known extension we do not read (.mobi, .djvu...) fails before the download; the bytes decide the rest.
    const ext = archiveExt(item);
    if (ext && !formatOfExt(ext)) throw new Error(t('errors.comics.unsupported'));
    const book = await this.book(sid, itemId);
    const start = item.UserData?.Played ? 0 : comicPageFromTicks(item.UserData?.PlaybackPositionTicks);
    return { pageCount: book.count, title: item.Name, startPage: Math.min(start, book.count - 1), pages: book.dims, meta: book.meta };
  }

  async page(itemId: string, index: number, thumb = false, serverId?: string): Promise<{ data: Buffer; type: string } | null> {
    if (!ID.test(itemId) || (serverId !== undefined && !ID.test(serverId))) return null;
    const book = await this.book(this.sid(serverId), itemId);
    if (!Number.isInteger(index) || index < 0 || index >= book.count) return null;
    if (book.pdf) return { data: await this.pdfEngine().render(book.pdf, index, thumb ? 240 : PDF_PAGE_HEIGHT), type: 'image/jpeg' };
    const data = await book.read(index);
    const type = imageType(book.name(index));
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
      const data = await fs.promises.readFile(file);
      const now = new Date();
      void fs.promises.utimes(file, now, now).catch(() => undefined); // mtime is the LRU clock
      return { data, type: coverType(data) };
    } catch {
      // not generated yet
    }
    if (this.coverFailed.has(key)) return null;
    let pending = this.coverPending.get(key);
    if (!pending) {
      pending = this.coverSlot(signal, () => this.makeCover(sid, itemId, COVER_HEIGHT, signal))
        .then((data) => {
          void this.saveCover(`${sid}-${itemId}-`, file, data);
          return data;
        })
        .catch((err: unknown) => {
          // A card scrolled away, a slow or unreachable server, a 5xx: tried again next time; a book without a cover is not.
          if (!signal?.aborted && !transientError(err)) this.coverFailed.add(key);
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
    const local = this.localCopy(sid, itemId);
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(COVER_TIMEOUT)]) : AbortSignal.timeout(COVER_TIMEOUT);
    const data = local ? await this.localCover(sid, itemId, local, height) : await this.remoteCover(sid, itemId, height, sig);
    const dims = imageSize(data);
    const type = coverType(data);
    if (dims && dims[0] * dims[1] <= MAX_THUMB_PIXELS && (type === 'image/png' || type === 'image/jpeg')) {
      const img = nativeImage.createFromBuffer(data);
      if (!img.isEmpty()) return img.resize({ height: Math.min(height, dims[1]), quality: 'good' }).toJPEG(85);
    }
    if (data.length > COVER_MAX_RAW) throw new Error('cover page too large to keep');
    return data;
  }

  // The book's bytes on this machine: an offline copy, the cached file, or the folder it was extracted to.
  private localCopy(sid: string, itemId: string): string | undefined {
    const key = `${sid}-${itemId}`;
    return [this.downloads.findDone(itemId, sid)?.filePath, this.books.get(key)?.file, path.join(this.dir, `${key}.book`), path.join(this.dir, `${key}.d`)].find((p): p is string => Boolean(p && fs.existsSync(p)));
  }

  private async localCover(sid: string, itemId: string, file: string, height: number): Promise<Buffer> {
    if (isDir(file)) {
      const page = coverEntry(fs.readdirSync(file).map((f): DirPage => ({ name: archiveName(f), file: path.join(file, f) })));
      if (!page || fs.statSync(page.file).size > COVER_MAX_ENTRY) throw new Error('no cover page');
      return fs.promises.readFile(page.file);
    }
    const format = sniff(await fileHead(file));
    if (format === 'zip' || format === 'epub') return this.zipCover(await listEntries(file), (e) => readEntry(file, e));
    if (format === 'pdf') return this.pdfEngine().render(this.fileUrl(sid, itemId), 0, height);
    if (!format) throw new Error('not a comic book');
    const whole = fs.statSync(file).size <= COVER_LOCAL_WHOLE;
    return this.archiveCover(whole ? await fs.promises.readFile(file) : await fileHead(file, COVER_PREFIX), !whole);
  }

  // With Range requests: the end of the file first (a ZIP's central directory, or a PDF's trailer), then
  // the cover entry; or the first 8 MiB of a RAR or tar. A server that ignores Range is refused (httpSource).
  private async remoteCover(sid: string, itemId: string, height: number, signal: AbortSignal): Promise<Buffer> {
    const src = await httpSource(this.rangeGet(sid, itemId, signal));
    const entries = await listEntriesFrom(src).catch(() => null);
    if (entries) return this.zipCover(entries, (e) => readEntryFrom(src, e));
    const tailLen = Math.min(src.size, 1024);
    if ((await src.read(src.size - tailLen, tailLen)).includes('%%EOF')) return this.pdfEngine().render(this.fileUrl(sid, itemId), 0, height);
    // The magic first: a 7z (index at the end) or an unknown file costs 1 KiB, not 8 MiB.
    const format = sniff(await src.read(0, Math.min(src.size, 1024)));
    if (format !== 'rar' && format !== 'tar') throw new Error(`no remote cover for ${format ?? 'this file'}`);
    const head = await src.read(0, Math.min(src.size, COVER_PREFIX));
    return this.archiveCover(head, src.size > head.length);
  }

  private async zipCover(entries: ZipEntry[], read: (e: ZipEntry) => Promise<Buffer>): Promise<Buffer> {
    const epub = entries.some((e) => e.name === 'META-INF/container.xml');
    const e = epub ? (await epubBook(entries, read, true)).cover : coverEntry(entries);
    if (!e || e.size > COVER_MAX_ENTRY) throw new Error('no cover page');
    return read(e);
  }

  private async archiveCover(data: Uint8Array, partial: boolean): Promise<Buffer> {
    const found = await this.runArchive({ mode: 'cover', data, partial, limits: { maxEntry: COVER_MAX_ENTRY, maxTotal: 2 * COVER_PREFIX, maxEntries: MAX_ARCHIVE_ENTRIES } });
    if (!('data' in found)) throw new Error('no cover page');
    return Buffer.from(found.data);
  }

  // GET /Items/{id}/File with a Range header, as the servers' own readers do; /Download (needs the
  // download right) once /File is refused.
  private rangeGet(sid: string, itemId: string, signal?: AbortSignal): RangeFetch {
    const api = this.connection.apiFor(sid);
    let route = 'File';
    const get = async (range: string): Promise<Response> => {
      const res = (await fetchFollowing(api, api.url(`/Items/${itemId}/${route}`), { method: 'GET', headers: { Range: range }, auth: api.authHeaders(), signal })) ?? new Response(null, { status: 502 });
      if (route === 'Download' || ![401, 403, 404].includes(res.status)) return res;
      void res.body?.cancel();
      route = 'Download';
      return get(range);
    };
    return get;
  }

  private fileUrl(sid: string, itemId: string): string {
    return `wicaby-media://comic-file/${sid}/${itemId}`;
  }

  private pdfEngine(): ComicEngines['pdf'] {
    if (!this.engines) throw archiveError('corrupt', 'no PDF renderer');
    return this.engines.pdf;
  }

  private runArchive(job: ArchiveJob): Promise<ArchiveResult> {
    if (!this.engines) throw archiveError('corrupt', 'no archive worker');
    const w = this.engines.archiveWorker();
    return runArchiveJob(w.script, w.evaluate, { ...job, wasm: w.wasm });
  }

  // wicaby-media://comic-file/<sid>/<id>: the book's bytes for the PDF page renderer, one explicit
  // range at a time, from the local copy or from the server (the token stays in main).
  async file(itemId: string, range: string | null, serverId?: string, signal?: AbortSignal): Promise<Response> {
    if (!ID.test(itemId) || (serverId !== undefined && !ID.test(serverId))) return new Response(null, { status: 404 });
    const sid = this.sid(serverId);
    const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    const start = Number(m?.[1]);
    let end = Number(m?.[2]);
    if (!m || end < start || end - start >= MAX_FILE_RANGE) return new Response(null, { status: 416 });
    const local = this.localCopy(sid, itemId);
    let body: Buffer;
    let size: number;
    if (local && !isDir(local)) {
      const fh = await fs.promises.open(local, 'r');
      try {
        size = (await fh.stat()).size;
        if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        end = Math.min(end, size - 1);
        body = Buffer.alloc(end - start + 1);
        await fh.read(body, 0, body.length, start);
      } finally {
        await fh.close();
      }
    } else {
      const res = await this.rangeGet(sid, itemId, signal)(`bytes=${start}-${end}`);
      const total = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1];
      if (res.status !== 206 || !total) {
        void res.body?.cancel();
        return new Response(null, { status: 502 });
      }
      size = Number(total);
      body = await rangeBody(res, end - start + 1);
    }
    return new Response(new Uint8Array(body), {
      status: 206,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length), 'Content-Range': `bytes ${start}-${start + body.length - 1}/${size}` },
    });
  }

  // Older versions of the same cover go at once; the rest by LRU past COVER_CACHE_CAP.
  private async saveCover(prefix: string, file: string, data: Buffer): Promise<void> {
    try {
      await fs.promises.mkdir(this.coversDir, { recursive: true });
      await fs.promises.writeFile(file, data);
      const names = await fs.promises.readdir(this.coversDir);
      const old = names.filter((f) => f.startsWith(prefix) && path.join(this.coversDir, f) !== file);
      await Promise.all(old.map((f) => fs.promises.rm(path.join(this.coversDir, f), { force: true })));
      if (++this.coverWrites % COVER_PRUNE_EVERY !== 0) return;
      const all = (
        await Promise.all(
          names.map(async (n) => {
            const f = path.join(this.coversDir, n);
            return { f, st: await fs.promises.stat(f).catch(() => null) };
          }),
        )
      ).sort((a, b) => (b.st?.mtimeMs ?? 0) - (a.st?.mtimeMs ?? 0));
      let total = 0;
      for (const { f, st } of all) {
        if (!st) continue;
        total += st.size;
        if (f !== file && total > COVER_CACHE_CAP) await fs.promises.rm(f, { force: true });
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
    const key = `${sid}-${itemId}`;
    const dir = path.join(this.dir, `${key}.d`);
    let book: Book;
    if (isDir(dir)) {
      // Extracted earlier: the pages are files already, nothing to download. mtime is the LRU clock.
      const now = new Date();
      fs.utimesSync(dir, now, now);
      book = await dirBook(dir).catch((err: unknown) => {
        throw bookError(err);
      });
    } else {
      const local = this.downloads.findDone(itemId, sid)?.filePath;
      const file = local ?? (await this.fetch(sid, itemId));
      try {
        const format = sniff(await fileHead(file));
        if (format === 'zip' || format === 'epub') book = await zipBook(file, format);
        else if (format === 'pdf') book = await this.pdfBook(sid, itemId, file);
        else if (format) {
          await this.runArchive({ mode: 'extract', file, dir, maxArchive: MAX_WASM_ARCHIVE, limits: { maxEntry: MAX_ENTRY_SIZE, maxTotal: Math.max(this.capBytes(), MAX_BOOK), maxEntries: MAX_ARCHIVE_ENTRIES } });
          // The pages are files now: the cached archive is not needed again (an offline copy stays).
          if (!local) fs.rmSync(file, { force: true });
          book = await dirBook(dir);
          this.prune(dir);
        } else throw archiveError('corrupt', 'not a comic book');
      } catch (err) {
        log.warn(`cannot read book ${itemId}`, err);
        // A cached copy that does not parse would fail forever; drop it so a later open refetches.
        if (!local) fs.rmSync(file, { force: true });
        throw bookError(err);
      }
    }
    this.books.set(key, book);
    // A 7z or PDF has no remote cover; now that a local copy exists, the next card asks again.
    for (const k of this.coverFailed) if (k.startsWith(`${key}-`)) this.coverFailed.delete(k);
    return book;
  }

  private async pdfBook(sid: string, itemId: string, file: string): Promise<Book> {
    const url = this.fileUrl(sid, itemId);
    const { count, sizes } = await this.pdfEngine().info(url);
    if (!count) throw Object.assign(new Error('no pages'), { code: 'noPages' });
    const dims = Array.from({ length: count }, (_, i): ComicPage => ({ width: sizes[i]?.[0] ?? 0, height: sizes[i]?.[1] ?? 0 }));
    return { file, count, dims, meta: {}, pdf: url, name: () => 'page.jpg', read: () => Promise.reject(new Error('PDF pages are drawn')) };
  }

  private async fetch(sid: string, itemId: string): Promise<string> {
    const file = path.join(this.dir, `${sid}-${itemId}.book`);
    if (fs.existsSync(file)) {
      // mtime is the LRU clock.
      const now = new Date();
      fs.utimesSync(file, now, now);
      return file;
    }
    const api = this.connection.apiFor(sid);
    fs.mkdirSync(this.dir, { recursive: true });
    const part = `${file}.part`;
    await download(
      async (signal) => {
        // /File is what the servers' own readers use and needs no download right; /Download does.
        const get = (route: string) => fetchFollowing(api, api.url(`/Items/${itemId}/${route}`), { method: 'GET', headers: {}, auth: api.authHeaders(), signal });
        let res = await get('File');
        if (res?.status === 401 || res?.status === 403 || res?.status === 404) {
          void res.body?.cancel();
          res = await get('Download');
        }
        if (!res?.ok || !res.body) throw new Error(res?.status === 403 ? t('errors.comics.notAllowed') : `HTTP ${res?.status ?? 502}`);
        return res.body;
      },
      part,
      Math.max(this.capBytes(), MAX_BOOK),
      FETCH_IDLE,
      { tooLarge: t('errors.comics.tooLarge'), stalled: t('errors.comics.stalled') },
    );
    fs.renameSync(part, file);
    this.prune(file);
    return file;
  }

  // Least recently opened books (cached files and extraction folders) go once the cache passes its cap.
  private prune(keep: string): void {
    const books = fs
      .readdirSync(this.dir)
      .filter((f) => /\.(book|cbz|d)$/.test(f))
      .map((f) => {
        const file = path.join(this.dir, f);
        const st = fs.statSync(file);
        return { file, mtime: st.mtimeMs, size: st.isDirectory() ? folderBytes(file) : st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
    let total = 0;
    for (const { file, size } of books) {
      total += size;
      if (total <= this.capBytes() || file === keep) continue;
      try {
        fs.rmSync(file, { recursive: true, force: true });
      } catch {
        continue; // still being read; next prune gets it
      }
      for (const [id, b] of this.books) if (b.file === file) this.books.delete(id);
    }
  }
}

// Bytes in a flat folder (an extracted book).
export function folderBytes(dir: string): number {
  let n = 0;
  for (const f of fs.readdirSync(dir)) n += fs.statSync(path.join(dir, f), { throwIfNoEntry: false })?.size ?? 0;
  return n;
}

const isInfo = (name: string) => /(^|[\\/])comicinfo\.xml$/i.test(name);

// The reading order shared by every format: ComicInfo's Page/@Image indexes the sorted image list,
// "Deleted" pages (ads, scanner credits) go, DoublePage marks spreads, header sizes give the dims.
async function bookOf<T extends { name: string }>(
  file: string,
  sorted: T[],
  infoXml: string | null,
  meta: ComicMeta,
  heads: (pages: T[]) => Promise<Buffer[]>,
  read: (page: T) => Promise<Buffer>,
): Promise<Book> {
  const info = infoXml ? parseComicInfo(infoXml) : { meta: {}, pages: [] };
  const byIndex = new Map(info.pages.map((p) => [p.image, p]));
  const kept = sorted.map((_, i) => i).filter((i) => !byIndex.get(i)?.deleted);
  const pages = kept.length > 0 ? kept.map((i) => sorted[i]) : sorted;
  if (pages.length === 0) throw Object.assign(new Error('no pages'), { code: 'noPages' });
  const h = await heads(pages);
  const dims = pages.map((_, k): ComicPage => {
    const ci = byIndex.get(kept[k] ?? k);
    const [width, height] = imageSize(h[k]) ?? [ci?.width ?? 0, ci?.height ?? 0];
    return ci?.double ? { width, height, double: true } : { width, height };
  });
  return { file, count: pages.length, dims, meta: { ...meta, ...info.meta }, name: (i) => pages[i].name, read: (i) => read(pages[i]) };
}

async function zipBook(file: string, format: 'zip' | 'epub'): Promise<Book> {
  const entries = await listEntries(file).catch((err: Error) => {
    throw archiveError('corrupt', err.message);
  });
  const read = (e: ZipEntry) => readEntry(file, e);
  if (format === 'epub') {
    const { pages, title } = await epubBook(entries, read);
    return bookOf(file, pages, null, title ? { title } : {}, (p) => readHeads(file, p), read);
  }
  const infoEntry = entries.find((e) => isInfo(e.name));
  const info = infoEntry ? (await readEntry(file, infoEntry).catch(() => Buffer.alloc(0))).toString('utf8') : null;
  return bookOf(file, pageEntries(entries), info, {}, (p) => readHeads(file, p), read);
}

// An extracted archive: flatName files, pages sorted by their names in the archive.
async function dirBook(dir: string): Promise<Book> {
  const files = fs.readdirSync(dir).map((f): DirPage => ({ name: archiveName(f), file: path.join(dir, f) }));
  const infoFile = files.find((f) => isInfo(f.name));
  const info = infoFile && fs.statSync(infoFile.file).size <= MAX_COMIC_INFO ? fs.readFileSync(infoFile.file, 'utf8') : null;
  const heads = async (pages: DirPage[]) => {
    const out: Buffer[] = [];
    let budget = MAX_HEADS_TOTAL;
    for (const p of pages) {
      const head = budget > 0 ? await fileHead(p.file, HEAD_BYTES) : Buffer.alloc(0);
      budget -= head.length;
      out.push(head);
    }
    return out;
  };
  const read = async (p: DirPage) => {
    const size = (await fs.promises.stat(p.file)).size;
    if (size > MAX_ENTRY_SIZE) throw new Error('page too large');
    return inFlightLimited(size, () => fs.promises.readFile(p.file));
  };
  return bookOf(dir, pageEntries(files), info, {}, heads, read);
}
