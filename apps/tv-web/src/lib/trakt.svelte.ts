// Client-side Trakt scrobbling (TP-09; Android core trakt/Trakt.kt and TraktClient.kt, desktop main/features/trakt.ts):
// the user's own Trakt application (client id and secret), authorized with the device-code flow; start, pause and
// stop follow the playback reports, and a watched mark set by hand goes to the Trakt history. A server that runs the
// Trakt plugin already scrobbles: it is skipped when detected (admins can read the plugin list) or when the user
// turned it off. The account stays on this TV (its storage; a TV has no keystore). Errors never carry a token.
import type { BaseItem } from '$shared/models';
import type { Api } from './api';
import { load, save } from './storage';

const API = 'https://api.trakt.tv';
const CLIENT_RE = /^[A-Za-z0-9_-]{8,128}$/;
// A token this close to its expiry is refreshed before use.
const REFRESH_MARGIN_MS = 10 * 60_000;

interface Account {
  clientId: string;
  secret: string;
  user: string;
  access?: string;
  refresh?: string;
  expiresAt: number;
}

export type TraktError = 'client' | 'denied' | 'expired' | 'network' | 'server';

export const trakt = $state<{
  clientId: string;
  // Non-null once authorized ("" when Trakt did not give the username).
  user: string | null;
  pending: { userCode: string; url: string; expiresAt: number } | null;
  error: TraktError | null;
  offServers: string[];
}>({ clientId: '', user: null, pending: null, error: null, offServers: load<string[]>('trakt.off', []) });

let account: Account | null = load<Account | null>('trakt.account', null);
if (account) {
  trakt.clientId = account.clientId;
  trakt.user = account.access ? account.user : null;
}

function store(a: Account | null): void {
  account = a;
  save('trakt.account', a ?? undefined);
  trakt.clientId = a?.clientId ?? '';
  trakt.user = a?.access ? a.user : null;
}

async function call(path: string, clientId: string, body?: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': clientId };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${API}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error' });
}

async function ok<T>(path: string, clientId: string, body?: unknown, token?: string): Promise<T> {
  const r = await call(path, clientId, body, token);
  if (!r.ok) throw new Error(`trakt ${path}: HTTP ${r.status}`);
  return (r.status === 204 ? undefined : await r.json()) as T;
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at?: number;
}

const withTokens = (a: Account, t: Tokens): Account => ({
  ...a,
  access: t.access_token,
  refresh: t.refresh_token,
  expiresAt: (t.created_at ? t.created_at * 1000 : Date.now()) + t.expires_in * 1000,
});

// --- Authorization (device code) ---

let poll = 0;

export async function connect(clientId: string, secret: string): Promise<void> {
  cancel();
  trakt.error = null;
  if (!CLIENT_RE.test(clientId.trim()) || !CLIENT_RE.test(secret.trim())) return void (trakt.error = 'client');
  const id = clientId.trim();
  const sec = secret.trim();
  let code: { device_code: string; user_code: string; verification_url: string; expires_in: number; interval: number };
  try {
    code = await ok('/oauth/device/code', id, { client_id: id });
  } catch {
    return void (trakt.error = 'client');
  }
  store({ clientId: id, secret: sec, user: '', expiresAt: 0 });
  const expiresAt = Date.now() + code.expires_in * 1000;
  trakt.pending = { userCode: code.user_code, url: code.verification_url, expiresAt };
  let interval = Math.max(1, code.interval) * 1000;
  const tick = async (): Promise<void> => {
    if (!trakt.pending) return;
    if (Date.now() > expiresAt) return fail('expired');
    let r: Response;
    try {
      r = await call('/oauth/device/token', id, { code: code.device_code, client_id: id, client_secret: sec });
    } catch {
      poll = window.setTimeout(tick, interval);
      return;
    }
    if (r.status === 200) {
      const tokens = (await r.json()) as Tokens;
      let a = withTokens({ clientId: id, secret: sec, user: '', expiresAt: 0 }, tokens);
      try {
        const me = await ok<{ user?: { username?: string } }>('/users/settings', id, undefined, a.access);
        a = { ...a, user: me.user?.username ?? '' };
      } catch {
        // The name is only shown: authorized all the same.
      }
      trakt.pending = null;
      store(a);
      return;
    }
    if (r.status === 400) poll = window.setTimeout(tick, interval);
    else if (r.status === 429) {
      interval += 1000;
      poll = window.setTimeout(tick, interval);
    } else fail(r.status === 418 ? 'denied' : r.status === 410 || r.status === 404 ? 'expired' : 'server');
  };
  poll = window.setTimeout(tick, interval);
}

