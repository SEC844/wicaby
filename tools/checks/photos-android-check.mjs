// Photos spec PH-05 AC2/AC4, PH-06 AC1-AC3, PH-07 AC4 on an Android emulator against mock-emby: builds the app and its
// androidTest APK, installs both on ONE emulator, runs the Compose device tests with the mock reachable at 10.0.2.2,
// then reads the mock's request log (tv: the tv-low image sizes and the Dream's photo query).
// Usage: node tools/checks/photos-android-check.mjs --serial emulator-5584 --app mobile|tv [--no-build]
// The emulator is yours to start and stop (swiftshader, -no-audio, -read-only). Only an emulator-NNNN serial is
// accepted: never a real TV or phone. Not part of `npm run checks` (it needs an emulator). Never prints a coordinate.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const serial = arg('--serial');
const app = arg('--app');
assert.match(serial ?? '', /^emulator-\d+$/, '--serial emulator-NNNN (an emulator, never a real device)');
assert.ok(app === 'mobile' || app === 'tv', '--app mobile|tv');
const PORT = 8981;
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? 'C:/Android/Sdk';
const ADB = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');

function adb(...args) {
  const r = spawnSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`adb ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

const cfg = app === 'tv'
  ? { tasks: [':tv:assembleDebug', ':tv:assembleDebugAndroidTest'], apk: (abi) => `tv/build/outputs/apk/debug/tv-${abi}-debug.apk`, test: 'tv/build/outputs/apk/androidTest/debug/tv-debug-androidTest.apk', pkg: 'com.wika.wicaby.tv', cls: ['com.wika.wicaby.tv.ui.photos.PhotosTvDeviceTest,com.wika.wicaby.tv.ui.photos.PhotoDreamDeviceTest', 'com.wika.wicaby.tv.ui.photos.MemoriesHomeDeviceTest'] }
  : { tasks: [':mobile:assembleFossDebug', ':mobile:assembleFossDebugAndroidTest'], apk: (abi) => `mobile/build/outputs/apk/foss/debug/mobile-foss-${abi}-debug.apk`, test: 'mobile/build/outputs/apk/androidTest/foss/debug/mobile-foss-debug-androidTest.apk', pkg: 'com.wika.wicaby', cls: ['com.wika.wicaby.mobile.ui.photos.PhotosTest,com.wika.wicaby.mobile.ui.photos.MemoriesHomeTest'] };

assert.equal(adb('get-state').trim(), 'device', `${serial} is not ready`);
const abis = adb('shell', 'getprop', 'ro.product.cpu.abilist').trim().split(',');
// The APKs are split per ARM ABI; x86_64 emulator images run arm64 through their translator.
const abi = ['arm64-v8a', 'armeabi-v7a'].find((a) => abis.includes(a));
assert.ok(abi, `${serial} runs neither arm64-v8a nor armeabi-v7a (${abis})`);

const android = path.join(root, 'apps/android');
if (!process.argv.includes('--no-build')) {
  const b = spawnSync('bash', ['-c', `./gradlew ${cfg.tasks.join(' ')} -q`], { cwd: android, stdio: 'inherit' });
  assert.equal(b.status, 0, 'gradle build failed');
}

// MOCK_PHOTOS=6000: the newest month holds the dozen assets the D-pad steps need, and the timeline pages 6 times.
// The mock logs into a file: adb runs synchronously below, and a pipe nobody reads meanwhile would stall the mock.
// PHOTOS_LOG=<file> keeps it (paths and queries only, no coordinates).
const logFile = process.env.PHOTOS_LOG ?? path.join(os.tmpdir(), `wicaby-photos-android-${process.pid}.log`);
const mock = spawn(process.execPath, [path.join(root, 'tools/mock-server/mock-emby.mjs'), String(PORT)], { stdio: ['ignore', fs.openSync(logFile, 'w'), 'inherit'], env: { ...process.env, MOCK_PHOTOS: '6000' } });
let exited = null;
mock.on('exit', (code) => { exited = code; });
for (let t = 0; !fs.readFileSync(logFile, 'utf8').includes(`:${PORT}`); t++) {
  assert.ok(exited === null && t < 300, `mock-emby did not start (${exited}): is port ${PORT} taken?`);
  await new Promise((r) => setTimeout(r, 100));
}
const log = () => fs.readFileSync(logFile, 'utf8').split('\n');

let failed = false;
try {
  adb('install', '-r', '-t', path.join(android, cfg.apk(abi)));
  adb('install', '-r', '-t', path.join(android, cfg.test));
  // cls: one `am instrument` per entry. The tv-low size assertions below read only the first run's requests: the
  // home screen of MemoriesHomeDeviceTest (second run, normal device class) asks for cards, covers and Latest rows.
  let firstRun = null;
  for (const cls of cfg.cls) {
    const out = adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'mock', `http://10.0.2.2:${PORT}`, '-e', 'class', cls, `${cfg.pkg}.test/androidx.test.runner.AndroidJUnitRunner`);
    firstRun ??= log();
    for (const m of out.matchAll(/INSTRUMENTATION_STATUS: (photos-[\w-]+)=(.*)/g)) console.log(`${m[1]}: ${m[2]}`);
    for (const m of out.matchAll(/INSTRUMENTATION_STATUS: stack=([\s\S]*?)INSTRUMENTATION_STATUS_CODE: -2/g)) console.error(m[1].split('\n').slice(0, 12).join('\n'));
    const ok = /OK \((\d+) tests?\)/.exec(out);
    if (!ok) {
      failed = true;
      console.error(out.split('\n').filter((l) => /FAILURES|Tests run|INSTRUMENTATION_RESULT|shortMsg/.test(l)).join('\n'));
    } else console.log(`device tests (${cls.split(',').map((c) => c.split('.').pop()).join(', ')}): OK (${ok[1]})`);
  }

  if (app === 'tv') {
    // PH-06 AC3, forced tv-low: grid tiles (maxWidth only) at most 240 px, viewer and screensaver images
    // (maxWidth with maxHeight) at 1280.
    const images = firstRun.filter((l) => /^GET \/emby\/Items\/[^/]+\/Images\/Primary\?/.test(l)).map((l) => new URL(l.slice(4), 'http://mock'));
    const grid = images.filter((u) => !u.searchParams.has('maxHeight')).map((u) => Number(u.searchParams.get('maxWidth')));
    const viewer = images.filter((u) => u.searchParams.has('maxHeight')).map((u) => Number(u.searchParams.get('maxWidth')));
    console.log(`mock log: ${grid.length} grid requests (maxWidth ${Math.min(...grid)}-${Math.max(...grid)}), ${viewer.length} viewer/screensaver requests (maxWidth ${[...new Set(viewer)].join(', ')})`);
    assert.ok(grid.length > 0 && grid.every((w) => w > 0 && w <= 240), 'tv-low grid requests above 240 px');
    assert.ok(viewer.length > 0 && viewer.every((w) => w === 1280), 'tv-low viewer requests not at 1280 px');
    // PH-07 AC1/AC4: the Dream's photo query.
    const saver = firstRun.filter((l) => l.startsWith('GET /emby/Users/') && l.includes('IncludeItemTypes=Photo&') && l.includes('SortBy=Random'));
    console.log(`mock log: ${saver.length} screensaver photo queries`);
    assert.ok(saver.length > 0, 'no screensaver photo query (IncludeItemTypes=Photo, SortBy=Random)');
  }
} catch (e) {
  failed = true;
  console.error(e.message);
} finally {
  mock.kill();
  if (!process.env.PHOTOS_LOG) setTimeout(() => fs.rmSync(logFile, { force: true }), 500);
}
if (failed) process.exit(1);
console.log(`photos-android-check (${app}): OK`);
