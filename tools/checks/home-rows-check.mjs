// Home "Because you watched" rows and the shuffle (apps/desktop/src/renderer/lib/items.ts).
// Run: node tools/checks/home-rows-check.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { becauseSeeds, dedupe, merge, shuffled, unseen } from '../../apps/desktop/src/renderer/lib/items.ts';

const ep = (id, series, server = 'A') => ({ Id: id, Name: id, Type: 'Episode', SeriesId: series, SeriesName: `Show ${series}`, ServerId: server });
const movie = (id, server = 'A', tmdb) => ({ Id: id, Name: id, Type: 'Movie', ServerId: server, ProviderIds: tmdb ? { Tmdb: tmdb } : undefined });

// Episodes stand for their series; two episodes of one show give one seed; 2 seeds at most.
const seeds = becauseSeeds([ep('e1', 's1'), ep('e2', 's1'), movie('m1'), movie('m2')]);
assert.deepEqual(seeds.map((s) => [s.Id, s.Name, s.Type, s.ServerId]), [
  ['s1', 'Show s1', 'Series', 'A'],
  ['m1', 'm1', 'Movie', 'A'],
]);
// The same id on two servers is two titles.
assert.equal(becauseSeeds([movie('m1', 'A'), movie('m1', 'B')]).length, 2);
assert.deepEqual(becauseSeeds([]), []);

// Unseen: drops the same item and the same title from another server, keeps the rest in order.
const shown = [movie('m1', 'A'), movie('m2', 'A', '42')];
const sim = [movie('m1', 'A'), movie('m3', 'B', '42'), movie('m4', 'A'), movie('m1', 'B')];
assert.deepEqual(unseen(sim, shown).map((x) => `${x.ServerId}:${x.Id}`), ['A:m4', 'B:m1']);
assert.deepEqual(unseen([], shown), []);

// An item listed twice (by one server, or repeated) keeps one copy: keyed {#each} blocks throw on duplicate keys.
assert.deepEqual(dedupe([movie('m1'), movie('m2'), movie('m1')]).map((x) => x.Id), ['m1', 'm2']);
assert.deepEqual(merge([[movie('m1'), movie('m1')], [movie('m1', 'B')]]).map((x) => `${x.ServerId}:${x.Id}`), ['A:m1', 'B:m1']);
assert.deepEqual(unseen([movie('m5'), movie('m5')], shown).map((x) => x.Id), ['m5']);

// Shuffle: a permutation on a copy.
const list = Array.from({ length: 50 }, (_, i) => i);
const mixed = shuffled(list);
assert.notEqual(mixed, list);
assert.deepEqual([...mixed].sort((a, b) => a - b), list);
assert.deepEqual(list, Array.from({ length: 50 }, (_, i) => i));

// "Ce jour-là" (photos PH-08 AC4): a row of the layout like the others (so it can be hidden and moved), only with a
// photo library, under the same id on desktop and Android (core HomeRows.MEMORIES).
const root = path.resolve(import.meta.dirname, '../..');
const home = readFileSync(path.join(root, 'apps/desktop/src/renderer/routes/Home.svelte'), 'utf8');
assert.ok(home.includes("...(hasPhotos ? [{ id: 'memories'"), 'desktop: the memories row in the row model, with a photo library only');
assert.ok(home.includes("if (wants('memories'))"), 'desktop: a hidden memories row is not loaded');
assert.ok(readFileSync(path.join(root, 'apps/android/core/src/main/java/com/wika/wicaby/core/data/HomeRows.kt'), 'utf8').includes('const val MEMORIES = "memories"'), 'Android: same id');

console.log('home-rows-check: OK');
