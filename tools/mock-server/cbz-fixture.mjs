// Test fixtures for the comic reader: a tiny PNG encoder and ZIP writer, shared
// by tools/mock-server/mock-emby.mjs (generated CBZ books) and tools/checks/zip-check.mjs.
import zlib from 'node:zlib';

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

// pixel(x, y) -> [r, g, b]; truecolour, no alpha, filter 0 on every row.
export function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// entries: [{ name, data, store? }]. zip64 forces ZIP64 records (for the self-check).
export function zip(entries, { zip64 = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const body = e.store ? e.data : zlib.deflateRawSync(e.data);
    const method = e.store ? 0 : 8;
    const crc = zlib.crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(e.data.length), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(zip64 ? 45 : 20, 4);
    c.writeUInt16LE(zip64 ? 45 : 20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(zip64 ? 0xffffffff : body.length, 20);
    c.writeUInt32LE(zip64 ? 0xffffffff : e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    centrals.push(c, name, extra);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const tail = [];
  if (zip64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12);
    z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(entries.length), 24);
    z.writeBigUInt64LE(BigInt(entries.length), 32);
    z.writeBigUInt64LE(BigInt(cd.length), 40);
    z.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(z, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...locals, cd, ...tail, end]);
}

// Roku BIF trick-play file: images[i] is shown from i * intervalMs (multiplier = intervalMs).
export function bif(images, intervalMs = 10_000) {
  const head = Buffer.alloc(64);
  head.set([0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);
  head.writeUInt32LE(0, 8);
  head.writeUInt32LE(images.length, 12);
  head.writeUInt32LE(intervalMs, 16);
  const index = Buffer.alloc((images.length + 1) * 8);
  let offset = 64 + index.length;
  images.forEach((img, i) => {
    index.writeUInt32LE(i, i * 8);
    index.writeUInt32LE(offset, i * 8 + 4);
    offset += img.length;
  });
  index.writeUInt32LE(0xffffffff, images.length * 8);
  index.writeUInt32LE(offset, images.length * 8 + 4);
  return Buffer.concat([head, index, ...images]);
}

// A comic page: flat colour panels with a big page number drawn as 5x7 pixel digits,
// so screenshots show at a glance which page is on screen.
const DIGITS = ['01110100011001110101110011000101110', '00100011000010000100001000010001110', '01110100010000100010001000100011111', '11111000100010000010000011000101110', '00010001100101010010111110001000010', '11111100001111000001000011000101110', '00110010001000011110100011000101110', '11111000010001000100010000100001000', '01110100011000101110100011000101110', '01110100011000101111000010001001100'];
export function comicPage(n, hue, width = 600, height = 900) {
  const label = String(n);
  const scale = 16;
  const textW = label.length * 6 * scale;
  const ox = Math.floor((width - textW) / 2);
  const oy = Math.floor(height / 2 - 3.5 * scale);
  const [r, g, b] = hue;
  return png(width, height, (x, y) => {
    const border = x < 24 || y < 24 || x >= width - 24 || y >= height - 24;
    if (border) return [245, 242, 235];
    const gutter = (y > height / 3 - 6 && y < height / 3 + 6) || (y > (height * 2) / 3 - 6 && y < (height * 2) / 3 + 6) || (y < height / 3 && x > width / 2 - 6 && x < width / 2 + 6);
    if (gutter) return [245, 242, 235];
    const dx = x - ox;
    const dy = y - oy;
    if (dx >= 0 && dy >= 0 && dx < textW && dy < 7 * scale) {
      const d = Math.floor(dx / (6 * scale));
      const cx = Math.floor((dx % (6 * scale)) / scale);
      const cy = Math.floor(dy / scale);
      if (cx < 5 && DIGITS[Number(label[d])][cy * 5 + cx] === '1') return [20, 20, 24];
    }
    const shade = 0.75 + 0.25 * Math.sin((x + y) / 40);
    return [Math.round(r * shade), Math.round(g * shade), Math.round(b * shade)];
  });
}
