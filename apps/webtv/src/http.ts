// Emby and Jellyfin over fetch(), straight from the TV's browser (docs/webtv.md). The desktop does this in main
// (main/connection/api-client.ts): same auth header, same /emby prefix, same address candidates.
import type { Query, ServerKind } from '../../desktop/src/shared/contract';
import type { SystemInfoPublic } from '../../desktop/src/shared/models';
import { t } from '../../desktop/src/renderer/lib/i18n.svelte';
import { DEMO_ADDRESS, demoRequest } from './demo';

export interface Identity {
  client: string;
  version: string;
  deviceId: string;
  deviceName: string;
}

// A saved server. The token lives in localStorage (the TV has no OS keychain); logs never show it (redact()).
export interface StoredServer {
  id: string;
  name: string;
  kind: ServerKind;
  version: string;
  address: string;
  userId?: string;
  userName?: string;
  token?: string;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const quote = (v: string) => `"${encodeURIComponent(v)}"`;

export function buildQuery(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.append(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export const prefix = (kind: ServerKind): string => (kind === 'emby' ? '/emby' : '');

// The API base every path hangs off (images and streams too).
export const apiBase = (s: Pick<StoredServer, 'address' | 'kind'>): string => `${s.address}${prefix(s.kind)}`;

// Same header as the desktop (ApiClient.authHeaders).
export function authHeaders(s: Pick<StoredServer, 'kind' | 'token' | 'userId'>, id: Identity): Record<string, string> {
  const parts = [`Client=${quote(id.client)}`, `Device=${quote(id.deviceName)}`, `DeviceId=${quote(id.deviceId)}`, `Version=${quote(id.version)}`];
  if (s.kind === 'emby') {
    if (s.userId) parts.unshift(`UserId=${quote(s.userId)}`);
    const h: Record<string, string> = { 'X-Emby-Authorization': `Emby ${parts.join(', ')}` };
    if (s.token) h['X-Emby-Token'] = s.token;
    return h;
  }
  if (s.token) parts.push(`Token=${quote(s.token)}`);
  return { Authorization: `MediaBrowser ${parts.join(', ')}` };
}

// Tokens out of anything logged: query parameters, header values, JSON fields.
export function redact(text: string): string {
  return text
    .replace(/([?&](?:api_key|apikey|x-emby-token|token)=)[^&#\s"]+/gi, '$1***')
    .replace(/((?:X-Emby-Token|AccessToken|Token)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1***');
}

export async function request<T>(s: StoredServer, id: Identity, method: string, path: string, query?: Query, body?: unknown, timeoutMs = 20_000): Promise<T> {
  if (s.address === DEMO_ADDRESS) return demoRequest<T>(method, path, query, body);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: 'application/json', ...authHeaders(s, id) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${apiBase(s)}${path}${buildQuery(query)}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal, credentials: 'omit' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(text.slice(0, 300) || `HTTP ${res.status}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    if (!(res.headers.get('content-type') ?? '').includes('json')) return ((await res.text()) || undefined) as T;
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (ctl.signal.aborted) throw new HttpError(t('errors.connection.timeout'), 0);
    // fetch() only says "Failed to fetch": no route, a refused certificate, or the server's CORS answer.
    throw new HttpError(t('errors.web.blocked'), 0);
  } finally {
    clearTimeout(timer);
  }
}

// Same candidates as the desktop (api-client.ts addressCandidates): https first, then :8096.
export function addressCandidates(input: string): string[] {
  let raw = input.trim().replace(/\/+$/, '');
  if (!raw) return [];
  if (/^https?:\/\//i.test(raw)) return [raw];
  raw = raw.replace(/^\/+/, '');
  const hostPart = raw.split('/')[0];
  if (/:\d+$/.test(hostPart)) return [`http://${raw}`, `https://${raw}`];
  const [host, ...rest] = raw.split('/');
  const tail = rest.length ? `/${rest.join('/')}` : '';
  return [`https://${raw}`, `http://${host}:8096${tail}`, `http://${raw}`];
}

export interface Probe {
  address: string;
  kind: ServerKind;
  info: SystemInfoPublic;
}

async function probeOne(address: string, timeoutMs: number): Promise<Probe> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // Emby answers under /emby (and usually at the root too); Jellyfin only at the root.
    for (const pre of ['/emby', '']) {
      let info: SystemInfoPublic;
      try {
        const res = await fetch(`${address}${pre}/System/Info/Public`, { headers: { Accept: 'application/json' }, signal: ctl.signal, credentials: 'omit' });
        if (!res.ok) continue;
        info = (await res.json()) as SystemInfoPublic;
      } catch (err) {
        if (ctl.signal.aborted) throw err;
        continue;
      }
      if (!info?.Id) continue;
      const kind: ServerKind = /jellyfin/i.test(info.ProductName ?? '') ? 'jellyfin' : pre === '/emby' || /emby/i.test(info.ProductName ?? '') ? 'emby' : 'jellyfin';
      return { address, kind, info };
    }
    throw new Error(t('errors.connection.notAServer'));
  } finally {
    clearTimeout(timer);
  }
}

// The first candidate that answers (Plex is out of scope here).
export function probe(input: string, timeoutMs = 8000): Promise<Probe> {
  const list = addressCandidates(input);
  if (!list.length) return Promise.reject(new Error(t('errors.connection.emptyAddress')));
  return Promise.any(list.map((a) => probeOne(a, timeoutMs))).catch(() => {
    throw new Error(t('errors.connection.unreachable'));
  });
}