function fail(e: TraktError): void {
  cancel();
  trakt.error = e;
}

export function cancel(): void {
  clearTimeout(poll);
  trakt.pending = null;
}

export async function disconnect(): Promise<void> {
  cancel();
  const a = account;
  store(null);
  if (a?.access) await ok('/oauth/revoke', a.clientId, { token: a.access, client_id: a.clientId, client_secret: a.secret }).catch(() => {});
}

export function setScrobble(serverId: string, on: boolean): void {
  trakt.offServers = on ? trakt.offServers.filter((s) => s !== serverId) : [...new Set([...trakt.offServers, serverId])];
  save('trakt.off', trakt.offServers);
}

// --- The server's own Trakt plugin ---

const plugins = new Map<string, Promise<boolean | null>>();

// true: the server scrobbles itself; null: unknown (not an admin).
export function hasPlugin(api: Api): Promise<boolean | null> {
  const key = api.serverId ?? api.address;
  let p = plugins.get(key);
  if (!p) {
    p = api.get<{ Name?: string; Status?: string }[]>('/Plugins').then(
      (list) => list.some((x) => /trakt/i.test(x.Name ?? '') && (!x.Status || x.Status === 'Active' || x.Status === 'Restart')),
      () => null,
    );
    plugins.set(key, p);
  }
  return p;
}

// --- Scrobbling and history ---

// The ids Trakt matches a movie or an episode on; null when there is nothing to match.
function traktIds(item: BaseItem): ['movie' | 'episode', Record<string, string | number>] | null {
  const kind = item.Type === 'Movie' ? 'movie' : item.Type === 'Episode' ? 'episode' : null;
  if (!kind) return null;
  const ids: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(item.ProviderIds ?? {})) {
    const key = k.toLowerCase();
    const value = (v ?? '').trim();
    if (key === 'imdb' && /^tt\d+$/.test(value)) ids.imdb = value;
    else if ((key === 'tmdb' || key === 'tvdb') && /^\d+$/.test(value)) ids[key] = Number(value);
  }
  return Object.keys(ids).length ? [kind, ids] : null;
}

async function authorized(): Promise<Account | null> {
  let a = account;
  if (!a?.access) return null;
  if (a.refresh && a.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
    try {
      const t = await ok<Tokens>('/oauth/token', a.clientId, {
        refresh_token: a.refresh,
        client_id: a.clientId,
        client_secret: a.secret,
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        grant_type: 'refresh_token',
      });
      a = withTokens(a, t);
      store(a);
    } catch {
      return a;
    }
  }
  return a;
}

async function eligible(api: Api): Promise<Account | null> {
  if (!account?.access || (api.serverId && trakt.offServers.includes(api.serverId))) return null;
  if ((await hasPlugin(api)) === true) return null;
  return authorized();
}

// start (also on resume), pause, stop: the progress in percent, two decimals.
export function scrobble(action: 'start' | 'pause' | 'stop', api: Api, item: BaseItem, positionMs: number, durationMs: number): void {
  const ids = traktIds(item);
  if (!ids || !account?.access) return;
  const pct = durationMs > 0 ? Math.max(0, Math.min(100, (positionMs * 100) / durationMs)) : 0;
  const body = { [ids[0]]: { ids: ids[1] }, progress: Math.round(pct * 100) / 100 };
  void eligible(api).then((a) => a && call(`/scrobble/${action}`, a.clientId, body, a.access).catch(() => {}));
}

// A watched mark set by hand: added to the history; unwatched removes the latest play.
export function history(api: Api, item: BaseItem, watched: boolean): void {
  const ids = traktIds(item);
  if (!ids || !account?.access) return;
  void eligible(api).then(async (a) => {
    if (!a) return;
    if (watched) return void (await call('/sync/history', a.clientId, { [`${ids[0]}s`]: [{ ids: ids[1] }] }, a.access).catch(() => {}));
    try {
      const [type, id] = Object.entries(ids[1])[0];
      const found = await ok<{ [k: string]: { ids?: { trakt?: number } } }[]>(`/search/${type}/${id}?type=${ids[0]}`, a.clientId, undefined, a.access);
      const traktId = found[0]?.[ids[0]]?.ids?.trakt;
      if (!traktId) return;
      const plays = await ok<{ id?: number }[]>(`/sync/history/${ids[0]}s/${traktId}?limit=1`, a.clientId, undefined, a.access);
      if (plays[0]?.id) await call('/sync/history/remove', a.clientId, { ids: [plays[0].id] }, a.access);
    } catch {
      // Best effort, as on Android.
    }
  });
}
