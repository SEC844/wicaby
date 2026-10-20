// AniSkip fallback (apps/desktop/src/shared/aniskip.ts): saved api.aniskip.com responses to markers, and the
// MAL/AniList id + episode an episode resolves to. Android's AniSkipTest reads the same fixtures.
// Run: node tools/checks/aniskip-check.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aniskipMarkers, aniskipTarget, aniskipUrl } from '../../apps/desktop/src/shared/aniskip.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/aniskip.json', import.meta.url), 'utf8'));

for (const c of fx.cases) {
  const m = aniskipMarkers(c.response);
  if (c.expect === null) {
    assert.equal(m, null, c.name);
    continue;
  }
  assert.equal(m.introStartMs, c.expect.introStartMs ?? undefined, c.name);
  assert.equal(m.introEndMs, c.expect.introEndMs ?? undefined, c.name);
  assert.equal(m.creditsStartMs, c.expect.creditsStartMs ?? undefined, c.name);
  const recap = m.segments?.find((s) => s.type === 'recap');
  assert.deepEqual(recap ? [recap.startMs, recap.endMs] : null, c.expect.recap, c.name);
}
assert.equal(aniskipMarkers(null), null);

for (const c of fx.targets) {
  const t = aniskipTarget(c.episode, c.season, c.series);
  assert.deepEqual(t && { mal: t.mal ?? null, anilist: t.anilist ?? null, episode: t.episode }, c.expect, c.name);
}

assert.equal(
  aniskipUrl(5114, 1, 1_469_634),
  'https://api.aniskip.com/v2/skip-times/5114/1?types[]=op&types[]=ed&types[]=mixed-op&types[]=mixed-ed&types[]=recap&episodeLength=1470',
);
console.log('aniskip-check: ok');
