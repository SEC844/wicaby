// i18n check (docs/i18n.md):
//  1. fr and en catalogues: same keys per namespace, no empty values, same placeholders, valid plurals.
//  2. t('…') / tParts('…') keys used in the source exist.
//  3. Hard-coded French left in .svelte/.ts files, counted per file.
//  4. French typography (livetv-spec-final.md §13.1, §21.6): in French strings (desktop fr/*.json and the Android
//     res/values/*.xml of every module), a plain space (U+0020) before : ; ? ! % or inside « » fails; U+00A0 and
//     U+202F pass. On Android a space before a format specifier (%1$s, %d) passes; the literal sign %% does not.
//  5. ICU `=0` and Android (§21.8): Android ignores quantity="zero" in French and English, so a desktop message
//     with an `=0` branch whose Android port is a <plurals name="x"> needs a <string name="x_zero"> in the same
//     module (values and values-en); a quantity="zero" item in values or values-en is an error. Once Android
//     has Live TV strings, the three §21.8 keys need their _zero strings, and a renamed livetv_* plurals port of a
//     =0 message needs a _zero sibling (see zeroRule()).
//     Names map as in §13.1: dots → underscores, camelCase → snake_case (livetv.record.minutes → livetv_record_minutes).
//  6. Plurals: fixtures/i18n/plurals.json pins French counts 0 and 1 (CLDR `one` covers both) through the real
//     formatter, plus catalogue keys once they exist; a French `one` branch that spells "1" / "un" / "une"
//     instead of `#` fails, since French shows it for 0 too.
// Strings that broke rules 4 or 6 before they existed are listed in fixtures/i18n/baseline.json with their exact
// French text, a ratchet: a listed string passes only while its text is unchanged (whoever edits it fixes it), and
// the list may only shrink (--write-baseline rewrites it from the current catalogues and names what it newly
// admits; never use it to admit a new string).
// Usage: node tools/checks/i18n-check.mjs [--list [path-filter]] [--strict] [--self-test]
//        [--locales=<dir>] [--android=<dir>] [--write-baseline]
// Exit 1 on catalogue or key errors; --strict also fails on any hard-coded French.
// --self-test seeds bad strings (in memory, and once end to end on a temporary copy of the catalogues) and
// fails unless every rule above catches its seed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths are relative to the desktop app (apps/desktop).
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', 'apps', 'desktop');
const { inspectMessage, flattenInto, formatMessage } = await import(new URL('../../apps/desktop/src/shared/i18n-core.ts', import.meta.url).href);

const NAMESPACES = ['common', 'shell', 'onboarding', 'browse', 'item', 'player', 'reader', 'settings', 'downloads', 'torrents', 'livetv', 'vpn', 'errors', 'main'];
const LANGS = ['fr', 'en'];

const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const localesDir = opt('locales') ? path.resolve(opt('locales')) : path.join(root, 'src/renderer/locales');
const androidDir = opt('android') ? path.resolve(opt('android')) : path.resolve(root, '..', 'android');
const BASELINE = path.join(here, 'fixtures', 'i18n', 'baseline.json');
const PLURAL_FIXTURES = path.join(here, 'fixtures', 'i18n', 'plurals.json');
const listAt = args.indexOf('--list');
const listing = listAt >= 0;
const listFilter = listing && args[listAt + 1] && !args[listAt + 1].startsWith('--') ? args[listAt + 1].replace(/\\/g, '/') : '';
const strict = args.includes('--strict');

// ---- Rules 4 to 6 as pure functions (the self-test feeds them seeded strings) ----

// Rule 4: every plain space before : ; ? ! % or inside « ». On Android a '%' that opens a format specifier
// (%1$s, %d, %2$02d, %.1f) is not a percent sign; the literal sign is written %%, which still counts.
const ANDROID_SPEC = /^%(?:\d+\$)?[-#+0,(]*\d*(?:\.\d+)?[a-zA-Z]/;
function nbspViolations(text, { android = false } = {}) {
  const out = [];
  const re = / (?=[:;?!»%])|(?<=«) /g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (android && text[m.index + 1] === '%' && ANDROID_SPEC.test(text.slice(m.index + 1))) continue;
    out.push(text.slice(Math.max(0, m.index - 12), m.index + 2));
  }
  return out;
}

// Desktop key → Android resource name (§13.1).
const androidName = (key) => key.replace(/\./g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

// The {arg, plural, …} blocks of an ICU message, with each case's raw text.
function pluralBlocks(message) {
  const out = [];
  const re = /\{\s*(\w+)\s*,\s*plural\s*,/g;
  for (let m = re.exec(message); m; m = re.exec(message)) {
    const cases = {};
    let i = m.index + m[0].length;
    for (;;) {
      while (/\s/.test(message[i] ?? '')) i++;
      if (i >= message.length || message[i] === '}') break;
      const open = message.indexOf('{', i);
      if (open < 0) break;
      const sel = message.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < message.length && depth; j++) depth += message[j] === '{' ? 1 : message[j] === '}' ? -1 : 0;
      cases[sel] = message.slice(open + 1, j - 1);
      i = j;
    }
    out.push({ arg: m[1], cases });
  }
  return out;
}

// Android res values: { module: { values: Map<'kind/name', {kind, name, texts, zeroItems}>, 'values-en': … } }.
const decodeAndroid = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([nt])/g, ' ')
    .replace(/\\(.)/g, '$1');

