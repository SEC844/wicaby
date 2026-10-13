// Golden-vector check for the Live TV pure modules (apps/desktop/src/shared/livetv/*.ts),
// spec docs/specs/livetv-spec-final.md §4.2, §17.1, §21.6. The Kotlin twins (C/livetv/*.kt,
// LiveTvParityTest) replay the same files in tools/checks/fixtures/livetv/.
// Run: node tools/checks/livetv-check.mjs
// Authoring aid: LIVETV_FIXTURE_FILL=1 fills the "out" of cases that have none (never overwrites
// an existing "out"); review every filled value against the spec before committing it.
//
// Fixture shape: { "about": "...", "cases": [ { "name", "fn", "args": [...], "out": ... } ] }.
// Values are plain JSON: a Map becomes an object, a Set a sorted array, undefined fields vanish.
// Anchor cases run under the zone of their "tz" (TZ is set per case); times there are ISO strings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '../../apps/desktop/src/shared/livetv');
const fixDir = path.join(here, 'fixtures', 'livetv');
const localesDir = path.resolve(here, '../../apps/desktop/src/renderer/locales');

// The modules import each other without an extension (Vite, esbuild and tsc resolve that);
// Node's type stripping needs the '.ts', so resolve it here for this directory only.
const srcUrl = pathToFileURL(srcDir).href + '/';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(srcUrl) && !/\.[cm]?[jt]s$/.test(specifier)) {
      return next(specifier + '.ts', context);
    }
    return next(specifier, context);
  },
});

const MODULES = ['model', 'dialect', 'channel-order', 'lens', 'zap', 'tiles', 'timers', 'anchor', 'prefs', 'keys', 'nav'];
const FIXTURES = ['normalize', 'dialect', 'channel-order', 'lens', 'zap', 'tiles', 'timers', 'anchor', 'prefs', 'guide-nav'];

let failures = 0;
let passed = 0;
const fail = (where, msg) => {
  failures++;
  console.log(`  FAIL ${where}: ${msg}`);
};

// ---- 1. Erasable syntax only, and no locale-dependent collation ----

// What Node's type stripping rejects (or what breaks parity), found in source with comments and
// string contents blanked out.
function syntaxProblems(src) {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
  const bad = [
    [/\benum\s+\w+/, 'enum / const enum'],
    [/\bnamespace\s+\w+/, 'namespace'],
    [/\bmodule\s+\w+\s*\{/, 'module block'],
    [/constructor\s*\([^)]*\b(public|private|protected|readonly)\s/, 'parameter property'],
    [/\bdeclare\s+(module|global)\b/, 'declare module'],
    [/Intl\.Collator|localeCompare|toLocaleLowerCase|toLocaleUpperCase/, 'locale-dependent collation (use nameKey)'],
  ];
  return bad.filter(([re]) => re.test(code)).map(([, what]) => what);
}

for (const [seed, what] of [
  ['export const enum K { A }', 'enum / const enum'],
  ['enum K { A }', 'enum / const enum'],
  ['namespace N { }', 'namespace'],
  ['class A { constructor(private x: number) {} }', 'parameter property'],
  ['a.localeCompare(b)', 'locale-dependent collation (use nameKey)'],
]) {
  if (!syntaxProblems(seed).includes(what)) fail('syntax gate', `missed a seeded ${what}`);
}
if (syntaxProblems("const s = 'enum X'; // namespace N").length) fail('syntax gate', 'flags strings or comments');

for (const name of MODULES) {
  const file = path.join(srcDir, `${name}.ts`);
  if (!fs.existsSync(file)) {
    fail(`${name}.ts`, 'missing');
    continue;
  }
  for (const what of syntaxProblems(fs.readFileSync(file, 'utf8'))) fail(`${name}.ts`, `uses ${what}`);
}

const mods = {};
for (const name of MODULES) mods[name] = await import(pathToFileURL(path.join(srcDir, `${name}.ts`)).href);
const { model, dialect, lens, zap, tiles, timers, anchor, prefs, keys, nav } = Object.fromEntries(MODULES.map((m) => [m.replace('-', '_'), mods[m]]));
const order = mods['channel-order'];

// ---- Helpers ----

const plain = (v) =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => {
      if (x instanceof Map) return Object.fromEntries(x);
      if (x instanceof Set) return [...x].sort();
      if (x === Infinity || x === -Infinity) return null;
      return x;
    }) ?? 'null',
  );

