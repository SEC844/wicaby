// Photos spec PH-01: the shared timeline logic (apps/desktop/src/renderer/lib/photos) against the parity vectors in
// fixtures/photos/photo-fixtures.json. Android's core PhotoFixturesTest reads the same file in place (no copy to
// drift), and checks its strings against the same templates.
// Run: node tools/checks/photos-check.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { displayAspect, needsRelayout, rotation, takenAt, toAsset } from '../../apps/desktop/src/renderer/lib/photos/asset.ts';
import { exifOf, formatExif } from '../../apps/desktop/src/renderer/lib/photos/exif.ts';
import { justify, layoutTimeline } from '../../apps/desktop/src/renderer/lib/photos/justify.ts';
import { memories, memoryQuery } from '../../apps/desktop/src/renderer/lib/photos/memories.ts';
import { cluster } from '../../apps/desktop/src/renderer/lib/photos/cluster.ts';
import { buckets, byTakenDesc } from '../../apps/desktop/src/renderer/lib/photos/timeline.ts';

const root = path.resolve(import.meta.dirname, '../..');
const F = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'photos', 'photo-fixtures.json'), 'utf8'));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);
let n = 0;

// The fixture's unit templates are the desktop catalogue's.
for (const lang of ['fr', 'en']) {
  const e = JSON.parse(readFileSync(path.join(root, `apps/desktop/src/renderer/locales/${lang}/photos.json`), 'utf8')).exif;
  const t = F.templates[lang];
  assert.deepEqual([e.apertureValue, e.exposureValue, e.focalValue, e.isoValue, e.dimensionsValue, e.altitudeValue, e.locationValue], [t.aperture, t.exposure, t.focal, t.iso, t.dimensions, t.altitude, t.location], `${lang}/photos.json templates`);
}

for (const c of F.takenAt) assert.equal(takenAt(c.premiereDate, c.dateCreated, c.offsetMin), c.expected, c.name), n++;
for (const c of F.toAsset) assert.deepEqual(toAsset(c.item, c.offsetMin, c.withLocation), c.expected, c.name), n++;
for (const c of F.orientation) {
  near(displayAspect(c.width, c.height, c.orientation), c.aspect, c.name);
  assert.equal(rotation(c.orientation, c.width, c.height, c.decodedW, c.decodedH), c.rotate, c.name);
  assert.equal(needsRelayout(c.aspect, c.decodedW, c.decodedH, c.rotate), c.relayout, c.name);
  n++;
}
for (const c of F.justify) {
  const rows = justify(c.aspects, c.width, c.targetH, c.gap, c.maxScale);
  assert.equal(rows.length, c.rows.length, `${c.name}: rows`);
  rows.forEach((r, i) => {
    const e = c.rows[i];
    near(r.top, e.top, `${c.name} row ${i} top`);
    near(r.height, e.height, `${c.name} row ${i} height`);
    assert.deepEqual(r.items.map((it) => it.index), e.items.map((it) => it.index), `${c.name} row ${i} items`);
    r.items.forEach((it, k) => (near(it.x, e.items[k].x, `${c.name} row ${i} x`), near(it.w, e.items[k].w, `${c.name} row ${i} w`)));
    // Invariants: a full row spans the width exactly; a panorama rides alone; nothing exceeds maxScale.
    const right = r.items.at(-1).x + r.items.at(-1).w;
    assert.ok(right <= c.width + 1e-6 && r.height <= c.targetH * c.maxScale + 1e-6, `${c.name} row ${i} fits`);
    if (r.items.some((it) => c.aspects[it.index] > 3)) assert.equal(r.items.length, 1, `${c.name} row ${i}: panorama alone`);
  });
  n++;
}
for (const c of F.sort) assert.deepEqual([...c.assets].sort(byTakenDesc).map((a) => a.id), c.expected, c.name), n++;
for (const c of F.buckets) assert.deepEqual(buckets(c.takenAt.map((t) => ({ takenAt: t })), c.unit), c.expected, c.name), n++;
for (const c of F.layoutTimeline) {
  const got = layoutTimeline(c.buckets, c.aspects, c.width, c.targetH, c.gap, c.headerH);
  assert.equal(got.length, c.expected.length, c.name);
  got.forEach((s, i) => {
    const e = c.expected[i];
    assert.deepEqual([s.key, s.rows.length, s.rows[0]?.items[0]?.index ?? null], [e.key, e.rows, e.first], `${c.name} section ${i}`);
    near(s.top, e.top, `${c.name} section ${i} top`);
    near(s.height, e.height, `${c.name} section ${i} height`);
  });
  n++;
}
for (const c of F.memories) assert.deepEqual(memories(c.takenAt.map((t) => ({ takenAt: t })), c.today), c.expected, c.name), n++;
for (const c of F.exif) assert.deepEqual(formatExif(exifOf(c.item), c.lang, F.templates[c.lang], c.aperture), c.expected, c.name), n++;
// Skeleton paging (PH-05 AC1): DateCreated pages, each re-sorted by takenAt, then month buckets. Android's PhotoSource
// replays the same pages from a MockWebServer (core PhotoSourceTest).
for (const c of F.skeleton ?? []) {
  const order = c.pages.flatMap((p) => p.Items.map((x) => toAsset(x, c.offsetMin)).sort(byTakenDesc));
  assert.deepEqual(order.map((a) => a.id), c.expected.ids, `${c.name}: order`);
  assert.deepEqual(order.map((a) => a.takenAt), c.expected.takenAt, `${c.name}: takenAt`);
  assert.deepEqual(buckets(order), c.expected.buckets, `${c.name}: buckets`);
  n++;
}

