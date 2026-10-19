// Vite plugin: `virtual:tokens` exports the TV themes of the shared Graphite tokens (packages/tokens/tokens.json,
// resolved by its build.mjs), so this app follows the desktop and Android apps from the same source. Each theme
// carries the CSS custom properties src/lib/theme.ts sets on <html>, in rgba() (Chromium 53 has no space-separated
// rgb()), and its accents in that theme's tones. Light is desktop and mobile only (tv: false), as on Android TV.
import path from 'node:path';
import { resolve, rgba } from '../../../packages/tokens/build.mjs';

const TOKENS = path.resolve(import.meta.dirname, '..', '..', '..', 'packages', 'tokens', 'tokens.json');
const ID = 'virtual:tokens';

// CSS custom property ← token role, as Android TV's C facade reads them (ui/Theme.kt).
const VARS = {
  '--bg': 'bg',
  '--elevated': 'bg-elevated',
  '--elevated-2': 'bg-elevated-2',
  '--label': 'label',
  '--label-2': 'label-2',
  '--label-3': 'label-3',
  '--fill-1': 'fill-1',
  '--fill-2': 'fill-2',
  '--fill-3': 'fill-3',
  '--fill-4': 'fill-4',
  '--separator': 'separator',
  '--scrim': 'scrim',
  // Opaque fill for focused surfaces: a lift shadow must not show through.
  '--raised': 'raised-focus',
};

function css(color) {
  const [r, g, b, a] = rgba(color);
  return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function tvThemes() {
  return resolve().filter((t) => t.tv).map((t) => ({
    id: t.id,
    vars: { ...Object.fromEntries(Object.entries(VARS).map(([v, role]) => [v, css(t.roles[role])])), '--red': css(t.system.red) },
    accents: t.accents.map((a) => ({ color: css(a.color), fg: css(a.fg) })),
  }));
}

export default function tokens() {
  return {
    name: 'wicaby-tokens',
    resolveId: (id) => (id === ID ? '\0' + ID : null),
    load(id) {
      if (id !== '\0' + ID) return null;
      this.addWatchFile(TOKENS);
      return `export default ${JSON.stringify(tvThemes())};`;
    },
  };
}
