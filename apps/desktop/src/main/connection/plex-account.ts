// plex.tv for the Plex dialect (plex-spec §2, §5.1, §5.5, PX-04): the PIN link ("link with a code"), the
// account's servers (resources), Home users and the switch between them, and the watchlist that stands in for
// Favorites (D-6). The account token and the Home user tokens go only to plex.tv, clients.plex.tv and
// discover.provider.plex.tv, never to a Plex Media Server (each server gets its own accessToken). Dev builds can
// point every plex.tv host at the mock (WICABY_PLEXTV_BASE, tools/mock-server/mock-plex.mjs); a packaged build
// ignores it. Wicaby is an unofficial client: the X-Plex-* headers name Wicaby truthfully (plex-spec §1.2).
// TODO(owner, D-8): a human reads the current plex.tv terms before any public release with Plex.
import os from 'node:os';
import { app, net } from 'electron';
import type { PlexConnection } from '../../shared/plex/connections';
import { ApiError, type ClientIdentity } from './api-client';

const HOSTS = { plex: 'https://plex.tv', clients: 'https://clients.plex.tv', discover: 'https://discover.provider.plex.tv' } as const;

export function plexTvBase(host: keyof typeof HOSTS, env = process.env.WICABY_PLEXTV_BASE, packaged = app.isPackaged): string {
  return !packaged && env && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(env.replace(/\/+$/, '')) ? env.replace(/\/+$/, '') : HOSTS[host];
}

const platform = (): string => (process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux');

// The headers every plex.tv and PMS request carries; the token only as a header, never in a URL.
export function plexHeaders(identity: ClientIdentity, token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'X-Plex-Product': 'Wicaby',
    'X-Plex-Version': identity.version,
    'X-Plex-Client-Identifier': identity.deviceId,
    'X-Plex-Device': platform(),
    'X-Plex-Device-Name': identity.deviceName,
    'X-Plex-Platform': platform(),
    'X-Plex-Platform-Version': os.release(),
  };
  if (token) h['X-Plex-Token'] = token;
  return h;
}

export interface PlexPin {
  id: number;
  code: string;
  expiresIn?: number;
  authToken?: string | null;
}

export interface PlexResource {
  name: string;
  clientIdentifier: string;
  provides?: string;
  productVersion?: string;
  owned?: boolean;
  sourceTitle?: string | null;
  accessToken?: string;
  httpsRequired?: boolean;
  connections?: PlexConnection[];
}

export interface PlexHomeUser {
  id?: number;
  uuid: string;
  title: string;
  admin?: boolean;
  protected?: boolean;
  thumb?: string;
}

export interface PlexAccountUser {
  uuid: string;
  title?: string;
  username?: string;
  subscription?: { active?: boolean };
  profile?: { autoSelectSubtitle?: number; defaultSubtitleLanguage?: string };
}

export class PlexTv {
  constructor(private readonly identity: ClientIdentity) {}

  private async call<T>(host: keyof typeof HOSTS, method: string, path: string, token?: string, timeoutMs = 15_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await net.fetch(`${plexTvBase(host)}${path}`, { method, headers: plexHeaders(this.identity, token), signal: controller.signal, redirect: 'error' });
      if (!res.ok) throw new ApiError(`plex.tv ${res.status}`, res.status);
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(err instanceof Error ? err.message : String(err), 0);
    } finally {
      clearTimeout(timer);
    }
  }

  createPin(): Promise<PlexPin> {
    return this.call('plex', 'POST', '/api/v2/pins?strong=false');
  }

  // null once the PIN expired (plex.tv answers 404).
  pin(id: number): Promise<PlexPin | null> {
    return this.call<PlexPin>('plex', 'GET', `/api/v2/pins/${id}`).catch((err) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    });
  }

  user(token: string): Promise<PlexAccountUser> {
    return this.call('plex', 'GET', '/api/v2/user', token);
  }

  // The servers this user can reach (players and other resources left out), each with its own accessToken.
  async servers(token: string): Promise<PlexResource[]> {
    const all = await this.call<PlexResource[]>('clients', 'GET', '/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1', token);
    return (Array.isArray(all) ? all : []).filter((r) => (r.provides ?? '').split(',').includes('server') && /^[0-9a-f]{40}$/i.test(r.clientIdentifier ?? ''));
  }

  async homeUsers(token: string): Promise<PlexHomeUser[]> {
    const r = await this.call<{ users?: PlexHomeUser[] }>('plex', 'GET', '/api/v2/home/users', token);
    return (r?.users ?? []).filter((u) => typeof u.uuid === 'string' && typeof u.title === 'string');
  }

  // The Home user's own token. A protected user needs their PIN: 401 when it is wrong.
  async switchUser(token: string, uuid: string, pin?: string): Promise<string> {
    const q = pin ? `?pin=${encodeURIComponent(pin)}` : '';
    const r = await this.call<{ authToken?: string }>('plex', 'POST', `/api/v2/home/users/${encodeURIComponent(uuid)}/switch${q}`, token);
    if (!r?.authToken) throw new ApiError('plex.tv switch without a token', 502);
    return r.authToken;
  }

  // The watchlist's plex:// GUIDs (D-6: it is the Favorites of a plex server).
  async watchlist(token: string): Promise<string[]> {
    const r = await this.call<{ MediaContainer?: { Metadata?: { guid?: string }[] } }>('discover', 'GET', '/library/sections/watchlist/all?includeFields=guid&X-Plex-Container-Size=300', token);
    return (r?.MediaContainer?.Metadata ?? []).map((m) => m.guid).filter((g): g is string => typeof g === 'string');
  }

  // Discover's ratingKey is the id at the end of a plex:// GUID.
  async setWatchlisted(token: string, guid: string, on: boolean): Promise<void> {
    const key = /^plex:\/\/\w+\/([0-9a-z]+)$/i.exec(guid)?.[1];
    if (!key) throw new ApiError('PLEX-UNMAPPED watchlist without a plex:// guid', 404);
    await this.call('discover', 'PUT', `/actions/${on ? 'addToWatchlist' : 'removeFromWatchlist'}?ratingKey=${key}`, token);
  }
}
