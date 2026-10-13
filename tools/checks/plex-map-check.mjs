// Golden vectors for the Plex dialect's pure core (plex-spec §3.2 guard 3, PX-03): apps/desktop/src/shared/plex/*.ts
// against tools/checks/fixtures/plex/vectors.json. The Kotlin twin (C/plex/*.kt, PX-13) will replay the same file.
// Also the purity gate: those modules import nothing but each other and shared types (no Node, no Electron), and
// use erasable TypeScript only (Node runs them with type stripping, as livetv-check does for shared/livetv).
// Fixture: { "about", "cases": [ { "name", "fn", "args": [...], "out" } ] }; "out": { "throws": "<message>" } for a
// PlexUnmapped. Values are plain JSON: undefined fields vanish.
// Authoring aid: PLEX_FIXTURE_FILL=1 fills the "out" of cases that have none (never overwrites one); review every
// filled value against the spec before committing it.
// Usage: node tools/checks/plex-map-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const srcDir = path.resolve(import.meta.dirname, '../../apps/desktop/src/shared/plex');
const fixture = path.join(import.meta.dirname, 'fixtures', 'plex', 'vectors.json');
const MODULES = ['types', 'guid', 'images', 'map', 'query', 'routes', 'decision'];
// decision.json: the playback decision (PX-08, PX-09), in the same format.
const FIXTURES = [fixture, path.join(import.meta.dirname, 'fixtures', 'plex', 'decision.json')];

// Extensionless relative imports (Vite and tsc resolve them); Node's type stripping needs the '.ts'.
const srcUrl = pathToFileURL(path.dirname(srcDir)).href + '/';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(srcUrl) && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});

const problems = [];
// ---- 1. Purity and erasable syntax ----
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
for (const name of MODULES) {
  const file = path.join(srcDir, `${name}.ts`);
  if (!fs.existsSync(file)) {
    problems.push(`${name}.ts missing`);
    continue;
  }
  const code = strip(fs.readFileSync(file, 'utf8'));
  for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (!/^\.\/[\w-]+$/.test(spec) && !/^\.\.\/(models|contract)$/.test(spec)) problems.push(`${name}.ts imports ${spec} (only ./<plex module> and ../models, ../contract types)`);
    if (/^\.\.\//.test(spec) && !/import\s+type\s/.test(m[0])) problems.push(`${name}.ts: a value import of ${spec} (type-only, so no runtime code crosses in)`);
  }
  if (/\brequire\s*\(|\bprocess\.|\bBuffer\b|\bwindow\.|\bdocument\./.test(code)) problems.push(`${name}.ts uses a Node or browser global`);
  const body = code.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
  for (const [re, what] of [
    [/\benum\s+\w+/, 'enum'],
    [/\bnamespace\s+\w+/, 'namespace'],
    [/constructor\s*\([^)]*\b(public|private|protected|readonly)\s/, 'a parameter property'],
    [/Intl\.Collator|localeCompare|toLocaleLowerCase|toLocaleUpperCase/, 'locale-dependent collation'],
  ]) if (re.test(body)) problems.push(`${name}.ts uses ${what}`);
}

const mods = {};
for (const name of MODULES.filter((x) => x !== 'types')) Object.assign(mods, await import(pathToFileURL(path.join(srcDir, `${name}.ts`)).href));

// ---- 2. Vectors ----
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
// Adapters for results that are not plain data.
const RUN = {
  playablePart: (...a) => mods.playablePart(...a)?.id ?? null,
  partQueue: (...a) => mods.partQueue(...a).map((p) => p.id),
  matchRoute: (...a) => {
    const hit = mods.matchRoute(...a);
    return hit && { op: hit.route.op, media: hit.route.media ?? false, params: hit.params };
  },
};
function run(c) {
  const fn = RUN[c.fn] ?? mods[c.fn];
  if (typeof fn !== 'function') throw new Error(`unknown fn ${c.fn}`);
  try {
    return plain(fn(...c.args));
  } catch (err) {
    if (err?.name === 'PlexUnmapped') return { throws: err.message, status: err.status };
    throw err;
  }
}

const fill = process.env.PLEX_FIXTURE_FILL === '1';
let filled = 0;
let passed = 0;
const names = new Set();
const all = [];
for (const file of FIXTURES) {
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const before = filled;
all.push(...data.cases);
for (const c of data.cases) {
  if (names.has(c.name)) problems.push(`duplicate case name: ${c.name}`);
  names.add(c.name);
  let got;
  try {
    got = run(c);
  } catch (err) {
    problems.push(`${c.name}: threw ${err.stack ?? err}`);
    continue;
  }
  if (!('out' in c)) {
    if (fill) (c.out = got), filled++;
    else problems.push(`${c.name}: no "out" (PLEX_FIXTURE_FILL=1 fills it)`);
    continue;
  }
  try {
    assert.deepStrictEqual(got, c.out);
    passed++;
  } catch {
    problems.push(`${c.name}:\n    expected ${JSON.stringify(c.out)}\n    got      ${JSON.stringify(got)}`);
  }
}
if (fill && filled > before) fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
if (all.length < 80) problems.push(`only ${all.length} vectors (PX-03 asks for at least 80)`);
// Every function the core exports for the adapter has a vector.
const covered = new Set(all.map((c) => c.fn));
for (const fn of ['providerIds', 'imageTag', 'imagePaths', 'parseImageRoute', 'transcodePath', 'itemType', 'toView', 'toUserData', 'toStream', 'toMediaSources', 'toItem', 'toItemsResult', 'toExtras', 'toSegments', 'toHubs', 'toChapters', 'parseId', 'msToTicks', 'ticksToMs', 'epochToIso', 'playablePart', 'partQueue', 'seasonsFlattened', 'itemsRequest', 'resumeRequest', 'nextUpRequest', 'answerMeta', 'latestRequest', 'metadataRequest', 'playedRequest', 'userDataRequest', 'timelineRequest', 'transcodeRequest', 'itemsUri', 'withGenreIds', 'translate', 'matchRoute', 'profileExtra', 'decisionRequest', 'toPlaybackInfo', 'decisionFailure', 'remoteCapKbps', 'trackPut', 'partPaths', 'partWindow', 'accountSubtitles'])
  if (!covered.has(fn)) problems.push(`no vector for ${fn}`);

if (problems.length) {
  console.error(`plex-map-check: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`plex-map-check: ok (${passed} vectors${filled ? `, ${filled} filled` : ''}; ${MODULES.length} pure modules)`);
