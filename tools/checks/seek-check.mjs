// X-04 stepped seek (apps/desktop/src/shared/stepped-seek.ts) against the golden vectors shared with
// SteppedSeekTest.kt: tools/checks/fixtures/seek/stepped-seek.json.
// Run: node tools/checks/seek-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const seek = await import(new URL('../../apps/desktop/src/shared/stepped-seek.ts', import.meta.url).href);
const fx = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'seek', 'stepped-seek.json'), 'utf8'));

let failures = 0;
let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err.message}`);
  }
};

assert.equal(seek.MERGE_MS, 800);
for (const [repeats, m] of fx.multiplier) check(`multiplier(${repeats})`, () => assert.equal(seek.multiplier(repeats), m));

for (const c of fx.sequences) {
  check(c.name, () => {
    let p = null;
    for (const repeat of c.presses) p = seek.press(p, c.position, c.duration, c.step, repeat);
    assert.equal(p.origin, c.position, 'origin');
    assert.equal(p.target, c.target, 'target');
    assert.equal(p.repeats, c.repeats, 'repeats');
    assert.equal(seek.appliedSeconds(p), c.badge, 'badge');
  });
}

for (const c of fx.chapters) check(c.name, () => assert.equal(seek.chapterTarget(c.starts, c.position, c.forward), c.out));

console.log(`seek-check: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
