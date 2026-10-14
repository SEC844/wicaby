// What each kind of source can do (file-sources-spec §2.2, plex-spec §3.4). One pure function, checked
// against tools/checks/fixtures/server-caps.json (caps-check.mjs). Replace a `kind === 'jellyfin'` test with a
// flag only where a third answer is needed; the Plex column is filled ahead of its adapter.
import type { ServerKind } from './contract';

export interface ServerCaps {
  admin: boolean;
  // 'probed': asked at run time (/LiveTv/Info).
  liveTv: boolean | 'probed';
  sessionsRemote: boolean;
  castReceiver: boolean;
  favorites: boolean;
  serverHubs: boolean;
  hideFromResume: boolean;
  subtitleSearch: boolean;
  comics: boolean;
  // Played, progress and resume come from this machine (files/progress), not a server.
  localUserData: boolean;
  transcode: boolean;
  // Cast, downloads and Trakt: nothing of this source leaves the machine.
  castSend: boolean;
  // Home skips the source unless "Show file sources on Home" is on.
  homeOptIn: boolean;
}

const SERVER: ServerCaps = {
  admin: true,
  liveTv: 'probed',
  sessionsRemote: true,
  castReceiver: true,
  favorites: true,
  serverHubs: false,
  hideFromResume: true,
  subtitleSearch: true,
  comics: true,
  localUserData: false,
  transcode: true,
  castSend: true,
  homeOptIn: false,
};

const FILES: ServerCaps = {
  admin: false,
  liveTv: false,
  sessionsRemote: false,
  castReceiver: false,
  favorites: false,
  serverHubs: false,
  hideFromResume: true,
  subtitleSearch: false,
  comics: false,
  localUserData: true,
  transcode: false,
  castSend: false,
  homeOptIn: true,
};

const TABLE: Record<ServerKind, ServerCaps> = {
  emby: SERVER,
  jellyfin: { ...SERVER, hideFromResume: false },
  // Favorites: the plex.tv watchlist (D-6).
  plex: { ...SERVER, admin: false, sessionsRemote: false, castReceiver: false, serverHubs: true, comics: false },
  files: FILES,
  // IPTV (main/iptv): Live TV only, from this machine. Not a server: no admin, no Home, no cast receiver.
  iptv: { ...FILES, liveTv: true, localUserData: false, homeOptIn: false },
};

// Sources that are not media servers (file and IPTV sources): left out of the server counts, the merged
// server views and "disconnect all".
export const isLocalSource = (kind: string | undefined): boolean => kind === 'files' || kind === 'iptv';

// An unknown kind (a newer settings file, a missing session) gets the server row.
export function caps(kind: string | undefined): ServerCaps {
  return TABLE[kind as ServerKind] ?? SERVER;
}

// The label next to a source's name. Brand names: not translated.
export function kindLabel(kind: string | undefined, files = 'Files'): string {
  return kind === 'jellyfin' ? 'Jellyfin' : kind === 'plex' ? 'Plex' : kind === 'files' ? files : kind === 'iptv' ? 'IPTV' : 'Emby';
}
