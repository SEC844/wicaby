// File sources pure core (file-sources-spec FS-01): apps/desktop/src/shared/files/*.ts against the golden vectors in
// fixtures/files/*.json (ids and path guard, natural sort, file names, sidecars, NFO, PROPFIND, progress, URLs).
// The modules are bundled for platform "neutral": a Node or Electron import fails the build, so they stay pure
// (the renderer imports them too). A few expectations are also asserted by hand, so a vector regenerated from a
// broken module cannot pass silently. Usage: node tools/checks/files-core-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(import.meta.dirname, '..', '..');
const dir = path.join(repo, 'apps/desktop/src/shared/files');
const fx = path.join(import.meta.dirname, 'fixtures', 'files');
const MODULES = ['ids', 'natsort', 'names', 'sidecars', 'nfo', 'propfind', 'progress', 'urls', 'shapes'];

for (const m of MODULES) {
  const text = fs.readFileSync(path.join(dir, `${m}.ts`), 'utf8');
  assert.ok(!/from ['"](node:|electron|fs|path)/.test(text), `${m}.ts imports Node or Electron`);
}
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-files-core-')), 'core.mjs');
await build({
  stdin: { contents: MODULES.map((m) => `export * as ${m} from './${m}';`).join('\n'), resolveDir: dir, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: out,
  logLevel: 'error',
});
const { ids, natsort, names, sidecars, nfo, propfind, progress, urls, shapes } = await import(pathToFileURL(out).href);
const load = (f) => JSON.parse(fs.readFileSync(path.join(fx, f), 'utf8'));
let cases = 0;
const eq = (actual, expected, msg) => {
  assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), expected, msg);
  cases++;
};

// ---- paths ----
const paths = load('paths.json');
assert.ok(paths.hostile.length >= 40, `at least 40 hostile paths (${paths.hostile.length})`);
for (const v of paths.valid) {
  eq(ids.encodeId(v.rel), v.id, `encode ${JSON.stringify(v.rel)}`);
  eq(ids.decodeId(v.id), v.rel, `decode ${v.id}`);
}
for (const r of paths.hostile) eq(ids.guardRel(r), null, `guard refuses ${JSON.stringify(r).slice(0, 60)}`);
for (const r of paths.hostile) eq(ids.encodeId(r), null, `no id for ${JSON.stringify(r).slice(0, 60)}`);
for (const i of paths.hostileIds) eq(ids.decodeId(i), null, `decode refuses ${i.slice(0, 60)}`);
for (const r of paths.noId) {
  assert.equal(ids.guardRel(r), r);
  eq(ids.encodeId(r), null, 'too long for an id');
}
for (const c of paths.crumbs) eq(ids.crumbs(c.rel), c.crumbs, `crumbs of ${c.rel}`);
assert.equal(ids.ROOT_ID, 'p.');
assert.equal(ids.decodeId('p.'), '');
for (const [a, b] of [['..', 'x'], ['a/../b', 'x'], ['C:', 'x'], ['CON', 'x']]) assert.equal(ids.guardRel(a), null, `hand: ${a} ${b}`);

// ---- natural sort ----
const nat = load('natsort.json');
for (const p of nat.pairs) {
  eq(Math.sign(natsort.natCompare(p.a, p.b)), p.cmp, `${p.a} vs ${p.b}`);
  eq(Math.sign(natsort.natCompare(p.b, p.a)), -p.cmp, `${p.b} vs ${p.a} (antisymmetric)`);
}
eq([...nat.sorted.input].sort(natsort.natCompare), nat.sorted.output, 'sorted list');
assert.ok(natsort.natCompare('E2', 'E10') < 0 && natsort.natCompare('Season 2', 'Season 10') < 0 && natsort.natCompare('01', '1') < 0, 'hand: E2 < E10, Season 2 < Season 10, 01 < 1');

// ---- names ----
for (const v of load('names.json')) {
  const { input, label, ...expect } = v;
  const got = names.parseName(input);
  eq(got, expect, `name ${input}`);
  eq(names.episodeLabel(got), label, `label ${input}`);
}
assert.deepEqual(names.parseName('Example.Show.S01E02.720p.mkv'), { title: 'Example Show', season: 1, episode: 2 }, 'hand: SxxEyy');
assert.deepEqual(names.parseName('Example.Movie.2019.1080p.mkv'), { title: 'Example Movie', year: 2019 }, 'hand: film');

// ---- sidecars ----
const side = load('sidecars.json');
for (const c of side.videos) eq(sidecars.videoSidecars(c.video, c.names), c.expect, `sidecars of ${c.video}`);
for (const c of side.folders) eq(sidecars.folderSidecars(c.names), c.expect, `folder sidecars ${c.names.join(',')}`);
const movie = sidecars.videoSidecars('Example.Movie.2019.1080p.mkv', side.videos[0].names);
assert.equal(movie.poster, 'poster.jpg', 'hand: folder poster');
assert.deepEqual(
  movie.subtitles.map((s) => [s.language, s.forced]),
  [['en', true], ['fr', false]],
  'hand: fr and en.forced subtitles',
);

// ---- nfo ----
for (const c of load('nfo.json')) eq(nfo.parseNfo(c.input), c.expect, `nfo ${c.input.slice(0, 40)}`);
assert.equal(nfo.parseNfo('<movie><title>Example Movie &amp; Friends</title></movie>').title, 'Example Movie & Friends', 'hand: NFO title');
assert.equal(nfo.parseNfo('<!DOCTYPE m [<!ENTITY x "boom">]><movie><title>&x;</title></movie>').title, '&x;', 'hand: no entity expansion');

// ---- propfind ----
const pf = load('propfind.json');
for (const c of pf.cases) eq(propfind.parseMultistatus(c.xml, pf.base, c.rel), c.expect, `propfind ${c.rel || 'root'} #${pf.cases.indexOf(c)}`);
const evil = pf.cases[2].expect;
assert.ok(evil.dropped >= 6 && evil.entries.length === 1 && evil.entries[0].name === 'ok.mkv', 'hand: evil hrefs dropped');

// ---- progress ----
const pr = load('progress.json');
for (const k of pr.keys) eq(progress.progressKey(k.rel, k.size, k.mtimeMs), k.key, `key ${k.rel}`);
for (const r of pr.reports) eq(progress.report(r.prev ?? undefined, pr.file, r.pos, r.dur, pr.now), r.expect, `report ${r.pos}/${r.dur}`);
eq(progress.continueList(pr.continue.doc, pr.continue.limit), pr.continue.expect, 'continue (limit)');
eq(progress.continueList(pr.continue.doc), pr.continue.all, 'continue (all)');
eq(Object.keys(progress.prune(pr.continue.doc, pr.prune.max).records).sort(), pr.prune.expect, 'prune');
const f = { size: 1, mtimeMs: 10_000 };
assert.equal(progress.report(undefined, f, 4, 100, 0).positionMs, 0, 'hand: under 5 %: no resume point');
assert.equal(progress.report(undefined, f, 50, 100, 0).positionMs, 50, 'hand: 50 % resumes');
assert.ok(progress.report(undefined, f, 90, 100, 0).played, 'hand: 90 % is played');
assert.ok(!progress.sameFile(progress.report(undefined, f, 50, 100, 0), 1, 11_000), 'hand: a new mtime second is another file');

// ---- urls ----
const u = load('urls.json');
for (const c of u.parse) eq(urls.parseSourceUrl(c.input), c.expect, `parse ${c.input}`);
for (const c of u.redact) eq(urls.redactUrl(c.input), c.expect, `redact ${c.input}`);
for (const c of u.unc) eq(urls.uncPath(c.url, c.rel), c.expect, `unc ${c.url} ${c.rel}`);
for (const c of u.display) {
  eq(urls.displayUrl(c.input), c.expect, `display ${c.input}`);
  eq(urls.defaultName(c.input), c.name, `name ${c.input}`);
}
assert.equal(urls.parseSourceUrl('https://demo:secret@dav.example/media').url, 'https://dav.example/media', 'hand: userinfo leaves the URL');

// ---- folder shapes (§4.3) ----
const sh = load('shapes.json');
for (const [name, n] of sh.seasons) eq(shapes.seasonNumber(name), n, `season number of ${JSON.stringify(name)}`);
for (const c of sh.folders) {
  const children = c.children.map((n) => ({ name: n.replace(/\/$/, ''), dir: n.endsWith('/') }));
  const got = shapes.folderShape(c.name, children);
  eq({ shape: got.shape, film: got.film?.name ?? null }, { shape: c.shape, film: c.film ?? null }, `shape of ${c.name} [${c.children.join(', ')}]`);
}
for (const c of sh.episodeOrder) eq([...c.names].sort((a, b) => shapes.episodeOrder(a, b) || natsort.natCompare(a, b)), c.sorted, `episode order ${c.names[0]}`);
assert.equal(shapes.folderShape('Example Show', [{ name: 'Season 1', dir: true }]).shape, 'Series', 'hand: season folders make a series');

assert.ok(cases >= 200, `at least 200 vector cases (${cases})`);
console.log(`files-core-check: ok (${cases} vector cases, ${paths.hostile.length} hostile paths, ${paths.hostileIds.length} hostile ids)`);
