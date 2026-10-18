// Emby / Jellyfin HTTP client: the browser counterpart of the desktop's main/connection/api-client.ts and of the
// Android core Emby.kt. One instance per signed-in server and user.
import type { AuthenticationResult, BaseItem, ItemsResult, SystemInfoPublic, UserDto } from '$shared/models';
import { CLIENT, VERSION, deviceId, deviceName } from './identity';

export type ServerKind = 'emby' | 'jellyfin';
export type Query = Record<string, string | number | boolean | undefined | null>;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;

function quote(value: string): string {
  return `"${encodeURIComponent(value)}"`;
}

export function buildQuery(query?: Query): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const k of Object.keys(query)) {
    const v = query[k];
    if (v !== undefined && v !== null && v !== '') parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// fetch() with a timeout. Engines before Chromium 66 ignore AbortSignal, so the request also races the timer.
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      controller.abort();
      reject(new ApiError('timeout', 0));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetch(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class Api {
  constructor(
    readonly address: string,
    readonly kind: ServerKind,
    public token?: string,
    public userId?: string,
  ) {}

  private get prefix(): string {
    return this.kind === 'emby' ? '/emby' : '';
  }

  url(path: string, query?: Query): string {
    return `${this.address}${this.prefix}${path}${buildQuery(query)}`;
  }

  authHeaders(): Record<string, string> {
    const parts = [`Client=${quote(CLIENT)}`, `Device=${quote(deviceName)}`, `DeviceId=${quote(deviceId)}`, `Version=${quote(VERSION)}`];
    if (this.kind === 'emby') {
      if (this.userId) parts.unshift(`UserId=${quote(this.userId)}`);
      const headers: Record<string, string> = { 'X-Emby-Authorization': `Emby ${parts.join(', ')}` };
      if (this.token) headers['X-Emby-Token'] = this.token;
      return headers;
    }
    if (this.token) parts.push(`Token=${quote(this.token)}`);
    return { Authorization: `MediaBrowser ${parts.join(', ')}` };
  }

  async request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...this.authHeaders() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetchWithTimeout(this.url(path, query), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, TIMEOUT_MS);
    } catch (e) {
      throw e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : String(e), 0);
    }
    if (!res.ok) throw new ApiError((await res.text().catch(() => '')).slice(0, 300) || `HTTP ${res.status}`, res.status);
    if (res.status === 204) return undefined as T;
    const type = res.headers.get('content-type') ?? '';
    return (type.includes('json') ? await res.json() : await res.text()) as T;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>('POST', path, query, body ?? {});
  }

  del<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('DELETE', path, query);
  }

  // --- Sign-in ---

  publicUsers(): Promise<UserDto[]> {
    return this.get('/Users/Public');
  }

  async signIn(username: string, password: string): Promise<AuthenticationResult> {
    const r = await this.post<AuthenticationResult>('/Users/AuthenticateByName', { Username: username, Pw: password });
    this.token = r.AccessToken;
    this.userId = r.User.Id;
    return r;
  }

  // --- Browsing (the Android Emby.kt calls the TV screens use) ---

  views(): Promise<ItemsResult> {
    return this.get(`/Users/${this.userId}/Views`);
  }

  items(query: Query): Promise<ItemsResult> {
    return this.get(`/Users/${this.userId}/Items`, query);
  }

  item(id: string): Promise<BaseItem> {
    return this.get(`/Users/${this.userId}/Items/${id}`);
  }

  // Server image, sized for the slot it fills (servers resize and cache).
  image(itemId: string, type: string, tag: string | undefined, maxWidth: number, index?: number): string | undefined {
    if (!tag) return undefined;
    const path = index === undefined ? `/Items/${itemId}/Images/${type}` : `/Items/${itemId}/Images/${type}/${index}`;
    return this.url(path, { tag, maxWidth: Math.round(maxWidth), quality: 90 });
  }
}

// --- Finding a server from what the user typed ---

// "192.168.1.20", "nas:8920", "https://media.example.org/jellyfin" → candidate base URLs, most likely first.
export function candidates(input: string): string[] {
  const raw = input.trim().replace(/\/+$/, '');
  if (!raw) return [];
  if (/^https?:\/\//i.test(raw)) return [raw];
  const hasPort = /:\d+(\/|$)/.test(raw);
  return hasPort ? [`http://${raw}`, `https://${raw}`] : [`http://${raw}:8096`, `https://${raw}:8920`, `https://${raw}`, `http://${raw}`];
}

export interface FoundServer {
  address: string;
  kind: ServerKind;
  info: SystemInfoPublic;
}

// Emby answers on /emby/System/Info/Public and on /System/Info/Public; Jellyfin only on the latter.
export async function probe(input: string): Promise<FoundServer | null> {
  for (const address of candidates(input)) {
    try {
      const res = await fetchWithTimeout(`${address}/System/Info/Public`, { headers: { Accept: 'application/json' } }, 6_000);
      if (!res.ok) continue;
      const info = (await res.json()) as SystemInfoPublic & { ProductName?: string };
      if (!info?.Id) continue;
      const kind: ServerKind = /jellyfin/i.test(info.ProductName ?? '') ? 'jellyfin' : 'emby';
      return { address, kind, info };
    } catch {
      // next candidate
    }
  }
  return null;
}
