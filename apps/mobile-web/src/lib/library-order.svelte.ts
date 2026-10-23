// The order of the libraries (Bibliothèques tab, Settings > Appearance): the user's own, by hand, kept on the phone
// per account. A library the order does not know yet comes after, in the server's order. Not sent to the server
// (OrderedViews) until how Emby takes it is checked on a real server: writing it went with a broken Home on the
// phone (2026-10-23); clearServerOrder takes back what an earlier version wrote.
import type { BaseItem } from '$shared/models';
import type { Api } from '$tv/api';
import { load, save } from '$tv/storage';

const orders = $state<Record<string, string[]>>(load<Record<string, string[]>>('libraryOrder', {}));
const key = (api: Api) => `${api.serverId ?? api.address}/${api.userId}`;

export function arranged(api: Api, views: BaseItem[]): BaseItem[] {
  const order = orders[key(api)];
  if (!order?.length) return views;
  const at = (v: BaseItem) => {
    const i = order.indexOf(v.Id);
    return i < 0 ? order.length + views.indexOf(v) : i;
  };
  return [...views].sort((a, b) => at(a) - at(b));
}

export function setOrder(api: Api, ids: string[]): void {
  orders[key(api)] = ids;
  save('libraryOrder', $state.snapshot(orders));
}

export async function clearServerOrder(api: Api): Promise<void> {
  try {
    const config = await api.userConfiguration();
    const ordered = config.OrderedViews;
    if (!Array.isArray(ordered) || !ordered.length) return;
    await api.setUserConfiguration({ ...config, OrderedViews: [] });
  } catch {
    // Left as it is.
  }
}

export function moved<T>(list: T[], from: number, to: number): T[] {
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}
