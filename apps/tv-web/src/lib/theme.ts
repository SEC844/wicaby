// Themes and accents (Android TV ui/Theme.kt C and Accents): the TV themes of the shared tokens (virtual:tokens,
// scripts/tokens.mjs), applied as CSS custom properties on <html>. A theme the TV never offers reads as graphite.
import themes, { type TvTheme } from 'virtual:tokens';

export const THEMES = themes;

export function palette(id: string): TvTheme {
  return themes.find((t) => t.id === id) ?? themes[0];
}

// The theme's accent [index] in its own tone, with the text colour on it.
export function accentOf(p: TvTheme, index: number): { color: string; fg: string } {
  return p.accents[index] ?? p.accents[0];
}

export function applyTheme(id: string, accent: number): void {
  const p = palette(id);
  const style = document.documentElement.style;
  for (const name of Object.keys(p.vars)) style.setProperty(name, p.vars[name]);
  const a = accentOf(p, accent);
  style.setProperty('--accent', a.color);
  style.setProperty('--on-accent', a.fg);
}
