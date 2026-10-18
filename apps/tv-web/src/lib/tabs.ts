// A top-level destination of the tab bar (Chrome.kt TopTab): text tabs scroll, icon tabs stay pinned on the right.
export interface TopTab {
  key: string;
  label: string;
  icon?: string;
}

// Libraries with a tab (Main.kt BROWSABLE, a library without a type included); the others only feed home rows.
const BROWSABLE = new Set(['movies', 'tvshows', 'homevideos', 'photos', 'boxsets', 'mixed', 'livetv', 'books', 'music']);
export const browsable = (collectionType: string | undefined): boolean => !collectionType || BROWSABLE.has(collectionType);
