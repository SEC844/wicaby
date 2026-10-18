// Fails when the app asks for a string the Android catalogues do not have (t('key'), plural('key'), t(cond ? 'a' :
// 'b')): this app has no catalogue of its own, so a missing key would show its raw name on screen.
import fs from 'node:fs';
import path from 'node:path';
import androidStrings from './android-strings.mjs';

const src = path.resolve(import.meta.dirname, '..', 'src');
const code = androidStrings().load.call({ addWatchFile() {} }, '\0virtual:strings');
const { fr, en } = JSON.parse(code.slice('export default '.length, -1));

const missing = [];
for (const file of fs.readdirSync(src, { recursive: true })) {
  if (!/\.(ts|svelte)$/.test(file)) continue;
  const text = fs.readFileSync(path.join(src, file), 'utf8');
  // Every string literal inside a t( or plural( call's first argument (covers ternaries between two keys).
  for (const call of text.matchAll(/\b(t|plural)\(([^,)]*)/g)) {
    for (const lit of call[2].matchAll(/'([a-z][a-z0-9_]*)'/g)) {
      const key = lit[1];
      const table = call[1] === 't' ? 'strings' : 'plurals';
      if (!(key in fr[table])) missing.push(`${file}: ${key} (French)`);
      else if (!(key in en[table]) && !(key in fr[table])) missing.push(`${file}: ${key} (English)`);
    }
  }
}
if (missing.length) {
  console.error(`Missing strings:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log('strings: ok');