const iso = (s) => {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new Error(`bad time ${s}`);
  return t;
};
const isoOut = (t) => {
  // Local ISO with offset, in the current TZ (anchor vectors read like wall clocks).
  if (t === null || t === undefined) return t;
  const d = new Date(t);
  const off = -d.getTimezoneOffset();
  const p = (n) => String(Math.abs(n)).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? '+' : '-'}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
};

// Program rows in fixtures: [id, channelId, start, end] or full objects.
const prog = (p) => (Array.isArray(p) ? { id: p[0], channelId: p[1], start: p[2], end: p[3], title: p[0], flags: p[4] ?? 0 } : p);
const progs = (list) => list.map(prog);
const channel = (c, i) => ({ serverId: 's', tags: [], radio: false, favorite: false, serverIndex: i, ...c, numKey: order.parseChannelNumber(c.number ?? '') });
const channels = (list) => list.map(channel);
const ids = (rows) => rows.map((r) => r.id);

// Pretty JSON that keeps short arrays and objects on one line (the fixtures stay readable).
function formatJson(v, pad = '') {
  const flat = JSON.stringify(v);
  if (flat === undefined) return 'null';
  if (v === null || typeof v !== 'object' || flat.length + pad.length <= 110) return flat;
  const inner = pad + '  ';
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')) return flat;
  if (Array.isArray(v)) return `[\n${v.map((x) => inner + formatJson(x, inner)).join(',\n')}\n${pad}]`;
  return `{\n${Object.entries(v)
    .map(([k, x]) => `${inner}${JSON.stringify(k)}: ${formatJson(x, inner)}`)
    .join(',\n')}\n${pad}}`;
}

// ---- 2. Case evaluators per fixture file ----

