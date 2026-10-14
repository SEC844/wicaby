// Sidebar sections by media type (apps/desktop/src/renderer/lib/sidebar-groups.ts, sidebar redesign spec §3.2).
// Run: node tools/checks/sidebar-groups-check.mjs
import assert from 'node:assert/strict';
import { GROUPS, libraryKind, libraryRows } from '../../apps/desktop/src/renderer/lib/sidebar-groups.ts';

const cases = {
  movies: ['watch', 'film'],
  tvshows: ['watch', 'tv'],
  mixed: ['watch', 'trailer'],
  folders: ['watch', 'trailer'],
  boxsets: ['watch', 'collection'],
  trailers: ['watch', 'trailer'],
  homevideos: ['photos', 'images'],
  photos: ['photos', 'images'],
  music: ['music', 'music'],
  musicvideos: ['music', 'monitorPlay'],
  books: ['books', 'bookClosed'],
  audiobooks: ['books', 'bookHeadphones'],
  playlists: ['other', 'list'],
  games: ['other', 'folder'],
  TvShows: ['watch', 'tv'],
};
for (const [type, want] of Object.entries(cases)) assert.deepEqual(libraryKind(type), want, type);
for (const empty of [undefined, null, '']) assert.deepEqual(libraryKind(empty), ['watch', 'trailer'], String(empty));
assert.deepEqual(GROUPS, ['watch', 'live', 'music', 'photos', 'books', 'files', 'other']);

const lib = (Id, CollectionType, ServerId = 's1') => ({ Id, CollectionType, ServerId });
// Live TV views are never rows; the playlists view is All Playlists' target when there is music, else an Other row.
const withMusic = libraryRows([lib('a', 'movies'), lib('lt', 'livetv'), lib('pl', 'playlists'), lib('m', 'music'), lib('b', 'tvshows')], 's1');
assert.deepEqual(withMusic.map((r) => [r.lib.Id, r.group]), [['a', 'watch'], ['m', 'music'], ['b', 'watch']]);
const noMusic = libraryRows([lib('pl', 'playlists'), lib('x', 'games')]);
assert.deepEqual(noMusic.map((r) => [r.lib.Id, r.group, r.icon]), [['pl', 'other', 'list'], ['x', 'other', 'folder']]);
assert.deepEqual(libraryRows([]), []);
// Two servers: only the music server's playlists view becomes All Playlists; the other server's stays reachable.
const two = libraryRows([lib('m', 'music', 's1'), lib('pl1', 'playlists', 's1'), lib('pl2', 'playlists', 's2')], 's1');
assert.deepEqual(two.map((r) => r.lib.Id), ['m', 'pl2']);
console.log('sidebar-groups-check: ok');
