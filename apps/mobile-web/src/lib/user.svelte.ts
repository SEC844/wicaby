// What the signed-in user may do on a server (their Policy), read once per server and account for the session.
// `adminOf` holds the answers once in, for the synchronous checks (the desktop admin's isAdminFor).
import type { Api } from '$tv/api';

const admins = new Map<string, Promise<boolean>>();
export const adminOf = $state<Record<string, boolean>>({});

export function isAdmin(api: Api): Promise<boolean> {
  const key = `${api.serverId ?? api.address}/${api.userId}`;
  if (!admins.has(key)) {
    const ask = api.me().then((u) => !!(u as { Policy?: { IsAdministrator?: boolean } }).Policy?.IsAdministrator, () => false);
    admins.set(key, ask);
    void ask.then((on) => (adminOf[key] = on));
  }
  return admins.get(key)!;
}

export const adminKey = (api: Api): string => `${api.serverId ?? api.address}/${api.userId}`;
