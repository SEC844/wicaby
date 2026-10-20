// External ratings (apps/desktop/src/shared/ratings.ts): the MDBList route from an item's provider ids, and the
// parser against a saved answer (fixtures/ratings/mdblist-movie.json, also read by Android's RatingsTest).
// Run: node tools/checks/ratings-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mdblistPath, MDBLIST_PATH_RE, parseMdblist } from '../../apps/desktop/src/shared/ratings.ts';

const sample = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'ratings', 'mdblist-movie.json'), 'utf8'));

// Known sources only, in display order; popcorn given as a string; TMDb from its 0-100 score; null values dropped.
assert.deepEqual(parseMdblist(sample), [
  { source: 'imdb', value: 9.3 },
  { source: 'tomatoes', value: 89 },
  { source: 'popcorn', value: 98 },
  { source: 'metacritic', value: 82 },
  { source: 'letterboxd', value: 4.6 },
  { source: 'tmdb', value: 87 },
]);
// Missing, empty or out-of-range ratings, and non-answers.
assert.deepEqual(
  parseMdblist({ ratings: [{ source: 'imdb', value: null }, { source: 'tomatoes', value: 'N/A' }, { source: 'metacritic', value: 0 }, { source: 'letterboxd', value: 42 }, null] }),
  [],
);
assert.deepEqual(parseMdblist(null), []);
assert.deepEqual(parseMdblist({ error: 'Invalid API key!' }), []);

// Route: imdb first, tmdb otherwise; key case as the servers send it; movies and series only.
assert.equal(mdblistPath({ Type: 'Movie', ProviderIds: { Imdb: 'tt0111161', Tmdb: '278' } }), 'imdb/movie/tt0111161');
assert.equal(mdblistPath({ Type: 'Series', ProviderIds: { tmdb: '1396' } }), 'tmdb/show/1396');
assert.equal(mdblistPath({ Type: 'Series', ProviderIds: { IMDB: 'nm123', Tvdb: '81189' } }), null);
assert.equal(mdblistPath({ Type: 'Episode', ProviderIds: { Imdb: 'tt0959621' } }), null);
assert.equal(mdblistPath({ Type: 'Movie' }), null);
// What main and the web bridge accept from the page: nothing that leaves the route.
assert.ok(MDBLIST_PATH_RE.test('tmdb/show/1396'));
for (const bad of ['imdb/movie/tt1/../x', 'imdb/movie/tt0111161?apikey=x', 'lists/top', '']) assert.ok(!MDBLIST_PATH_RE.test(bad), bad);

console.log('ratings-check: ok');
