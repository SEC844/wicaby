// The sidebar's sections by media type (.dev/sidebar-redesign-spec.md §3): one table maps a library's
// CollectionType to its group and glyph. The glyph encodes the type, never the library. Unknown types land in
// Other, the only place the generic folder glyph remains. Checked by tools/checks/sidebar-groups-check.mjs.
import type { IconName } from '../components/Icon.svelte';

export const GROUPS = ['watch', 'live', 'music', 'photos', 'books', 'files', 'other'] as const;
export type GroupId = (typeof GROUPS)[number];

const TYPES: Record<string, [GroupId, IconName]> = {
  movies: ['watch', 'film'], // i18n-ignore (icon name)
  tvshows: ['watch', 'tv'],
  // Emby and Jellyfin "mixed content" folders are almost always video (documentaries and the like).
  mixed: ['watch', 'trailer'],
  folders: ['watch', 'trailer'],
  '': ['watch', 'trailer'],
  boxsets: ['watch', 'collection'],
  trailers: ['watch', 'trailer'],
  // The app opens home videos as the photo timeline (Library.svelte), so they sit with the photos.
  homevideos: ['photos', 'images'],
  photos: ['photos', 'images'],
  music: ['music', 'music'],
  musicvideos: ['music', 'monitorPlay'],
  // Only reached when there is no music library: otherwise the view is the target of All Playlists.
  playlists: ['other', 'list'],
  // Closed book for both, so the two book types read as one family (BookOpen elsewhere in the app is fine).
  books: ['books', 'bookClosed'],
  audiobooks: ['books', 'bookHeadphones'],
};

export function libraryKind(type?: string | null): [GroupId, IconName] {
  return TYPES[(type ?? '').toLowerCase()] ?? ['other', 'folder'];
}

// Library rows in server order then view order. Live TV views are never rows (they turn on the Live TV group); the
// playlists view of the server All Playlists targets (playlistsServer) is not a row, any other server's stays one.
export function libraryRows<T extends { CollectionType?: string | null; ServerId?: string }>(
  libs: T[],
  playlistsServer?: string,
): { group: GroupId; icon: IconName; lib: T }[] {
  const type = (l: T) => (l.CollectionType ?? '').toLowerCase();
  return libs
    .filter((l) => type(l) !== 'livetv' && !(playlistsServer && type(l) === 'playlists' && l.ServerId === playlistsServer))
    .map((lib) => {
      const [group, icon] = libraryKind(lib.CollectionType);
      return { group, icon, lib };
    });
}