const evaluators = {
  normalize: (c) => {
    const a = c.args;
    switch (c.fn) {
      case 'parseServerDate':
        return model.parseServerDate(a[0]);
      case 'normalizeChannel':
        return model.normalizeChannel(a[0], a[1], a[2]);
      case 'normalizeProgram':
        return model.normalizeProgram(a[0], a[1]);
      case 'flagsOf':
        return model.flagsOf(a[0], a[1]);
      case 'hdProbe':
        return model.hdProbe(a[0]);
      case 'onNowProbe':
        return model.onNowProbe(a[0], a[1]);
      case 'defaultCaps':
        return model.defaultCaps(a[0]);
      case 'skewSequence': {
        // args: [[serverMs, clientMs], …] → the state after each answer
        let s = { streak: 0, skewMs: 0 };
        return a[0].map(([server, client]) => (s = model.nextSkew(s, server, client)));
      }
      case 'pf':
        return model.PF;
    }
  },
  dialect: (c) => {
    const f = dialect.OPS[c.fn];
    if (!f) throw new Error(`unknown op ${c.fn}`);
    return f(c.args[0], c.args[1] ?? {});
  },
  'channel-order': (c) => {
    const a = c.args;
    switch (c.fn) {
      case 'parseChannelNumber':
        return order.parseChannelNumber(a[0]);
      case 'nameKey':
        return order.nameKey(a[0]);
      case 'sortNames':
        return a[0].slice().sort(order.compareNames);
      case 'compareNames':
        return Math.sign(order.compareNames(a[0], a[1]));
      case 'sortChannels':
        return ids(order.sortChannels(channels(a[0]), a[1], a[2] ?? {}));
      case 'duplicateNumbers':
        return order.duplicateNumbers(channels(a[0]));
    }
  },
  lens: (c) => {
    const a = c.args;
    switch (c.fn) {
      case 'reconcileFavorites':
        return ids(lens.reconcileFavorites(channels(a[0]), a[1]));
      case 'recentIds':
        return lens.recentIds(channels(a[0]), a[1], a[2]);
      case 'pushRecent':
        return lens.pushRecent(a[0], a[1], a[2]);
      case 'applyLens':
        return ids(lens.applyLens({ rows: channels(a[0]), ...a[1] }));
      case 'availableLenses':
        return lens.availableLenses(channels(a[0]), a[1], a[2]);
      case 'stepLens':
        return lens.stepLens(a[0], a[1], a[2]);
      case 'lensToParam':
        return lens.lensToParam(a[0]);
      case 'lensFromParam':
        return lens.lensFromParam(a[0]);
      case 'categoryRows':
        return ids(lens.categoryRows(channels(a[0]), a[1], a[2], a[3]));
      case 'categoryRowsProbe':
        return lens.categoryRowsProbe(a[0], a[1]);
      case 'dimmed':
        return lens.dimmed({ flags: a[0] }, a[1]);
      case 'categorySourceFromTiles':
        return lens.categorySourceFromTiles(a[0].map((flags) => ({ flags })), a[1]);
      case 'categorySourceFromGenres':
        return lens.categorySourceFromGenres(a[0]);
      case 'genreFlags':
        return lens.genreFlags(a[0]);
      case 'genreTokens':
        return lens.genreTokens(a[0]);
      case 'searchChannels':
        return ids(lens.searchChannels(channels(a[0]), a[1], a[2]));
    }
  },
  zap: (c) => {
    const a = c.args;
    switch (c.fn) {
      case 'zapTarget':
        return zap.zapTarget(a[0], a[1], a[2], a[3], a[4]);
      case 'zapScenario': {
        // args: [list, initialCurrent, events, hidden?] → per event {effects, pending, current, last, tuning}
        let s = zap.zapInit(a[1]);
        return a[2].map((ev) => {
          const r = zap.zapReduce(s, ev, a[0], a[3] ?? []);
          s = r.state;
          return { effects: r.effects, pending: s.pending, current: s.current, last: s.last, tuning: s.tuning };
        });
      }
      case 'digitScenario': {
        // args: [lineup, events, timeoutMs?] → per event {buf, preview, result}
        const ix = zap.digitIndex(a[0]);
        let st = null;
        return a[1].map((ev) => {
          const r = zap.digitReduce(ix, st, ev, a[2]);
          st = r.state;
          return { buf: st ? st.buf : null, preview: r.preview, result: r.result ?? null };
        });
      }
    }
  },
  tiles: (c) => {
    const a = c.args;
    switch (c.fn) {
      case 'tuning':
        return tiles.TUNING;
      case 'deviceClass':
        return tiles.deviceClass(a[0]);
      case 'slabOf':
        return tiles.slabOf(iso(a[0]));
      case 'slabStart':
        return new Date(tiles.slabStart(a[0])).toISOString();
      case 'slabRange':
        return tiles.slabRange(iso(a[0]), iso(a[1]));
      case 'cleanPrograms':
        return tiles.cleanPrograms(progs(a[0])).map((p) => [p.id, p.start, p.end]);
      case 'mergePrograms':
        return tiles.mergePrograms(progs(a[0]), progs(a[1])).map((p) => [p.id, p.start, p.end, p.title]);
      case 'programsInWindow':
        return ids(tiles.programsInWindow(tiles.cleanPrograms(progs(a[0])), a[1], a[2]));
      case 'programAt':
        return tiles.programAt(tiles.cleanPrograms(progs(a[0])), a[1])?.id ?? null;
      case 'planTiles':
        return tiles.planTiles({ ...a[0], tuning: tiles.TUNING[a[0].tuning] });
      case 'dropStale': {
        const r = tiles.dropStale(a[0], { ...a[1], tuning: tiles.TUNING[a[1].tuning] });
        return { keep: r.keep.map((q) => q.channelIds[0] + '@' + q.slabs[0]), dropped: r.dropped.map((q) => q.channelIds[0] + '@' + q.slabs[0]) };
      }
      case 'idleSet':
        return tiles.idleSet(a[0], a[1], tiles.TUNING[a[2]]);
      case 'ingestTile': {
        const r = tiles.ingestTile(a[0], progs(a[1]));
        return { coverage: r.coverage, byChannel: Object.fromEntries([...r.byChannel].map(([k, v]) => [k, ids(v)])) };
      }
    }
  },
  timers: (c) => {
    const a = c.args;
    switch (c.fn) {
      case 'mapTimerStatus':
        return timers.mapTimerStatus(a[0]);
      case 'normalizeTimers':
        return timers.normalizeTimers(a[0]);
      case 'buildOverlay':
        return timers.buildOverlay(timers.normalizeTimers(a[0]));
      case 'markFor':
        return timers.markFor(a[0], a[1] === null ? null : timers.buildOverlay(timers.normalizeTimers(a[1])));
      case 'conflictCount':
        return timers.conflictCount(timers.normalizeTimers(a[0]));
      case 'visibleOptions':
        return timers.visibleOptions(a[0], a[1]);
      case 'applyOptions':
        return timers.applyOptions(a[0], a[1]);
      case 'quickRecordBody':
        return timers.quickRecordBody(a[0], a[1]);
      case 'mapDvrError':
        return timers.mapDvrError(a[0], a[1], a[2], a[3]);
    }
  },
  anchor: (c) => {
    const a = c.args;
    switch (c.fn) {
      case 'dayStart':
        return isoOut(anchor.dayStart(iso(a[0])));
      case 'addDays':
        return isoOut(anchor.addDays(iso(a[0]), a[1]));
      case 'dayKey':
        return anchor.dayKey(iso(a[0]));
      case 'parseDayKey':
        return isoOut(anchor.parseDayKey(a[0]));
      case 'parseAt':
        return isoOut(anchor.parseAt(iso(a[0]), a[1]));
      case 'dayChips':
        return anchor.dayChips(iso(a[0]), a[1] === null ? null : iso(a[1])).map((d) => ({ index: d.index, key: d.key, start: isoOut(d.start), hours: (d.end - d.start) / 3_600_000 }));
      case 'daypartTime':
        return isoOut(anchor.daypartTime(iso(a[0]), a[1]));
      case 'leftForNow':
        return isoOut(anchor.leftForNow(iso(a[0]), a[1]));
      case 'leftForDaypart':
        return isoOut(anchor.leftForDaypart(iso(a[0]), a[1]));
      case 'leftForDay':
        return isoOut(anchor.leftForDay(iso(a[0]), iso(a[1]), a[2]));
      case 'shiftDay':
        return isoOut(anchor.shiftDay(iso(a[0]), a[1]));
      case 'anchorScenario': {
        // args: [startIso, events with ISO "at"] → per event {mode, recenter}
        let s = anchor.anchorInit(iso(a[0]));
        return a[1].map((ev) => {
          const r = anchor.anchorReduce(s, { ...ev, at: iso(ev.at) });
          s = r.state;
          return { mode: s.mode, recenter: r.recenter };
        });
      }
    }
  },
  prefs: (c) => {
    const a = c.args;
    switch (c.fn) {
      case 'decodePrefs':
        return prefs.decodePrefs(a[0]);
      case 'encodeField':
        return prefs.encodeField(a[0], a[1]);
      case 'chunkStats': {
        // args: [prefix, count, idPattern] → chunk keys, sizes and a round trip
        const items = Array.from({ length: a[1] }, (_, i) => a[2].replace('{i}', String(i).padStart(12, '0')));
        const out = prefs.chunkArray(a[0], items);
        return { keys: Object.keys(out), bytes: Object.values(out).map(prefs.utf8Length), roundTrip: JSON.stringify(prefs.readChunks(out, a[0])) === JSON.stringify(items) };
      }
      case 'mergeCustomPrefs':
        return prefs.mergeCustomPrefs(a[0], a[1]);
      case 'prefsBody':
        return prefs.prefsBody(a[0], a[1]);
      case 'syncScenario': {
        // args: [steps] where a step is {queue}|{loaded: bool}|{write: serverDto}
        let s = prefs.syncInit();
        return a[0].map((st) => {
          if ('queue' in st) {
            s = prefs.queueChange(s, st.queue);
            return { load: s.load };
          }
          if ('loaded' in st) {
            s = prefs.loaded(s, st.loaded);
            return { load: s.load };
          }
          const w = prefs.planWrite(s, st.write);
          if (w) s = w.next;
          return { write: w ? w.body : null };
        });
      }
    }
  },
  'guide-nav': (c) => {
    const a = c.args;
    const mk = (m) => {
      const data = new Map(Object.entries(m.programs).map(([k, v]) => [k, v === null ? undefined : tiles.cleanPrograms(progs(v))]));
      return { rows: m.rows, programs: (id) => data.get(id), rangeStart: m.rangeStart, rangeEnd: m.rangeEnd, left: m.left, right: m.right, now: m.now };
    };
    switch (c.fn) {
      case 'rowCells':
        return nav.rowCells(mk(a[0]), a[1], a[2], a[3]) ?? null;
      case 'navMoves': {
        // args: [model, focus, [move, …], pageRows?] → each result; the viewport follows scrollLeft
        let m = { ...a[0] };
        let f = a[1];
        return a[2].map((mv) => {
          const r = nav.navMove(mk(m), f, mv, a[3] ?? 1);
          if (r.scrollLeft !== undefined) m = { ...m, left: r.scrollLeft, right: r.scrollLeft + (m.right - m.left) };
          if (r.focus) f = r.focus;
          return r;
        });
      }
      case 'restoreFocus':
        return nav.restoreFocus(mk(a[0]), a[1], a[2]);
      case 'resolveJump':
        return nav.resolveJump(mk(a[0]), a[1], a[2], a[3]);
      case 'gateMoves': {
        let g = nav.repeatGateInit();
        return a[0].map(([frame, repeat]) => {
          const r = nav.gateMove(g, frame, repeat);
          g = r.gate;
          return r.accept;
        });
      }
    }
  },
};

