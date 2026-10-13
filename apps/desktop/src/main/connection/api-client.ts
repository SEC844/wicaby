import { Readable } from 'node:stream';
import { net } from 'electron';
import type { Query, ServerKind } from '../../shared/contract';
import type { SystemInfoPublic } from '../../shared/models';
import { t } from '../i18n';

export interface ClientIdentity {
  client: string;
  version: string;
  deviceId: string;
  deviceName: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// A non-JSON request body (image upload: base64 text with an image content type).
export class RawBody {
  constructor(
    readonly contentType: string,
    readonly data: string,
  ) {}
}

export function buildQuery(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.append(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

// Set by the embedded mesh node (vpn/embedded-mesh.ts). A server on the user's
// tailnet is reached through a loopback forwarder: requests go to the rewritten
// URL while the original address stays the server's identity.
export interface AddressRoute {
  ensure(address: string): Promise<void>;
  rewrite(url: string): string;
}
let route: AddressRoute | null = null;
export function setAddressRoute(next: AddressRoute | null): void {
  route = next;
}
export const routed = (url: string): string => (route ? route.rewrite(url) : url);

function quote(value: string): string {
  return `"${encodeURIComponent(value)}"`;
}

// One client per active server connection. Requests run through Electron's
// net stack, so Windows proxy settings and the Chromium HTTP cache apply.
export class ApiClient {
  constructor(
    readonly address: string,
    readonly kind: ServerKind,
    private readonly identity: ClientIdentity,
    public token?: string,
    public userId?: string,
  ) {}

  get prefix(): string {
    return this.kind === 'emby' ? '/emby' : '';
  }

  url(path: string, query?: Query): string {
    return routed(`${this.address}${this.prefix}${path}${buildQuery(query)}`);
  }

  authHeaders(): Record<string, string> {
    const { client, version, deviceId, deviceName } = this.identity;
    const parts = [`Client=${quote(client)}`, `Device=${quote(deviceName)}`, `DeviceId=${quote(deviceId)}`, `Version=${quote(version)}`];
    if (this.kind === 'emby') {
      if (this.userId) parts.unshift(`UserId=${quote(this.userId)}`);
      const headers: Record<string, string> = { 'X-Emby-Authorization': `Emby ${parts.join(', ')}` };
      if (this.token) headers['X-Emby-Token'] = this.token;
      return headers;
    }
    if (this.token) parts.push(`Token=${quote(this.token)}`);
    return { Authorization: `MediaBrowser ${parts.join(', ')}` };
  }

  // The auth headers a player sends itself, each one comma-free: mpv splits its header list on commas.
  mediaAuthHeaders(): string[] {
    if (!this.token) return [];
    return [this.kind === 'emby' ? `X-Emby-Token: ${this.token}` : `Authorization: MediaBrowser Token="${this.token}"`];
  }

  async request<T>(method: string, path: string, query?: Query, body?: unknown, timeoutMs = 20_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: 'application/json', ...this.authHeaders() };
      let payload: string | undefined;
      if (body instanceof RawBody) {
        headers['Content-Type'] = body.contentType;
        payload = body.data;
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await net.fetch(this.url(path, query), { method, headers, body: payload, signal: controller.signal, redirect: redirectPolicy(this.token) });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ApiError(text.slice(0, 300) || `HTTP ${res.status}`, res.status);
      }
      if (res.status === 204) return undefined as T;
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('json')) {
        const text = await res.text();
        return (text ? text : undefined) as T;
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (controller.signal.aborted) throw new ApiError(t('errors.connection.timeout'), 0);
      throw new ApiError(err instanceof Error ? err.message : String(err), 0);
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  post<T>(path: string, query?: Query, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, query, body);
  }
}

// Query parameters that carry an access token. Server URLs (TranscodingUrl,
// DeliveryUrl) embed one; players and wicaby-media:// get it as a header instead.
const TOKEN_PARAMS = new Set(['api_key', 'apikey', 'x-emby-token', 'x-mediabrowser-token']);
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

// Removes token parameters from a URL's query, keeping the rest byte for byte.
export function stripTokenParams(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const h = url.indexOf('#', q);
  const end = h < 0 ? url.length : h;
  const kept = url
    .slice(q + 1, end)
    .split('&')
    .filter((p) => {
      if (!p) return false;
      let name = p.split('=')[0].replace(/\+/g, ' ');
      try {
        name = decodeURIComponent(name);
      } catch {
        // Malformed escape: compare it as written.
      }
      return !TOKEN_PARAMS.has(name.trim().toLowerCase());
    });
  return url.slice(0, q) + (kept.length ? `?${kept.join('&')}` : '') + url.slice(end);
}

function httpOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

// An absolute URL (scheme:...) or a network-path one ('//host', '\\host'): never a path on the server.
function absoluteForm(url: string): boolean {
  return ABSOLUTE.test(url) || /^[\\/]{2}/.test(url);
}

// True for a relative server URL, or an absolute one on the server's own
// origin (scheme://host:port of its address). Only those may carry the token.
export function isServerOrigin(api: Pick<ApiClient, 'address'>, url: string): boolean {
  if (!absoluteForm(url)) return true;
  const origin = httpOrigin(url);
  return origin !== null && origin === httpOrigin(api.address);
}

// The server as reached: its own origin, or the loopback forwarder `routed` sends it
// through (a relative redirect from the server resolves against the forwarder).
export function sameServer(api: Pick<ApiClient, 'address'>, url: string): boolean {
  const origin = httpOrigin(url);
  return origin !== null && (origin === httpOrigin(api.address) || origin === httpOrigin(routed(api.address)));
}

// An absolute http(s) URL in WHATWG form, token parameters removed, for a player that
// gets no auth for it. Null for anything else: file:, smb:, edl:, av:, a UNC or
// network-path '//host' or '\\host', credentials in the URL. The serialised form keeps
// a player with another URL parser (FFmpeg) on the host the check saw.
export function plainHttpUrl(url: string): string | null {
  const clean = stripTokenParams(url);
  if (!/^https?:\/\//i.test(clean)) return null;
  try {
    const u = new URL(clean);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

// A server URL as a path under the API base (what wicaby-media://api expects):
// relative ones as given, same-origin absolute ones without origin and base path.
// Null for anything on another origin. Token parameters are removed.
export function serverPath(api: Pick<ApiClient, 'address'>, url: string): string | null {
  const clean = stripTokenParams(url);
  if (!isServerOrigin(api, clean)) return null;
  if (!absoluteForm(clean)) return clean.startsWith('/') ? clean : `/${clean}`;
  const u = new URL(clean);
  const base = new URL(api.address).pathname.replace(/\/+$/, '');
  let path = u.pathname + u.search;
  if (base && path.toLowerCase().startsWith(`${base.toLowerCase()}/`)) path = path.slice(base.length);
  return path;
}

// Relative server URLs (TranscodingUrl, DeliveryUrl) follow the same rule as
// the official clients: they are relative to the API base, prefix included.
// Token parameters are removed and the result is in WHATWG form. An absolute http(s)
// URL on another origin comes back without routing (plainHttpUrl): callers check
// isServerOrigin and never send it the token. Null for any other absolute or
// network-path form ('//host', '\\host', file:, smb:...): nothing to play.
export function resolveServerUrl(api: Pick<ApiClient, 'address' | 'prefix'>, url: string): string | null {
  const clean = stripTokenParams(url);
  if (absoluteForm(clean)) return isServerOrigin(api, clean) ? routed(new URL(clean).href) : plainHttpUrl(clean);
  const rel = clean.startsWith('/') ? clean : `/${clean}`;
  const full = api.prefix && rel.toLowerCase().startsWith(`${api.prefix}/`) ? api.address + rel : api.address + api.prefix + rel;
  try {
    const u = new URL(full);
    return u.origin === httpOrigin(api.address) ? routed(u.href) : null;
  } catch {
    return null;
  }
}

export type ServerFetch = { response: Response } | { foreign: string };

// net.fetch follows a redirect with every header still set (Chromium keeps X-Emby-Token
// and X-Emby-Authorization on a cross-origin hop). Here a hop that stays on the server
// is followed with them; the first hop anywhere else ends the request and comes back as
// `foreign` (http(s) only, token parameters removed) for the caller to fetch without
// auth. A hop to any other scheme fails the request.
export function fetchServer(
  api: Pick<ApiClient, 'address'>,
  url: string,
  init: { method: string; headers: Record<string, string>; timeoutMs?: number },
): Promise<ServerFetch> {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const request = net.request({ url, method: init.method, redirect: 'manual' });
    for (const [k, v] of Object.entries(init.headers)) request.setHeader(k, v);
    request.on('redirect', (_status, _method, location) => {
      if (sameServer(api, location)) return request.followRedirect();
      const foreign = plainHttpUrl(location);
      settle(() => (foreign ? resolve({ foreign }) : reject(new Error('redirect refused'))));
      request.abort();
    });
    request.on('response', (res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      const empty = init.method === 'HEAD' || [101, 204, 205, 304].includes(res.statusCode);
      const body = empty ? null : (Readable.toWeb(res as unknown as Readable) as ReadableStream);
      settle(() => resolve({ response: new Response(body, { status: res.statusCode, headers }) }));
    });
    request.on('error', (err) => settle(() => reject(err)));
    request.on('abort', () => settle(() => reject(new Error('aborted'))));
    if (init.timeoutMs) timer = setTimeout(() => (settle(() => reject(new Error('timeout'))), request.abort()), init.timeoutMs);
    request.end();
  });
}

// Token binding (ConnectionManager): a server token is only ever sent to an
// origin, scheme://host:port, where the user signed in to that server. An
// address that merely answers with the server's public Id is not enough.
export function credentialOrigin(address: string | undefined): string | null {
  if (!address) return null;
  try {
    const u = new URL(address);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function tokenAllowed(address: string, trustedOrigins: readonly string[] | undefined): boolean {
  const origin = credentialOrigin(address);
  return Boolean(origin && trustedOrigins?.includes(origin));
}

// A request carrying the token never follows a redirect: the X-Emby-Token header (or
// Authorization) would go along to wherever the Location points, trusted origin or not.
export function redirectPolicy(token: string | undefined): 'error' | 'follow' {
  return token ? 'error' : 'follow';
}

export interface ProbeResult {
  address: string;
  kind: ServerKind;
  info: SystemInfoPublic;
}

async function probeOne(address: string, timeoutMs: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await route?.ensure(address).catch(() => undefined);
    // Emby answers under /emby (and usually at the root too); Jellyfin only at the root.
    for (const prefix of ['/emby', '']) {
      let info: SystemInfoPublic;
      try {
        const res = await net.fetch(routed(`${address}${prefix}/System/Info/Public`), {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) continue;
        info = (await res.json()) as SystemInfoPublic;
      } catch (err) {
        if (controller.signal.aborted) throw err;
        continue; // HTML page or redirect instead of JSON.
      }
      if (!info?.Id) continue;
      const kind: ServerKind = /jellyfin/i.test(info.ProductName ?? '') ? 'jellyfin' : prefix === '/emby' || /emby/i.test(info.ProductName ?? '') ? 'emby' : 'jellyfin';
      return { address, kind, info };
    }
    // A Plex Media Server (plex-spec §3.3): /identity, no auth, names it by its machineIdentifier.
    const plex = await identityOf(address, controller.signal);
    if (plex) return plex;
    throw new Error(t('errors.connection.notAServer'));
  } finally {
    clearTimeout(timer);
  }
}

async function identityOf(address: string, signal: AbortSignal): Promise<ProbeResult | null> {
  try {
    const res = await net.fetch(routed(`${address}/identity`), { headers: { Accept: 'application/json' }, signal, redirect: 'error' });
    const c = res.ok ? ((await res.json()) as { MediaContainer?: { machineIdentifier?: string; version?: string } })?.MediaContainer : undefined;
    const id = c?.machineIdentifier ?? '';
    return /^[0-9a-f]{40}$/i.test(id) ? { address, kind: 'plex', info: { Id: id, ServerName: '', Version: c?.version ?? '', ProductName: 'Plex Media Server' } } : null;
  } catch (err) {
    if (signal.aborted) throw err;
    return null;
  }
}

// One address of a known Plex server, /identity only (the Plex connection race, shared/plex/connections.ts).
export async function probePlexIdentity(address: string, timeoutMs: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await route?.ensure(address).catch(() => undefined);
    const hit = await identityOf(address, controller.signal);
    if (!hit) throw new Error(t('errors.connection.notAServer'));
    return hit;
  } finally {
    clearTimeout(timer);
  }
}

// Resolves with the first address that answers. Mirrors Emby's
// DetermineServerUrl, which races manual, local and remote addresses.
export function probeFirst(addresses: string[], timeoutMs = 6000): Promise<ProbeResult> {
  const unique = [...new Set(addresses.filter(Boolean))];
  if (unique.length === 0) return Promise.reject(new Error(t('errors.connection.noAddress')));
  return Promise.any(unique.map((a) => probeOne(a, timeoutMs))).catch(() => {
    throw new Error(t('errors.connection.unreachable'));
  });
}

export function addressCandidates(input: string): string[] {
  let raw = input.trim().replace(/\/+$/, '');
  if (!raw) return [];
  if (/^https?:\/\//i.test(raw)) return [raw];
  raw = raw.replace(/^\/+/, '');
  const hostPart = raw.split('/')[0];
  const hasPort = /:\d+$/.test(hostPart);
  if (hasPort) return [`http://${raw}`, `https://${raw}`];
  const [host, ...rest] = raw.split('/');
  const tail = rest.length ? `/${rest.join('/')}` : '';
  return [`https://${raw}`, `http://${host}:8096${tail}`, `http://${raw}`];
}
