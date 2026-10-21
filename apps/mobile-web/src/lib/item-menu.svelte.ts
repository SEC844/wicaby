// A title's menu, from a long press on its card or its page's "…" (Emby's item context menu, the Android cards'
// onLongClick): one at a time over the pages, drawn by components/ItemMenu.svelte.
import type { BaseItem } from '$shared/models';
import type { SeriesDates } from '$desktop/continue';

export interface ItemMenuContext {
  // Opened from the Continue watching row: "Remove" hides the card (and the series' dates order the undo).
  continueRow?: SeriesDates;
  // The page it was opened on is this title's own: no "More info".
  onPage?: boolean;
}

export const itemMenu = $state<{ item: BaseItem | null; ctx: ItemMenuContext }>({ item: null, ctx: {} });

export function openItemMenu(item: BaseItem, ctx: ItemMenuContext = {}): void {
  itemMenu.item = item;
  itemMenu.ctx = ctx;
}

export function closeItemMenu(): void {
  itemMenu.item = null;
}