// ---- 3. Replay the fixtures ----

const fill = process.env.LIVETV_FIXTURE_FILL === '1';
if (fill) {
  for (const name of FIXTURES) {
    const file = path.join(fixDir, `${name}.json`);
    if (fs.existsSync(file)) fs.writeFileSync(file, formatJson(JSON.parse(fs.readFileSync(file, 'utf8'))) + '\n');
  }
}
const files = fs.existsSync(fixDir) ? fs.readdirSync(fixDir).filter((f) => f.endsWith('.json')) : [];
for (const name of FIXTURES) if (!files.includes(`${name}.json`)) fail(`fixtures/livetv/${name}.json`, 'missing');

const origTz = process.env.TZ;
for (const name of FIXTURES) {
  const file = path.join(fixDir, `${name}.json`);
  if (!fs.existsSync(file)) continue;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  let filled = 0;
  for (const c of data.cases) {
    const where = `${name}.json "${c.name}"`;
    if (c.tz) process.env.TZ = c.tz;
    try {
      const got = plain(evaluators[name](c));
      if (!('out' in c)) {
        if (fill) {
          c.out = got;
          filled++;
        } else fail(where, 'no "out"');
        continue;
      }
      assert.deepStrictEqual(got, c.out);
      passed++;
    } catch (err) {
      fail(where, err instanceof assert.AssertionError ? `\n${err.message.split('\n').slice(0, 40).join('\n')}` : String(err?.stack ?? err));
    } finally {
      if (c.tz) {
        if (origTz === undefined) delete process.env.TZ;
        else process.env.TZ = origTz;
      }
    }
  }
  if (filled) {
    fs.writeFileSync(file, formatJson(data) + '\n');
    console.log(`  filled ${filled} case(s) in ${name}.json`);
  }
}