function parseAndroidXml(xml) {
  const out = new Map();
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const re = /<(string|plurals|string-array)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const [, kind, attrs, inner = ''] = m;
    if (/\btranslatable\s*=\s*"false"/.test(attrs)) continue;
    const name = /\bname\s*=\s*"([^"]+)"/.exec(attrs)?.[1];
    if (!name) continue;
    const texts = [];
    const zeroItems = [];
    const quantities = {};
    if (kind === 'string') texts.push(decodeAndroid(inner));
    else
      for (const it of inner.matchAll(/<item\b([^>]*)>([\s\S]*?)<\/item>/g)) {
        texts.push(decodeAndroid(it[2]));
        const q = /\bquantity\s*=\s*"(\w+)"/.exec(it[1])?.[1];
        if (q) quantities[q] = decodeAndroid(it[2]);
        if (q === 'zero') zeroItems.push(it[2]);
      }
    out.set(`${kind}/${name}`, { kind, name, texts, zeroItems, quantities });
  }
  return out;
}

function loadAndroid(dir) {
  const modules = {};
  if (!fs.existsSync(dir)) return modules;
  for (const mod of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!mod.isDirectory()) continue;
    const res = path.join(dir, mod.name, 'src', 'main', 'res');
    if (!fs.existsSync(res)) continue;
    for (const variant of ['values', 'values-en']) {
      const vdir = path.join(res, variant);
      if (!fs.existsSync(vdir)) continue;
      const map = new Map();
      for (const f of fs.readdirSync(vdir).filter((x) => x.endsWith('.xml')).sort())
        for (const [k, v] of parseAndroidXml(fs.readFileSync(path.join(vdir, f), 'utf8'))) map.set(k, { ...v, file: `${mod.name}/${variant}/${f}` });
      (modules[mod.name] ??= {})[variant] = map;
    }
  }
  return modules;
}

// Rule 4 over both platforms. Returns [{ id, text, where }]: id is the baseline key, text the whole French string
// (an Android plurals or string-array joins its items with a newline), which the baseline pins.
function frenchTypography(frCatalog, android) {
  const out = [];
  for (const [key, v] of frCatalog) for (const at of nbspViolations(v)) out.push({ id: key, text: v, where: `fr: ${key}: plain space in "${at}"` });
  for (const [mod, variants] of Object.entries(android))
    for (const e of variants.values?.values() ?? [])
      for (const text of e.texts)
        for (const at of nbspViolations(text, { android: true })) out.push({ id: `${mod}/${e.name}`, text: e.texts.join('\n'), where: `android ${e.file}: ${e.name}: plain space in "${at}"` });
  return out;
}

// The ratchet. `baseline` maps id → the exact French text the string had when it was admitted. A violation passes
// only while its string still has that text: editing a grandfathered string means fixing its typography, so a new
// plain space cannot hide in an old string, and the list can only shrink.
function ratchet(violations, baseline) {
  const errs = [];
  for (const v of violations) {
    if (!Object.hasOwn(baseline, v.id)) errs.push(v.where);
    else if (baseline[v.id] !== v.text) errs.push(`${v.where} (baselined string changed; the baseline only admits its old text, so fix the whole string)`);
  }
  const bad = new Set(violations.map((v) => v.id));
  return { errs, fixed: Object.keys(baseline).filter((id) => !bad.has(id)) };
}

