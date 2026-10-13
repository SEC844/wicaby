// Renderer translations and locale-aware formatting. Conventions: docs/i18n.md.
import {
  flattenInto,
  formatMessage,
  lookup,
  messageParts,
  resolveLanguage,
  type Catalog,
  type Lang,
  type LanguagePref,
  type Params,
  type Part,
} from '../../shared/i18n-core';

export type { Lang, LanguagePref, Params, Part };

const files = import.meta.glob<Record<string, unknown>>('../locales/*/*.json', { eager: true, import: 'default' });
const catalogs: Record<Lang, Catalog> = { fr: new Map(), en: new Map() };
for (const [file, data] of Object.entries(files)) {
  const m = /\/locales\/(fr|en)\/([\w-]+)\.json$/.exec(file);
  if (m) flattenInto(catalogs[m[1] as Lang], data, m[2]);
}

// Read through t() and fmt, so every template that shows text re-renders on a switch.
export const locale = $state<{ current: Lang }>({ current: resolveLanguage('auto', navigator.language) });

export function setLanguage(pref: LanguagePref | undefined): void {
  const next = resolveLanguage(pref, navigator.language);
  document.documentElement.lang = next;
  if (next !== locale.current) locale.current = next;
}

const warned = new Set<string>();

export function has(key: string): boolean {
  return lookup(catalogs, locale.current, key) !== undefined;
}

export function t(key: string, params?: Params): string {
  const lang = locale.current;
  const msg = lookup(catalogs, lang, key);
  if (msg === undefined) {
    if (import.meta.env.DEV && !warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] missing key: ${key}`);
    }
    return key;
  }
  return formatMessage(msg, params, lang);
}

// For a message whose placeholder needs markup around it:
// {#each tParts('player.resume.stoppedAt') as p}{#if p.slot}<span class="mono">{time}</span>{:else}{p.text}{/if}{/each}
export function tParts(key: string): Part[] {
  const msg = lookup(catalogs, locale.current, key);
  return msg === undefined ? [{ text: t(key) }] : messageParts(msg);
}

// ---- Formatting ----

// French keeps fr-FR so the output stays exactly what it was before i18n. English
// takes the Windows region when it is an English one (en-GB gets a 24 h clock).
function intlLocale(): string {
  if (locale.current === 'fr') return 'fr-FR';
  return /^en-/i.test(navigator.language) ? navigator.language : 'en-US';
}

const cache = new Map<string, unknown>();
function cached<T>(kind: string, opts: object | undefined, make: (loc: string) => T): T {
  const loc = intlLocale();
  const k = `${kind}|${loc}|${opts ? JSON.stringify(opts) : ''}`;
  let f = cache.get(k) as T | undefined;
  if (!f) cache.set(k, (f = make(loc)));
  return f;
}

type DateInput = Date | string | number;
const toDate = (v: DateInput) => (v instanceof Date ? v : new Date(v));

const BYTE_UNITS: Record<Lang, string[]> = {
  fr: ['o', 'Ko', 'Mo', 'Go', 'To'],
  en: ['B', 'KB', 'MB', 'GB', 'TB'],
};

const pad2 = (n: number) => String(n).padStart(2, '0');
// Runtime style: "1 h 42" / "53 min" in French (as before), "1h 42m" / "53m" in English.
const DURATION: Record<Lang, { min: (m: number) => string; hm: (h: number, m: number) => string }> = {
  fr: { min: (m) => `${m} min`, hm: (h, m) => `${h} h ${pad2(m)}` },
  en: { min: (m) => `${m}m`, hm: (h, m) => (m ? `${h}h ${m}m` : `${h}h`) },
};

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.35],
  ['month', 12],
  ['year', Infinity],
];

export const fmt = {
  number(n: number, opts?: Intl.NumberFormatOptions): string {
    return cached('n', opts, (l) => new Intl.NumberFormat(l, opts)).format(n);
  },

  // "12 octobre 2026" / "October 12, 2026"; pass Intl options for other shapes.
  date(v: DateInput, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }): string {
    return cached('d', opts, (l) => new Intl.DateTimeFormat(l, opts)).format(toDate(v));
  },

  // "22:41" / "10:41 PM".
  time(v: DateInput): string {
    // 2-digit hours read "08:00 PM" on a 12 h clock: numeric there, 2-digit on a 24 h one.
    return cached('t', undefined, (l) => {
      const h12 = new Intl.DateTimeFormat(l, { hour: 'numeric' }).resolvedOptions().hour12;
      return new Intl.DateTimeFormat(l, { hour: h12 ? 'numeric' : '2-digit', minute: '2-digit' });
    }).format(toDate(v));
  },

  // "mar. 13" / "Tue 13": en-US Intl puts the day first ("13 Tue") for this pair.
  day(v: DateInput): string {
    return `${fmt.date(v, { weekday: 'short' })} ${fmt.date(v, { day: 'numeric' })}`;
  },

  // "il y a 5 min" / "5 min. ago"; "À l’instant" / "Just now" under a minute.
  relative(v: DateInput, now = Date.now()): string {
    let delta = (toDate(v).getTime() - now) / 1000;
    if (Math.abs(delta) < 60) return t('common.time.justNow');
    const rtf = cached('r', undefined, (l) => new Intl.RelativeTimeFormat(l, { numeric: 'auto', style: 'short' }));
    for (const [unit, size] of RELATIVE_STEPS) {
      if (Math.abs(delta) < size) return rtf.format(Math.round(delta), unit);
      delta /= size;
    }
    return '';
  },

  // "1,5 Go" / "1.5 GB": whole numbers below a megabyte, one decimal above.
  bytes(n: number): string {
    const units = BYTE_UNITS[locale.current];
    if (!n) return `0 ${units[0]}`;
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const digits = i >= 2 ? 1 : 0;
    return `${fmt.number(n / 1024 ** i, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[i]}`;
  },

  // "53,0 Mo/s" / "53.0 MB/s".
  speed(bytesPerSecond: number): string {
    return `${fmt.bytes(bytesPerSecond)}/s`;
  },

  // Network bitrate: "12,5 Mb/s" / "12.5 Mbps".
  bitrate(mbps: number, digits = 0): string {
    const n = fmt.number(mbps, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return locale.current === 'fr' ? `${n} Mb/s` : `${n} Mbps`;
  },

  // Runtime from milliseconds, rounded to the minute.
  duration(ms: number): string {
    const min = Math.round(Math.max(0, ms) / 60000);
    const d = DURATION[locale.current];
    return min < 60 ? d.min(min) : d.hm(Math.floor(min / 60), min % 60);
  },

  // "A, B et C" / "A, B, and C".
  list(items: string[], type: Intl.ListFormatType = 'conjunction'): string {
    return cached('l', { type }, (l) => new Intl.ListFormat(l, { type })).format(items);
  },

  // ISO 639 code to a language name in the UI language: "fre" -> "français" / "French".
  language(code: string): string {
    try {
      return cached('ln', undefined, (l) => new Intl.DisplayNames([l], { type: 'language', fallback: 'code' })).of(code) ?? code;
    } catch {
      return code;
    }
  },

  // Locale-aware, number-aware string sort.
  compare(a: string, b: string): number {
    return cached('c', undefined, (l) => new Intl.Collator(l, { numeric: true, sensitivity: 'base' })).compare(a, b);
  },
};
