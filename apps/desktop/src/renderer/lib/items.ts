// Pure item helpers (no IPC, no runes): api.ts re-exports them and tools/checks tests them.
import type { BaseItem } from "../../shared/models";

// Emby and Jellyfin ids collide across servers: keys, caches and transition
// names use the server too.
export function itemKey(item: { Id: string; ServerId?: string }): string {
  return `${item.ServerId ?? ""}:${item.Id}`;
}

// The same film or series on several servers (matching Imdb, Tmdb or Tvdb id).
function providerKeys(item: BaseItem): string[] {
  return Object.entries(item.ProviderIds ?? {})
    .filter(([k, v]) => v && /^(imdb|tmdb|tvdb)$/i.test(k))
    .map(([k, v]) => `${item.Type}:${k.toLowerCase()}:${v}`);
}

export function sameTitle(a: BaseItem, b: BaseItem): boolean {
  const keys = new Set(providerKeys(a));
  return providerKeys(b).some((k) => keys.has(k));
}

// Keeps the first copy of a title found on several servers, and of an item listed twice
// (a server can repeat one; keyed {#each} blocks throw on the duplicate key).
export function dedupe(items: BaseItem[]): BaseItem[] {
  const owner = new Map<string, string | undefined>();
  const seen = new Set<string>();
  return items.filter((it) => {
    const key = itemKey(it);
    if (seen.has(key)) return false;
    seen.add(key);
    const keys = providerKeys(it);
    if (keys.some((k) => owner.has(k) && owner.get(k) !== it.ServerId))
      return false;
    for (const k of keys) owner.set(k, it.ServerId);
    return true;
  });
}

// One list per server into one: interleaved so no server buries the others,
// then (byDate) most recently played first, then duplicates dropped.
export function merge(
  lists: (BaseItem[] | null | undefined)[],
  byDate = false,
): BaseItem[] {
  const out: BaseItem[] = [];
  const longest = Math.max(0, ...lists.map((l) => l?.length ?? 0));
  for (let i = 0; i < longest; i++)
    for (const l of lists) if (l?.[i]) out.push(l[i]);
  if (byDate) {
    const t = (x: BaseItem) => Date.parse(x.UserData?.LastPlayedDate ?? "") || 0;
    out.sort((a, b) => t(b) - t(a));
  }
  return dedupe(out);
}

// "Because you watched": the latest played titles, an episode standing for its series, one each.
export function becauseSeeds(played: BaseItem[], n = 2): BaseItem[] {
  const out: BaseItem[] = [];
  for (const it of played) {
    const title = it.Type === "Episode" && it.SeriesId
      ? { Id: it.SeriesId, Name: it.SeriesName ?? it.Name, Type: "Series", ServerId: it.ServerId }
      : it;
    if (out.some((o) => itemKey(o) === itemKey(title))) continue;
    out.push(title);
    if (out.length === n) break;
  }
  return out;
}

// What no other row shows yet: not the same item, nor the same title on another server (dedupe).
export function unseen(items: BaseItem[], shown: BaseItem[]): BaseItem[] {
  const keys = new Set(shown.map(itemKey));
  const kept = new Set(dedupe([...shown, ...items]));
  return items.filter((i) => kept.has(i) && !keys.has(itemKey(i)));
}

// Fisher-Yates, on a copy.
export function shuffled<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
