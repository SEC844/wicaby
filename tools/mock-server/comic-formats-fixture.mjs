// Comic fixtures in the formats other than CBZ (tools/checks/comic-formats-check.mjs, the mock servers' COMICS).
// All uncompressed and written here from the public format notes: RAR from RARLAB's technote (store method,
// so nothing of the RAR compressor), 7z from 7zFormat.txt (Copy coder), PDF with the PNG predictor.
import zlib from 'node:zlib';
import { zip } from './cbz-fixture.mjs';

const tarField = (s, len) => Buffer.from(String(s).padEnd(len, '\0').slice(0, len), 'latin1');

// entries: [{ name, data }] -> ustar archive.
export function tar(entries) {
  const out = [];
  for (const e of entries) {
    const h = Buffer.concat([
      tarField(e.name, 100), tarField('0000644', 8), tarField('0000000', 8), tarField('0000000', 8),
      tarField(e.data.length.toString(8).padStart(11, '0'), 12), tarField('14700000000', 12), Buffer.from('        '),
      Buffer.from('0'), Buffer.alloc(100), tarField('ustar', 6), Buffer.from('00'), Buffer.alloc(247),
    ]);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    out.push(h, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  return Buffer.concat([...out, Buffer.alloc(1024)]);
}

function vint(n) {
  const b = [];
  do {
    b.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n = Math.floor(n / 128);
  } while (n > 0);
  return Buffer.from(b);
}

// RAR 5.0, store method. encrypted: each file header carries an encryption record (the data is not really encrypted).
// size: the unpacked size written in the header (a forged one for the size caps), else the real one.
export function rar5(entries, { encrypted = false } = {}) {
  const block = (body, data = Buffer.alloc(0)) => {
    const sized = Buffer.concat([vint(body.length), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(zlib.crc32(sized) >>> 0);
    return Buffer.concat([crc, sized, data]);
  };
  const out = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]), block(Buffer.concat([vint(1), vint(0), vint(0)]))];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(zlib.crc32(e.data) >>> 0);
    // Encryption record: type 1, version 0, flags 0, KDF count, 16-byte salt, 16-byte IV.
    const rec = Buffer.concat([vint(1), vint(0), vint(0), Buffer.from([15]), Buffer.alloc(32, 7)]);
    const extra = encrypted ? Buffer.concat([vint(rec.length), rec]) : Buffer.alloc(0);
    const flags = 0x02 | (extra.length ? 0x01 : 0);
    const head = [vint(2), vint(flags), ...(extra.length ? [vint(extra.length)] : []), vint(e.data.length)];
    out.push(block(Buffer.concat([...head, vint(0x04), vint(e.size ?? e.data.length), vint(0x20), crc, vint(0), vint(0), vint(name.length), name, extra]), e.data));
  }
  out.push(block(Buffer.concat([vint(5), vint(0), vint(0)])));
  return Buffer.concat(out);
}

// RAR 1.5-4.x, store method (METHOD 0x30).
export function rar4(entries) {
  const head = (type, flags, rest) => {
    const h = Buffer.alloc(7);
    h[2] = type;
    h.writeUInt16LE(flags, 3);
    h.writeUInt16LE(7 + rest.length, 5);
    const all = Buffer.concat([h, rest]);
    all.writeUInt16LE(zlib.crc32(all.subarray(2)) & 0xffff, 0);
    return all;
  };
  const out = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]), head(0x73, 0, Buffer.alloc(6))];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'latin1');
    const f = Buffer.alloc(25);
    f.writeUInt32LE(e.data.length, 0);
    f.writeUInt32LE(e.data.length, 4);
    f[8] = 2; // Win32
    f.writeUInt32LE(zlib.crc32(e.data) >>> 0, 9);
    f.writeUInt32LE(0x5a210000, 13); // 2025-01-01 as a DOS date
    f[17] = 29;
    f[18] = 0x30;
    f.writeUInt16LE(name.length, 19);
    f.writeUInt32LE(0x20, 21);
    out.push(head(0x74, 0x8000, Buffer.concat([f, name])), e.data);
  }
  out.push(head(0x7b, 0x4000, Buffer.alloc(0)));
  return Buffer.concat(out);
}

// 7z number: n leading 1 bits in the first byte = n more little-endian bytes, the first byte's low bits on top.
function num7z(v) {
  for (let n = 0; n < 8; n++) {
    if (v < 2 ** (7 * (n + 1))) {
      const rest = Buffer.alloc(n);
      for (let i = 0; i < n; i++) rest[i] = Math.floor(v / 2 ** (8 * i)) & 0xff;
      return Buffer.concat([Buffer.from([((0xff00 >> n) & 0xff) | Math.floor(v / 2 ** (8 * n))]), rest]);
    }
  }
  throw new Error('7z number too large');
}

