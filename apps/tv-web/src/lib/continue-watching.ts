// Merged "Continuer à regarder" (feature-specs.md X-01; Android core ContinueWatching.kt): in-progress items and
// next-up episodes in one row, one card per series, most recently watched first, minus the cards the user removed.
// The merge and the hidden-card rules are the desktop's pure renderer/lib/continue.ts.
import type { BaseItem } from '$shared/models';
import { hiddenKey, isHidden, mergeContinue, recency, type HiddenEntry, type SeriesDates, withHidden, withoutHidden } from '$desktop/continue';
import { dedupe } from '$desktop/items';
import type { Api } from './api';
import { fanOut } from './servers';
import { apis } from './session.svelte';
import { runtimeText } from './format';
import { t } from './i18n.svelte';
import { load, save } from './storage';

export interface ContinueRow {
  items: BaseItem[];
  series: SeriesDates;
}

const inProgress = (item: BaseItem): boolean => (item.UserData?.PlaybackPositionTicks ?? 0) > 0;
const hidden = (): HiddenEntry[] => load<HiddenEntry[]>('continue_hidden', []);

// Every item carries its server, as the desktop's api.ts stamps them (keys and hidden entries use it).
function stamp(items: BaseItem[], serverId: string): BaseItem[] {
  for (const it of items) it.ServerId ??= serverId;
  return items;
}

// Resume, next up and the series dates (one batched call), minus the hidden cards.
export async function loadContinue(api: Api, serverId: string): Promise<ContinueRow> {
  const [resume, nextUp] = await Promise.all([api.resume(), api.nextUp()]);
  stamp(resume, serverId);
  stamp(nextUp, serverId);
  const ids = [...resume, ...nextUp].filter((i) => !inProgress(i) && i.SeriesId).map((i) => i.SeriesId!);
  // Without dates the next-up cards keep the server order, after the dated ones.
  const dates = await api.seriesUserData([...new Set(ids)]).catch(() => new Map<string, string>());
  const series: SeriesDates = new Map([...dates].map(([id, d]) => [`${serverId}:${id}`, d]));
  const list = hidden();
  const items = mergeContinue(resume, nextUp, series).filter((i) => !isHidden(list, hiddenKey(i, api.userId!), recency(i, series)));
  return { items, series };
}

// The card line: "Suivant : S2·É5" on a next-up episode, the time left on an in-progress film; undefined keeps the
// card's own line.
export function continueSubtitle(item: BaseItem): string | undefined {
  if (inProgress(item) && item.Type !== 'Episode') {
    const left = runtimeText((item.RunTimeTicks ?? 0) - (item.UserData?.PlaybackPositionTicks ?? 0));
    return left ? t('continue_time_left', left) : undefined;
  }
  if (!inProgress(item) && item.Type === 'Episode' && item.IndexNumber != null) return t('next_episode_short', item.ParentIndexNumber ?? 0, item.IndexNumber);
  return undefined;
}

// Emby also hides an in-progress item on the server (a failure there means unsupported: the local list covers it).
export async function removeFromContinue(api: Api, item: BaseItem, series: SeriesDates): Promise<void> {
  save('continue_hidden', withHidden(hidden(), hiddenKey(item, api.userId!), recency(item, series)));
  if (api.isEmby && inProgress(item)) await api.hideFromResume(item.Id, true).catch(() => {});
}

export async function undoRemove(api: Api, item: BaseItem): Promise<void> {
  if (api.isEmby && inProgress(item)) await api.hideFromResume(item.Id, false).catch(() => {});
  save('continue_hidden', withoutHidden(hidden(), hiddenKey(item, api.userId!)));
}

// Every signed-in server's row in one (TP-06): their cards by how recently they were watched, one copy of a title
// found on several servers. Alone, the primary's row as is.
export async function loadContinueAll(api: Api, serverId: string): Promise<ContinueRow> {
  const others = apis().filter((a) => a !== api);
  if (!others.length) return loadContinue(api, serverId);
  const rows = await fanOut((a) => loadContinue(a, a.serverId ?? serverId));
  const series: SeriesDates = new Map();
  for (const r of rows) r?.series.forEach((d, k) => series.set(k, d));
  const items = rows.flatMap((r) => r?.items ?? []);
  const time = (i: BaseItem) => Date.parse(recency(i, series)) || 0;
  items.sort((a, b) => time(b) - time(a));
  return { items: dedupe(items), series };
}
