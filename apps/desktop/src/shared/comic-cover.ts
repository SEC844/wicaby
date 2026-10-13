import type { BaseItem } from './models';

// Comics the server has no cover for show their first page (wicaby-media://comic-cover):
// CBZ/ZIP books, or books whose list entry does not name the format. The returned
// version (Etag, else DateCreated) keys the cover cache; null: the server's art or nothing.
export function comicCoverVersion(item: BaseItem): string | null {
  if (item.Type !== 'Book' || item.ImageTags?.Primary) return null;
  const ext = (/\.([^.\/]+)$/.exec(item.Path ?? '')?.[1] ?? item.Container?.split(',')[0] ?? '').toLowerCase();
  if (ext && ext !== 'cbz' && ext !== 'zip') return null;
  return item.Etag ?? item.DateCreated ?? '';
}
