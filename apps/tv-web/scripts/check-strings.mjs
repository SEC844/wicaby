// Fails when the app asks for a string the Android catalogues do not have (t('key'), plural('key'), t(cond ? 'a' :
// 'b')): this app has no catalogue of its own, so a missing key would show its raw name on screen.
import fs from 'node:fs';
import path from 'node:path';
import androidStrings from './android-strings.mjs';

const src = path.resolve(import.meta.dirname, '..', 'src');
const code = androidStrings().load.call({ addWatchFile() {} }, '\0virtual:strings');
const { fr } = JSON.parse(code.slice('export default '.length, -1));

const missing = [];
for (const file of fs.readdirSync(src, { recursive: true })) {
  if (!/\.(ts|svelte)$/.test(file)) continue;
  const text = fs.readFileSync(path.join(src, file), 'utf8');
  // Every string literal in the first argument of t(, plural( or k( (k marks keys kept in option tables), ternaries
  // between two keys included. French is the catalogue every key must be in: English falls back to it, as Android
  // does for its untranslatable strings.
  for (const call of text.matchAll(/\b(t|plural|k)\(([^,)]*)/g)) {
    for (const lit of call[2].matchAll(/'([a-z][a-z0-9_]*)'/g)) {
      const table = call[1] === 'plural' ? 'plurals' : 'strings';
      if (!(lit[1] in fr[table])) missing.push(`${file}: ${lit[1]}`);
    }
  }
}
if (missing.length) {
  console.error(`Missing strings:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log('strings: ok');
