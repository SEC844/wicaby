// Android mobile flavours self-check (cast spec CA-10): foss (the default) keeps the FFmpeg decoder and links no
// Google code; gplay adds Google Cast through Play services and drops the FFmpeg decoder; each one has its own
// release assets and update channel, so an installed build never updates into the other flavour.
// Usage: node tools/checks/flavour-check.mjs [--gradle] [--apk]
//   (default)  static checks of the Gradle wiring, sources, release.yml, and make-update-manifest.mjs run on a
//              temporary release folder; no Android SDK needed (npm run checks).
//   --gradle   also resolves the release runtime classpaths with ./gradlew :mobile:dependencies (CI Android job).
//   --apk      also lists the dex packages of the built release APKs with apkanalyzer (after
//              :mobile:assembleFossRelease :mobile:assembleGplayRelease).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const android = path.join(root, 'apps', 'android');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let n = 0;
const ok = (msg) => console.log(`ok ${++n} - ${msg}`);
const GMS = 'com.google.android.gms';
const FFMPEG = 'org.jellyfin.media3:media3-ffmpeg-decoder';

// Every .kt file under apps/android/<dir>, as [relative path, text].
function sources(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.kt')) out.push([path.relative(root, p).replaceAll('\\', '/'), fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(path.join(android, dir));
  return out;
}

// 1. Gradle: the flavours, and each flavour-scoped dependency in its flavour only.
const mobile = read('apps/android/mobile/build.gradle.kts');
assert.match(mobile, /flavorDimensions \+= "distribution"/);
assert.match(mobile, /create\("foss"\) \{[^}]*isDefault = true[^}]*"CAST_SDK", "false"/);
assert.match(mobile, /create\("gplay"\) \{[^}]*"CAST_SDK", "true"/);
assert.match(mobile, /"fossImplementation"\(libs\.jellyfin\.media3\.ffmpeg\.decoder\)/);
assert.match(mobile, /"gplayImplementation"\(libs\.androidx\.media3\.cast\)/);
assert.doesNotMatch(mobile, /^\s*(implementation|api)\(libs\.(jellyfin\.media3\.ffmpeg\.decoder|androidx\.media3\.cast)\)/m);
assert.doesNotMatch(mobile, /applicationIdSuffix|versionCodeOverride|versionNameSuffix/, 'both flavours keep one applicationId and versionCode');
const core = read('apps/android/core/build.gradle.kts');
assert.match(core, /^\s*compileOnly\(libs\.jellyfin\.media3\.ffmpeg\.decoder\)/m);
assert.doesNotMatch(core, /^\s*(api|implementation|runtimeOnly)\(libs\.jellyfin\.media3\.ffmpeg\.decoder\)/m);
assert.doesNotMatch(core, /media3\.cast|play-services/);
assert.match(read('apps/android/core/consumer-rules.pro'), /-dontwarn androidx\.media3\.decoder\.ffmpeg\.\*\*/);
assert.match(read('apps/android/tv/build.gradle.kts'), /^\s*implementation\(libs\.jellyfin\.media3\.ffmpeg\.decoder\)/m);
assert.match(read('apps/android/gradle/libs.versions.toml'), /androidx-media3-cast = \{ module = "androidx\.media3:media3-cast", version\.ref = "media3" \}/);
ok('Gradle: foss is the default with FFmpeg, gplay has media3-cast; :core compiles against FFmpeg only, :tv ships it');

