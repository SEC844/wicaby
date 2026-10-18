// Vite plugin: the TV web app speaks with the Android TV app's own words. `virtual:strings` is built from the
// strings.xml of the Android modules the TV app uses (:tv, :core, :livetv-ui), French from values/ and English from
// values-en/, so both apps share one set of translations and the Android translation checks cover this app too.
// Strings keep Android's printf placeholders (%1$s, %d, %2$02d, %%); src/lib/i18n.svelte.ts formats them.
import fs from 'node:fs';
import path from 'node:path';

const ANDROID = path.resolve(import.meta.dirname, '..', '..', 'android');
const MODULES = ['tv', 'core', 'livetv-ui'];
const ID = 'virtual:strings';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

// Android resource string rules: surrounding quotes keep spaces, backslash escapes, XML entities, inline markup
// (<b>, <xliff:g>) reduced to its text.
export function decode(raw) {
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<\/?[a-zA-Z][^>]*>/g, '');
  s = s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m));
  s = s.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  else s = s.replace(/\s+/g, ' ');
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) =>
    c[0] === 'u' && c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : ({ n: '\n', t: '\t' })[c] ?? c);
}

export function parse(xml) {
  const strings = {};
  const plurals = {};
  for (const m of xml.matchAll(/<string\s+name="([^"]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/string>)/g)) strings[m[1]] = decode(m[2] ?? '');
  for (const m of xml.matchAll(/<plurals\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/plurals>/g)) {
    plurals[m[1]] = {};
    for (const q of m[2].matchAll(/<item\s+quantity="(\w+)"\s*>([\s\S]*?)<\/item>/g)) plurals[m[1]][q[1]] = decode(q[2]);
  }
  return { strings, plurals };
}

function load(folder) {
  const out = { strings: {}, plurals: {} };
  for (const m of MODULES) {
    const file = path.join(ANDROID, m, 'src', 'main', 'res', folder, 'strings.xml');
    if (!fs.existsSync(file)) continue;
    const { strings, plurals } = parse(fs.readFileSync(file, 'utf8'));
    Object.assign(out.strings, strings);
    Object.assign(out.plurals, plurals);
  }
  return out;
}

export default function androidStrings() {
  const files = MODULES.flatMap((m) => ['values', 'values-en'].map((f) => path.join(ANDROID, m, 'src', 'main', 'res', f, 'strings.xml')));
  return {
    name: 'wicaby-android-strings',
    resolveId: (id) => (id === ID ? '\0' + ID : null),
    load(id) {
      if (id !== '\0' + ID) return null;
      for (const f of files) if (fs.existsSync(f)) this.addWatchFile(f);
      return `export default ${JSON.stringify({ fr: load('values'), en: load('values-en') })};`;
    },
  };
}