// Map clusters (PH-09): 60 px grid cells per zoom, the mean position, the newest point as the cover.
for (const c of F.cluster) {
  const got = cluster(c.points, c.z);
  assert.equal(got.length, c.expected.length, c.name);
  got.forEach((g, i) => {
    const e = c.expected[i];
    assert.deepEqual([g.count, g.newest, g.indexes], [e.count, e.newest, e.indexes], `${c.name} ${i}`);
    assert.ok(Math.abs(g.lat - e.lat) < 1e-5 && Math.abs(g.lon - e.lon) < 1e-5, `${c.name} ${i} position`);
  });
  assert.equal(got.reduce((k, g) => k + g.count, 0), c.points.length, `${c.name}: every point in one cluster`);
  n++;
}

// Memories query (PH-08 AC3): /Years once, at most 10 ranges (the nearest earlier years), three in flight, the exact
// day kept (Feb 29 shows on Feb 28 in a year without one).
{
  const calls = { years: 0, ranges: [] };
  let inFlight = 0;
  let peak = 0;
  const photos = { 2024: ['2024-02-27T23:30:00', '2024-02-29T10:00:00', '2024-02-28T09:00:00', '2024-03-01T08:00:00'], 2019: ['2019-02-28T18:00:00'] };
  const years = async () => (calls.years++, [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015, 2014, 2013, 2025]);
  const range = async (min, max) => {
    calls.ranges.push([min, max]);
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return (photos[min.slice(0, 4)] ?? []).filter((t) => t >= min && t <= max).map((takenAt) => ({ takenAt }));
  };
  const got = await memoryQuery(years, range, (x) => x.takenAt, '2025-02-28');
  assert.equal(calls.years, 1);
  assert.equal(calls.ranges.length, 10, 'the 10 nearest earlier years');
  assert.deepEqual(calls.ranges.map(([min]) => min.slice(0, 4)).sort().reverse(), ['2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017', '2016', '2015']);
  assert.ok(peak <= 3, `three in flight at most (${peak})`);
  assert.deepEqual(calls.ranges.find(([min]) => min.startsWith('2024')), ['2024-02-27T00:00:00', '2024-03-01T23:59:59'], 'today ±1 day, the eve and the morrow filtered client-side');
  assert.deepEqual(calls.ranges.find(([min]) => min.startsWith('2019')), ['2019-02-27T00:00:00', '2019-03-01T23:59:59']);
  assert.deepEqual(got.memories.map((m) => [m.yearsAgo, m.indexes.map((i) => got.items[i].takenAt)]), [
    [1, ['2024-02-29T10:00:00', '2024-02-28T09:00:00']],
    [6, ['2019-02-28T18:00:00']],
  ]);
  const none = await memoryQuery(async () => [2026], range, (x) => x.takenAt, '2026-10-13');
  assert.deepEqual(none.memories, [], 'no earlier year: no memory');
  n++;
}

// French typography in the values: U+00A0 before units and ";".
const fr = F.exif.find((c) => c.lang === 'fr' && c.aperture === 'apex').expected;
assert.ok(fr.some(([, v]) => v === 'ƒ/2,8') && fr.some(([, v]) => v === '1/250 s') && fr.some(([, v]) => v === '35 mm'), 'ƒ/2,8, 1/250 s, 35 mm');

console.log(`photos-check: ${n} vectors ok`);
