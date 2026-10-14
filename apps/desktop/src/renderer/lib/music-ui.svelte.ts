// Music UI state and verbs shared by the library tabs, the album page, the now-playing bar, the queue panel and
// the full-screen player (music-spec MU-03 to MU-06). Main owns the queue (PlaybackState.music); this file only
// keeps what the pages show: the queue's items by id, the open panel and the track menu.
import type { BaseItem } from '../../shared/models';
import { selectIds } from '../../shared/music-ui';
import { apiFor, LIST_FIELDS } from './api';
import { w } from './bridge';
import { t } from './i18n.svelte';
import { instantMix } from './music';
import { dataVersion, errorMessage, playback, toast } from './stores.svelte';

export const musicUi = $state<{
  queue: boolean;
  menu: { item: BaseItem; x: number; y: number; from: HTMLElement | null } | null;
  addTo: BaseItem | null;
  // With addTo: a multi-selection's ids, all of addTo's server.
  addIds: string[] | null;
}>({ queue: false, menu: null, addTo: null, addIds: null });

// ---- Multi-select of track rows (music spec C3): Ctrl-click toggles, Shift-click takes a range, in one list at a
// time (list: the page's key); a plain click plays and clears it, as do Escape and a new page (SelectionBar).
export const selection = $state<{ list: string; items: BaseItem[]; anchor: string | null }>({ list: '', items: [], anchor: null });
export const clearSelection = (): void => {
  selection.items = [];
  selection.anchor = null;
};
// true when the click selected (the row must not play). Space on a row toggles it like Ctrl-click (Shift+Space: a range).
export function selectRow(list: string, order: BaseItem[], item: BaseItem, e: MouseEvent | KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey || e.shiftKey || ('key' in e && e.key === ' '))) {
    clearSelection();
    return false;
  }
  e.preventDefault();
  if (selection.list !== list) {
    clearSelection();
    selection.list = list;
  }
  const byId = new Map(order.map((x) => [x.Id, x]));
  const ids = selectIds(selection.items.map((x) => x.Id), order.map((x) => x.Id), item.Id, selection.anchor, e.shiftKey);
  selection.items = ids.map((id) => byId.get(id)).filter((x): x is BaseItem => Boolean(x));
  if (!e.shiftKey || !selection.anchor) selection.anchor = item.Id;
  return true;
}

// ---- Drag tracks onto the queue or a sidebar playlist (C3, C5): the selection when the row is in it, else the row.
const MIME = 'application/x-wicaby-tracks';
export function dragTracks(e: DragEvent, list: string, item: BaseItem): void {
  if (!e.dataTransfer) return;
  const items = selection.list === list && selection.items.some((x) => x.Id === item.Id) ? selection.items : [item];
  e.dataTransfer.setData(MIME, JSON.stringify({ ids: items.map((x) => x.Id), serverId: item.ServerId }));
  e.dataTransfer.setData('text/plain', items.map((x) => x.Name).join('\n'));
  e.dataTransfer.effectAllowed = 'copy';
}
export const carriesTracks = (e: DragEvent): boolean => Boolean(e.dataTransfer?.types.includes(MIME));
// What a drop carries, checked: only a list of ids from this app's rows.
export function droppedTracks(e: DragEvent): { ids: string[]; serverId?: string } | null {
  try {
    const v = JSON.parse(e.dataTransfer?.getData(MIME) || 'null') as { ids?: unknown; serverId?: unknown } | null;
    if (!Array.isArray(v?.ids) || !v.ids.length || !v.ids.every((x) => typeof x === 'string')) return null;
    return { ids: v.ids as string[], serverId: typeof v.serverId === 'string' ? v.serverId : undefined };
  } catch {
    return null;
  }
}

// The current track is music (the bar, the panel and the shortcuts show only then).
export const musicActive = () => Boolean(playback.value?.active && playback.value.music && playback.value.item);

// Queue items by id, fetched once per id (names, art, artists and durations of the queue rows).
export const known = $state<Record<string, BaseItem>>({});
const asked = new Set<string>();
export async function ensureItems(ids: string[], serverId?: string): Promise<void> {
  const missing = [...new Set(ids)].filter((id) => !known[id] && !asked.has(id));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    chunk.forEach((id) => asked.add(id));
    try {
      const r = await apiFor(serverId).items({ Ids: chunk.join(','), Fields: LIST_FIELDS, EnableUserData: true });
      for (const it of r.Items) known[it.Id] = it;
    } catch {
      // Rows without their item show a placeholder; asked again on the next change.
      chunk.forEach((id) => asked.delete(id));
    }
  }
}

export async function playTracks(ids: string[], startIndex: number, serverId?: string): Promise<void> {
  try {
    if (!ids.length) throw new Error(t('item.errors.nothingToPlay'));
    await w.playback.play({ itemIds: ids, startIndex, serverId });
  } catch (err) {
    toast('error', errorMessage(err));
  }
}

// "Mix" (spec §3.3): GET /Items/{id}/InstantMix for a track, album, artist, genre or playlist, played now;
// radio also turns the top-up on once it plays.
export async function playMix(item: BaseItem, radio = false): Promise<void> {
  try {
    const r = await instantMix(item.Id, 100, item.ServerId);
    const ids = (r.Items ?? []).map((x) => x.Id);
    if (!ids.length) throw new Error(t('item.errors.nothingToPlay'));
    await w.playback.play({ itemIds: ids, serverId: item.ServerId });
    if (radio) await w.playback.command({ type: 'radio', value: true });
  } catch (err) {
    toast('error', errorMessage(err));
  }
}

export async function toggleFavorite(item: BaseItem): Promise<void> {
  const next = !item.UserData?.IsFavorite;
  item.UserData = { ...item.UserData, IsFavorite: next };
  if (known[item.Id] && known[item.Id] !== item) known[item.Id].UserData = { ...known[item.Id].UserData, IsFavorite: next };
  try {
    await apiFor(item.ServerId).setFavorite(item.Id, next);
    dataVersion.userData++;
  } catch (err) {
    item.UserData = { ...item.UserData, IsFavorite: !next };
    toast('error', errorMessage(err));
  }
}

export const command = (c: Parameters<typeof w.playback.command>[0]) => void w.playback.command(c).catch((err) => toast('error', errorMessage(err)));

export function openTrackMenu(item: BaseItem, e: MouseEvent | KeyboardEvent, from: HTMLElement | null): void {
  e.preventDefault();
  const r = from?.getBoundingClientRect();
  const x = 'clientX' in e && e.clientX ? e.clientX : (r?.right ?? 0) - 220;
  const y = 'clientY' in e && e.clientY ? e.clientY : (r?.bottom ?? 0);
  musicUi.menu = { item, x, y, from };
}

// The track artists unless they are only the album artist (album pages show them once, in the header).
export const featured = (track: BaseItem, albumArtist?: string): string => {
  const a = (track.Artists ?? []).join(', ');
  return a && a !== albumArtist ? a : '';
};
