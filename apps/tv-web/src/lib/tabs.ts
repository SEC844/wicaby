import { arrange } from './home-rows';

// A top-level destination of the tab bar (Chrome.kt TopTab): text tabs scroll, icon tabs stay pinned on the right.
export interface TopTab {
  key: string;
  label: string;
  icon?: string;
}

// Libraries with a tab (Main.kt BROWSABLE, a library without a type included); the others only feed home rows.
const BROWSABLE = new Set(['movies', 'tvshows', 'homevideos', 'photos', 'boxsets', 'mixed', 'livetv', 'books', 'music']);
export const browsable = (collectionType: string | undefined): boolean => !collectionType || BROWSABLE.has(collectionType);

// #6 (Android TabOrder.kt): Home, Search and Settings stay where they are; the tabs between them follow the user's
// order (Settings > Interface > Tab bar), hidden ones left out. [current] stays while open, so a jump to a hidden
// tab still shows where the user is.
const PINNED = new Set(['home', 'search', 'settings']);

export const movableTabs = <T extends { key: string }>(tabs: T[]): T[] => tabs.filter((t) => !PINNED.has(t.key));

export function tabBar<T extends { key: string }>(tabs: T[], pref: { order: string[]; hidden: string[] }, current?: string): T[] {
  const byKey = new Map(tabs.map((t) => [t.key, t]));
  const middle = arrange(movableTabs(tabs).map((t) => t.key), pref).filter((k) => !pref.hidden.includes(k) || k === current);
  return [...tabs.filter((t) => t.key === 'home'), ...middle.map((k) => byKey.get(k)!), ...tabs.filter((t) => PINNED.has(t.key) && t.key !== 'home')];
}
