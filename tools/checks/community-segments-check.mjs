// Community timestamps (apps/desktop/src/shared/community-segments.ts): saved TheIntroDB and IntroDB answers to
// times with the sanity drops, the ids and URLs a movie or an episode asks with, and the per-kind priority merge
// (server, TheIntroDB, IntroDB, AniSkip). No network.
// Run: node tools/checks/community-segments-check.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  communityMarkers,
  communityTarget,
  introDbTimes,
  introDbUrl,
  mergeMarkers,
  missingKinds,
  theIntroDbTimes,
  theIntroDbUrl,
} from '../../apps/desktop/src/shared/community-segments.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/community-segments.json', import.meta.url), 'utf8'));
const flat = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, [v.startMs, v.endMs]]));

for (const c of fx.theintrodb) assert.deepEqual(flat(theIntroDbTimes(c.response, c.runtimeMs)), c.expect, `theintrodb: ${c.name}`);
for (const c of fx.introdb) assert.deepEqual(flat(introDbTimes(c.response, c.runtimeMs)), c.expect, `introdb: ${c.name}`);

// Ids: an episode asks with its series' ids and its numbers, a movie with its own; junk ids are not sent.
const series = { Tmdb: '1396', Tvdb: '81189', IMDB: 'tt0903747' };
const ep = communityTarget({ Type: 'Episode', ParentIndexNumber: 2, IndexNumber: 1 }, series);
assert.deepEqual(ep, { tmdb: '1396', tvdb: '81189', imdb: 'tt0903747', season: 2, episode: 1 });
assert.equal(theIntroDbUrl(ep), 'https://api.theintrodb.org/v4/media?tvdb_id=81189&season=2&episode=1');
assert.equal(introDbUrl(ep), 'https://api.introdb.app/segments?imdb_id=tt0903747&season=2&episode=1');
const movie = communityTarget({ Type: 'Movie' }, { Imdb: 'tt1375666', Tmdb: '27205&x=1' });
assert.equal(theIntroDbUrl(communityTarget({ Type: 'Movie' }, { Imdb: 'tt1375666', Tmdb: '27205' })), 'https://api.theintrodb.org/v4/media?tmdb_id=27205', 'TMDB before IMDb');
assert.equal(theIntroDbUrl(movie), 'https://api.theintrodb.org/v4/media?imdb_id=tt1375666');
assert.equal(introDbUrl(movie), 'https://api.introdb.app/segments?imdb_id=tt1375666&is_movie=true');
assert.equal(introDbUrl(communityTarget({ Type: 'Movie' }, { Tvdb: '5' })), null, 'introdb: IMDb ids only');
assert.equal(communityTarget({ Type: 'Episode', ParentIndexNumber: 1 }, series), null, 'no episode number');
assert.equal(communityTarget({ Type: 'Movie' }, { Imdb: '../x' }), null, 'no usable id');
assert.equal(communityTarget({ Type: 'TvChannel' }, series), null);
// The same id rules as Android's CommunitySegments.kt: 1 to 10 digits, tt and 5 to 10 digits.
assert.deepEqual(communityTarget({ Type: 'Movie' }, { Tmdb: '1234567890' }), { tmdb: '1234567890', tvdb: undefined, imdb: undefined });
assert.equal(communityTarget({ Type: 'Movie' }, { Tmdb: '12345678901', Imdb: 'tt1234' }), null, 'ids too long or too short');

// Markers: a credits start at 0 is dropped (it would mark the item watched as it starts).
assert.equal(communityMarkers({}), null);
assert.equal(communityMarkers({ credits: { startMs: 0, endMs: 10 } }), null);
assert.deepEqual(communityMarkers({ intro: { startMs: 1, endMs: 2 }, preview: { startMs: 9, endMs: 10 }, recap: { startMs: 3, endMs: 4 } }), {
  introStartMs: 1,
  introEndMs: 2,
  creditsStartMs: undefined,
  segments: [
    { type: 'recap', startMs: 3, endMs: 4 },
    { type: 'preview', startMs: 9, endMs: 10 },
  ],
});

// Priority per kind: the server, then TheIntroDB, then IntroDB, then AniSkip.
const server = { introStartMs: 100, introEndMs: 200, creditsStartMs: undefined, segments: [{ type: 'commercial', startMs: 500, endMs: 600 }] };
const tidb = communityMarkers(theIntroDbTimes(fx.theintrodb[1].response, 2843000));
const idb = communityMarkers(introDbTimes(fx.introdb[1].response, 2843000));
const aniskip = { introStartMs: 1, introEndMs: 2, creditsStartMs: 3, segments: [{ type: 'recap', startMs: 7, endMs: 8 }, { type: 'preview', startMs: 9, endMs: 10 }] };
assert.deepEqual(mergeMarkers(server, tidb, idb, aniskip), {
  introStartMs: 100,
  introEndMs: 200,
  creditsStartMs: 2786500,
  segments: [
    { type: 'preview', startMs: 9, endMs: 10 },
    { type: 'recap', startMs: 95000, endMs: 259000 },
    { type: 'commercial', startMs: 500, endMs: 600 },
  ].sort((a, b) => a.startMs - b.startMs),
});
assert.equal(mergeMarkers(null, undefined), null);
assert.equal(missingKinds(server), true);
assert.equal(missingKinds(mergeMarkers(server, tidb, idb, aniskip)), false, 'every kind marked: nobody is asked');

console.log('community-segments-check: ok');
