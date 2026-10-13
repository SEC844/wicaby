#!/usr/bin/env node
// Strips metadata from the README images: PNG keeps only IHDR, PLTE, tRNS, IDAT and IEND (no tEXt, iTXt, zTXt,
// eXIf, tIME, caBX or colour profile); WebP loses its EXIF, XMP and ICC chunks. Pixels are untouched.
//
//   node tools/screenshots/strip-metadata.mjs [dir|file…]           strip in place (default docs/screenshots)
//   node tools/screenshots/strip-metadata.mjs --check [dir|file…]   exit 1 if an image still carries metadata
//   node tools/screenshots/strip-metadata.mjs --self-test
// Both screenshot scripts call it on what they write; npm run checks runs --check.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
const WEBP_DROP = new Set(['EXIF', 'XMP ', 'ICCP']);

// Returns { out, dropped } where out is the stripped file (the same buffer when nothing was dropped).
export function strip(buf) {
  if (buf.subarray(0, 8).equals(PNG_SIG)) {
    const parts = [PNG_SIG];
    const dropped = [];
    for (let pos = 8; pos < buf.length; ) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString('latin1', pos + 4, pos + 8);
      (PNG_KEEP.has(type) ? parts : dropped).push(PNG_KEEP.has(type) ? buf.subarray(pos, pos + 12 + len) : type);
      pos += 12 + len;
      if (type === 'IEND') break;
    }
    return { out: dropped.length ? Buffer.concat(parts) : buf, dropped };
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const parts = [];
    const dropped = [];
    for (let pos = 12; pos + 8 <= buf.length; ) {
      const type = buf.toString('latin1', pos, pos + 4);
      const end = pos + 8 + buf.readUInt32LE(pos + 4) + (buf.readUInt32LE(pos + 4) & 1);
      if (WEBP_DROP.has(type)) dropped.push(type.trim());
      else parts.push(Buffer.from(buf.subarray(pos, end)));
      pos = end;
    }
    if (!dropped.length) return { out: buf, dropped };
    // VP8X flags: ICC 0x20, EXIF 0x08, XMP 0x04.
    const x = parts.find((p) => p.toString('latin1', 0, 4) === 'VP8X');
    if (x) x[8] &= ~(0x20 | 0x08 | 0x04);
    const body = Buffer.concat(parts);
    const head = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1');
    head.writeUInt32LE(body.length + 4, 4);
    return { out: Buffer.concat([head, body]), dropped };
  }
  return { out: buf, dropped: [] };
}

function files(targets) {
  return targets.flatMap((t) => {
    const p = path.resolve(ROOT, t);
    if (!fs.statSync(p).isDirectory()) return [p];
    return fs.readdirSync(p).filter((f) => /\.(png|webp)$/i.test(f) && !f.endsWith('.raw.png')).map((f) => path.join(p, f));
  });
}

function selfTest() {
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'latin1');
    data.copy(b, 8);
    b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
    return b;
  };
  const ihdr = chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
  const idat = chunk('IDAT', zlib.deflateSync(Buffer.from([0, 1, 2, 3])));
  const clean = Buffer.concat([PNG_SIG, ihdr, idat, chunk('IEND', Buffer.alloc(0))]);
  const dirty = Buffer.concat([PNG_SIG, ihdr, chunk('tEXt', Buffer.from('Software\0x')), chunk('caBX', Buffer.alloc(4)), idat, chunk('eXIf', Buffer.alloc(4)), chunk('IEND', Buffer.alloc(0))]);
  const r = strip(dirty);
  if (!r.out.equals(clean) || r.dropped.join() !== 'tEXt,caBX,eXIf' || strip(clean).dropped.length) throw new Error('PNG strip');
  const riff = (type, data) => Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(Uint32Array.of(data.length).buffer), data, Buffer.alloc(data.length & 1)]);
  const webp = (chunks) => { const body = Buffer.concat(chunks); const h = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'); h.writeUInt32LE(body.length + 4, 4); return Buffer.concat([h, body]); };
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x08 | 0x02;
  const w = strip(webp([riff('VP8X', vp8x), riff('ANIM', Buffer.alloc(6)), riff('EXIF', Buffer.alloc(3))]));
  const want = Buffer.alloc(10); want[0] = 0x02;
  if (!w.out.equals(webp([riff('VP8X', want), riff('ANIM', Buffer.alloc(6))])) || w.dropped.join() !== 'EXIF') throw new Error('WebP strip');
  console.log('strip-metadata self-test: ok');
}

if (import.meta.filename === path.resolve(process.argv[1] ?? '')) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    selfTest();
  } else {
    const check = argv.includes('--check');
    const targets = argv.filter((a) => !a.startsWith('--'));
    const dirty = [];
    for (const f of files(targets.length ? targets : ['docs/screenshots'])) {
      const { out, dropped } = strip(fs.readFileSync(f));
      if (!dropped.length) continue;
      dirty.push(`${path.relative(ROOT, f)}: ${dropped.join(', ')}`);
      if (!check) fs.writeFileSync(f, out);
    }
    if (check && dirty.length) {
      console.error(`image metadata found (run node tools/screenshots/strip-metadata.mjs):\n  ${dirty.join('\n  ')}`);
      process.exit(1);
    }
    console.log(dirty.length ? `stripped:\n  ${dirty.join('\n  ')}` : 'no image metadata');
  }
}