// Rule 5. Three passes:
//  a. a quantity="zero" item anywhere;
//  b. a desktop =0 message ported under its §13.1 name as <plurals> without the _zero string in that module;
//  c. once Android has Live TV strings (a resource named livetv_*), the §21.8 =0 keys need their §13.1-named
//     _zero strings in values and values-en, whatever the port looks like (<string>, <plurals>, another name);
//     and a livetv_* <plurals> whose English one/other texts are those of a desktop =0 message (a port under
//     another name) needs a _zero sibling. A port outside livetv_* under another name is not detected.
const ZERO_KEYS = ['livetv.record.minutes', 'livetv.record.keepUpToValue', 'livetv.scheduled.ruleEpisodes'];
const pluralText = (s) =>
  (s ?? '')
    .replace(/%(?:\d+\$)?d|\{\s*\w+\s*\}|#/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
function zeroRule(frCatalog, android, enCatalog = new Map()) {
  const errs = [];
  for (const [mod, variants] of Object.entries(android))
    for (const variant of ['values', 'values-en'])
      for (const e of variants[variant]?.values() ?? [])
        if (e.zeroItems.length) errs.push(`android ${e.file}: plurals ${e.name} has a quantity="zero" item, which ${variant === 'values' ? 'French' : 'English'} ignores; use a ${e.name}_zero string chosen in code`);
  const reported = new Set(); // variant:name already flagged by pass b
  const zeroKeys = [...frCatalog].filter(([, msg]) => pluralBlocks(msg).some((b) => '=0' in b.cases)).map(([key]) => key);
  for (const key of zeroKeys) {
    const name = androidName(key);
    for (const [mod, variants] of Object.entries(android)) {
      if (!variants.values?.has(`plurals/${name}`) && !variants['values-en']?.has(`plurals/${name}`)) continue;
      for (const variant of ['values', 'values-en'])
        if (!variants[variant]?.has(`string/${name}_zero`)) {
          reported.add(`${variant}:${name}`);
          errs.push(`android ${mod}/${variant}: ${key} has an ICU =0 branch, so plurals ${name} needs <string name="${name}_zero">`);
        }
    }
  }
  const liveMods = Object.entries(android).filter(([, v]) => ['values', 'values-en'].some((x) => [...(v[x]?.values() ?? [])].some((e) => e.name.startsWith('livetv_'))));
  if (!liveMods.length) return errs;
  const has = (variant, res) => Object.values(android).some((v) => v[variant]?.has(res));
  for (const key of ZERO_KEYS) {
    const name = androidName(key);
    for (const variant of ['values', 'values-en'])
      if (!has(variant, `string/${name}_zero`) && !reported.has(`${variant}:${name}`))
        errs.push(`android ${variant}: Live TV strings exist (${liveMods.map(([m]) => m).join(', ')}) but <string name="${name}_zero"> is missing; ${key} has an ICU =0 branch (§21.8)`);
  }
  const enShapes = zeroKeys
    .map((key) => ({ key, b: pluralBlocks(enCatalog.get(key) ?? '').find((x) => '=0' in x.cases) }))
    .filter((x) => x.b?.cases.other !== undefined)
    .map(({ key, b }) => ({ key, one: pluralText(b.cases.one), other: pluralText(b.cases.other) }));
  for (const [mod, variants] of liveMods)
    for (const e of variants['values-en']?.values() ?? []) {
      if (e.kind !== 'plurals' || !e.name.startsWith('livetv_') || e.quantities.other === undefined) continue;
      const other = pluralText(e.quantities.other);
      const one = e.quantities.one === undefined ? undefined : pluralText(e.quantities.one);
      const twin = enShapes.find((x) => x.other === other && (one === undefined || x.one === one));
      if (!twin || androidName(twin.key) === e.name) continue;
      for (const variant of ['values', 'values-en'])
        if (!variants[variant]?.has(`string/${e.name}_zero`)) errs.push(`android ${mod}/${variant}: plurals ${e.name} ports ${twin.key}, which has an ICU =0 branch, so it needs <string name="${e.name}_zero">`);
    }
  return errs;
}

// Rule 6: a French `one` case that spells the number instead of #.
function frenchOneErrors(key, message) {
  const errs = [];
  for (const b of pluralBlocks(message)) {
    const one = b.cases.one;
    if (one !== undefined && /^\s*(1|un|une)(?![\p{L}\d])/iu.test(one) && !one.includes('#'))
      errs.push(`fr: ${key}: {${b.arg}, plural} case "one" starts with "${one.trim().split(/\s/)[0]}"; French uses it for 0 and 1, write #`);
  }
  return errs;
}

// Rule 6: run plural fixtures; `catalog` (lang → Map) serves the cases that name a key.
function pluralFixtureErrors(cases, catalog) {
  const errs = [];
  let ran = 0;
  let pending = 0;
  for (const c of cases) {
    const message = c.message ?? catalog?.[c.lang]?.get(c.key);
    if (message === undefined) {
      pending++;
      continue;
    }
    ran++;
    const got = formatMessage(message, c.params, c.lang);
    if (got !== c.expect) errs.push(`plural fixture ${c.key ?? JSON.stringify(c.message)} (${c.lang}, ${JSON.stringify(c.params)}): got ${JSON.stringify(got)}, want ${JSON.stringify(c.expect)}`);
  }
  return { errs, ran, pending };
}

const rel = (f) => path.relative(root, f).replace(/\\/g, '/');
const errors = [];

if (args.includes('--self-test')) process.exit(selfTest());

// ---- 1. Catalogues ----

// The canonical namespaces must exist; a feature may add its own (both languages).
const extra = new Set(
  LANGS.flatMap((l) => (fs.existsSync(path.join(localesDir, l)) ? fs.readdirSync(path.join(localesDir, l)) : []))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter((ns) => !NAMESPACES.includes(ns)),
);
const allNamespaces = [...NAMESPACES, ...[...extra].sort()];
const catalogs = { fr: new Map(), en: new Map() };
for (const ns of allNamespaces) {
  const per = {};
  for (const lang of LANGS) {
    const file = path.join(localesDir, lang, `${ns}.json`);
    per[lang] = new Map();
    if (!fs.existsSync(file)) {
      errors.push(`${rel(file)}: missing`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${rel(file)}: invalid JSON (${err.message})`);
      continue;
    }
    const raw = new Map();
    const collect = (v, key) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) collect(x, `${key}.${k}`);
      else raw.set(key, v);
    };
    collect(data, ns);
    for (const [key, v] of raw) {
      if (typeof v !== 'string') errors.push(`${lang}/${ns}.json: ${key} is not a string`);
      else if (!v.trim()) errors.push(`${lang}/${ns}.json: ${key} is empty`);
    }
    flattenInto(per[lang], data, ns);
    for (const [k, v] of per[lang]) catalogs[lang].set(k, v);
  }
  for (const [a, b] of [
    ['fr', 'en'],
    ['en', 'fr'],
  ]) {
    for (const key of per[a].keys()) if (!per[b].has(key)) errors.push(`${b}/${ns}.json: missing ${key} (present in ${a})`);
  }
  for (const [key, fr] of per.fr) {
    const en = per.en.get(key);
    const f = inspectMessage(fr);
    for (const e of f.errors) errors.push(`fr/${ns}.json: ${key}: ${e}`);
    if (en === undefined) continue;
    const g = inspectMessage(en);
    for (const e of g.errors) errors.push(`en/${ns}.json: ${key}: ${e}`);
    if (f.args.join() !== g.args.join()) errors.push(`${ns}: ${key}: placeholders differ (fr {${f.args.join('}, {')}} / en {${g.args.join('}, {')}})`);
  }
}

// ---- 4 to 6. French typography, =0 on Android, plurals ----

const android = loadAndroid(androidDir);
const typo = frenchTypography(catalogs.fr, android);
const oneErrs = [...catalogs.fr].flatMap(([key, msg]) => frenchOneErrors(key, msg).map((where) => ({ id: key, text: msg, where })));
// Baseline sections map id → exact French text (see ratchet()).
const byId = (list) => Object.fromEntries([...new Map(list.map((v) => [v.id, v.text]))].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const readBaseline = () => (fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {});
if (args.includes('--write-baseline')) {
  const before = readBaseline();
  const ids0 = (x) => (Array.isArray(x) ? x : Object.keys(x ?? {})); // arrays: the first, id-only format
  const known = new Set([...ids0(before.nbsp?.desktop), ...ids0(before.nbsp?.android), ...ids0(before.frenchOne)]);
  const nbsp = byId(typo);
  const data = {
    note: 'Strings that broke i18n-check rule 4 (plain space before : ; ? ! % or inside « » in French) or rule 6 (French plural `one` spelled out) when the rules landed, each with its exact French text (Android plurals and arrays: items joined by a newline). A string passes only while it keeps that text. Only remove entries.',
    nbsp: {
      desktop: Object.fromEntries(Object.entries(nbsp).filter(([id]) => !id.includes('/'))),
      android: Object.fromEntries(Object.entries(nbsp).filter(([id]) => id.includes('/'))),
    },
    frenchOne: byId(oneErrs),
  };
  const ids = [...Object.keys(nbsp), ...Object.keys(data.frenchOne)];
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, `${JSON.stringify(data, null, 2)}\n`);
  const admitted = ids.filter((id) => !known.has(id));
  console.log(`Wrote ${ids.length} baseline entries to ${path.relative(process.cwd(), BASELINE)}${admitted.length ? `; newly admitted (justify each in review): ${admitted.join(', ')}` : ''}.`);
}
const baseline = readBaseline();
const typoRun = ratchet(typo, { ...baseline.nbsp?.desktop, ...baseline.nbsp?.android });
const oneRun = ratchet(oneErrs, { ...baseline.frenchOne });
for (const e of typoRun.errs) errors.push(`${e} (French typography wants U+00A0 or U+202F there)`);
errors.push(...oneRun.errs);
const typoNewCount = typoRun.errs.length;
const fixedBaseline = [...typoRun.fixed, ...oneRun.fixed];

errors.push(...zeroRule(catalogs.fr, android, catalogs.en));
const pluralFixtures = fs.existsSync(PLURAL_FIXTURES) ? JSON.parse(fs.readFileSync(PLURAL_FIXTURES, 'utf8')).cases : [];
const pluralRun = pluralFixtureErrors(pluralFixtures, catalogs);
errors.push(...pluralRun.errs);
// Every French plural renders something for 0 and 1 (no case left empty by a broken branch).
for (const [key, msg] of catalogs.fr)
  for (const b of pluralBlocks(msg))
    for (const n of [0, 1]) {
      const out = formatMessage(msg, { [b.arg]: n }, 'fr');
      if (!out.trim()) errors.push(`fr: ${key}: renders ${JSON.stringify(out)} for ${b.arg} = ${n}`);
    }

// ---- Source scanning ----

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'locales' && e.name !== 'node_modules') walk(p, out);
    } else if (/\.(svelte|ts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

// JS/TS tokenizer: emits string literals (template literals with their static
// parts, joined by "…") and keys passed to t()/tParts(). Skips comments and regexes.
// Returns the index after the closing brace when stopAtBrace is set.
function scanJs(src, start, stopAtBrace, emit) {
  let i = start;
  let depth = 0;
  let prev = ''; // last significant char, to tell a regex from a division
  let word = '';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) return src.length;
      continue;
    }
    if (c === '/' && n === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? src.length : e + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') {
          s += /[ntr]/.test(src[j + 1] ?? '') ? ' ' : (src[j + 1] ?? '');
          j += 2;
        } else s += src[j++];
      }
      emit(s, i, src.slice(Math.max(0, i - 12), i));
      i = j + 1;
      prev = 'a';
      word = '';
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') {
          s += /[ntr]/.test(src[j + 1] ?? '') ? ' ' : (src[j + 1] ?? '');
          j += 2;
        } else if (src[j] === '$' && src[j + 1] === '{') {
          j = scanJs(src, j + 2, true, emit);
          s += '…';
        } else s += src[j++];
      }
      emit(s, i, src.slice(Math.max(0, i - 12), i));
      i = j + 1;
      prev = 'a';
      word = '';
      continue;
    }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /^(return|typeof|case|in|of)$/.test(word))) {
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '[') cls = true, j++;
        else if (src[j] === ']') cls = false, j++;
        else if (src[j] === '/' && !cls) break;
        else j++;
      }
      i = j + 1;
      while (/[a-z]/i.test(src[i] ?? '')) i++;
      prev = 'a';
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      if (stopAtBrace && depth === 0) return i + 1;
      depth--;
    }
    if (!/\s/.test(c)) {
      prev = c;
      word = /[\w$]/.test(c) ? word + c : '';
    } else if (word) prev = 'a';
    i++;
  }
  return i;
}

const lineOf = (src, i) => {
  let n = 1;
  for (let k = 0; k < i && k < src.length; k++) if (src.charCodeAt(k) === 10) n++;
  return n;
};

// Attributes whose values are never shown to the user.
const CODE_ATTRS = /^(class|style|href|src|id|name|type|role|for|key|lang|d|viewBox|xmlns|fill|stroke|transform|points|autocomplete|inputmode|accept|method|rel|target|loading|decoding|draggable|tabindex|slot|this|generics|data-.*|on.*|bind:.*|class:.*|style:.*|use:.*|in:.*|out:.*|transition:.*|animate:.*)$/;

// Svelte: <script> blocks go through scanJs; markup text, static attribute
// values and {expressions} are extracted separately.
function scanSvelte(src, emitText, emitJs) {
  const blocks = [];
  src.replace(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/g, (m, tag, body, off) => {
    blocks.push([off, off + m.length]);
    if (tag === 'script') {
      const bodyStart = off + m.indexOf('>') + 1;
      scanJs(src.slice(0, bodyStart + body.length), bodyStart, false, emitJs);
    }
    return m;
  });
  let i = 0;
  let text = '';
  let textStart = 0;
  const flush = () => {
    if (text.trim()) emitText(text, textStart);
    text = '';
  };
  // {/if} and {/each} close a block: no expression, and the slash would read as a regex.
  const expr = (at) => (src[at] === '/' ? src.indexOf('}', at) + 1 || src.length : scanJs(src, at, true, emitJs));
  while (i < src.length) {
    const blk = blocks.find(([a]) => a === i);
    if (blk) {
      flush();
      i = blk[1];
      continue;
    }
    if (src.startsWith('<!--', i)) {
      flush();
      const e = src.indexOf('-->', i);
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    const c = src[i];
    if (c === '{') {
      flush();
      i = expr(i + 1);
      continue;
    }
    if (c === '<' && /[a-zA-Z/!]/.test(src[i + 1] ?? '')) {
      flush();
      i++;
      while (i < src.length && src[i] !== '>') {
        if (src[i] === '{') {
          i = expr(i + 1);
          continue;
        }
        const m = /^([^\s=>/{]+)\s*=\s*(["'])/.exec(src.slice(i, i + 200));
        if (m) {
          const name = m[1];
          const q = m[2];
          i += m[0].length;
          let val = '';
          const valStart = i;
          while (i < src.length && src[i] !== q) {
            if (src[i] === '{') {
              i = expr(i + 1);
              val += '…';
            } else val += src[i++];
          }
          i++;
          if (!CODE_ATTRS.test(name)) emitText(val, valStart);
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    if (!text) textStart = i;
    text += c;
    i++;
  }
  flush();
}

// ---- French heuristics ----

const ACCENT = /[àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]/;
const ELISION = /\b(l|d|qu|n|s|j|c|m|t)[’'][a-zà-ÿ]/i;
const STOPWORDS = new Set(
  'le la les des du de un une et est sont pour avec dans sur sans pas vous votre vos nous ce cette ces au aux ou qui que quand sinon aucun aucune tout tous toutes encore ici fois entre depuis par en ne moins chaque lorsque après avant'.split(' '),
);
// Common one-word French labels without an accent.
const UI_WORDS = new Set(
  'annuler fermer retour enregistrer supprimer retirer ajouter modifier reprendre suivant rechercher ouvrir quitter lire lecture film films saison saisons accueil favoris chargement erreur serveur serveurs connexion aucun aucune toujours jamais automatique manuel petite grande normale compacte confortable affiches vignettes chaines titres artistes nom oui non valider appliquer continuer parcourir actualiser copier afficher masquer langue vitesse passer musique livre livres dossier fichier ombre contour fond blanc jaune gris clair hauteur largeur proposer personne utilisateur administrateur adresse inconnu nouveau nouveaux nouvelle disponible disponibles introuvable invalide patientez bibliotheque sortie tout'.split(
    ' ',
  ),
);

function isFrench(raw) {
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!/[a-zà-ÿ]/i.test(s)) return false;
  if (/^[\w-]+(\.[\w-]+)+$/.test(s)) return false; // a t() key or a dotted path
  if (/^(\.{0,2}\/|https?:|wicaby|app:|#\/|\/)/.test(s)) return false; // paths, routes, URLs
  if (/sans-serif|var\(--/.test(s)) return false; // CSS
  if (ACCENT.test(s) || ELISION.test(s)) return true;
  const words = s.toLowerCase().split(/[^a-zà-ÿœæ]+/).filter(Boolean);
  if (words.length === 1) return UI_WORDS.has(words[0]) && /^[A-Za-zÀ-ÿ]/.test(s) && !/[_$]/.test(s);
  if (!s.includes(' ') || /[;=(){}<>]|=>/.test(s)) return false;
  return words.some((w) => STOPWORDS.has(w)) || words.some((w) => UI_WORDS.has(w));
}

// ---- 2 + 3. Scan ----

const usedKeys = new Map();
const hits = new Map();
for (const file of walk(path.join(root, 'src'))) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const ignored = (line) => /i18n-ignore/.test(lines[line - 1] ?? '') || /i18n-ignore/.test(lines[line - 2] ?? '');
  const skipLine = (line) => {
    const l = lines[line - 1] ?? '';
    return /\b(log|console|logger)\.(debug|info|warn|error|log|scope)\(/.test(l) || /^\s*(import|export)\b.*\bfrom\b/.test(l);
  };
  const found = [];
  // Only files that import the i18n module call the real t(); others may have their own t/has.
  const usesI18n = /from\s+['"][^'"]*\/i18n(\.svelte)?['"]/.test(src);
  const report = (text, at) => {
    const line = lineOf(src, at);
    if (!ignored(line) && !skipLine(line) && isFrench(text)) found.push({ line, text: text.replace(/\s+/g, ' ').trim() });
  };
  const emitJs = (s, at, before) => {
    if (usesI18n && /\b(t|tParts|has)\(\s*$/.test(before)) {
      if (!s.includes('…')) usedKeys.set(s, usedKeys.get(s) ?? `${rel(file)}:${lineOf(src, at)}`);
      return;
    }
    report(s, at);
  };
  if (file.endsWith('.svelte')) scanSvelte(src, report, emitJs);
  else scanJs(src, 0, false, emitJs);
  if (found.length) hits.set(rel(file), found);
}

for (const [key, where] of usedKeys) if (!catalogs.fr.has(key) && !catalogs.en.has(key)) errors.push(`${where}: unknown key ${key}`);

// ---- Report ----

const keyCount = (lang) => catalogs[lang].size;
console.log(`Catalogues: ${allNamespaces.length} namespaces (${allNamespaces.join(', ')}), ${keyCount('fr')} keys fr / ${keyCount('en')} keys en, ${usedKeys.size} literal keys used in source.`);
if (errors.length) {
  console.log(`\n${errors.length} catalogue error(s):`);
  for (const e of errors) console.log(`  ${e}`);
} else console.log('Catalogues OK.');
console.log(
  `French typography: ${typo.length - typoNewCount} baselined, ${typoNewCount} new or changed. French plural one: ${oneErrs.length} (${oneErrs.length - oneRun.errs.length} baselined). Baseline: ${fixedBaseline.length ? `${fixedBaseline.length} baseline entr${fixedBaseline.length > 1 ? 'ies are' : 'y is'} fixed now, remove from fixtures/i18n/baseline.json: ${fixedBaseline.join(', ')}` : 'current'}. ` +
    `Plural fixtures: ${pluralRun.ran} run, ${pluralRun.pending} waiting for their key.`,
);

const sorted = [...hits].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
const total = sorted.reduce((n, [, f]) => n + f.length, 0);
console.log(`\nHard-coded French: ${total} string(s) in ${sorted.length} file(s)`);
for (const [file, found] of sorted) {
  console.log(`  ${String(found.length).padStart(5)}  ${file}`);
  if (listing && (!listFilter || file.includes(listFilter))) for (const h of found) console.log(`         ${String(h.line).padStart(5)}: ${h.text.slice(0, 110)}`);
}
if (!listing && total) console.log('\n(--list [path-filter] prints each string; mark a deliberate one with an i18n-ignore comment on or above its line.)');

process.exit(errors.length || (strict && total) ? 1 : 0);

// ---- Self-test: every rule must catch a seeded bad string ----

function selfTest() {
  const fails = [];
  const expect = (name, ok) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) fails.push(name);
  };
  console.log('i18n-check self-test (seeded bad strings must be caught, good ones must pass):');

  // Rule 4.
  expect('plain space before ":" is caught', nbspViolations('Qualité : {label}').length === 1);
  expect('plain space before "?", "!" and ";" is caught', ['Toujours là ?', 'Bravo !', 'Vide ; rien'].every((s) => nbspViolations(s).length === 1));
  expect('plain spaces inside « » are caught', nbspViolations('Aucun résultat pour « {term} »').length === 2);
  expect('U+00A0 and U+202F pass', nbspViolations('Qualité : {label} ; « Néon » ?').length === 0);
  expect('URLs, times and ICU syntax pass', nbspViolations('http://h:8096/?x=1 à 20:50 {count, plural, one {# a} other {# b}}').length === 0);
  const xml = parseAndroidXml(
    '<resources><string name="a">Qualité\u00A0: %1$s</string><string name="b">Qualité&#160;: x</string>' +
      '<string name="c">Qualité : x</string><string name="d" translatable="false">A : b</string>' +
      '<string-array name="e"><item>Oui ?</item></string-array></resources>',
  );
  const typoA = frenchTypography(new Map(), { tv: { values: xml } }).map((v) => v.id);
  expect('Android: escaped NBSP passes, plain spaces fail, untranslatable skipped', typoA.join() === 'tv/c,tv/e');
  expect('plain space before "%" is caught ("{percent} %", "en cours, {percent} % écoulés")', nbspViolations('{percent} %').length === 1 && nbspViolations('en cours, {percent} % écoulés').length === 1);
  expect('U+00A0 and U+202F before "%" pass', nbspViolations('{percent} %').length === 0 && nbspViolations('en cours, {percent} % écoulés').length === 0);
  expect('desktop has no format specifiers: "{n} % de" is caught', nbspViolations('{n} % de plus').length === 1);
  expect('Android: a space before %1$s, %d, %2$02d or %.1f passes', ['Lecture %1$s', 'Profil %d', '%1$d h %2$02d', 'Débit %.1f Mb/s', 'De %1$s à %2$s'].every((s) => nbspViolations(s, { android: true }).length === 0));
  expect('Android: a space before the literal %% is caught', nbspViolations('Téléchargement… %1$d %%', { android: true }).length === 1);
  const pct = parseAndroidXml('<resources><string name="p">Téléchargement… %1$d %%</string><string name="q">Téléchargement… %1$d %%</string><string name="r">Connexion à %1$s…</string></resources>');
  expect('Android: "%1$d %%" fails, NBSP before %% and "à %1$s" pass', frenchTypography(new Map(), { core: { values: pct } }).map((v) => v.id).join() === 'core/p');

  // Ratchet: a baselined string passes only with the text it was admitted with.
  const stillWatching = 'Toujours là ?';
  const typoOf = (text) => frenchTypography(new Map([['player.upNext.stillWatching', text]]), {});
  const base = { 'player.upNext.stillWatching': stillWatching };
  expect('ratchet: a baselined string with its admitted text passes', ratchet(typoOf(stillWatching), base).errs.length === 0);
  expect('ratchet: a new violation appended to a baselined string is caught', ratchet(typoOf(`${stillWatching} Encore là ? Oui !`), base).errs.length > 0);
  expect('ratchet: an edited baselined string that keeps its one violation is caught', ratchet(typoOf('Toujours devant l’écran ?'), base).errs.length === 1);
  expect('ratchet: a string not in the baseline is caught', ratchet(typoOf(stillWatching), {}).errs.length === 1);
  const fixed = ratchet(typoOf('Toujours là ?'), base);
  expect('ratchet: a fixed baselined string passes and is reported for removal', fixed.errs.length === 0 && fixed.fixed.join() === 'player.upNext.stillWatching');

  // Rule 5.
  expect('desktop key → Android name', androidName('player.live.backToLive') === 'player_live_back_to_live' && androidName('livetv.record.keepUpToValue') === 'livetv_record_keep_up_to_value');
  const fr = new Map([
    ['livetv.record.minutes', '{count, plural, =0 {À l’heure} one {# minute} other {# minutes}}'],
    ['livetv.channelCount', '{count, plural, one {# chaîne} other {# chaînes}}'],
  ]);
  const port = (extra = '') =>
    parseAndroidXml(
      `<resources><plurals name="livetv_record_minutes"><item quantity="one">%d minute</item><item quantity="other">%d minutes</item></plurals>` +
        '<string name="livetv_record_keep_up_to_value_zero">x</string><string name="livetv_scheduled_rule_episodes_zero">x</string>' +
        `${extra}</resources>`,
    );
  const zero = '<string name="livetv_record_minutes_zero">À l’heure</string>';
  expect('=0 ported without _zero is caught in values and values-en', zeroRule(fr, { tv: { values: port(), 'values-en': port() } }).length === 2);
  expect('=0 with _zero only in values is caught once', zeroRule(fr, { tv: { values: port(zero), 'values-en': port() } }).length === 1);
  expect('=0 with _zero in values and values-en passes', zeroRule(fr, { tv: { values: port(zero), 'values-en': port(zero) } }).length === 0);
  expect('=0 not ported to Android yet is not an error', zeroRule(fr, { tv: { values: new Map(), 'values-en': new Map() } }).length === 0);
  const qz = parseAndroidXml('<resources><plurals name="x"><item quantity="zero">aucun</item><item quantity="other">%d</item></plurals></resources>');
  expect('quantity="zero" is caught', zeroRule(new Map(), { tv: { values: qz } }).length === 1);
  // Once Android has Live TV strings, the three §21.8 keys need their _zero strings however they are ported.
  const allZeros = (lang) =>
    ZERO_KEYS.map((k) => `<string name="${androidName(k)}_zero">${lang === 'fr' ? 'zéro' : 'zero'}</string>`).join('');
  const live = (extra) => parseAndroidXml(`<resources><string name="livetv_guide_title">Guide</string>${extra}</resources>`);
  expect('no Android Live TV strings yet: the §21.8 keys are not required', zeroRule(new Map(), { tv: { values: new Map(), 'values-en': new Map() } }).length === 0);
  expect('Live TV strings without the §21.8 _zero strings: 3 keys × 2 variants caught', zeroRule(new Map(), { tv: { values: live(''), 'values-en': live('') } }).length === 6);
  expect('Live TV strings with every §21.8 _zero string pass', zeroRule(new Map(), { tv: { values: live(allZeros('fr')), 'values-en': live(allZeros('en')) } }).length === 0);
  const asString = live('<string name="livetv_record_min">%d min</string>' + allZeros('fr').replace(/<string name="livetv_record_minutes_zero">[^<]*<\/string>/, ''));
  expect('record.minutes ported as a <string> under another name, no _zero: caught', zeroRule(new Map(), { tv: { values: asString, 'values-en': live(allZeros('en')) } }).some((e) => e.includes('livetv_record_minutes_zero')));
  const frZ = new Map([['livetv.scheduled.ruleEpisodes', '{count, plural, =0 {Aucun épisode programmé} one {# épisode programmé} other {# épisodes programmés}}']]);
  const enZ = new Map([['livetv.scheduled.ruleEpisodes', '{count, plural, =0 {No episodes scheduled} one {# episode scheduled} other {# episodes scheduled}}']]);
  const renamed = (lang) =>
    live(
      `<plurals name="livetv_rule_eps"><item quantity="one">%d ${lang === 'fr' ? 'épisode programmé' : 'episode scheduled'}</item><item quantity="other">%d ${lang === 'fr' ? 'épisodes programmés' : 'episodes scheduled'}</item></plurals>${allZeros(lang)}`,
    );
  expect('a renamed livetv_* plurals port of an =0 message without a _zero sibling is caught', zeroRule(frZ, { tv: { values: renamed('fr'), 'values-en': renamed('en') } }, enZ).filter((e) => e.includes('livetv_rule_eps_zero')).length === 2);
  const renamedOk = (lang) => renamed(lang).set('string/livetv_rule_eps_zero', { kind: 'string', name: 'livetv_rule_eps_zero', texts: ['x'], zeroItems: [], quantities: {} });
  expect('the renamed port with its _zero sibling passes', zeroRule(frZ, { tv: { values: renamedOk('fr'), 'values-en': renamedOk('en') } }, enZ).length === 0);

  // Rule 6.
  expect('French "one {1 chaîne}" is caught', frenchOneErrors('k', '{n, plural, one {1 chaîne} other {# chaînes}}').length === 1);
  expect('French "one {une chaîne}" is caught', frenchOneErrors('k', '{n, plural, one {une chaîne} other {# chaînes}}').length === 1);
  expect('French "one {# chaîne}" and "=0" pass', frenchOneErrors('k', '{n, plural, =0 {Aucune chaîne} one {# chaîne} other {# chaînes}}').length === 0);
  const cases = JSON.parse(fs.readFileSync(PLURAL_FIXTURES, 'utf8')).cases;
  const good = pluralFixtureErrors(cases, null);
  expect(`plural fixtures pass through formatMessage (${good.ran} inline cases)`, good.errs.length === 0 && good.ran > 0);
  expect('plural fixtures cover French counts 0 and 1', [0, 1].every((n) => cases.some((c) => c.lang === 'fr' && c.message && Object.values(c.params).includes(n))));
  const wrong = pluralFixtureErrors([{ lang: 'fr', message: '{count, plural, one {# chaîne} other {# chaînes}}', params: { count: 0 }, expect: '0 chaînes' }], null);
  expect('a fixture expecting "0 chaînes" in French is caught', wrong.errs.length === 1);

  // End to end: the real CLI on a copy of the catalogues plus seeded bad strings, and a seeded Android module.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-i18n-'));
  try {
    const loc = path.join(tmp, 'locales');
    fs.cpSync(localesDir, loc, { recursive: true });
    const seeds = {
      fr: { qaSeed: 'Qualité : {label}', qaSeedPercent: 'en cours, {percent} % écoulés', qaSeedMinutes: '{count, plural, =0 {À l’heure} one {# minute} other {# minutes}}' },
      en: { qaSeed: 'Quality: {label}', qaSeedPercent: 'on now, {percent}% elapsed', qaSeedMinutes: '{count, plural, =0 {On Time} one {# minute} other {# minutes}}' },
    };
    for (const lang of LANGS) {
      const f = path.join(loc, lang, 'livetv.json');
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...seeds[lang] }, null, 2));
    }
    // A new violation inside a baselined string (X-04 will edit this one).
    const pf = path.join(loc, 'fr', 'player.json');
    const player = JSON.parse(fs.readFileSync(pf, 'utf8'));
    const baselined = player.upNext?.stillWatching;
    if (baselined !== undefined) player.upNext.stillWatching = `${baselined} Encore là ? Oui !`;
    fs.writeFileSync(pf, JSON.stringify(player, null, 2));
    for (const variant of ['values', 'values-en']) {
      const d = path.join(tmp, 'android', 'tv', 'src', 'main', 'res', variant);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'strings.xml'), '<resources><plurals name="livetv_qa_seed_minutes"><item quantity="one">%d minute</item><item quantity="other">%d minutes</item></plurals></resources>');
    }
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--locales=${loc}`, `--android=${path.join(tmp, 'android')}`], { encoding: 'utf8' });
    expect('end to end: seeded "Qualité : {label}" fails the check', r.status === 1 && /fr: livetv\.qaSeed: plain space/.test(r.stdout));
    expect('end to end: seeded "en cours, {percent} % écoulés" fails the check', r.status === 1 && /fr: livetv\.qaSeedPercent: plain space/.test(r.stdout));
    expect('end to end: " Encore là ? Oui !" appended to baselined player.upNext.stillWatching fails the check', baselined !== undefined && r.status === 1 && /fr: player\.upNext\.stillWatching: .*baselined string changed/.test(r.stdout));
    expect('end to end: seeded =0 plural without livetv_qa_seed_minutes_zero fails the check', r.status === 1 && r.stdout.includes('livetv_qa_seed_minutes_zero'));
    const clean = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--locales=${localesDir}`, `--android=${path.join(tmp, 'none')}`], { encoding: 'utf8' });
    expect('end to end: the unseeded catalogues pass', clean.status === 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(fails.length ? `\n${fails.length} self-test expectation(s) failed.` : '\ni18n-check self-test passed.');
  return fails.length ? 1 : 0;
}
