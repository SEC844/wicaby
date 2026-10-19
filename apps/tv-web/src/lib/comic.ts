// A comic book for the reader (Android core comics/Comics.kt, ComicPages.kt): CBZ, ZIP and image EPUB read over
// Range requests (lib/zip.ts), the pages in natural order without folders, resource forks or hidden files, the
// ComicInfo.xml flags (manga order, long strip, deleted ad pages), page images as object URLs kept for the pages
// around the one read, and the progress the jellyfin-web way (the 0-based page as PlaybackPositionTicks / 10,000), so
// every client resumes everyone's. RAR, 7z, tar and PDF need decoders the TV has not: the reader says so.
import type { BaseItem } from '$shared/models';
import type { Api } from './api';
import { Zip, ZipError, type Entry } from './zip';

export type ComicFailure = 'unsupported' | 'encrypted' | 'text-book' | 'too-large' | 'no-pages' | 'forbidden' | 'load';

export class ComicError extends Error {
  constructor(readonly kind: ComicFailure) {
    super(kind);
  }
}

const IMAGE = /\.(jpe?g|jpe|jfif|png|webp|gif|bmp)$/i;
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };
const KEEP = 8;
export const TICKS_PER_PAGE = 10_000;

export const isPage = (name: string): boolean => !name.endsWith('/') && IMAGE.test(name) && !name.split(/[\\/]/).some((p) => p === '__MACOSX' || p.startsWith('.'));

// Natural order (Intl.Collator numeric): "2.jpg" before "10.jpg", case-insensitive.
export function natural(a: string, b: string): number {
  const x = a.match(/\d+|\D+/g) ?? [];
  const y = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    let c: number;
    if (/^\d/.test(p) && /^\d/.test(q)) {
      const pt = p.replace(/^0+/, '');
      const qt = q.replace(/^0+/, '');
      c = pt.length !== qt.length ? pt.length - qt.length : pt < qt ? -1 : pt > qt ? 1 : 0;
    } else {
      const pl = p.toLowerCase();
      const ql = q.toLowerCase();
      c = pl < ql ? -1 : pl > ql ? 1 : 0;
    }
    if (c) return c;
  }
  return x.length !== y.length ? x.length - y.length : a < b ? -1 : a > b ? 1 : 0;
}

export function extension(item: BaseItem): string {
  const path = item.Path ?? item.MediaSources?.[0]?.Path ?? '';
  const m = /\.([^.\\/]+)$/.exec(path);
  return (m?.[1] ?? item.Container?.split(',')[0] ?? item.MediaSources?.[0]?.Container ?? '').toLowerCase();
}

export interface PageSize {
  width: number;
  height: number;
}

export class ComicBook {
  pages: Entry[] = [];
  rtl = false;
  webtoon = false;
  // Pages ComicInfo marks as double spreads.
  readonly doubles = new Set<number>();
  private readonly urls = new Map<number, string>();
  private readonly pending = new Map<number, Promise<string>>();
  private order: number[] = [];

  constructor(private readonly zip: Zip) {}