// 7z, one Copy-coder folder per file, plain (uncompressed) header.
export function sevenZip(entries) {
  const n = entries.length;
  const b = (...bytes) => Buffer.from(bytes);
  const names = Buffer.concat(entries.map((e) => Buffer.from(`${e.name}\0`, 'utf16le')));
  const header = Buffer.concat([
    b(0x01, 0x04),
    b(0x06), num7z(0), num7z(n), b(0x09), ...entries.map((e) => num7z(e.data.length)), b(0x00),
    b(0x07, 0x0b), num7z(n), b(0x00), ...entries.map(() => b(0x01, 0x01, 0x00)), b(0x0c), ...entries.map((e) => num7z(e.data.length)), b(0x00),
    // SubStreamsInfo, all defaults (one stream per folder): libarchive wants it present.
    b(0x08, 0x00),
    b(0x00),
    b(0x05), num7z(n), b(0x11), num7z(names.length + 1), b(0x00), names, b(0x00),
    b(0x00),
  ]);
  const packed = Buffer.concat(entries.map((e) => e.data));
  const start = Buffer.alloc(20);
  start.writeBigUInt64LE(BigInt(packed.length), 0);
  start.writeBigUInt64LE(BigInt(header.length), 8);
  start.writeUInt32LE(zlib.crc32(header) >>> 0, 16);
  const sig = Buffer.alloc(12);
  sig.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]);
  sig.writeUInt32LE(zlib.crc32(start) >>> 0, 8);
  return Buffer.concat([sig, start, packed, header]);
}

// The IDAT stream of a png() image is a valid PDF Flate image with the PNG predictor.
function pngParts(p) {
  const idat = [];
  for (let o = 8; o < p.length; ) {
    const len = p.readUInt32BE(o);
    if (p.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(p.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  return { w: p.readUInt32BE(16), h: p.readUInt32BE(20), data: Buffer.concat(idat) };
}

// pages: png() buffers, one per page at its own size (1 px = 1 pt). Classic xref table, no object streams.
export function pdf(pages, title = 'Planches') {
  const objs = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), null, Buffer.from(`<< /Title (${title}) /Producer (wicaby fixture) >>`)];
  const add = (body) => objs.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
  const kids = [];
  for (const p of pages) {
    const { w, h, data } = pngParts(p);
    const img = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${w} >> /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]));
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    const content = add(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`, 'latin1');
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let at = parts[0].length;
  const offsets = objs.map((o, i) => {
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(obj);
    at += obj.length;
    return at - obj.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  return Buffer.concat([...parts, Buffer.from(xref, 'latin1')]);
}

// EPUB 3. pages: png() buffers, one fixed-layout XHTML page each; text: a novel-like book with no image at all;
// drm: META-INF/encryption.xml lists the page images, as a DRM'd store book does.
export function epub(pages, { title = 'Planches', text = false, drm = false } = {}) {
  const items = text ? ['Chapitre 1', 'Chapitre 2', 'Chapitre 3'] : pages;
  const xhtml = (body) => `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`;
  const files = [
    { name: 'mimetype', data: Buffer.from('application/epub+zip'), store: true },
    { name: 'META-INF/container.xml', data: Buffer.from('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>') },
  ];
  const manifest = [];
  const spine = [];
  items.forEach((it, i) => {
    const n = String(i + 1).padStart(3, '0');
    // Images are named in reverse reading order on purpose: the spine, not the names, gives the order.
    const img = `images/${String(items.length - i).padStart(3, '0')}.png`;
    if (text) {
      files.push({ name: `OEBPS/text/c${n}.xhtml`, data: Buffer.from(xhtml(`<h1>${it}</h1><p>${'Il était une fois une carte sans territoire. '.repeat(40)}</p>`)) });
    } else {
      files.push({ name: `OEBPS/${img}`, data: it, store: true });
      // Page 1 is wrapped in SVG, as fixed-layout converters write it; the others are plain <img>.
      const body = i === 0 ? `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 600 900"><image width="600" height="900" xlink:href="../${img}"/></svg>` : `<img src="../${img}" alt=""/>`;
      files.push({ name: `OEBPS/text/p${n}.xhtml`, data: Buffer.from(xhtml(body)) });
      manifest.push(`<item id="img${n}" href="${img}" media-type="image/png"${i === 0 ? ' properties="cover-image"' : ''}/>`);
    }
    manifest.push(`<item id="x${n}" href="text/${text ? 'c' : 'p'}${n}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="x${n}"/>`);
  });
  if (drm) files.push({ name: 'META-INF/encryption.xml', data: Buffer.from(`<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">${manifest.filter((m) => m.includes('image/png')).map((m) => `<EncryptedData><CipherData><CipherReference URI="OEBPS/${/href="([^"]+)"/.exec(m)[1]}"/></CipherData></EncryptedData>`).join('')}</encryption>`) });
  files.push({
    name: 'OEBPS/content.opf',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:wicaby-fixture</dc:identifier><dc:title>${title}</dc:title>${text ? '' : '<meta property="rendition:layout">pre-paginated</meta>'}</metadata><manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`),
  });
  return zip(files);
}
