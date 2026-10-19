// The archive writers the TV packages need, with Node alone (no SDK, no dependency): ZIP for the Tizen .wgt, ustar
// and ar for the webOS .ipk. Fixed timestamps, so the same build packs to the same bytes.
import zlib from 'node:zlib';

// files: [{ name, data: Buffer }]; each entry deflated unless that makes it larger. UTF-8 names.
export function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const crc = zlib.crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(store ? 0 : 8, 8);
    head.writeUInt32LE(0x00210000, 10); // 1980-01-01
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    local.push(head, nameBuf, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(store ? 0 : 8, 10);
    dir.writeUInt32LE(0x00210000, 12);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += head.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, end]);
}

function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

// files: [{ name, data: Buffer, mode? }]; directories are implied by the names (added before their files).
export function tar(files) {
  const blocks = [];
  const dirs = new Set();
  const mtime = Math.floor(Date.UTC(2026, 0, 1) / 1000);
  const header = (name, size, type, mode) => {
    const h = Buffer.alloc(512);
    const n = Buffer.from(name, 'utf8');
    // No ustar prefix field: the app's paths stay well under 100 bytes.
    if (n.length > 100) throw new Error(`tar: path too long: ${name}`);
    n.copy(h, 0);
    h.write(octal(mode, 8), 100, 'ascii');
    h.write(octal(0, 8), 108, 'ascii');
    h.write(octal(0, 8), 116, 'ascii');
    h.write(octal(size, 12), 124, 'ascii');
    h.write(octal(mtime, 12), 136, 'ascii');
    h.write('        ', 148, 'ascii');
    h.write(type, 156, 'ascii');
    h.write('ustar\0', 257, 'ascii');
    h.write('00', 263, 'ascii');
    h.write('root', 265, 'ascii');
    h.write('root', 297, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(octal(sum, 7) + ' ', 148, 'ascii');
    return h;
  };
  for (const f of files) {
    const parts = f.name.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const d = `${parts.slice(0, i).join('/')}/`;
      if (d === './' || dirs.has(d)) continue;
      dirs.add(d);
      blocks.push(header(d, 0, '5', 0o755));
    }
    blocks.push(header(f.name, f.data.length, '0', f.mode ?? 0o644), f.data, Buffer.alloc((512 - (f.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// members: [{ name, data: Buffer }], names of 16 characters at most.
export function ar(members) {
  const out = [Buffer.from('!<arch>\n', 'ascii')];
  for (const m of members) {
    const h = `${m.name.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(m.data.length).padEnd(10)}\`\n`;
    out.push(Buffer.from(h, 'ascii'), m.data);
    if (m.data.length % 2) out.push(Buffer.from('\n'));
  }
  return Buffer.concat(out);
}
