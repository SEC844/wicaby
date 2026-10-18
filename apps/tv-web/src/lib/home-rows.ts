// Home layout (Android core HomeRows.kt, desktop ui.homeRows): per user, the row ids in display order and the hidden
// ones; rows the saved order does not know yet (a new library) keep their default place. `thumb`: the Latest rows
// shown as thumbnails instead of posters.
import type { BaseItem } from '$shared/models';
import { itemKey } from '$desktop/items';

export const RESUME = 'resume'; // "Continue Watching", merged or not
export const NEXT_UP = 'nextUp';
export const UPCOMING = 'upcoming';
export const LIVE_NOW = 'liveNow'; // only when a server has Live TV
export const BECAUSE = 'because';
export const MEMORIES = 'memories'; // photos "On this day", only with a photo library
const LATEST = 'latest:';

export const latest = (viewId: string): string => LATEST + viewId;
export const latestViewId = (id: string): string | null => (id.startsWith(LATEST) ? id.slice(LATEST.length) : null);

export interface HomePref {
  order: string[];
  hidden: string[];
  thumb: string[];
}

// The rows the TV has, in the desktop's default order.
export function defaults(latestViewIds: string[], merged: boolean, live = false, memories = false): string[] {
  return [
    RESUME,
    ...(merged ? [] : [NEXT_UP]),
    UPCOMING,
    ...(live ? [LIVE_NOW] : []),
    ...latestViewIds.map(latest),
    ...(memories ? [MEMORIES] : []),
    BECAUSE,
  ];
}

// The saved order, minus rows gone, plus new rows after their default neighbour.
export function arrange(defaultIds: string[], pref: { order: string[] } | null): string[] {
  if (!pref) return defaultIds;
  const out = pref.order.filter((id, i, a) => defaultIds.includes(id) && a.indexOf(id) === i);
  defaultIds.forEach((id, i) => {
    if (out.includes(id)) return;
    out.splice(i === 0 ? 0 : out.indexOf(defaultIds[i - 1]) + 1, 0, id);
  });
  return out;
}

export function move(rows: string[], from: number, to: number): string[] {
  if (from < 0 || to < 0 || from >= rows.length || to >= rows.length || from === to) return rows;
  const out = rows.slice();
  out.splice(to, 0, out.splice(from, 1)[0]);
  return out;
}

// The stored key is the Android one ("thumbRows"): a 0.4.0-0.4.2 "Thumb" set is dropped.
export function encode(p: HomePref): string {
  return JSON.stringify({ order: p.order, hidden: p.hidden, thumbRows: p.thumb });
}

export function decode(s: string | null): HomePref | null {
  if (!s) return null;
  try {
    const o = JSON.parse(s) as { order?: string[]; hidden?: string[]; thumbRows?: string[] };
    return { order: o.order ?? [], hidden: o.hidden ?? [], thumb: o.thumbRows ?? [] };
  } catch {
    return null;
  }
}

// The n latest distinct titles played (an episode stands for its series): "Because you watched" seeds.
export function becauseSeeds(played: BaseItem[], n = 2): BaseItem[] {
  const out: BaseItem[] = [];
  for (const it of played) {
    const title: BaseItem =
      it.Type === 'Episode' && it.SeriesId ? { Id: it.SeriesId, Name: it.SeriesName ?? it.Name, Type: 'Series', ServerId: it.ServerId } : it;
    if (out.some((o) => o.Id === title.Id && o.ServerId === title.ServerId)) continue;
    out.push(title);
    if (out.length === n) break;
  }
  return out;
}

// What no other row shows yet.
export function unseen(items: BaseItem[], shown: BaseItem[]): BaseItem[] {
  const keys = new Set(shown.map(itemKey));
  const seen = new Set<string>();
  return items.filter((it) => {
    const k = itemKey(it);
    if (keys.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
