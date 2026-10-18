// Vite plugin: `virtual:icons` exports the Android TV app's icon paths (object Ic in ui/Theme.kt, 24 × 24 Material
// Symbols paths), so both TV apps draw the same glyphs from one place. Use them through src/components/Icon.svelte.
import fs from 'node:fs';
import path from 'node:path';

const THEME = path.resolve(import.meta.dirname, '..', '..', 'android', 'tv', 'src', 'main', 'java', 'com', 'wika', 'wicaby', 'tv', 'ui', 'Theme.kt');
const ID = 'virtual:icons';

export function parseIcons(kotlin) {
  const block = /^object Ic \{([\s\S]*?)^\}/m.exec(kotlin)?.[1] ?? '';
  const icons = {};
  for (const m of block.matchAll(/^\s+val (\w+) = icon\("([^"]+)"\)/gm)) icons[m[1]] = m[2];
  return icons;
}

export default function androidIcons() {
  return {
    name: 'wicaby-android-icons',
    resolveId: (id) => (id === ID ? '\0' + ID : null),
    load(id) {
      if (id !== '\0' + ID) return null;
      this.addWatchFile(THEME);
      const icons = parseIcons(fs.readFileSync(THEME, 'utf8'));
      if (!Object.keys(icons).length) throw new Error(`no icons found in ${THEME}`);
      return `export default ${JSON.stringify(icons)};`;
    },
  };
}
