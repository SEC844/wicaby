// Library administration over the IPC API proxy, for one server.
// Emby and Jellyfin share the /Library/VirtualFolders family but differ in how
// a folder is addressed (Emby: Id in the body, Jellyfin: name in the query),
// in a few verbs (Emby prefers POST …/Delete) and in some LibraryOptions fields.
import type { Query, ServerKind } from '../../../shared/contract';
import { w } from '../../lib/bridge';
import { sessionFor } from '../../lib/stores.svelte';

export interface PathInfo {
  Path: string;
  NetworkPath?: string | null;
}

export interface TypeOptions {
  Type: string;
  MetadataFetchers?: string[];
  MetadataFetcherOrder?: string[];
  ImageFetchers?: string[];
  ImageFetcherOrder?: string[];
  ImageOptions?: unknown[];
  [k: string]: unknown;
}

// Superset of both servers. The editor posts back the object it read, so the
// fields Wicaby does not show survive a save.
export interface LibraryOptions {
  PathInfos?: PathInfo[];
  TypeOptions?: TypeOptions[];
  PreferredMetadataLanguage?: string | null;
  MetadataCountryCode?: string | null;
  SubtitleDownloadLanguages?: string[];
  DisabledSubtitleFetchers?: string[];
  SubtitleFetcherOrder?: string[];
  [k: string]: unknown;
}

export interface VirtualFolder {
  Name: string;
  Locations?: string[];
  CollectionType?: string | null;
  LibraryOptions?: LibraryOptions;
  ItemId?: string;
  // Emby only: the folder id its write endpoints expect.
  Id?: string;
  Guid?: string;
  RefreshProgress?: number | null;
  RefreshStatus?: string | null;
}

export interface FsEntry {
  Name: string;
  Path: string;
  // Directory, File, NetworkComputer, NetworkShare.
  Type: string;
}

export interface TaskInfo {
  Id: string;
  Name: string;
  Key?: string;
  State: 'Idle' | 'Running' | 'Cancelling' | string;
  CurrentProgressPercentage?: number | null;
  LastExecutionResult?: { StartTimeUtc?: string; EndTimeUtc?: string; Status?: string } | null;
}

export interface OptionInfo {
  Name: string;
  DefaultEnabled: boolean;
}

export interface AvailableOptions {
  MetadataSavers?: OptionInfo[];
  MetadataReaders?: OptionInfo[];
  SubtitleFetchers?: OptionInfo[];
  TypeOptions?: { Type: string; MetadataFetchers?: OptionInfo[]; ImageFetchers?: OptionInfo[] }[];
}

export interface Culture {
  Name?: string;
  DisplayName: string;
  TwoLetterISOLanguageName: string;
  ThreeLetterISOLanguageName?: string;
}

export interface Country {
  Name?: string;
  DisplayName: string;
  TwoLetterISORegionName: string;
}

export interface ServerPaths {
  ProgramDataPath?: string;
  CachePath?: string;
  InternalMetadataPath?: string;
  MetadataPath?: string;
  TranscodingTempPath?: string;
  LogPath?: string;
  ItemsByNamePath?: string;
}

// Content types offered when creating a library. '' is Emby's "mixed" (no
// collection type); Jellyfin has an explicit 'mixed'.
export const CONTENT_TYPES: Record<ServerKind, string[]> = {
  emby: ['movies', 'tvshows', 'music', 'musicvideos', 'homevideos', 'books', 'audiobooks', 'mixed'],
  jellyfin: ['movies', 'tvshows', 'music', 'musicvideos', 'homevideos', 'books', 'mixed'],
  // File and IPTV sources and Plex servers have no admin panel (caps().admin is false).
  iptv: [],
  files: [],
  plex: [],
  navidrome: [],
};

// Collection type of a folder as the UI names it ('mixed' when the server has none).
export function contentType(f: VirtualFolder): string {
  return f.CollectionType || 'mixed';
}

// Item types counted for the "N films" line of a library.
export const COUNT_TYPES: Record<string, string> = {
  movies: 'Movie',
  tvshows: 'Series',
  music: 'MusicAlbum',
  musicvideos: 'MusicVideo',
  homevideos: 'Video,Photo',
  books: 'Book',
  audiobooks: 'AudioBook',
  boxsets: 'BoxSet',
};

export const isVideoType = (type: string) => ['movies', 'tvshows', 'musicvideos', 'homevideos', 'mixed'].includes(type);

// Folder address for Emby's write endpoints.
const embyId = (f: VirtualFolder) => f.Id ?? f.ItemId ?? '';

async function emby404<T>(first: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await first();
  } catch (err) {
    // Older and newer Emby builds expose one of the two verbs; the proxy keeps the status in the message.
    if (/\b(404|405)\b|not found|method/i.test(String(err))) return fallback();
    throw err;
  }
}