// ---- 4. Binary search against a brute-force filter on 10,000 random windows ----

{
  let seed = 0x5eed1e57;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const MIN = 60_000;
  const base = Date.UTC(2026, 9, 22);
  let mismatches = 0;
  for (let round = 0; round < 20; round++) {
    // A messy EPG: random lengths, gaps, overlaps, zero lengths and duplicate ids.
    const raw = [];
    let t = base - Math.floor(rnd() * 600) * MIN;
    for (let i = 0; i < 400; i++) {
      const len = Math.floor(rnd() * 180) * MIN;
      const gap = rnd() < 0.2 ? Math.floor(rnd() * 120) * MIN : rnd() < 0.1 ? -Math.floor(rnd() * 10) * MIN : 0;
      t += gap;
      raw.push({ id: rnd() < 0.02 && i > 0 ? `p${i - 1}` : `p${i}`, channelId: 'c', start: t, end: t + len, title: '', flags: 0 });
      t += len;
    }
    const clean = tiles.cleanPrograms(raw);
    for (let i = 1; i < clean.length; i++) if (clean[i].start < clean[i - 1].end || clean[i].end <= clean[i].start) mismatches++;
    const lo = clean[0]?.start ?? base;
    const hi = clean[clean.length - 1]?.end ?? base;
    for (let w = 0; w < 500; w++) {
      const from = lo - 120 * MIN + Math.floor(rnd() * ((hi - lo) / MIN + 240)) * MIN;
      const to = from + Math.floor(rnd() * 600) * MIN;
      const fast = tiles.programsInWindow(clean, from, to).map((p) => p.id).join();
      const slow = clean.filter((p) => p.end > from && p.start < to).map((p) => p.id).join();
      if (fast !== slow) mismatches++;
      const at = from + Math.floor(rnd() * 60) * MIN;
      const pa = tiles.programAt(clean, at)?.id ?? null;
      const pb = clean.find((p) => p.start <= at && at < p.end)?.id ?? null;
      if (pa !== pb) mismatches++;
    }
  }
  if (mismatches) fail('binary search', `${mismatches} mismatch(es) against the brute-force filter over 10,000 windows`);
  else passed++;
}

