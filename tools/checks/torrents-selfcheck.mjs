// Self-check for the qBittorrent /sync/maindata merge, the release-name
// matcher and the API version gate. No qBittorrent needed.
// Usage: node tools/checks/torrents-selfcheck.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// The desktop app's sources live in apps/desktop.
const root = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wicaby-torrents-')), 'maindata.mjs');
await build({ entryPoints: [path.join(root, 'src/main/torrents/maindata.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error' });
const { applyMaindata, emptySync, toTorrent, isComplete, versionAtLeast, titleKey, findItem } = await import(pathToFileURL(out).href);

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(64);

// Full update.
let s = applyMaindata(emptySync(), {
  rid: 1,
  full_update: true,
  torrents: { [A]: { name: 'Alpha', progress: 0.5, state: 'downloading', dlspeed: 100, category: 'films' }, [B]: { name: 'Beta', progress: 1, state: 'uploading' } },
  categories: { films: { name: 'films', savePath: 'D:\\Films' } },
  server_state: { dl_info_speed: 100, use_alt_speed_limits: false },
});
assert.equal(s.rid, 1);
assert.equal(Object.keys(s.torrents).length, 2);

// Partial: only changed fields; untouched fields and torrents survive.
const before = s;
s = applyMaindata(s, { rid: 2, torrents: { [A]: { progress: 0.75 } }, server_state: { dl_info_speed: 250 } });
assert.equal(s.torrents[A].progress, 0.75);
assert.equal(s.torrents[A].name, 'Alpha');
assert.equal(s.torrents[A].category, 'films');
assert.equal(s.torrents[B].name, 'Beta');
assert.equal(s.server.dl_info_speed, 250);
assert.equal(s.server.use_alt_speed_limits, false);
assert.equal(before.torrents[A].progress, 0.5, 'previous state is not mutated');

// New torrent, removal, category change and removal.
s = applyMaindata(s, {
  rid: 3,
  torrents: { [C]: { name: 'Gamma', progress: 0, state: 'metaDL' } },
  torrents_removed: [B],
  categories: { series: { name: 'series', savePath: 'D:\\Séries' }, films: { savePath: 'E:\\Films' } },
});
assert.deepEqual(Object.keys(s.torrents).sort(), [A, C]);
assert.equal(s.categories.films.savePath, 'E:\\Films');
assert.equal(s.categories.series.savePath, 'D:\\Séries');
s = applyMaindata(s, { rid: 4, categories_removed: ['series'] });
assert.deepEqual(Object.keys(s.categories), ['films']);

// A response without changes keeps everything but the rid.
const same = applyMaindata(s, { rid: 5 });
assert.equal(same.rid, 5);
assert.deepEqual(same.torrents, s.torrents);

// full_update resets: torrents absent from it are gone.
s = applyMaindata(s, { rid: 9, full_update: true, torrents: { [C]: { name: 'Gamma', progress: 0.1 } } });
assert.deepEqual(Object.keys(s.torrents), [C]);
assert.deepEqual(s.categories, {});
assert.equal(s.torrents[C].state, undefined);

// Mapping to the IPC shape.
const t = toTorrent(A, { name: 'Alpha', progress: 1, state: 'stoppedUP', num_seeds: 3, num_complete: 40, num_leechs: 1, num_incomplete: 9, seq_dl: true, f_l_piece_prio: false, force_start: true, eta: 8640000, size: 1024 });
assert.equal(t.seeds, 3);
assert.equal(t.seedsTotal, 40);
assert.equal(t.peersTotal, 9);
assert.equal(t.sequential, true);
assert.equal(t.forceStart, true);
assert.equal(toTorrent(B, {}).name, B);
assert.equal(toTorrent(B, {}).state, 'unknown');

// Completion.
assert.equal(isComplete({ progress: 1, state: 'uploading' }), true);
assert.equal(isComplete({ progress: 1, state: 'stoppedUP' }), true);
assert.equal(isComplete({ progress: 1, state: 'checkingUP' }), false);
assert.equal(isComplete({ progress: 0.999, state: 'downloading' }), false);

// API gate for stop/start (5.x) vs pause/resume (4.x).
assert.equal(versionAtLeast('2.11.4', '2.11.0'), true);
assert.equal(versionAtLeast('2.11', '2.11.0'), true);
assert.equal(versionAtLeast('2.9.3', '2.11.0'), false);
assert.equal(versionAtLeast('v3.0', '2.11.0'), true);
assert.equal(versionAtLeast('', '2.11.0'), false);

// Release names against library items.
assert.equal(titleKey('Néon.Fantôme.2024.1080p.WEB-DL.x265-MOCK'), 'neon fantome');
assert.equal(titleKey('Les.Ombres.du.Port.S01.1080p.WEB.x264-MOCK'), 'les ombres du port');
assert.equal(titleKey('2012.2009.1080p.BluRay'), '2012');
assert.equal(titleKey('[GRP] Some Show - S02E05 [1080p].mkv'), 'some show');
const items = [
  { Id: 'm1', Name: 'Néon Fantôme', Path: '/media/m1.mkv' },
  { Id: 'e1', Name: 'Pilote', SeriesName: 'Les Ombres du Port', Path: '/tv/Les Ombres du Port/S01/e1.mkv' },
  { Id: 'p1', Name: 'Autre chose', Path: 'D:\\Media\\Films\\Odd.Name.2020.720p\\file.mkv' },
];
assert.equal(findItem('Néon.Fantôme.2024.1080p.WEB-DL.x265-MOCK', items)?.Id, 'm1');
assert.equal(findItem('Les.Ombres.du.Port.S01.1080p.WEB.x264-MOCK', items)?.Id, 'e1');
assert.equal(findItem('Odd.Name.2020.720p', items)?.Id, 'p1', 'folder named like the torrent');
assert.equal(findItem('Unrelated.2021.1080p', items), undefined);

console.log('torrents self-check: ok');
