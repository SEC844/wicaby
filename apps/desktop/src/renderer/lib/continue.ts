// Merged "Continuer à regarder" (feature-specs.md X-01): in-progress items and next-up episodes in one row,
// one card per series, most recently watched first, minus the cards the user removed. Pure: no store, no IPC
// (tools/checks/continue-check.mjs runs it on fixtures).
import type { BaseItem } from '../../shared/models';

// One removed card: `serverId:userId:itemId`, and the card's recency date when it was removed ('' = none).
export type HiddenEntry = { key: string; played: string };
export const HIDE_CAP = 500;

const time = (d?: string | null): number => (d ? Date.parse(d) || 0 : 0);
const at = (item: BaseItem) => `${item.ServerId ?? ''}:`;

// Series last played, keyed `serverId:seriesId` (the batched series UserData answer, keyed by itemKey()).
export type SeriesDates = Map<string, string>;

const inProgress = (item: BaseItem) => (item.UserData?.PlaybackPositionTicks ?? 0) > 0;

// The date a card sorts and un-hides by: its own last play for an in-progress item, the series' for a next-up one.
export function recency(item: BaseItem, series: SeriesDates): string {
  if (inProgress(item)) return item.UserData?.LastPlayedDate ?? '';
  return (item.SeriesId ? series.get(at(item) + item.SeriesId) : undefined) ?? item.UserData?.LastPlayedDate ?? '';
}

export function mergeContinue(resume: BaseItem[], nextUp: BaseItem[], series: SeriesDates): BaseItem[] {
  // Emby's Resume can mix in rows without a position: those are next-up material.
  const started = resume.filter(inProgress);
  const seen = new Set<string>();
  for (const it of started) seen.add(at(it) + (it.SeriesId ?? it.Id));
  const out = [...started];
  for (const it of [...resume.filter((x) => !inProgress(x)), ...nextUp]) {
    // A series with an episode in progress keeps that card; one card per series or film.
    const k = at(it) + (it.SeriesId ?? it.Id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  // Newest first; undated cards after the dated ones, in server order (Array.prototype.sort is stable).
  const t = new Map(out.map((it) => [it, time(recency(it, series))]));
  return out.sort((a, b) => Number(t.get(b)! > 0) - Number(t.get(a)! > 0) || t.get(b)! - t.get(a)!);
}

export const hiddenKey = (item: BaseItem, userId: string) => `${item.ServerId ?? ''}:${userId}:${item.Id}`;

// Hidden until the card's date grows (it was played again).
export function isHidden(list: readonly HiddenEntry[], key: string, played: string): boolean {
  const e = list.find((x) => x.key === key);
  return !!e && time(played) <= time(e.played);
}

// Newest last; the oldest entries go past HIDE_CAP.
export function withHidden(list: readonly HiddenEntry[], key: string, played: string): HiddenEntry[] {
  return [...list.filter((x) => x.key !== key), { key, played }].slice(-HIDE_CAP);
}

export function withoutHidden(list: readonly HiddenEntry[], key: string): HiddenEntry[] {
  return list.filter((x) => x.key !== key);
}