export function libraryAdmin(serverId: string, kindHint?: ServerKind) {
  const kind = (): ServerKind => kindHint ?? sessionFor(serverId)?.server.kind ?? 'emby';
  const jf = () => kind() === 'jellyfin';
  const get = <T>(path: string, query?: Query) => w.api.get<T>(path, query, serverId);
  const post = <T>(path: string, query?: Query, body?: unknown) => w.api.post<T>(path, query, body, serverId);
  const del = <T>(path: string, query?: Query) => w.api.del<T>(path, query, serverId);

  return {
    kind,

    async folders(): Promise<VirtualFolder[]> {
      if (jf()) return (await get<VirtualFolder[]>('/Library/VirtualFolders')) ?? [];
      // Emby 4.8+ documents only the paged /Query form; older builds serve the plain list.
      return emby404(
        async () => (await get<{ Items: VirtualFolder[] }>('/Library/VirtualFolders/Query'))?.Items ?? [],
        async () => (await get<VirtualFolder[]>('/Library/VirtualFolders')) ?? [],
      );
    },

    add(name: string, type: string, options: LibraryOptions, refresh: boolean): Promise<unknown> {
      const collectionType = type === 'mixed' && !jf() ? undefined : type;
      if (jf()) return post('/Library/VirtualFolders', { name, collectionType, refreshLibrary: refresh }, { LibraryOptions: options });
      const paths = (options.PathInfos ?? []).map((p) => p.Path);
      return post(
        '/Library/VirtualFolders',
        { name, collectionType, refreshLibrary: refresh },
        { Name: name, CollectionType: collectionType, RefreshLibrary: refresh, Paths: paths, LibraryOptions: options },
      );
    },

    remove(f: VirtualFolder): Promise<unknown> {
      if (jf()) return del('/Library/VirtualFolders', { name: f.Name, refreshLibrary: true });
      const q = { Id: embyId(f), Name: f.Name, refreshLibrary: true };
      return emby404(
        () => post('/Library/VirtualFolders/Delete', q, { Id: embyId(f), RefreshLibrary: true }),
        () => del('/Library/VirtualFolders', q),
      );
    },

    rename(f: VirtualFolder, newName: string): Promise<unknown> {
      if (jf()) return post('/Library/VirtualFolders/Name', { name: f.Name, newName, refreshLibrary: false });
      return post('/Library/VirtualFolders/Name', { Id: embyId(f), Name: f.Name, NewName: newName, refreshLibrary: false }, { Id: embyId(f), NewName: newName, RefreshLibrary: false });
    },

    addPath(f: VirtualFolder, path: string): Promise<unknown> {
      const PathInfo = { Path: path };
      if (jf()) return post('/Library/VirtualFolders/Paths', { refreshLibrary: false }, { Name: f.Name, PathInfo });
      return post('/Library/VirtualFolders/Paths', { refreshLibrary: false }, { Id: embyId(f), Name: f.Name, Path: path, PathInfo, RefreshLibrary: false });
    },

    removePath(f: VirtualFolder, path: string): Promise<unknown> {
      if (jf()) return del('/Library/VirtualFolders/Paths', { name: f.Name, path, refreshLibrary: false });
      return emby404(
        () => post('/Library/VirtualFolders/Paths/Delete', { refreshLibrary: false }, { Id: embyId(f), Path: path, RefreshLibrary: false }),
        () => del('/Library/VirtualFolders/Paths', { Id: embyId(f), name: f.Name, path, refreshLibrary: false }),
      );
    },

    saveOptions(f: VirtualFolder, options: LibraryOptions): Promise<unknown> {
      const Id = jf() ? f.ItemId : embyId(f);
      return post('/Library/VirtualFolders/LibraryOptions', undefined, { Id, LibraryOptions: options });
    },

    // Fetchers and savers the server can use for a content type (both servers).
    availableOptions(type: string, isNew: boolean): Promise<AvailableOptions> {
      return get<AvailableOptions>('/Libraries/AvailableOptions', {
        LibraryContentType: type === 'mixed' ? undefined : type,
        IsNewLibrary: isNew,
      });
    },

    cultures: () => get<Culture[]>('/Localization/Cultures'),
    countries: () => get<Country[]>('/Localization/Countries'),

    // ---- Server file system (the server's disks, not this PC's) ----
    drives: () => get<FsEntry[]>('/Environment/Drives'),
    directory: (path: string) =>
      get<FsEntry[]>('/Environment/DirectoryContents', jf() ? { path, includeFiles: false, includeDirectories: true } : { Path: path, IncludeFiles: false, IncludeDirectories: true }),
    // Emby only: SMB computers on the server's network and their shares.
    networkDevices: () => (jf() ? Promise.resolve([] as FsEntry[]) : get<FsEntry[]>('/Environment/NetworkDevices')),
    networkShares: (path: string) => get<FsEntry[]>('/Environment/NetworkShares', { Path: path }),

    // ---- Scans ----
    refreshAll: () => post('/Library/Refresh'),
    refreshFolder: (f: VirtualFolder) =>
      post(`/Items/${encodeURIComponent(f.ItemId ?? '')}/Refresh`, {
        Recursive: true,
        MetadataRefreshMode: 'Default',
        ImageRefreshMode: 'Default',
        ReplaceAllMetadata: false,
        ReplaceAllImages: false,
      }),
    async scanTask(): Promise<TaskInfo | undefined> {
      const tasks = (await get<TaskInfo[]>('/ScheduledTasks', { IsHidden: false })) ?? [];
      return tasks.find((x) => x.Key === 'RefreshLibrary') ?? tasks.find((x) => /scan media library|analyser la médiathèque/i.test(x.Name));
    },

    async count(f: VirtualFolder): Promise<number | null> {
      const types = COUNT_TYPES[contentType(f)];
      const uid = sessionFor(serverId)?.user?.id;
      if (!f.ItemId || !uid) return null;
      const q: Query = { ParentId: f.ItemId, Recursive: true, Limit: 0, IncludeItemTypes: types, EnableTotalRecordCount: true };
      const r = jf() ? await get<{ TotalRecordCount: number }>('/Items', { ...q, userId: uid }) : await get<{ TotalRecordCount: number }>(`/Users/${uid}/Items`, q);
      return r?.TotalRecordCount ?? null;
    },

    serverPaths: () => get<ServerPaths>('/System/Info'),
  };
}

