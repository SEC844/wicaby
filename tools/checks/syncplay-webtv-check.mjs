// Self-check for the web TV app's Jellyfin SyncPlay clock and scheduling (apps/webtv/src/syncplay.ts): the
// /GetUtcTime offset, the best sample, a command's delay (or catch-up when late) and the 2 s drift rule.
// Run: node tools/checks/syncplay-webtv-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(import.meta.dirname, '..', '..');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-syncplay-')), 'syncplay.mjs');
const stubs = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /i18n\.svelte$/ }, () => ({ path: 'i18n', namespace: 'stub' }));
    b.onLoad({ filter: /^i18n$/, namespace: 'stub' }, () => ({ contents: `export const t = (k) => k; export const fmt = {}; export const has = () => false;` }));
  },
};
await build({ entryPoints: [path.join(repo, 'apps/webtv/src/syncplay.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', plugins: [stubs], packages: 'external', define: { 'import.meta.env.VITE_WICABY_DEMO': '"0"' } });
const { clockSample, bestSample, schedule, drift, DRIFT_MS, SyncPlay } = await import(pathToFileURL(out).href);

// Server 1000 ms ahead, 40 ms each way, 2 ms on the server.
let s = clockSample(10_000, 11_040, 11_042, 10_082);
assert.equal(s.offset, 1000);
assert.equal(s.ping, 80);
// Asymmetric legs skew the offset by half the difference; the shortest ping wins.
const slow = clockSample(10_000, 11_200, 11_202, 10_242);
assert.equal(bestSample([slow, s, clockSample(0, 1010, 1010, 30)]).ping, 30);
assert.equal(bestSample([]), undefined);
// The server's ISO time with 7 fractional digits parses (Jellyfin's DateTime format).
assert.equal(Date.parse('2026-10-20T12:00:00.1234567Z') % 1000, 123);

// A command 500 ms ahead in server time, clock 1000 ms ahead: wait 500 ms, start at its position.
assert.deepEqual(schedule(21_500, 60_000, 20_000 - 1000 + 0, 1000), { delayMs: 1500, positionMs: 60_000 });
assert.deepEqual(schedule(21_500, 60_000, 20_000, 1000), { delayMs: 500, positionMs: 60_000 });
// 300 ms late: now, 300 ms further in.
assert.deepEqual(schedule(21_000, 60_000, 20_300, 1000), { delayMs: 0, positionMs: 60_300 });

// Drift from the Unpause anchor: 10 s later the group is at 70 s.
const anchor = { positionMs: 60_000, atLocal: 5000 };
assert.equal(drift(anchor, 15_000, 70_000), 0);
assert.equal(drift(anchor, 15_000, 72_500), 2500);
assert.equal(drift(anchor, 15_000, 69_000), -1000);
assert.ok(Math.abs(drift(anchor, 15_000, 72_500)) > DRIFT_MS, 'seek past 2 s');
assert.ok(Math.abs(drift(anchor, 15_000, 71_900)) <= DRIFT_MS, 'no seek under 2 s');

// The group's Stop ends playback here but keeps the TV in the group; closing the player itself leaves it.
const host = { state: () => ({ active: true }), local: async () => {}, toast() {}, log() {} };
const sp = new SyncPlay(host);
let left = 0;
sp.leave = async () => void left++;
sp.group = { id: 'g', name: 'G', members: [], state: 'playing' };
sp.onState({ active: true });
sp.onMessage({ MessageType: 'SyncPlayCommand', Data: { Command: 'Stop', When: new Date().toISOString() } });
sp.onState({ active: false });
assert.equal(left, 0, 'group Stop does not leave');
sp.onState({ active: true });
sp.onState({ active: false });
assert.equal(left, 1, 'closing the player leaves');

// create/join wait for GroupJoined from the socket before the item page plays.
const sp2 = new SyncPlay(host);
let joined = false;
const wait = sp2.joined().then(() => (joined = true));
await Promise.resolve();
assert.equal(joined, false);
sp2.onMessage({ MessageType: 'SyncPlayGroupUpdate', Data: { Type: 'GroupJoined', Data: { GroupId: 'g', GroupName: 'G', State: 'Idle' } } });
await wait;
assert.equal(sp2.current()?.id, 'g');

console.log('syncplay-webtv-check: ok');
