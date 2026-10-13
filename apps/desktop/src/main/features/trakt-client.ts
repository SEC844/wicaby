// Trakt API v2 calls Wicaby needs: the OAuth device-code flow, token refresh and
// revocation, and scrobbling. No Electron import, so tools/checks/trakt-check.mjs
// runs it against tools/mock-server/mock-trakt.mjs. Error messages never carry a token.

export const TRAKT_API = 'https://api.trakt.tv';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class TraktError extends Error {
  constructor(readonly status: number) {
    super(`Trakt HTTP ${status}`);
  }
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at: number;
}

export type ScrobbleAction = 'start' | 'pause' | 'stop';

export class TraktClient {
  constructor(
    private readonly base: string,
    private readonly clientId: string,
    private readonly fetcher: Fetch = fetch,
  ) {}

  private async call<T>(path: string, body?: unknown, token?: string): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': this.clientId };
    if (token) headers.Authorization = `Bearer ${token}`;
    // redirect: 'error': a redirect must never carry the Bearer token elsewhere.
    const res = await this.fetcher(`${this.base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error' });
    const text = await res.text().catch(() => '');
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    return { status: res.status, data: data as T };
  }

  private async ok<T>(path: string, body?: unknown, token?: string): Promise<T> {
    const r = await this.call<T>(path, body, token);
    if (r.status < 200 || r.status >= 300) throw new TraktError(r.status);
    return r.data;
  }

  deviceCode(): Promise<DeviceCode> {
    return this.ok('/oauth/device/code', { client_id: this.clientId });
  }

  // 'pending' until the user enters the code, 'slow-down' on 429; 404/409/410/418 (bad,
  // used, expired, denied code) throw.
  async pollToken(code: string, secret: string): Promise<Tokens | 'pending' | 'slow-down'> {
    const r = await this.call<Tokens>('/oauth/device/token', { code, client_id: this.clientId, client_secret: secret });
    if (r.status === 200 && r.data?.access_token) return r.data;
    if (r.status === 400) return 'pending';
    if (r.status === 429) return 'slow-down';
    throw new TraktError(r.status);
  }

  refresh(refreshToken: string, secret: string): Promise<Tokens> {
    return this.ok('/oauth/token', {
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: secret,
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      grant_type: 'refresh_token',
    });
  }

  async revoke(token: string, secret: string): Promise<void> {
    await this.ok('/oauth/revoke', { token, client_id: this.clientId, client_secret: secret });
  }

  async username(token: string): Promise<string> {
    const r = await this.ok<{ user?: { username?: string } }>('/users/settings', undefined, token);
    return String(r?.user?.username ?? '');
  }

  // 409: Trakt already has this scrobble (a repeat within the hour), not a failure.
  async scrobble(action: ScrobbleAction, token: string, body: object): Promise<void> {
    const r = await this.call(`/scrobble/${action}`, body, token);
    if ((r.status < 200 || r.status >= 300) && r.status !== 409) throw new TraktError(r.status);
  }
}

interface ScrobbleItem {
  Type?: string;
  ProviderIds?: Record<string, string>;
}

// The Trakt scrobble body for a movie or an episode, matched on its provider ids only
// (imdb/tmdb/tvdb); null when there is nothing to match on.
export function scrobbleBody(item: ScrobbleItem, progress: number): object | null {
  const kind = item.Type === 'Movie' ? 'movie' : item.Type === 'Episode' ? 'episode' : null;
  if (!kind) return null;
  const ids: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(item.ProviderIds ?? {})) {
    const key = k.toLowerCase();
    const val = String(v ?? '').trim();
    if (key === 'imdb' && /^tt\d+$/.test(val)) ids.imdb = val;
    else if ((key === 'tmdb' || key === 'tvdb') && /^\d+$/.test(val)) ids[key] = Number(val);
  }
  if (!Object.keys(ids).length) return null;
  const pct = Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0;
  return { [kind]: { ids }, progress: Math.round(pct * 100) / 100 };
}

// The server's plugin list (GET /Plugins, admin only) holds an active Trakt plugin.
// Emby lists loaded plugins only; Jellyfin adds a Status.
export function hasTraktPlugin(list: unknown): boolean {
  if (!Array.isArray(list)) return false;
  return list.some((p) => p && /trakt/i.test(String(p.Name ?? '')) && (p.Status === undefined || p.Status === 'Active' || p.Status === 'Restart'));
}