// 2. Google code only in src/gplay: shared sources compile in foss without it.
const google = /^import (com\.google\.android\.gms|androidx\.media3\.cast|androidx\.mediarouter)\./m;
for (const dir of ['core/src/main', 'mobile/src/main', 'mobile/src/foss', 'tv/src/main', 'livetv-ui/src/main', 'mesh-ui/src/main']) {
  for (const [file, text] of sources(dir)) assert.doesNotMatch(text, google, `${file} imports Google Cast code outside src/gplay`);
}
assert.ok(sources('mobile/src/gplay').some(([, t]) => google.test(t)), 'src/gplay holds the Google Cast code');
for (const flavour of ['foss', 'gplay']) {
  assert.ok(sources(`mobile/src/${flavour}`).some(([f, t]) => f.endsWith('/cast/GoogleCastProvider.kt') && /object GoogleCastProvider/.test(t)), `${flavour} GoogleCastProvider`);
}
const manifest = read('apps/android/mobile/src/gplay/AndroidManifest.xml');
const provider = /OPTIONS_PROVIDER_CLASS_NAME"\s+android:value="([\w.]+)"/.exec(manifest)?.[1];
assert.ok(provider, 'gplay manifest names the OptionsProvider');
assert.ok(sources('mobile/src/gplay').some(([, t]) => t.includes(`class ${provider.split('.').at(-1)} : OptionsProvider`)), `${provider} exists in src/gplay`);
assert.ok(!fs.existsSync(path.join(android, 'mobile/src/main/res/raw/gplay_exception.txt')), 'the exception text is gplay only');
ok('Google Cast code, manifest entry and OptionsProvider live in src/gplay only');

// 3. Licence: gplay ships the section 7 text of LICENSE-EXCEPTION.md and names Play services, not FFmpeg.
const block = /```\n([\s\S]*?)```/.exec(read('LICENSE-EXCEPTION.md'))[1];
assert.equal(read('apps/android/mobile/src/gplay/res/raw/gplay_exception.txt').replaceAll('\r\n', '\n'), block);
for (const lang of ['values', 'values-en']) {
  const s = read(`apps/android/mobile/src/gplay/res/${lang}/strings.xml`);
  for (const k of ['licence_play_services', 'gplay_exception_title', 'about_line']) assert.match(s, new RegExp(`name="${k}"`), `gplay ${lang} ${k}`);
  assert.doesNotMatch(/name="about_line">([^<]*)/.exec(s)[1], /FFmpeg/, `gplay ${lang} about_line still names FFmpeg`);
}
const notices = read('THIRD_PARTY_NOTICES.md');
assert.match(notices, /Google Play services[^\n]*proprietary/i, 'THIRD_PARTY_NOTICES.md lists Google Play services');
assert.match(notices, /Jellyfin Media3 FFmpeg decoder[^\n]*not in `gplay`/, 'THIRD_PARTY_NOTICES.md says gplay has no FFmpeg decoder');
ok('gplay: section 7 text, About strings without FFmpeg, notices');

