// What the signed-in user may do on a server (their Policy), read once per server and account for the session.
import type { Api } from '$tv/api';

const admins = new Map<string, Promise<boolean>>();

export function isAdmin(api: Api): Promise<boolean> {
  const key = `${api.serverId ?? api.address}/${api.userId}`;
  if (!admins.has(key)) admins.set(key, api.me().then((u) => !!(u as { Policy?: { IsAdministrator?: boolean } }).Policy?.IsAdministrator, () => false));
  return admins.get(key)!;
}
