// Main-process translations: tray, taskbar, jump list, notifications, dialogs and
// error messages. Same catalogues as the renderer; only the namespaces main needs
// are bundled. Conventions: docs/i18n.md.
import { app } from 'electron';
import { flattenInto, formatMessage, lookup, resolveLanguage, type Catalog, type Lang, type Params } from '../shared/i18n-core';
import enCast from '../renderer/locales/en/cast.json';
import enCommon from '../renderer/locales/en/common.json';
import enErrors from '../renderer/locales/en/errors.json';
import enFiles from '../renderer/locales/en/files.json';
import enMain from '../renderer/locales/en/main.json';
import frCast from '../renderer/locales/fr/cast.json';
import frCommon from '../renderer/locales/fr/common.json';
import frErrors from '../renderer/locales/fr/errors.json';
import frFiles from '../renderer/locales/fr/files.json';
import frMain from '../renderer/locales/fr/main.json';
import type { SettingsService } from './core/settings';

const catalogs: Record<Lang, Catalog> = { fr: new Map(), en: new Map() };
for (const [lang, files] of [
  ['fr', { common: frCommon, errors: frErrors, main: frMain, cast: frCast, files: frFiles }],
  ['en', { common: enCommon, errors: enErrors, main: enMain, cast: enCast, files: enFiles }],
] as const) {
  for (const [ns, data] of Object.entries(files)) flattenInto(catalogs[lang], data, ns);
}

let settings: SettingsService | null = null;
let current: Lang = 'fr';
const listeners = new Set<(lang: Lang) => void>();

function resolve(): Lang {
  // getLocale() is only meaningful once the app is ready.
  return resolveLanguage(settings?.value.ui.language, app.isReady() ? app.getLocale() : undefined);
}

// Call once, right after the SettingsService exists.
export function initI18n(s: SettingsService): void {
  settings = s;
  current = resolve();
  s.on('change', () => {
    const next = resolve();
    if (next === current) return;
    current = next;
    for (const fn of listeners) fn(next);
  });
}

export function language(): Lang {
  return current;
}

// Native UI that is built once (tray menu, jump list, thumbar) rebuilds itself here.
export function onLanguageChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key: string, params?: Params): string {
  const msg = lookup(catalogs, current, key);
  if (msg === undefined) {
    if (!app.isPackaged) console.warn(`[i18n] missing key: ${key}`);
    return key;
  }
  return formatMessage(msg, params, current);
}
