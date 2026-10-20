// Watch history (TP-08, Android core WatchHistory.load, desktop routes/History.svelte): the same queries on every
// signed-in server, merged newest first, then the genres of the series whose episodes carry none (the stats need
// them). The grouping and the stats are the desktop's pure shared/history.ts.
import { merge } from '$desktop/items';
import type { BaseItem } from '$shared/models';
import { fanOut } from './servers';
import { apiOf } from './session.svelte';

export interface HistoryData {
  items: BaseItem[];
  seriesGenres: Map<string, string[]>;
}

// Emby can sort never-played items before played ones on DatePlayed: an unfiltered query may hold no history at
// all, hence one query per filter.
const QUERY = { Recursive: true, IncludeItemTypes: 'Movie,Episode', SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: 200 };
const FILTERS = ['IsPlayed', 'IsResumable'];

export async function loadHistory(): Promise<HistoryData> {
  const found = await fanOut(async (a) => {
    const lists = await Promise.all(FILTERS.map((f) => a.items({ ...QUERY, Filters: f })));
    return lists.flatMap((l) => l.Items).map((i) => (i.ServerId ? i : { ...i, ServerId: a.serverId }));
  });
  if (found.every((f) => f === null)) throw new Error('history: no server answered');
  const items = merge(found, true);
  // One lookup per server of the series whose episodes carry no genres.
  const missing = new Map<string, Set<string>>();
  for (const i of items) {
    if (i.Genres?.length || !i.SeriesId || !i.UserData?.LastPlayedDate) continue;
    const sid = i.ServerId ?? '';
    if (!missing.has(sid)) missing.set(sid, new Set());
    missing.get(sid)!.add(i.SeriesId);
  }
  const seriesGenres = new Map<string, string[]>();
  await Promise.all(
    [...missing].map(async ([sid, ids]) => {
      const a = apiOf(sid);
      if (!a) return;
      const r = await a.items({ Ids: [...ids].slice(0, 50).join(','), EnableImages: false }).catch(() => null);
      for (const s of r?.Items ?? []) seriesGenres.set(s.Id, s.Genres ?? []);
    }),
  );
  return { items, seriesGenres };
}
