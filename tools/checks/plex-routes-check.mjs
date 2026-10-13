// Plex route coverage (plex-spec §3.2 guard 2, R-1): every Emby path the desktop builds (renderer, main, shared)
// must be in the Plex route table (apps/desktop/src/shared/plex/routes.ts ROUTES: translated, or answered by the
// adapter) or in PLEX_UNSUPPORTED with its UI fallback. A new screen that calls a new Emby route fails here until
// someone decides what a plex server does with it. Also: every unsupported route really answers PLEX-UNMAPPED 404.
// Paths are string and template literals that start with an Emby root ('/Items…', '/Users…'); `${…}` becomes a
// placeholder. Folders whose routes never reach a plex server are declared below with the flag that keeps them away.
// Usage: node tools/checks/plex-routes-check.mjs [--self-test]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const src = path.resolve(import.meta.dirname, '../../apps/desktop/src');
const srcUrl = pathToFileURL(src).href + '/';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(srcUrl) && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const R = await import(pathToFileURL(path.join(src, 'shared/plex/routes.ts')).href);

// Folders a plex server never sees, and why (each is a capability flag or its own dialect).
const AWAY = {
  'renderer/admin/': 'caps.admin is false: no Admin route or sidebar entry for plex',
  'main/admin/': 'caps.admin is false (the metadata editor and image upload, D-2)',
  'main/comics/': 'caps.comics is false: no comics on Plex',
  'main/files/': 'the files dialect (FilesClient), another kind',
  'shared/plex/': 'the Plex dialect itself',
};
// Literals that are not request paths.
const NOT_ROUTES = new Set(['/emby', '/embywebsocket']);
// Jellyfin 10.9+ forms (renderer/lib/api.ts userRoute, main/connection/user-routes.ts): sent only when kind is
// 'jellyfin'; a plex server gets the Emby form.
const JELLYFIN = [
  [/^\/UserViews$/, '/Users/{}/Views'],
  [/^\/UserItems\/Resume$/, '/Users/{}/Items/Resume'],
  [/^\/User(Played|Favorite)Items\/\{\}$/, '/Users/{}/$1Items/{}'],
  [/^\/UserItems\/\{\}\/UserData$/, '/Users/{}/Items/{}/UserData'],
  [/^\/Items(\/Latest|\/Resume|\/\{\}(?:\/LocalTrailers|\/SpecialFeatures|\/Intros)?)?$/, '/Users/{}/Items$1'],
];
// Routes sent only when kind is 'jellyfin', with no Emby form (renderer/lib/music.ts: server lyrics).
const JELLYFIN_ONLY = new Set(['/Audio/{}/Lyrics']);
// Composed paths: the literal holds a variable segment whose values are listed here (with where they come from).
const COMPOSED = {
  '/Users/{}{}': [], // renderer/lib/api.ts userRoute(): its routes are scanned from the userRoute("…") calls.
  // main/connection/user-routes.ts userItemExtras(): LocalTrailers or Intros, Emby and Jellyfin forms.
  '/Users/{}/Items/{}/{}': ['/Users/{}/Items/{}/LocalTrailers', '/Users/{}/Items/{}/Intros'],
  '/Items/{}/{}': ['/Users/{}/Items/{}/LocalTrailers', '/Users/{}/Items/{}/Intros'],
};
const ROOTS = 'Users|Items|Shows|Sessions|Videos|Audio|Library|LiveTv|System|Playlists|Collections|Genres|Persons|Artists|MusicGenres|Studios|Search|MediaSegments|Notifications|ScheduledTasks|Plugins|Devices|UserViews|UserItems|UserPlayedItems|UserFavoriteItems|Auth|Branding|DisplayPreferences|Localization|Environment|Packages|Startup|Trailers|Movies|Albums|Instant|Images|Providers|Subtitles|Encoding|Channels|QuickConnect|Connect|Features|Web|Dlna|Tags|Years|Sync|emby|embywebsocket';
const START = new RegExp(`(['"\`])/(?:${ROOTS})(?=[/'"\`?$]|$)`, 'g');

// The literal starting at quote index i, with ${…} (and anything nested in it) as '{}'.
function literalAt(text, i) {
  const q = text[i];
  let out = '';
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') {
      out += text[j + 1];
      j++;
    } else if (ch === q) return out;
    else if (q === '`' && ch === '$' && text[j + 1] === '{') {
      let depth = 1;
      j += 2;
      for (; j < text.length && depth; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        else if (text[j] === "'" || text[j] === '"' || text[j] === '`') {
          const inner = text[j];
          for (j++; j < text.length && text[j] !== inner; j++) if (text[j] === '\\') j++;
        }
      }
      j--;
      out += '{}';
    } else if (ch === '\n' && q !== '`') return null;
    else out += ch;
  }
  return null;
}

// '{}' that is not a whole segment (or an extension) is a query string or an optional prefix: dropped.
const normalize = (p) => p.split('?')[0].replace(/(?<=\w)\{\}|\{\}(?=\w)/g, '').replace(/\/$/, '') || p;