// ---- 5. keys.ts: no duplicate binding per context; every label in fr and en ----

{
  const conflicts = keys.keyConflicts();
  for (const c of conflicts) fail('keys.ts', `${c.context}: ${c.combo} bound twice (${c.ids.join(', ')})`);
  const flat = (lang) => {
    const out = new Map();
    const walk = (v, k) => {
      if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, `${k}.${kk}`);
      else out.set(k, v);
    };
    walk(JSON.parse(fs.readFileSync(path.join(localesDir, lang, 'livetv.json'), 'utf8')), 'livetv');
    return out;
  };
  const cats = { fr: flat('fr'), en: flat('en') };
  const ids = new Set();
  for (const r of keys.LIVE_KEYS) {
    if (ids.has(r.id)) fail('keys.ts', `duplicate row id ${r.id}`);
    ids.add(r.id);
    if (!r.keys.length) fail('keys.ts', `${r.id} has no key`);
    for (const lang of ['fr', 'en']) if (typeof cats[lang].get(r.labelKey) !== 'string') fail('keys.ts', `${r.id}: ${r.labelKey} missing in ${lang}/livetv.json`);
  }
  // A seeded duplicate must be caught (the check checks itself).
  const seeded = keys.keyConflicts([...keys.LIVE_KEYS, { id: 'guide.seeded', context: 'guide', keys: ['f'], repeatable: false, labelKey: 'x' }]);
  if (!seeded.some((c) => c.context === 'guide' && c.combo === 'F')) fail('keys.ts', 'the duplicate check missed a seeded duplicate');
  // AZERTY: Digit1 types '&' without Shift; number entry still sees a digit. '/' needs Shift there.
  const r1 = keys.resolveKey({ key: '&', code: 'Digit1' }, 'live');
  if (r1?.id !== 'live.digits') fail('keys.ts', `AZERTY Digit1 resolved to ${r1?.id}`);
  const r2 = keys.resolveKey({ key: '/', code: 'Period', shiftKey: true }, 'guide');
  if (r2?.id !== 'guide.search') fail('keys.ts', `AZERTY '/' resolved to ${r2?.id}`);
  const r3 = keys.resolveKey({ key: 'I', code: 'KeyI', shiftKey: true }, 'live');
  if (r3?.id !== 'live.stats') fail('keys.ts', `Shift+I resolved to ${r3?.id}`);
  const r4 = keys.resolveKey({ key: 'i', code: 'KeyI' }, 'live');
  if (r4?.id !== 'live.info') fail('keys.ts', `I resolved to ${r4?.id}`);
  const r5 = keys.resolveKey({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true }, 'live');
  if (r5?.id !== 'live.zapUp') fail('keys.ts', `Ctrl+ArrowUp resolved to ${r5?.id}`);
  if (keys.resolveKey({ key: 'ArrowUp', code: 'ArrowUp' }, 'live') !== null) fail('keys.ts', 'plain ArrowUp must stay volume (no live row)');
  passed++;
}

