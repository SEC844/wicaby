// mDNS hint (file-sources-spec FS-07, §6.2): the pure parser decodes the answers in fixtures/files/mdns (WebDAV
// with path= and u=, SMB, a truncated packet, a compression loop), and a loopback round trip (this check answers
// its own query on 127.0.0.1, never the network) lists 1 service within 2.5 s.
// The fixtures are answers in the shape NAS responders send (PTR answer; SRV, TXT and A additional, compressed
// names), built by encode() below with example names. Rebuild them: node tools/checks/files-mdns-check.mjs --record
// Usage: node tools/checks/files-mdns-check.mjs
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { bundleFiles, quiet } from './files-bundle.mjs';

const F = await bundleFiles();
const dir = path.join(import.meta.dirname, 'fixtures', 'files', 'mdns');
let passed = 0;
const ok = (c, m) => (assert.ok(c, m), passed++);

// A response: header, then each record (name, type, class IN with cache-flush, TTL, data). A name already
// written is a compression pointer, as responders do.
function encode(records) {
  const out = [Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, records.length - 1])];
  let size = 12;
  const seen = new Map();
  const name = (n) => {
    if (seen.has(n)) return Buffer.from([0xc0 | (seen.get(n) >> 8), seen.get(n) & 0xff]);
    seen.set(n, size);
    return F.encodeName(n);
  };
  // size is always the offset name() writes at.
  for (const r of records) {
    const head = name(r.name);
    size += head.length + 10;
    let data;
    if (r.type === 12) data = name(r.ptr);
    else if (r.type === 33) {
      size += 6;
      data = Buffer.concat([Buffer.from([0, 0, 0, 0, r.port >> 8, r.port & 0xff]), name(r.target)]);
      size -= 6;
    } else if (r.type === 16) data = Buffer.concat(r.txt.map((t) => Buffer.concat([Buffer.from([Buffer.byteLength(t)]), Buffer.from(t)])));
    else data = Buffer.from(r.a.split('.').map(Number));
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(r.type, 0);
    fixed.writeUInt16BE(r.type === 12 ? 1 : 0x8001, 2);
    fixed.writeUInt32BE(120, 4);
    fixed.writeUInt16BE(data.length, 8);
    out.push(head, fixed, data);
    size += data.length;
  }
  return Buffer.concat(out);
}

const webdav = encode([
  { name: '_webdavs._tcp.local', type: 12, ptr: 'Example NAS._webdavs._tcp.local' },
  { name: 'Example NAS._webdavs._tcp.local', type: 33, port: 5006, target: 'storage.local' },
  { name: 'Example NAS._webdavs._tcp.local', type: 16, txt: ['path=/media', 'u=example'] },
  { name: 'storage.local', type: 1, a: '192.0.2.20' },
]);
const smb = encode([
  { name: '_smb._tcp.local', type: 12, ptr: 'Example Share._smb._tcp.local' },
  { name: 'Example Share._smb._tcp.local', type: 33, port: 445, target: 'storage.local' },
  { name: 'storage.local', type: 1, a: '192.0.2.20' },
]);
// A pointer to itself where the PTR data should be.
const loop = Buffer.from(webdav);
const ptrData = 12 + F.encodeName('_webdavs._tcp.local').length + 10;
loop.writeUInt16BE(0xc000 | ptrData, ptrData);
const fixtures = { 'webdav.bin': webdav, 'smb.bin': smb, 'truncated.bin': webdav.subarray(0, webdav.length - 9), 'loop.bin': loop };
if (process.argv.includes('--record')) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, b] of Object.entries(fixtures)) fs.writeFileSync(path.join(dir, f), b);
}
const read = (f) => fs.readFileSync(path.join(dir, f));
for (const [f, b] of Object.entries(fixtures)) ok(read(f).equals(b), `${f} is what encode() builds (re-record with --record)`);

// ---- the parser ----
const dav = F.servicesOf(F.parsePacket(read('webdav.bin')));
ok(dav.length === 1 && dav[0].protocol === 'webdav' && dav[0].url === 'https://storage.local:5006/media' && dav[0].user === 'example' && dav[0].name === 'Example NAS', `WebDAV with path= and u= (${JSON.stringify(dav)})`);
const share = F.servicesOf(F.parsePacket(read('smb.bin')));
ok(share.length === 1 && share[0].protocol === 'smb' && share[0].url === '\\\\storage.local\\' && share[0].name === 'Example Share', `SMB: the host, the user types the share (${JSON.stringify(share)})`);
ok(F.parsePacket(read('truncated.bin')) === null, 'a truncated packet is refused');
ok(F.parsePacket(read('loop.bin')) === null, 'a compression loop is refused');
ok(F.parsePacket(Buffer.alloc(0)) === null && F.parsePacket(Buffer.from(F.buildQuery())) === null, 'empty data and a query (no response bit) are refused');
for (let n = 0; n < webdav.length; n++) F.parsePacket(webdav.subarray(0, n));
passed++;
const q = F.buildQuery();
ok(q.readUInt16BE(4) === 3 && q.includes(F.encodeName('_webdav._tcp.local')) && q.includes(Buffer.from([0, 12, 0x80, 1])), 'the query: 3 PTR questions with the QU bit');

// ---- loopback round trip: this check is the responder ----
const responder = dgram.createSocket('udp4');
let asked = null;
responder.on('message', (msg, rinfo) => {
  asked = msg;
  responder.send(read('webdav.bin'), rinfo.port, rinfo.address);
  responder.send(Buffer.from('not dns'), rinfo.port, rinfo.address);
});
await new Promise((r) => responder.bind(0, '127.0.0.1', r));
const t0 = Date.now();
const found = await quiet(() => F.discover({ address: '127.0.0.1', port: responder.address().port }, 2500));
const ms = Date.now() - t0;
responder.close();
ok(asked?.equals(q), 'the responder got the query');
ok(found.length === 1 && found[0].url === 'https://storage.local:5006/media' && ms < 3000, `loopback: 1 service within 2.5 s (${ms} ms)`);
console.log(`files-mdns-check: ok (${passed} checks)`);
