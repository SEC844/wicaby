// Writes release/update.json, the manifest the Android apps read for sideloaded updates
// (core/update/Updates.kt). For each app it takes the newest Wicaby-<App>-<version>-<abi>.apk in
// release/tv, release/mobile and release/mobile-gplay, or in the release folder itself (abi = armv7,
// arm64 or universal), hashes it and lists it. Both namings are read: the GitHub release assets
// (Wicaby-TV-foss-*, Wicaby-Mobile-foss-*, Wicaby-Mobile-gplay-*) and release.yml's (Wicaby-TV-*,
// Wicaby-Mobile-*, Wicaby-Mobile-Cast-*).
// Mobile flavours (cast spec CA-10): "mobile" is foss (the key installed 0.2.0 builds read),
// "mobile-gplay" is gplay. Both share applicationId and versionCode, so each build reads only its
// own key and never updates into the other flavour.
//
//   node tools/release/make-update-manifest.mjs [<base-url>] [--flat] [--notes-fr "…"] [--notes-en "…"] [--dir <release dir>]
//
// <base-url> is where release/ is served, e.g. https://example.org/wicaby/ or a GitHub Releases
// download URL; APK URLs are written as <base-url>tv/<file>. Without it they stay relative (tv/<file>;
// <file> with --flat or for an APK in the release folder itself), which the apps resolve against the
// manifest's own URL: …/releases/latest/download/update.json -> …/releases/latest/download/<file>.
// Notes: --notes-fr / --notes-en apply to both apps; release/<app>/NOTES.fr.txt and NOTES.en.txt
// override them per app; otherwise the notes already in update.json are kept for the same version.
// versionCode comes from `aapt2 dump badging` (ANDROID_HOME build-tools), else from
// apps/android/<module>/build.gradle.kts when its versionName matches the APK's.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tools/release -> repo root (release/ and apps/android live there).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const notesFr = opt('--notes-fr');
const notesEn = opt('--notes-en');
// --dir: another release folder (tools/checks/flavour-check.mjs runs this script on a temporary one).
const dirOpt = opt('--dir');
// --flat: APKs sit next to update.json (GitHub Releases assets), not in release/tv/ and release/mobile/.
const flat = args.includes('--flat') && args.splice(args.indexOf('--flat'), 1).length > 0;
const release = dirOpt ? path.resolve(dirOpt) : path.join(root, 'release');
let base = args[0] ?? '';
if (base && !base.endsWith('/')) base += '/';

const ABIS = { armv7: 'armeabi-v7a', arm64: 'arm64-v8a', universal: 'universal' };
// label: the name part after "Wicaby-": the GitHub release asset name, then release.yml's.
const APPS = {
  tv: { label: 'TV-foss|TV', module: 'tv' },
  mobile: { label: 'Mobile-foss|Mobile', module: 'mobile' },
  'mobile-gplay': { label: 'Mobile-gplay|Mobile-Cast', module: 'mobile' },
};

const cmp = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function aapt2() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk) return null;
  const dir = path.join(sdk, 'build-tools');
  if (!fs.existsSync(dir)) return null;
  for (const v of fs.readdirSync(dir).sort(cmp).reverse()) {
    for (const exe of ['aapt2.exe', 'aapt2']) if (fs.existsSync(path.join(dir, v, exe))) return path.join(dir, v, exe);
  }
  return null;
}

function versionCode(apk, app, versionName) {
  const tool = aapt2();
  if (tool) {
    try {
      const out = execFileSync(tool, ['dump', 'badging', apk], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /versionCode='(\d+)'/.exec(out);
      if (m) return Number(m[1]);
    } catch {}
  }
  const gradle = path.join(root, 'apps', 'android', APPS[app].module, 'build.gradle.kts');
  const text = fs.existsSync(gradle) ? fs.readFileSync(gradle, 'utf8') : '';
  const name = /versionName\s*=\s*"([^"]+)"/.exec(text)?.[1];
  const code = /versionCode\s*=\s*(\d+)/.exec(text)?.[1];
  if (name === versionName && code) return Number(code);
  throw new Error(`${path.basename(apk)}: no versionCode (install build-tools for aapt2, or match ${path.relative(root, gradle)})`);
}

const outFile = path.join(release, 'update.json');
const previous = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
const manifest = {};

for (const [app, { label }] of Object.entries(APPS)) {
  const dir = path.join(release, app);
  const re = new RegExp(`^Wicaby-(?:${label})-(\\d+(?:\\.\\d+)*)-(armv7|arm64|universal)\\.apk$`, 'i');
  // [folder, URL prefix]: release/<app>/ (flat or not), then the release folder itself (GitHub assets as downloaded).
  const found = [[dir, flat ? '' : `${app}/`], [release, '']]
    .filter(([d]) => fs.existsSync(d))
    .flatMap(([d, prefix]) => fs.readdirSync(d).map((f) => [f, re.exec(f), d, prefix]))
    .filter(([, m]) => m);
  if (!found.length) continue;
  const newest = found.map(([, m]) => m[1]).sort(cmp).at(-1);
  const apks = {};
  let code = 0;
  for (const [file, m, d, prefix] of found.filter(([, m]) => m[1] === newest)) {
    const full = path.join(d, file);
    code ||= versionCode(full, app, newest);
    apks[ABIS[m[2].toLowerCase()]] = { url: `${base}${prefix}${encodeURIComponent(file)}`, sha256: sha256(full) };
  }
  const read = (lang) => {
    for (const ext of ['txt', 'md']) {
      const f = path.join(dir, `NOTES.${lang}.${ext}`);
      if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
    }
    return undefined;
  };
  const kept = previous[app]?.versionCode === code ? previous[app]?.notes ?? {} : {};
  const notes = { ...kept };
  const fr = read('fr') ?? notesFr;
  const en = read('en') ?? notesEn;
  if (fr) notes.fr = fr;
  if (en) notes.en = en;
  manifest[app] = { versionCode: code, versionName: newest, notes, apks };
  console.log(`${app}: ${newest} (${code}) · ${Object.keys(apks).join(', ')}`);
}

if (!Object.keys(manifest).length) {
  console.error(`No Wicaby-*-{armv7,arm64,universal}.apk in ${release} or its tv, mobile and mobile-gplay folders`);
  process.exit(1);
}
fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${path.relative(root, outFile)}`);
