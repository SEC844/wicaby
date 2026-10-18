import { net } from 'electron';
import { t } from '../i18n';

// Emby Connect: cloud account that links a user to their servers, so remote
// servers can be reached without typing an address.
const CONNECT_BASE = 'https://connect.emby.media/service';

export interface ConnectServer {
  Id?: string;
  SystemId: string;
  Name: string;
  Url?: string;
  LocalAddress?: string;
  AccessKey: string;
}

export interface ConnectSession {
  userId: string;
  userName: string;
  token: string;
}

// A host that accepts the connection and then stalls (captive portal, half-open VPN) must not leave the sign-in spinning.
async function fetchTimed(url: string, init: RequestInit): Promise<Response> {
  try {
    return await net.fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    if ((err as Error)?.name === 'TimeoutError') throw new Error(t('errors.connection.embyConnect.unavailable', { status: 0 }));
    throw err;
  }
}

function appHeader(version: string): Record<string, string> {
  return { 'X-Application': `Wicaby/${version}`, Accept: 'application/json' };
}

export async function connectAuthenticate(username: string, password: string, version: string): Promise<ConnectSession> {
  const body = new URLSearchParams({ nameOrEmail: username, rawpw: password }).toString();
  const res = await fetchTimed(`${CONNECT_BASE}/user/authenticate`, {
    method: 'POST',
    headers: { ...appHeader(version), 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body,
  });
  if (res.status === 401 || res.status === 400) throw new Error(t('errors.connection.embyConnect.wrongCredentials'));
  if (!res.ok) throw new Error(t('errors.connection.embyConnect.unavailable', { status: res.status }));
  const json = (await res.json()) as { AccessToken: string; User: { Id: string; Name?: string; DisplayName?: string } };
  return { userId: json.User.Id, userName: json.User.DisplayName || json.User.Name || username, token: json.AccessToken };
}

export async function connectServers(session: ConnectSession, version: string): Promise<ConnectServer[]> {
  const res = await fetchTimed(`${CONNECT_BASE}/servers?userId=${encodeURIComponent(session.userId)}`, {
    headers: { ...appHeader(version), 'X-Connect-UserToken': session.token },
  });
  if (!res.ok) throw new Error(t('errors.connection.embyConnect.serversUnavailable', { status: res.status }));
  return (await res.json()) as ConnectServer[];
}

// Trades the server's Connect access key for a local user token.
export async function connectExchange(
  address: string,
  connectUserId: string,
  accessKey: string,
  authorization: string,
): Promise<{ LocalUserId: string; AccessToken: string }> {
  const res = await fetchTimed(`${address}/emby/Connect/Exchange?format=json&ConnectUserId=${encodeURIComponent(connectUserId)}`, {
    headers: { Accept: 'application/json', 'X-Emby-Token': accessKey, 'X-Emby-Authorization': authorization },
    // The access key would go along to wherever a redirect points.
    redirect: 'error',
  });
  if (!res.ok) throw new Error(t('errors.connection.embyConnect.exchangeRefused', { status: res.status }));
  return (await res.json()) as { LocalUserId: string; AccessToken: string };
}
