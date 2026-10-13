// Message formatting shared by the renderer and the main process (see docs/i18n.md).
// ICU-lite: {name}, {n, plural, =0 {…} one {…} other {…}} with # for the number,
// and {v, select, a {…} other {…}}. No apostrophe escaping: French text is full of them.

export type Lang = 'fr' | 'en';
export type LanguagePref = 'auto' | Lang;
export const UI_LANGUAGES = ['auto', 'fr', 'en'] as const satisfies readonly LanguagePref[];
export const FALLBACK_LANG: Lang = 'fr';

export type Params = Record<string, string | number | undefined | null>;
export type Catalog = Map<string, string>;

export function resolveLanguage(pref: LanguagePref | undefined, systemLocale: string | undefined): Lang {
  if (pref === 'fr' || pref === 'en') return pref;
  return /^fr\b/i.test(systemLocale ?? '') ? 'fr' : 'en';
}

// Nested JSON sections become dotted keys under the namespace: browse.json { home: { title } } -> browse.home.title.
export function flattenInto(out: Catalog, value: unknown, prefix: string): void {
  if (typeof value === 'string') out.set(prefix, value);
  else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flattenInto(out, v, `${prefix}.${k}`);
  }
}

type Node = string | { arg: string } | { hash: true } | { arg: string; select: 'plural' | 'select'; cases: Record<string, Node[]> };

function parse(src: string, pos: { i: number }, depth: number): Node[] {
  const out: Node[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push(text);
    text = '';
  };
  while (pos.i < src.length) {
    const c = src[pos.i];
    if (c === '}' && depth > 0) {
      pos.i++;
      flush();
      return out;
    }
    if (c === '#' && depth > 0) {
      flush();
      out.push({ hash: true });
      pos.i++;
      continue;
    }
    if (c !== '{') {
      text += c;
      pos.i++;
      continue;
    }
    const close = src.indexOf('}', pos.i);
    const comma = src.indexOf(',', pos.i);
    if (close < 0) {
      text += src.slice(pos.i);
      break;
    }
    flush();
    if (comma < 0 || close < comma) {
      out.push({ arg: src.slice(pos.i + 1, close).trim() });
      pos.i = close + 1;
      continue;
    }
    const arg = src.slice(pos.i + 1, comma).trim();
    const comma2 = src.indexOf(',', comma + 1);
    const kind = src.slice(comma + 1, comma2).trim();
    if (comma2 < 0 || (kind !== 'plural' && kind !== 'select')) {
      out.push({ arg });
      pos.i = close + 1;
      continue;
    }
    pos.i = comma2 + 1;
    const cases: Record<string, Node[]> = {};
    for (;;) {
      while (/\s/.test(src[pos.i] ?? '')) pos.i++;
      if (pos.i >= src.length) break;
      if (src[pos.i] === '}') {
        pos.i++;
        break;
      }
      const open = src.indexOf('{', pos.i);
      if (open < 0) {
        pos.i = src.length;
        break;
      }
      const sel = src.slice(pos.i, open).trim();
      pos.i = open + 1;
      cases[sel] = parse(src, pos, depth + 1);
    }
    out.push({ arg, select: kind, cases });
  }
  flush();
  return out;
}

const parsed = new Map<string, Node[]>();
const pluralRules = new Map<Lang, Intl.PluralRules>();
const numbers = new Map<Lang, Intl.NumberFormat>();

function render(nodes: Node[], params: Params, lang: Lang, n: number | null): string {
  let s = '';
  for (const node of nodes) {
    if (typeof node === 'string') s += node;
    else if ('hash' in node) s += n === null ? '#' : numberFormat(lang).format(n);
    else if ('select' in node) {
      const v = params[node.arg];
      if (node.select === 'plural') {
        const num = Number(v);
        let rules = pluralRules.get(lang);
        if (!rules) pluralRules.set(lang, (rules = new Intl.PluralRules(lang)));
        const branch = node.cases[`=${num}`] ?? node.cases[rules.select(num)] ?? node.cases.other ?? [];
        s += render(branch, params, lang, num);
      } else {
        s += render(node.cases[String(v)] ?? node.cases.other ?? [], params, lang, n);
      }
    } else {
      const v = params[node.arg];
      s += v === undefined || v === null ? `{${node.arg}}` : String(v);
    }
  }
  return s;
}

function numberFormat(lang: Lang): Intl.NumberFormat {
  let f = numbers.get(lang);
  if (!f) numbers.set(lang, (f = new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-US')));
  return f;
}

export function formatMessage(message: string, params: Params | undefined, lang: Lang): string {
  if (!params && !message.includes('{')) return message;
  let nodes = parsed.get(message);
  if (!nodes) parsed.set(message, (nodes = parse(message, { i: 0 }, 0)));
  return render(nodes, params ?? {}, lang, null);
}

// Text split around {placeholders}, for markup that wraps a value (a <span class="mono"> time).
export type Part = { text: string; slot?: undefined } | { slot: string; text?: undefined };
export function messageParts(message: string): Part[] {
  const parts: Part[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  for (let m = re.exec(message); m; m = re.exec(message)) {
    if (m.index > last) parts.push({ text: message.slice(last, m.index) });
    parts.push({ slot: m[1] });
    last = m.index + m[0].length;
  }
  if (last < message.length) parts.push({ text: message.slice(last) });
  return parts;
}

// For tools/checks/i18n-check.mjs: every argument a message reads, and syntax problems.
export function inspectMessage(message: string): { args: string[]; errors: string[] } {
  const args = new Set<string>();
  const errors: string[] = [];
  let depth = 0;
  for (const c of message) {
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) errors.push('unbalanced braces');
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (typeof n === 'string' || 'hash' in n) continue;
      if (!/^\w+$/.test(n.arg)) errors.push(`bad placeholder {${n.arg}}`);
      args.add(n.arg);
      if ('select' in n) {
        if (!n.cases.other) errors.push(`{${n.arg}, ${n.select}} has no "other" case`);
        for (const c of Object.values(n.cases)) walk(c);
      }
    }
  };
  walk(parse(message, { i: 0 }, 0));
  return { args: [...args].sort(), errors };
}

// Lookup with the French fallback, shared by both processes.
export function lookup(catalogs: Record<Lang, Catalog>, lang: Lang, key: string): string | undefined {
  return catalogs[lang].get(key) ?? catalogs[FALLBACK_LANG].get(key);
}
