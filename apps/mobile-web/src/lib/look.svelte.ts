// The phone's own look preferences (Réglages > Apparence), beside the shared theme and accent: the text size, the
// library cards, the posters, the tab bar's labels, the motion. Kept on the phone; applied to the document as CSS
// variables and attributes, so a change shows at once everywhere.
import { load, save } from '$tv/storage';

// The text size: 'system' follows iOS's (Réglages > Luminosité et affichage > Taille du texte, read from the
// -apple-system-body font), else a fixed scale of the 17 pt body.
export type TextSize = 'system' | number;
export const TEXT_SCALES = [0.88, 1, 1.12, 1.24, 1.36];

export interface Look {
  textSize: TextSize;
  // Library cards: the server's artwork, or a plain tint with the library's icon.
  libraryArt: boolean;
  // Posters in rows and grids: 0 small, 1 medium, 2 large.
  posterSize: number;
  // The title under each poster.
  posterTitles: boolean;
  tabLabels: boolean;
  reduceMotion: boolean;
}

const DEFAULTS: Look = { textSize: 'system', libraryArt: true, posterSize: 1, posterTitles: true, tabLabels: true, reduceMotion: false };

export const look = $state<Look>({ ...DEFAULTS, ...load<Partial<Look>>('look', {}) });

export function setLook<K extends keyof Look>(key: K, value: Look[K]): void {
  look[key] = value;
  save('look', $state.snapshot(look));
  apply();
}

// iOS's body size in this browser (17 px at the default size), as a scale; 1 where the font is unknown.
export function systemScale(): number {
  if (!CSS.supports('font', '-apple-system-body')) return 1;
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;font:-apple-system-body';
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  return px > 0 ? px / 17 : 1;
}

// The accessibility sizes go far past what the layouts hold: the scale stops at 1.4.
export const textScale = (): number => Math.min(1.4, Math.max(0.82, look.textSize === 'system' ? systemScale() : look.textSize));

export function apply(): void {
  const root = document.documentElement;
  root.style.setProperty('--text-scale', textScale().toFixed(3));
  root.toggleAttribute('data-reduce-motion', look.reduceMotion);
}

// At start, and when the app comes back (the iOS text size may have changed meanwhile).
export function initLook(): void {
  apply();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && look.textSize === 'system' && apply());
}

// A poster's width in a row for the chosen size, from the medium one.
export const posterWidth = (medium: number): number => Math.round(medium * [0.8, 1, 1.24][look.posterSize]);
