// Persistent key/value storage (localStorage). TVs can refuse or wipe it (low storage, a factory reset): every access
// is guarded and the app keeps working with defaults.
const PREFIX = 'wicaby.';

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Full or blocked storage: the value lives for this session only.
  }
}