  static async open(api: Api, item: BaseItem): Promise<ComicBook> {
    const ext = extension(item);
    if (ext && !['cbz', 'zip', 'epub'].includes(ext)) throw new ComicError('unsupported');
    const zip = new Zip(api.url(`/Items/${item.Id}/File`), api.authHeaders());
    try {
      await zip.open();
    } catch (e) {
      throw new ComicError(e instanceof ZipError ? (e.kind === 'http' ? 'load' : e.kind === 'format' ? 'unsupported' : e.kind) : 'load');
    }
    const book = new ComicBook(zip);
    let pages = zip.entries.filter((e) => isPage(e.name)).sort((a, b) => natural(a.name, b.name));
    const info = zip.find('ComicInfo.xml');
    if (info) {
      const xml = new TextDecoder('utf-8').decode(await zip.read(info).catch(() => new Uint8Array()));
      book.rtl = /<Manga>\s*YesAndRightToLeft\s*<\/Manga>/i.test(xml);
      book.webtoon = /<Format>\s*(Web|Webtoon|Web Comic)\s*<\/Format>/i.test(xml);
      // Page/@Image indexes the sorted image list: Deleted pages (ads, scanner credits) go, DoublePage ones stand alone.
      const gone = new Set<number>();
      const double = new Set<number>();
      const tag = /<Page\b[^>]*>/gi;
      for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
        const n = /Image\s*=\s*"(\d+)"/i.exec(m[0]);
        if (!n) continue;
        if (/Type\s*=\s*"Deleted?"/i.test(m[0])) gone.add(Number(n[1]));
        if (/DoublePage\s*=\s*"true"/i.test(m[0])) double.add(Number(n[1]));
      }
      const kept = pages.map((_, i) => i).filter((i) => !gone.has(i));
      kept.forEach((i, k) => double.has(i) && book.doubles.add(k));
      pages = kept.map((i) => pages[i]);
    }
    if (!pages.length) throw new ComicError(ext === 'epub' ? 'text-book' : 'no-pages');
    book.pages = pages;
    return book;
  }

  // The page as an object URL; the few around the page read stay, the rest are released.
  page(i: number): Promise<string> {
    const have = this.urls.get(i);
    if (have) return Promise.resolve(have);
    let p = this.pending.get(i);
    if (!p) {
      const e = this.pages[i];
      p = this.zip.read(e).then((bytes) => {
        const ext = /\.([^.]+)$/.exec(e.name)?.[1]?.toLowerCase() ?? 'jpg';
        const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIME[ext] ?? 'image/jpeg' }));
        this.urls.set(i, url);
        this.order.push(i);
        while (this.order.length > KEEP) {
          const old = this.order.shift()!;
          const u = this.urls.get(old);
          if (u) URL.revokeObjectURL(u);
          this.urls.delete(old);
        }
        return url;
      });
      this.pending.set(i, p);
      void p.finally(() => this.pending.delete(i)).catch(() => {});
    }
    return p;
  }

  // The page's URL if it is already decoded into one.
  ready(i: number): string | undefined {
    return this.urls.get(i);
  }

  close(): void {
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
    this.order = [];
  }
}

// Komga's pairing (Android ComicPages.spreads): the cover, the last page and wide pages stand alone, the rest go two
// by two. Unknown sizes count as portrait.
export function spreads(sizes: (PageSize | undefined)[], n: number, double: boolean): number[][] {
  const wide = (i: number) => {
    const s = sizes[i];
    return !!s && s.width > s.height;
  };
  const out: number[][] = [];
  for (let i = 0; i < n; ) {
    if (!double || i === 0 || i + 1 >= n - 1 || wide(i) || wide(i + 1)) out.push([i++]);
    else {
      out.push([i, i + 1]);
      i += 2;
    }
  }
  return out;
}

// A long strip: a median height / width above 2.5 (Mihon's rule), from the sizes known.
export function looksWebtoon(sizes: (PageSize | undefined)[]): boolean {
  const r = sizes.filter((s): s is PageSize => !!s && s.width > 0).map((s) => s.height / s.width).sort((a, b) => a - b);
  return r.length >= 3 && r[r.length >> 1] > 2.5;
}

// Where to open: the saved page, or the start of a book already read. Small raw values written by other clients are
// pages already.
export function startPage(item: BaseItem, pageCount: number): number {
  const ud = item.UserData;
  if (!ud || ud.Played || pageCount <= 0) return 0;
  const ticks = ud.PlaybackPositionTicks ?? 0;
  const page = ticks <= 0 ? 0 : ticks >= TICKS_PER_PAGE ? Math.round(ticks / TICKS_PER_PAGE) : ticks;
  return Math.max(0, Math.min(pageCount - 1, page));
}

// The UserData write (never Sessions/Playing: the server would mark a runtime-less item played and zero it).
// Reaching the last page marks the book read.
export async function saveProgress(api: Api, id: string, page: number, pageCount: number): Promise<void> {
  const played = pageCount > 0 && page >= pageCount - 1;
  const body = {
    PlaybackPositionTicks: played ? 0 : Math.max(0, page) * TICKS_PER_PAGE,
    Played: played,
    PlayedPercentage: played ? 100 : Math.round((10000 * (page + 1)) / Math.max(1, pageCount)) / 100,
    LastPlayedDate: new Date().toISOString(),
  };
  const legacy = `/Users/${api.userId}/Items/${id}/UserData`;
  if (api.isEmby) return api.post(legacy, body);
  await api.post(`/UserItems/${id}/UserData`, body, { userId: api.userId }).catch(() => api.post(legacy, body));
}
