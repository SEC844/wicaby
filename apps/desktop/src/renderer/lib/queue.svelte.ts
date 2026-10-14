// Play next, add to queue and shuffle, from the item page and the card context menu.
// Main splices the ids into the queue already playing (same server), else plays them now.
import type { BaseItem } from '../../shared/models';
import { apiFor, playQueueFor } from './api';
import { w } from './bridge';
import { t } from './i18n.svelte';
import { shuffled } from './items';
import { errorMessage, playback, toast } from './stores.svelte';

export type QueueMode = 'next' | 'last' | 'shuffle';

const QUEUEABLE = ['Movie', 'Episode', 'Series', 'Season', 'BoxSet', 'Video', 'MusicVideo', 'Audio', 'MusicAlbum', 'Playlist', 'Trailer'];
// Series, season, collection, library: everything under it in random order.
const SHUFFLABLE = ['Series', 'Season', 'BoxSet', 'CollectionFolder'];

export function queueModes(item: BaseItem): QueueMode[] {
  if (item.LocationType === 'Virtual') return [];
  const out: QueueMode[] = QUEUEABLE.includes(item.Type) ? ['next', 'last'] : [];
  if (SHUFFLABLE.includes(item.Type)) out.push('shuffle');
  return out;
}

// The card context menu, drawn once by QueueMenu at the pointer.
export const cardMenu = $state<{ value: { item: BaseItem; x: number; y: number; from: HTMLElement | null } | null }>({ value: null });

export async function queue(item: BaseItem, mode: QueueMode): Promise<void> {
  try {
    const active = mode !== 'shuffle' && playback.value?.active;
    // Main would stop the other server's queue to play this one; refuse instead of interrupting it.
    if (active && playback.value?.item?.serverId !== item.ServerId) throw new Error(t('item.errors.queueOtherServer'));
    let ids: string[];
    if (mode === 'shuffle') {
      // SortBy=Random samples a big library server-side; the local shuffle covers the 2 min GET cache.
      const r = await apiFor(item.ServerId).items({
        ParentId: item.Id,
        Recursive: true,
        IncludeItemTypes: 'Movie,Episode,Video,MusicVideo,Audio',
        SortBy: 'Random',
        Limit: 500,
      });
      ids = shuffled(r.Items.map((x) => x.Id));
    } else if (item.Type === 'Episode') {
      ids = [item.Id];
    } else {
      // A series or season from its next unwatched episode, a film alone, an album or collection whole.
      const q = await playQueueFor(item);
      ids = q.itemIds.slice(q.startIndex);
    }
    if (ids.length === 0) throw new Error(t('item.errors.nothingToPlay'));
    await w.playback.play({ itemIds: ids, serverId: item.ServerId, command: mode === 'next' ? 'PlayNext' : mode === 'last' ? 'PlayLast' : undefined });
    if (active) toast('success', t(mode === 'next' ? 'item.toast.playingNext' : 'item.toast.addedToQueue', { name: item.Name }));
  } catch (err) {
    toast('error', errorMessage(err));
  }
}

// Tracks by id (a multi-selection, a drop on the queue): next or last in the queue playing, else played now.
// false when it failed (toasted).
export async function queueIds(ids: string[], serverId: string | undefined, mode: 'next' | 'last', name: string): Promise<boolean> {
  try {
    const active = playback.value?.active;
    if (active && playback.value?.item?.serverId !== serverId) throw new Error(t('item.errors.queueOtherServer'));
    if (ids.length === 0) throw new Error(t('item.errors.nothingToPlay'));
    await w.playback.play({ itemIds: ids, serverId, command: mode === 'next' ? 'PlayNext' : 'PlayLast' });
    if (active) toast('success', t(mode === 'next' ? 'item.toast.playingNext' : 'item.toast.addedToQueue', { name }));
    return true;
  } catch (err) {
    toast('error', errorMessage(err));
    return false;
  }
}
