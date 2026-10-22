// Data loading, stale-while-revalidate (Android TV Components.kt rememberLoad and Cache): a screen shows what it had
// at once and refreshes behind it. Entries are namespaced by signed-in account, kept in an LRU, and refetched by every
// visible screen when changed() is called (playback ended, watched or favourite toggled).
// `persist` entries also survive a restart (localStorage), so the home screen paints from the last visit instantly.
// They are capped (the latest written kept): a TV has about 5 MB of storage, and keys change with the account and
// the libraries shown.
import { keys as storedKeys, load as loadStored, save as saveStored } from './storage';
import { prefs } from './session.svelte';

const MAX = 64;
// Two accounts' Home, about.
const PERSIST_MAX = 16;
const map = new Map<string, unknown>();
const version = $state({ n: 0 });

function ns(): string {
  const s = prefs.session;
  return s ? `${s.server.id}/${s.userId}/` : '';
}

function remember(key: string, value: unknown): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX) map.delete(map.keys().next().value!);
}

// The persisted keys, oldest first. Entries written before the list existed are found once in the storage itself.
function persisted(): string[] {
  return loadStored<string[] | null>('cache-index', null) ?? storedKeys('cache:').map((k) => k.slice('cache:'.length));
}

function persist(key: string, value: unknown): void {
  const index = persisted().filter((k) => k !== key);
  index.push(key);
  while (index.length > PERSIST_MAX) saveStored(`cache:${index.shift()}`, undefined);
  saveStored('cache-index', index);
  saveStored(`cache:${key}`, value);
}

export function cached<T>(key: string): T | undefined {
  const k = ns() + key;
  if (!map.has(k)) return undefined;
  const v = map.get(k) as T;
  remember(k, v);
  return v;
}

export function changed(): void {
  version.n++;
}

export function clearCache(): void {
  map.clear();
}

export class Loaded<T> {
  value = $state<T | undefined>(undefined);
  error = $state<unknown>(undefined);
  get loading(): boolean {
    return this.value === undefined && this.error === undefined;
  }
}

// Call from a component's script. [key] is read inside an effect: a reactive key reloads when it changes.
export function useLoad<T>(key: () => string, block: () => Promise<T>, opts: { refresh?: boolean; persist?: boolean } = {}): Loaded<T> {
  const out = new Loaded<T>();
  $effect(() => {
    const k = ns() + key();
    void version.n;
    let stale = false;
    const memo = map.get(k) as T | undefined;
    const stored = memo === undefined && opts.persist ? loadStored<T | undefined>(`cache:${k}`, undefined) : undefined;
    // A local, never out.value: reading it here would make the effect depend on what it writes.
    const initial = memo ?? stored;
    out.value = initial;
    out.error = undefined;
    if (initial !== undefined && opts.refresh === false) return;
    block().then(
      (v) => {
        if (stale) return;
        remember(k, v);
        if (opts.persist) persist(k, v);
        out.value = v;
      },
      (e) => {
        if (!stale && initial === undefined) out.error = e;
      },
    );
    return () => {
      stale = true;
    };
  });
  return out;
}
