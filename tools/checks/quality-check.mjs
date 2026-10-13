// X-02 quality presets (apps/desktop/src/shared/quality-presets.ts) against the golden vectors shared
// with QualityTest.kt: tools/checks/fixtures/quality/quality.json.
// Run: node tools/checks/quality-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const q = await import(new URL('../../apps/desktop/src/shared/quality-presets.ts', import.meta.url).href);
const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'quality', 'quality.json'), 'utf8'));

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

check('preset table', () => assert.deepEqual(q.QUALITY_PRESETS.map((p) => [p.bitrate, p.height]), fx.presets));
check('original bitrate', () => assert.equal(q.ORIGINAL_BITRATE, fx.original));
for (const c of fx.shown) {
  check(`shown: ${c.name}`, () => {
    const rows = q.qualityRows({ bitrate: c.bitrate, height: c.height, size: 9_000_000_000, durationMs: 7_200_000 });
    assert.equal(rows[0].maxBitrate, null, 'Original first');
    assert.deepEqual(rows.slice(1).map((r) => r.maxBitrate), c.presets);
  });
}
check('coversSource hides 20 Mbps 1080p on an 18 Mbps 1080p source', () => assert.equal(q.coversSource({ bitrate: 20_000_000, height: 1080 }, 18_000_000, 1080), true));
for (const c of fx.size) check(`size ${c.bitrate}`, () => assert.equal(q.estimateSize(c.bitrate, c.durationMs), c.bytes));
check('percent relative to Original', () => {
  const rows = q.qualityRows({ bitrate: 18_000_000, height: 1080, size: 5_481_000_000, durationMs: 2_400_000 });
  const r2 = rows.find((r) => r.maxBitrate === 2_000_000);
  assert.equal(r2.size, q.estimateSize(2_000_000, 2_400_000));
  assert.equal(r2.percent, Math.round((r2.size / 5_481_000_000) * 100));
  assert.equal(rows[0].percent, 100);
});
check('no duration: no sizes', () => assert.ok(q.qualityRows({}).every((r) => r.size === undefined && r.percent === undefined)));
for (const v of fx.versions) {
  check(`version ${v.label}`, () => {
    const video = { Width: v.width, Height: v.height, Codec: v.codec };
    assert.equal(q.versionLabel(video, v.hdr), v.label);
    assert.equal(q.versionSignature(video, v.hdr), v.signature);
  });
}

console.log(`quality-check: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
