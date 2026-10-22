// The web TV app this one replaces (apps/webtv, up to 0.11.2) installs under the same ids, so an update keeps its
// storage: its `wicaby.web.*` keys are taken over once, at start, before the session and the device id are read
// (imported right after the polyfills, main.ts), then removed.
// - The device id, so the server sees the same device and the saved tokens stay valid (no second device).
// - The servers and their accounts: the primary one signed in, the others alongside it (TP-06), every account in
//   "Who's watching?".
// - The MDBList key.
// Its settings (the desktop's shape) and its ratings cache are not carried over: they are removed with the rest.
import type { ServerKind } from './api';
import type { Server, Session } from './session.svelte';
import { load, save } from './storage';

const OLD = {
  servers: 'wicaby.web.servers',
  primary: 'wicaby.web.primary',
  device: 'wicaby.web.device',
  settings: 'wicaby.web.settings',
  ratingsKey: 'wicaby.web.mdblist',
  ratingsCache: 'wicaby.web.ratings',
};

interface StoredServer {
  id: string;
  name: string;
  kind: ServerKind;
  address: string;
  userId?: string;
  userName?: string;
  token?: string;
}

function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function migrate(): void {
  const device = read<string>(OLD.device);
  if (typeof device === 'string' && /^[a-z0-9-]{16,64}$/.test(device) && !load<string>('deviceId', '')) save('deviceId', device);

  const servers = (read<StoredServer[]>(OLD.servers) ?? []).filter(
    (s) => s && typeof s.id === 'string' && /^https?:\/\//i.test(s.address ?? '') && (s.kind === 'emby' || s.kind === 'jellyfin'),
  );
  // An install that already has its own accounts keeps them.
  if (servers.length && !load<{ server: unknown } | null>('session', null)?.server) {
    const server = (s: StoredServer): Server => ({ id: s.id, name: s.name || s.address, address: s.address, kind: s.kind });
    const sessions = servers
      .filter((s) => s.token && s.userId)
      .map((s): Session => ({ server: server(s), userId: s.userId!, userName: s.userName ?? '', token: s.token! }));
    const primaryId = read<string>(OLD.primary);
    const primary = servers.find((s) => s.id === primaryId) ?? servers[0];
    const session = sessions.find((s) => s.server.id === primary.id) ?? null;
    save('session', {
      server: server(primary),
      session,
      profiles: sessions,
      onboarded: true,
      extras: sessions.filter((s) => s.server.id !== primary.id),
    });
  }

  const ratingsKey = read<string>(OLD.ratingsKey);
  if (typeof ratingsKey === 'string' && ratingsKey && !load<string>('ratings_key', '')) save('ratings_key', ratingsKey);

  try {
    for (const key of Object.values(OLD)) localStorage.removeItem(key);
  } catch {
    // Blocked storage: nothing was read either.
  }
}

migrate();
