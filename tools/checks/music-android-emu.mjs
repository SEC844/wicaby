// Music spec MU-07 AC5 (and MU-08 screenshots) on ONE Android phone emulator against mock-emby: builds the foss app and
// its androidTest APK, sets the media volume to 0, runs MusicDeviceTest (session PLAYING in dumpsys media_session with
// the track's metadata, the media notification, KEYCODE_MEDIA_NEXT), checks the mock saw silent WAV streams and the
// Stopped/Playing reports, and pulls the test's screenshots.
// Usage: node tools/checks/music-android-emu.mjs --serial emulator-5600 [--port 8987] [--out <dir>] [--no-build]
// The emulator is yours to start and stop (swiftshader, -no-audio, -read-only). Only an emulator-NNNN serial is
// accepted: never a real TV or phone. Not part of `npm run checks` (it needs an emulator). The mock audio is silent.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const serial = arg('--serial');
const out = arg('--out');
assert.match(serial ?? '', /^emulator-\d+$/, '--serial emulator-NNNN (an emulator, never a real device)');
const PORT = Number(arg('--port') ?? 8987);
const PKG = 'com.wika.wicaby';
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? 'C:/Android/Sdk';
const ADB = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');

function adb(...args) {
  const r = spawnSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`adb ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

assert.equal(adb('get-state').trim(), 'device', `${serial} is not ready`);
assert.equal(adb('shell', 'getprop', 'ro.kernel.qemu').trim() || adb('shell', 'getprop', 'ro.boot.qemu').trim(), '1', `${serial} is not an emulator`);
const abis = adb('shell', 'getprop', 'ro.product.cpu.abilist').trim().split(',');
const abi = ['arm64-v8a', 'armeabi-v7a'].find((a) => abis.includes(a));
assert.ok(abi, `${serial} runs neither arm64-v8a nor armeabi-v7a (${abis})`);

const android = path.join(root, 'apps/android');
if (!process.argv.includes('--no-build')) {
  const b = spawnSync('bash', ['-c', './gradlew :mobile:assembleFossDebug :mobile:assembleFossDebugAndroidTest -q'], { cwd: android, stdio: 'inherit' });
  assert.equal(b.status, 0, 'gradle build failed');
}

// Never audible (spec §6.2): media volume 0 before anything plays (the mock's WAVs are all-zero samples anyway).
adb('shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--set', '0');

const logFile = path.join(os.tmpdir(), `wicaby-music-android-${process.pid}.log`);
const mock = spawn(process.execPath, [path.join(root, 'tools/mock-server/mock-emby.mjs'), String(PORT)], { stdio: ['ignore', fs.openSync(logFile, 'w'), 'inherit'], env: { ...process.env, MOCK_MUSIC: '1' } });
let exited = null;
mock.on('exit', (code) => { exited = code; });
for (let t = 0; !fs.readFileSync(logFile, 'utf8').includes(`:${PORT}`); t++) {
  assert.ok(exited === null && t < 300, `mock-emby did not start (${exited}): is port ${PORT} taken?`);
  await new Promise((r) => setTimeout(r, 100));
}

let failed = false;
try {
  adb('install', '-r', '-t', path.join(android, `mobile/build/outputs/apk/foss/debug/mobile-foss-${abi}-debug.apk`));
  adb('install', '-r', '-t', path.join(android, 'mobile/build/outputs/apk/androidTest/foss/debug/mobile-foss-debug-androidTest.apk'));
  // The media notification needs it on Android 13+.
  spawnSync(ADB, ['-s', serial, 'shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS']);
  const res = adb('shell', 'am', 'instrument', '-w', '-r', '-e', 'mock', `http://10.0.2.2:${PORT}`, '-e', 'class', `${PKG}.mobile.music.MusicDeviceTest`, `${PKG}.test/androidx.test.runner.AndroidJUnitRunner`);
  for (const m of res.matchAll(/(music-[\w-]+)=(.*)/g)) console.log(`${m[1]}: ${m[2].trim()}`);
  for (const m of res.matchAll(/INSTRUMENTATION_STATUS: stack=([\s\S]*?)INSTRUMENTATION_STATUS_CODE: -2/g)) console.error(m[1].split('\n').slice(0, 12).join('\n'));
  assert.match(res, /OK \(1 test\)/, 'MusicDeviceTest failed');
  console.log('device test (MusicDeviceTest): OK');

  // The mock's side: static WAV streams, Stopped before the next Playing.
  const log = fs.readFileSync(logFile, 'utf8').split('\n');
  const streams = log.filter((l) => /^GET \/emby\/Audio\/[^/]+\/stream\?/i.test(l));
  console.log(`mock log: ${streams.length} audio stream requests`);
  assert.ok(streams.length >= 2 && streams.every((l) => /static=true/i.test(l)), 'expected static /Audio/{id}/stream requests');
  const reports = log.filter((l) => /^POST \/emby\/Sessions\/Playing(\/Stopped)?\b/.test(l) && !l.includes('/Progress'));
  console.log(`mock log: ${reports.map((l) => (l.includes('Stopped') ? 'Stopped' : 'Playing')).join(' ')}`);
  assert.ok(reports.length >= 3, 'expected Playing, Stopped, Playing');

  if (out) {
    fs.mkdirSync(out, { recursive: true });
    for (const name of ['music-library-mini-player', 'music-now-playing', 'music-queue']) {
      const r = spawnSync(ADB, ['-s', serial, 'exec-out', 'run-as', PKG, 'cat', `files/${name}.png`], { maxBuffer: 64 << 20 });
      if (r.status === 0 && r.stdout.length > 0) fs.writeFileSync(path.join(out, `${name}.png`), r.stdout);
    }
    console.log(`screenshots: ${out}`);
  }
} catch (e) {
  failed = true;
  console.error(e.message);
} finally {
  mock.kill();
  setTimeout(() => fs.rmSync(logFile, { force: true }), 500);
}
if (failed) process.exit(1);
console.log('music-android-emu: OK');