// 4. Update channels: gplay reads "mobile-gplay", foss keeps "mobile".
assert.match(read('apps/android/mobile/src/main/java/com/wika/wicaby/mobile/WicabyApp.kt'),
  /Updater\.init\(if \(BuildConfig\.FLAVOR == "gplay"\) "mobile-gplay" else "mobile",/);
const version = /versionName\s*=\s*"([^"]+)"/.exec(mobile)[1];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-flavours-'));
const manifestFor = (files) => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [dir, file] of files) {
    fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    fs.writeFileSync(path.join(tmp, dir, file), `${dir}/${file}`);
  }
  // Fake APKs: aapt2 fails on them and the script falls back to build.gradle.kts for the versionCode.
  execFileSync(process.execPath, [path.join(root, 'tools/release/make-update-manifest.mjs'), 'https://example.org/r/', '--flat', '--dir', tmp],
    { stdio: 'pipe', env: { ...process.env, ANDROID_HOME: '', ANDROID_SDK_ROOT: '' } });
  return JSON.parse(fs.readFileSync(path.join(tmp, 'update.json'), 'utf8'));
};
try {
  const both = manifestFor([
    ['mobile', `Wicaby-Mobile-${version}-arm64.apk`], ['mobile', `Wicaby-Mobile-${version}-armv7.apk`],
    ['mobile-gplay', `Wicaby-Mobile-Cast-${version}-arm64.apk`], ['mobile-gplay', `Wicaby-Mobile-Cast-${version}-armv7.apk`],
    // TV and mobile are versioned apart (a mobile-only fix bumps mobile alone).
    ['tv', `Wicaby-TV-${/versionName\s*=\s*"([^"]+)"/.exec(read('apps/android/tv/build.gradle.kts'))[1]}-universal.apk`],
  ]);
  assert.deepEqual(Object.keys(both).sort(), ['mobile', 'mobile-gplay', 'tv']);
  assert.equal(both.mobile.apks['arm64-v8a'].url, `https://example.org/r/Wicaby-Mobile-${version}-arm64.apk`);
  assert.equal(both['mobile-gplay'].apks['arm64-v8a'].url, `https://example.org/r/Wicaby-Mobile-Cast-${version}-arm64.apk`);
  assert.equal(both.mobile.versionCode, both['mobile-gplay'].versionCode);
  for (const a of Object.values(both.mobile.apks)) assert.doesNotMatch(a.url, /Cast/, 'the foss channel points at a gplay APK');
  for (const a of Object.values(both['mobile-gplay'].apks)) assert.match(a.url, /Wicaby-Mobile-Cast-/, 'the gplay channel points at a foss APK');
  // A gplay-only release leaves the foss channel out (no jump to gplay), even with a Cast APK in the foss folder.
  const gplayOnly = manifestFor([['mobile-gplay', `Wicaby-Mobile-Cast-${version}-arm64.apk`], ['mobile', `Wicaby-Mobile-Cast-${version}-arm64.apk`]]);
  assert.deepEqual(Object.keys(gplayOnly), ['mobile-gplay']);
  // And a foss-only release leaves the gplay channel out (no jump to foss).
  assert.deepEqual(Object.keys(manifestFor([['mobile', `Wicaby-Mobile-${version}-arm64.apk`]])), ['mobile']);
  // The GitHub release assets as uploaded (Wicaby-TV-foss-*, Wicaby-Mobile-foss-*, Wicaby-Mobile-gplay-*), all in one
  // folder next to update.json (docs/release.md, manual step).
  const tvVersion = /versionName\s*=\s*"([^"]+)"/.exec(read('apps/android/tv/build.gradle.kts'))[1];
  const gh = manifestFor([
    ['', `Wicaby-TV-foss-${tvVersion}-armv7.apk`], ['', `Wicaby-TV-foss-${tvVersion}-universal.apk`],
    ['', `Wicaby-Mobile-foss-${version}-arm64.apk`], ['', `Wicaby-Mobile-gplay-${version}-arm64.apk`], ['', `Wicaby-${version}-x64-setup.exe`],
  ]);
  assert.deepEqual(Object.keys(gh).sort(), ['mobile', 'mobile-gplay', 'tv']);
  assert.equal(gh.tv.apks['armeabi-v7a'].url, `https://example.org/r/Wicaby-TV-foss-${tvVersion}-armv7.apk`);
  assert.equal(gh.mobile.apks['arm64-v8a'].url, `https://example.org/r/Wicaby-Mobile-foss-${version}-arm64.apk`);
  assert.equal(gh['mobile-gplay'].apks['arm64-v8a'].url, `https://example.org/r/Wicaby-Mobile-gplay-${version}-arm64.apk`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
ok(`update.json: "mobile" lists only Wicaby-Mobile(-foss)-*, "mobile-gplay" only Wicaby-Mobile-Cast/gplay-*, flat GitHub names too (${version})`);

// 5. release.yml builds, names and publishes both flavours.
const release = read('.github/workflows/release.yml');
assert.match(release, /:tv:assembleRelease :mobile:assembleFossRelease :mobile:assembleGplayRelease/);
assert.match(release, /collect mobile foss mobile Mobile armeabi-v7a:armv7 arm64-v8a:arm64/);
assert.match(release, /collect mobile gplay mobile-gplay Mobile-Cast armeabi-v7a:armv7 arm64-v8a:arm64/);
assert.match(release, /release\/mobile-gplay\/Wicaby-Mobile-Cast-\*\.apk/);
assert.match(release, /dist\/mobile-gplay\/\*\.apk/);
assert.match(release, /cp LICENSE-EXCEPTION\.md release\//);
ok('release.yml: both flavours built, collected as Wicaby-Mobile-* and Wicaby-Mobile-Cast-*, published with the exception');

// 6. CI runs the unit tests of both flavours (the flavoured module has no testDebugUnitTest).
const ci = read('.github/workflows/ci.yml');
assert.match(ci, /:mobile:testFossDebugUnitTest/);
assert.match(ci, /:mobile:testGplayDebugUnitTest/);
assert.match(ci, /flavour-check\.mjs --gradle/);
ok('ci.yml: foss and gplay unit tests, and the dependency check');

const gradlew = (...args) => process.platform === 'win32'
  ? execFileSync('bash', ['gradlew', ...args], { cwd: android, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 << 20 })
  : execFileSync('./gradlew', args, { cwd: android, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 << 20 });

// 7 (--gradle). The release runtime classpaths, as Gradle resolves them.
if (process.argv.includes('--gradle')) {
  const deps = (project, conf) => gradlew('-q', `:${project}:dependencies`, '--configuration', conf);
  const foss = deps('mobile', 'fossReleaseRuntimeClasspath');
  const gplay = deps('mobile', 'gplayReleaseRuntimeClasspath');
  const tv = deps('tv', 'releaseRuntimeClasspath');
  assert.ok(!foss.includes(GMS), `fossReleaseRuntimeClasspath contains ${GMS}`);
  assert.ok(foss.includes(FFMPEG), 'fossReleaseRuntimeClasspath lacks the FFmpeg decoder');
  assert.ok(!gplay.includes(FFMPEG), `gplayReleaseRuntimeClasspath contains ${FFMPEG}`);
  assert.ok(gplay.includes('com.google.android.gms:play-services-cast-framework'), 'gplayReleaseRuntimeClasspath lacks Play services Cast');
  assert.ok(tv.includes(FFMPEG) && !tv.includes(GMS), 'tv: FFmpeg and no Play services');
  ok('Gradle: foss has no Play services, gplay no FFmpeg decoder, tv keeps FFmpeg');
}

// 8 (--apk). Acceptance 1 and 2 on the built APKs: no Play services classes in foss, no FfmpegLibrary in gplay.
if (process.argv.includes('--apk')) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  assert.ok(sdk, 'ANDROID_HOME is not set');
  const tool = path.join(sdk, 'cmdline-tools', 'latest', 'bin', process.platform === 'win32' ? 'apkanalyzer.bat' : 'apkanalyzer');
  const apks = (flavour) => {
    const dir = path.join(android, 'mobile', 'build', 'outputs', 'apk', flavour, 'release');
    const list = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.apk')) : [];
    assert.ok(list.length, `no ${flavour} release APK in ${path.relative(root, dir)}: run :mobile:assemble${flavour[0].toUpperCase()}${flavour.slice(1)}Release`);
    return list.map((f) => path.join(dir, f));
  };
  // One row per package, class and member: "C d …" a class defined in the APK, "C r …" one only referenced.
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 };
  const run = (args) => (process.platform === 'win32' ? execFileSync('cmd', ['/c', tool, ...args], opts) : execFileSync(tool, args, opts));
  const packages = (apk) => run(['dex', 'packages', apk]);
  for (const apk of apks('foss')) {
    const out = packages(apk);
    assert.equal(out.split('\n').filter((l) => l.includes(GMS)).length, 0, `${path.basename(apk)} has ${GMS} classes`);
    assert.match(out, /^C d\s.*\bandroidx\.media3\.decoder\.ffmpeg\.FfmpegLibrary\r?$/m, `${path.basename(apk)} lacks the FFmpeg decoder`);
  }
  for (const apk of apks('gplay')) {
    const out = packages(apk);
    // :core still references it (DeviceProfile probes it in runCatching); the class itself must be absent.
    assert.doesNotMatch(out, /^C d\s.*\bFfmpegLibrary\r?$/m, `${path.basename(apk)} has FfmpegLibrary`);
    assert.match(out, /^P d\s.*\bcom\.google\.android\.gms\.cast\.framework\r?$/m, `${path.basename(apk)} lacks the Cast framework`);
  }
  ok('APKs: foss has no com.google.android.gms classes, gplay no FfmpegLibrary');
}

console.log(`flavour-check: ${n} checks passed`);
