// Screen stack, as the Android TV app's Route stack (MainActivity.kt). Screens below the top stay mounted but
// hidden, so Back returns instantly with their scroll position and focused element intact.
import { focusFirst, focused, setFocus } from './focus';
import type { Server } from './session.svelte';

export type Route =
  | { name: 'servers'; add?: boolean }
  | { name: 'login'; server: Server; add?: boolean }
  | { name: 'main' }
  | { name: 'detail'; id: string; serverId?: string }
  | { name: 'folder'; id: string; title: string; serverId?: string };

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

// Focus the new top screen once it has rendered.
function settle(restore: HTMLElement | null): void {
  requestAnimationFrame(() => {
    if (restore && restore.isConnected) setFocus(restore);
    else focusFirst(document.querySelector('[data-screen-top]') ?? document);
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
