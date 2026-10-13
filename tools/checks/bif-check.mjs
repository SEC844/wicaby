// Self-check for the BIF trick-play parser (src/shared/bif.ts). Run: node tools/checks/bif-check.mjs
import assert from 'node:assert/strict';
import { bif } from '../mock-server/cbz-fixture.mjs';
import { bifFrameAt, parseBif } from '../../apps/desktop/src/shared/bif.ts';

const images = [Buffer.from('frame-0'), Buffer.from('frame-one'), Buffer.from('f2')];
const file = bif(images, 10_000);
const parsed = parseBif(new Uint8Array(file));
assert.equal(parsed.version, 0);
assert.equal(parsed.intervalMs, 10_000);
assert.equal(parsed.frames.length, 3);
parsed.frames.forEach((f, i) => {
  assert.equal(f.startMs, i * 10_000);
  assert.equal(file.subarray(f.offset, f.offset + f.size).toString(), images[i].toString());
});
assert.equal(bifFrameAt(parsed, 0), 0);
assert.equal(bifFrameAt(parsed, 9_999), 0);
assert.equal(bifFrameAt(parsed, 10_000), 1);
assert.equal(bifFrameAt(parsed, 1e9), 2);

// Multiplier 0 means 1000 ms; a subarray view must parse the same as a fresh buffer.
const zero = Buffer.from(file);
zero.writeUInt32LE(0, 16);
const backing = Buffer.concat([Buffer.alloc(7), zero]);
const view = new Uint8Array(backing.buffer, backing.byteOffset + 7, zero.length);
assert.equal(parseBif(view).frames[2].startMs, 2_000);

assert.throws(() => parseBif(new Uint8Array(64)), /not a BIF/);
assert.throws(() => parseBif(new Uint8Array(file.subarray(0, 70))), /truncated/);
const bad = Buffer.from(file);
bad.writeUInt32LE(file.length + 10, 64 + 3 * 8 + 4);
assert.throws(() => parseBif(new Uint8Array(bad)), /bad BIF offset/);

console.log('bif-check: ok');
