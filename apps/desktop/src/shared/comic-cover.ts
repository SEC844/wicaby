import type { BaseItem } from './models';

// Same list as main/comics/formats.ts COMIC_EXTS (comic-formats-check keeps them equal).
export const COVER_EXTS = new Set(['cbz', 'zip', 'epub', 'cbr', 'rar', 'cb7', '7z', 'cbt', 'tar', 'pdf']);

// Comics the server has no cover for show their first page (wicaby-media://comic-cover): the
// formats the reader opens, or books whose list entry does not name the format. The returned
// version (Etag, else DateCreated) keys the cover cache; null: the server's art or nothing.
export function comicCoverVersion(item: BaseItem): string | null {
  if (item.Type !== 'Book' || item.ImageTags?.Primary) return null;
  const ext = (/\.([^.\/]+)$/.exec(item.Path ?? '')?.[1] ?? item.Container?.split(',')[0] ?? '').toLowerCase();
  if (ext && !COVER_EXTS.has(ext)) return null;
  return item.Etag ?? item.DateCreated ?? '';
}
