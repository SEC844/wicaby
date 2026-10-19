// Screen stack, as the Android TV app's Route stack (MainActivity.kt). Screens below the top stay mounted but
// hidden, so Back returns instantly with their scroll position and focused element intact.
import type { BaseItem } from '$shared/models';
import { focusFirst, focused, setFocus } from './focus';
import type { Server } from './session.svelte';

export type Route =
  | { name: 'servers'; add?: boolean }
  | { name: 'login'; server: Server; add?: boolean }
  | { name: 'main' }
  | { name: 'detail'; id: string; serverId?: string }
  | { name: 'folder'; id: string; title: string; serverId?: string }
  // The player: [queue] for a shuffle (ids in play order, [id] first), [trailer] plays and reports nothing.
  | { name: 'player'; id: string; serverId?: string; fromStart?: boolean; trailer?: boolean; queue?: string[] }
  // Music: an album or audio playlist, an artist, a music library's whole grid, and the now-playing screen.
  | { name: 'musicAlbum'; id: string; title: string }
  | { name: 'musicArtist'; id: string; title: string }
  | { name: 'musicLibrary'; id: string; title: string; mode: 'albums' | 'artists' | 'songs' }
  | { name: 'nowPlaying' }
  // A Live TV channel full screen; [list] the zap order (channel ids) it was opened from, else the whole lineup.
  | { name: 'live'; id: string; list?: string[] }
  // Photos: an album's own timeline, and the viewer over a loaded timeline (lib/photos.svelte.ts timelineByKey).
  | { name: 'photoAlbum'; id: string; title: string }
  | { name: 'photoView'; key: string; index: number }
  | { name: 'reader'; id: string; fromStart?: boolean };

// Android Item.route(): an album or audio playlist opens its page, an artist theirs, a folder (collection, plain
// folder) its grid, a channel plays live, a photo album opens its timeline, everything else its details page.
export function itemRoute(item: BaseItem): Route {
  if (item.Type === 'MusicAlbum' || (item.Type === 'Playlist' && item.MediaType === 'Audio')) return { name: 'musicAlbum', id: item.Id, title: item.Name };
  if (item.Type === 'MusicArtist') return { name: 'musicArtist', id: item.Id, title: item.Name };
  if (item.Type === 'TvChannel') return { name: 'live', id: item.Id };
  if (item.Type === 'PhotoAlbum') return { name: 'photoAlbum', id: item.Id, title: item.Name };
  return item.IsFolder && item.Type !== 'Series' && item.Type !== 'Season'
    ? { name: 'folder', id: item.Id, title: item.Name, serverId: item.ServerId }
    : { name: 'detail', id: item.Id, serverId: item.ServerId };
}

interface Entry {
  key: number;
  route: Route;
  lastFocus: HTMLElement | null;
}

let nextKey = 1;
export const stack = $state<Entry[]>([]);

function leaveTop(): void {
  const top = stack[stack.length - 1];
  if (top) top.lastFocus = focused();
}

// Focus the new top screen once it has rendered: what it had before (Back), else its default element. A default
// that loads later (the home hero) takes the focus itself when it appears (lib/focus.ts focusable), so nothing
// else (the tab bar) is focused in the meantime; the first arrow press covers a screen without any default.
function settle(restore: HTMLElement | null): void {
  requestAnimationFrame(() => {
    if (restore && restore.isConnected) return setFocus(restore);
    const top = document.querySelector('[data-screen-top]');
    if (top?.querySelector('[data-autofocus]')) focusFirst(top);
  });
}

export const nav = {
  push(route: Route): void {
    leaveTop();
    stack.push({ key: nextKey++, route, lastFocus: null });
    settle(null);
  },
  reset(route: Route): void {
    stack.splice(0, stack.length, { key: nextKey++, route, lastFocus: null });
    settle(null);
  },
  // False when already on the first screen (the caller then offers to quit).
  back(): boolean {
    if (stack.length <= 1) return false;
    stack.pop();
    settle(stack[stack.length - 1].lastFocus);
    return true;
  },
  get depth(): number {
    return stack.length;
  },
};

// Back handlers, like Compose's BackHandler: the top screen's newest handler that returns true consumes Back.
// Each screen's handlers carry its stack key, so screens hidden under the top never react.
const SCREEN = Symbol('screen');
const handlers: { screen: number; fn: () => boolean }[] = [];

export function screenContext(key: number): [symbol, number] {
  return [SCREEN, key];
}

export function onBack(screen: number, fn: () => boolean): () => void {
  const h = { screen, fn };
  handlers.push(h);
  return () => {
    const i = handlers.indexOf(h);
    if (i >= 0) handlers.splice(i, 1);
  };
}

export function handleBack(): boolean {
  const top = stack[stack.length - 1]?.key;
  for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i].screen === top && handlers[i].fn()) return true;
  return nav.back();
}

export { SCREEN };