// Reminders and the wicaby://live deep link (§9.6, §3.1, D-8).
{
  const rm = await import(pathToFileURL(path.join(srcDir, 'reminders.ts')).href);
  const check = (name, got, want) => {
    try {
      assert.deepEqual(got, want);
      passed++;
    } catch {
      fail('reminders.ts', `${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };
  check('link', rm.liveLinkFromArgv(['wicaby.exe', 'wicaby://live?channel=12']), { channel: '12', server: undefined });
  check('link server', rm.liveLinkFromArgv(['wicaby://live/?channel=France%202&server=abc-1&start=live']), { channel: 'France 2', server: 'abc-1' });
  check('link bad server', rm.liveLinkFromArgv(['wicaby://live?channel=12&server=../x']), null);
  check('link no channel', rm.liveLinkFromArgv(['wicaby://live?server=a']), null);
  check('item link ignored', rm.liveLinkFromArgv(['wicaby://item/abc']), null);
  const chans = [{ Id: 'ltc-112', Name: 'Arte', ChannelNumber: '7' }, { Id: '12', Name: 'Twelve', ChannelNumber: '120' }, { Id: 'ltc-101', Name: 'Info', ChannelNumber: '12' }];
  check('match id first', rm.matchChannel(chans, '12')?.Id, '12');
  check('match number', rm.matchChannel(chans, '7')?.Id, 'ltc-112');
  check('match name', rm.matchChannel(chans, 'ARTE')?.Id, 'ltc-112');
  check('no match', rm.matchChannel(chans, 'nope'), undefined);
  const ok = { serverId: 's1', programId: 'p1', channelId: 'c1', start: 1000, title: 'T'.repeat(300), channelName: 'C', extra: 1 };
  check('clean', rm.cleanReminder(ok), { serverId: 's1', programId: 'p1', channelId: 'c1', start: 1000, title: 'T'.repeat(200), channelName: 'C', skewMs: 0 });
  check('clean skew', rm.cleanReminder({ ...ok, skewMs: -600_000 })?.skewMs, -600_000);
  check('clean absurd skew', rm.cleanReminder({ ...ok, skewMs: 1e12 })?.skewMs, 0);
  check('clean bad id', rm.cleanReminder({ ...ok, programId: 'a/b' }), null);
  check('clean bad start', rm.cleanReminder({ ...ok, start: Infinity }), null);
  check('clean null', rm.cleanReminder(null), null);
  check('due', rm.dueAt({ start: 600_000, leadMin: 2 }), 480_000);
  // Clock skew (§21.4): server 10 min ahead → a programme at server 60 min fires at client 60 − 1 − 10 min.
  const M = 60_000;
  check('client due, server ahead', rm.clientDueAt({ start: 60 * M, leadMin: 1, skewMs: 10 * M }), 49 * M);
  check('client due, server behind', rm.clientDueAt({ start: 60 * M, leadMin: 1, skewMs: -10 * M }), 69 * M);
  const r = (id, start, skewMs = 0) => ({ id, start, leadMin: 1, skewMs });
  const ids = ({ fire, keep }) => ({ fire: fire.map((x) => x.id), keep: keep.map((x) => x.id) });
  check('take: not yet', ids(rm.takeDue([r('a', 60 * M)], 58 * M)), { fire: [], keep: ['a'] });
  check('take: due now', ids(rm.takeDue([r('a', 60 * M)], 59 * M)), { fire: ['a'], keep: [] });
  check('take: skew +10 fires 10 min earlier', ids(rm.takeDue([r('a', 60 * M, 10 * M)], 49 * M)), { fire: ['a'], keep: [] });
  check('take: skew -10 waits', ids(rm.takeDue([r('a', 60 * M, -10 * M)], 59 * M)), { fire: [], keep: ['a'] });
  // Resume after a sleep: the due ones fire once (they leave the list), a too-late one is dropped silently.
  const slept = [r('missed', 60 * M), r('late', 30 * M), r('later', 120 * M)];
  const woke = rm.takeDue(slept, 62 * M);
  check('take: resume', ids(woke), { fire: ['missed'], keep: ['later'] });
  check('take: resume again fires nothing', ids(rm.takeDue(woke.keep, 62 * M)), { fire: [], keep: ['later'] });
  check('take: late uses server time', ids(rm.takeDue([r('a', 60 * M, -10 * M)], 74 * M)), { fire: ['a'], keep: [] });
}

console.log(failures ? `\nlivetv-check: ${failures} failure(s), ${passed} passed.` : `livetv-check: ${passed} cases passed.`);
process.exit(failures ? 1 : 0);