export function extract(text) {
  const out = [];
  for (const m of text.matchAll(START)) {
    const lit = literalAt(text, m.index);
    if (lit !== null) out.push(lit);
  }
  for (const m of text.matchAll(/userRoute\(\s*(['"`])/g)) {
    const lit = literalAt(text, m.index + m[0].length - 1);
    if (lit !== null) out.push(`/Users/{}${lit}`);
  }
  return out;
}

const sample = (p) => p.replace(/\{\}/g, 'x1');
const ROUTE_RES = R.ROUTES.map((r) => ({ r, re: new RegExp(`^${r.path.split(/(\{\w+\}|\*)/).map((part) => (part === '*' ? '.+' : /^\{\w+\}$/.test(part) ? '[^/]+?' : part.replace(/[.+?^$()|[\]\\]/g, '\\$&'))).join('')}$`) }));

// 'route' | 'unsupported:<fallback>' | null for one normalized path.
export function classify(p) {
  let forms = [p];
  for (const [re, to] of JELLYFIN) if (re.test(p)) forms = [p.replace(re, to)];
  if (p in COMPOSED) forms = COMPOSED[p];
  if (JELLYFIN_ONLY.has(p)) return 'jellyfin-only';
  if (!forms.length) return 'composed';
  const verdicts = forms.map((f) => {
    const s = sample(f);
    if (ROUTE_RES.some(({ re }) => re.test(s))) return 'route';
    const u = R.UNSUPPORTED_RE.find((x) => x.re.test(s));
    return u ? `unsupported: ${u.fallback}` : null;
  });
  return verdicts.includes(null) ? null : verdicts[0];
}

function scan() {
  const found = new Map(); // normalized path -> [file:line]
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(src, full).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (!Object.keys(AWAY).some((a) => `${rel}/` === a)) walk(full);
      } else if (/\.(ts|svelte)$/.test(e.name)) {
        const text = fs.readFileSync(full, 'utf8');
        for (const lit of extract(text)) {
          const p = normalize(lit);
          if (NOT_ROUTES.has(p)) continue;
          (found.get(p) ?? found.set(p, []).get(p)).push(rel);
        }
      }
    }
  };
  walk(src);
  return found;
}

// ---- Self-test: the extractor and the classifier catch what they must ----
assert.deepEqual(extract("api.get(`/Items/${id}/Similar`, q); x = '/Shows/NextUp'; userRoute(\"/Views\")"), ['/Items/{}/Similar', '/Shows/NextUp', '/Users/{}/Views']);
assert.deepEqual(extract('`/Videos/${a.Id}/${s.Id}/Subtitles/${i}/${k === \'j\' ? \'0/\' : \'\'}Stream.vtt`').map(normalize), ['/Videos/{}/{}/Subtitles/{}/Stream.vtt']);
assert.equal(normalize('/Videos/{}/index.bif{}'), '/Videos/{}/index.bif');
assert.equal(normalize('/Videos/{}/stream.{}'), '/Videos/{}/stream.{}');
assert.equal(normalize('/Users/{}{}'), '/Users/{}{}');
assert.equal(classify('/Items/{}/ThemeSongs'), null, 'self-test: an unknown route is caught');
assert.equal(classify('/UserViews'), 'route', 'self-test: a Jellyfin form maps to its Emby form');
assert.match(classify('/LiveTv/Programs'), /^unsupported/);
if (process.argv.includes('--self-test')) {
  console.log('plex-routes-check: self-test ok');
  process.exit(0);
}

// ---- Coverage ----
const found = scan();
const problems = [];
const tally = { route: 0, unsupported: 0, composed: 0, 'jellyfin-only': 0 };
for (const [p, where] of [...found].sort()) {
  const v = classify(p);
  if (v === null) problems.push(`${p}  (${[...new Set(where)].join(', ')}): neither in ROUTES nor in PLEX_UNSUPPORTED`);
  else tally[v.startsWith('unsupported') ? 'unsupported' : v]++;
}

// ---- Every unsupported route answers 404 PLEX-UNMAPPED, never an answer ----
for (const u of R.PLEX_UNSUPPORTED) {
  if (!u.fallback || u.fallback.length < 10) problems.push(`${u.path}: PLEX_UNSUPPORTED needs its UI fallback`);
  for (const method of ['GET', 'POST', 'DELETE']) {
    const s = sample(u.path.replace(/\{\w+\}/g, '{}').replace('*', 'x1'));
    try {
      R.translate(method, s);
      problems.push(`${method} ${s}: translated although declared unsupported`);
    } catch (err) {
      if (!(err.status === 404 && /^PLEX-UNMAPPED /.test(err.message))) problems.push(`${method} ${s}: ${err.message}`);
    }
  }
}

if (problems.length) {
  console.error(`plex-routes-check: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`plex-routes-check: ok (${found.size} Emby paths: ${tally.route} in the route table, ${tally.unsupported} declared unsupported, ${tally.composed} composed, ${tally['jellyfin-only']} Jellyfin-only; ${Object.keys(AWAY).length} folders away)`);
