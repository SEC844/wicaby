// The order of the libraries (Bibliothèques tab, Settings > Appearance): the user's own, by hand. Kept on the phone
// per account so it shows at once, and saved as the account's OrderedViews on the server too (Emby web's "Library
// order"), which every Emby app follows. A library the order does not know yet comes after, in the server's order.
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

// The server's copy, once the user lets go: not awaited by the screen (the phone's order already shows).
export async function saveOrderToServer(api: Api, ids: string[]): Promise<void> {
  try {
    const config = await api.userConfiguration();
    if (!('OrderedViews' in config)) return;
    await api.setUserConfiguration({ ...config, OrderedViews: ids });
  } catch {
    // Kept on the phone.
  }
}

export function moved<T>(list: T[], from: number, to: number): T[] {
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}
