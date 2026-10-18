// Translations: the Android TV app's strings (virtual:strings, scripts/android-strings.mjs), French and English.
// t() and plural() take Android's printf placeholders: %1$s, %2$d, %d, %2$02d and %%.
import catalogs from 'virtual:strings';

export type Lang = 'fr' | 'en';
export type LanguagePref = 'auto' | Lang;

function resolve(pref: LanguagePref): Lang {
  if (pref !== 'auto') return pref;
  return /^fr\b/i.test(navigator.language) ? 'fr' : 'en';
}

// Read through t(), so every template that shows text re-renders on a switch.
export const locale = $state<{ current: Lang }>({ current: resolve('auto') });

export function setLanguage(pref: LanguagePref): void {
  locale.current = resolve(pref);
  document.documentElement.lang = locale.current;
}

function format(template: string, args: (string | number)[]): string {
  let next = 0;
  return template.replace(/%(?:(\d+)\$)?(0?\d+)?([sd%])/g, (m, pos: string | undefined, width: string | undefined, type: string) => {
    if (type === '%') return '%';
    const value = args[pos ? Number(pos) - 1 : next++];
    if (value === undefined) return m;
    const text = type === 'd' ? String(Math.trunc(Number(value))) : String(value);
    return width ? text.padStart(Number(width), width.startsWith('0') ? '0' : ' ') : text;
  });
}

const warned = new Set<string>();
function missing(key: string): string {
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`i18n: missing string ${key}`);
  }
  return key;
}

export function t(key: string, ...args: (string | number)[]): string {
  const value = catalogs[locale.current].strings[key] ?? catalogs.fr.strings[key];
  return value === undefined ? missing(key) : format(value, args);
}

// CLDR rules for the two languages: French "one" covers 0 and 1, English only 1.
function category(lang: Lang, n: number): 'one' | 'other' {
  if (lang === 'fr') return n >= 0 && n < 2 ? 'one' : 'other';
  return n === 1 ? 'one' : 'other';
}

export function plural(key: string, n: number, ...args: (string | number)[]): string {
  const lang = locale.current;
  const forms = catalogs[lang].plurals[key] ?? catalogs.fr.plurals[key];
  if (!forms) return missing(key);
  const template = forms[category(lang, n)] ?? forms.other ?? Object.values(forms)[0];
  return format(template, args.length ? args : [n]);
}

// A translation key stored for later (option tables): t(key) reads it. Marked so scripts/check-strings.mjs checks it.
export const k = (key: string): string => key;
