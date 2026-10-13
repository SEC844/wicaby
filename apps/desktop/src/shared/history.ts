// Watch history helpers: the History page (renderer) and the "Continue watching" jump list
// and tray entries (main). Dependency-free so tools/checks/desk-shell-check.mjs runs it.
import type { BaseItem } from './models';

const DAY_MS = 86_400_000;
const TICKS_PER_MS = 10_000;

export const lastPlayed = (item: BaseItem): number => Date.parse(item.UserData?.LastPlayedDate ?? '') || 0;

// Items ever played, most recent first.
export function recentFirst(items: BaseItem[]): BaseItem[] {
  return items.filter((i) => lastPlayed(i) > 0).sort((a, b) => lastPlayed(b) - lastPlayed(a));
}

// Local midnight of a timestamp.
export function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 0 = today, 1 = yesterday… in local calendar days (DST-safe through rounding).
export function daysAgo(day: number, now = Date.now()): number {
  return Math.round((dayStart(now) - day) / DAY_MS);
}

// Recently played items grouped by local day, newest day first.
export function groupByDay(items: BaseItem[]): { day: number; items: BaseItem[] }[] {
  const groups: { day: number; items: BaseItem[] }[] = [];
  for (const item of recentFirst(items)) {
    const day = dayStart(lastPlayed(item));
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

// Personal stats over the loaded history. shortcut: the server keeps only the last play date
// per item, so a rewatch counts once and an unfinished item counts up to its saved position;
// exact totals would need the Playback Reporting plugin's per-session log.
export function watchStats(
  items: BaseItem[],
  seriesGenres: Map<string, string[]> = new Map(),
  now = Date.now(),
): { weekMs: number; monthMs: number; genres: string[] } {
  let weekMs = 0;
  let monthMs = 0;
  const counts = new Map<string, number>();
  for (const item of recentFirst(items)) {
    const ticks = item.UserData?.Played ? (item.RunTimeTicks ?? 0) : (item.UserData?.PlaybackPositionTicks ?? 0);
    const ms = ticks / TICKS_PER_MS;
    const age = now - lastPlayed(item);
    if (age <= 7 * DAY_MS) weekMs += ms;
    if (age <= 30 * DAY_MS) monthMs += ms;
    // Episodes rarely carry genres of their own: their series' count instead.
    const genres = item.Genres?.length ? item.Genres : (item.SeriesId && seriesGenres.get(item.SeriesId)) || [];
    for (const g of genres) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const genres = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g).slice(0, 5);
  return { weekMs, monthMs, genres };
}
