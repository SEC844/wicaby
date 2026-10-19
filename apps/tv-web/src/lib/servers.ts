// TP-06 several servers at once (Android core data/Servers.kt, desktop renderer api.ts fanOut): the same query on
// every signed-in server in parallel, each item tagged with its server, merged with the desktop's merge() (interleaved,
// optionally by last played, one copy of a title found on several servers). Alone, the primary's answer and its
// error as they are. An extra server that does not answer in time is left out, then skipped for a minute.
import type { BaseItem } from '$shared/models';
import { merge } from '$desktop/items';
import type { Api } from './api';
import { api, apis } from './session.svelte';

const EXTRA_TIMEOUT_MS = 8_000;
const OFFLINE_MS = 60_000;
const offlineUntil = new Map<string, number>();

const tag = (a: Api, items: BaseItem[]): BaseItem[] => items.map((i) => (i.ServerId || !a.serverId ? i : { ...i, ServerId: a.serverId }));

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

// One answer per server, null where an extra one failed or is resting.
export async function fanOut<T>(fn: (a: Api) => Promise<T>): Promise<(T | null)[]> {
  const main = api();
  return Promise.all(
    apis().map(async (a) => {
      if (a === main) return fn(a);
      const key = `${a.address}|${a.userId}`;
      if ((offlineUntil.get(key) ?? 0) > Date.now()) return null;
      try {
        return await within(fn(a), EXTRA_TIMEOUT_MS);
      } catch {
        offlineUntil.set(key, Date.now() + OFFLINE_MS);
        return null;
      }
    }),
  );
}

// The query on every server, merged; byDate: the most recently played first (Continue Watching).
export async function merged(fn: (a: Api) => Promise<BaseItem[]>, byDate = false): Promise<BaseItem[]> {
  const list = apis();
  if (list.length < 2) return fn(list[0] ?? api()!);
  const answers = await fanOut((a) => fn(a).then((items) => tag(a, items)));
  return merge(answers, byDate);
}

// The other signed-in servers' libraries, each tagged with its server (their Recently Added rows on Home).
export async function extraViews(): Promise<BaseItem[]> {
  const main = api();
  const lists = await fanOut(async (a): Promise<BaseItem[]> => (a === main ? [] : (await a.views()).map((v) => ({ ...v, ServerId: v.ServerId ?? a.serverId }))));
  return lists.flatMap((l) => l ?? []);
}

// A library in Home row ids: its plain id on the primary (what single-server settings saved), "<serverId>/<id>" on
// another server (Android Servers.libraryRef).
export function libraryRef(lib: BaseItem, primaryId?: string): string {
  return lib.ServerId && lib.ServerId !== primaryId ? `${lib.ServerId}/${lib.Id}` : lib.Id;
}