export type LibraryAdmin = ReturnType<typeof libraryAdmin>;

// ---- Fetcher lists (TypeOptions) ----

export interface FetcherRow {
  name: string;
  enabled: boolean;
}

// Ordered fetchers for one item type: the saved order first, then whatever the
// server offers that the order does not list yet. Enabled follows the saved
// list, or the server default when the library has no options for this type.
export function fetcherRows(options: LibraryOptions, type: string, which: 'Metadata' | 'Image', available: OptionInfo[]): FetcherRow[] {
  const t = options.TypeOptions?.find((x) => x.Type === type);
  const enabled = t?.[`${which}Fetchers`] as string[] | undefined;
  const order = (t?.[`${which}FetcherOrder`] as string[] | undefined) ?? [];
  const names = [...order.filter((n) => available.some((a) => a.Name === n)), ...available.map((a) => a.Name).filter((n) => !order.includes(n))];
  return names.map((name) => ({
    name,
    enabled: enabled ? enabled.includes(name) : (available.find((a) => a.Name === name)?.DefaultEnabled ?? false),
  }));
}

type TypeAvail = NonNullable<AvailableOptions['TypeOptions']>[number];

// Writes one list back. A type the library had no options for gets both lists
// from the server defaults first, so enabling a metadata source does not turn
// every image source off.
export function setFetcherRows(options: LibraryOptions, avail: TypeAvail, which: 'Metadata' | 'Image', rows: FetcherRow[]): void {
  options.TypeOptions ??= [];
  let t = options.TypeOptions.find((x) => x.Type === avail.Type);
  if (!t) {
    const meta = fetcherRows(options, avail.Type, 'Metadata', avail.MetadataFetchers ?? []);
    const img = fetcherRows(options, avail.Type, 'Image', avail.ImageFetchers ?? []);
    t = {
      Type: avail.Type,
      MetadataFetchers: meta.filter((r) => r.enabled).map((r) => r.name),
      MetadataFetcherOrder: meta.map((r) => r.name),
      ImageFetchers: img.filter((r) => r.enabled).map((r) => r.name),
      ImageFetcherOrder: img.map((r) => r.name),
      ImageOptions: [],
    };
    options.TypeOptions.push(t);
  }
  t[`${which}Fetchers`] = rows.filter((r) => r.enabled).map((r) => r.name);
  t[`${which}FetcherOrder`] = rows.map((r) => r.name);
}

// Subtitle fetchers use a disabled list plus an order, on both servers.
export function subtitleRows(options: LibraryOptions, available: OptionInfo[]): FetcherRow[] {
  const disabled = options.DisabledSubtitleFetchers ?? [];
  const order = options.SubtitleFetcherOrder ?? [];
  const names = [...order.filter((n) => available.some((a) => a.Name === n)), ...available.map((a) => a.Name).filter((n) => !order.includes(n))];
  return names.map((name) => ({ name, enabled: !disabled.includes(name) }));
}

export function setSubtitleRows(options: LibraryOptions, rows: FetcherRow[]): void {
  options.DisabledSubtitleFetchers = rows.filter((r) => !r.enabled).map((r) => r.name);
  options.SubtitleFetcherOrder = rows.map((r) => r.name);
}

// Windows paths use backslashes, the rest forward slashes.
export function joinPath(base: string, name: string): string {
  const sep = base.includes('\\') || /^[A-Za-z]:/.test(base) ? '\\' : '/';
  return base.endsWith(sep) ? base + name : `${base}${sep}${name}`;
}
