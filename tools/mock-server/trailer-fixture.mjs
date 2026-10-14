// A local trailer no Android decoder plays: Matroska with a VC-1 video track (WVC1 FourCC, a sequence header and
// frames of zeros) and silent 8 kHz PCM. ExoPlayer parses it, finds no VC-1 decoder and leaves the video out without
// an error: the sound plays over black, the 0.10.2 TV bug. mock-emby direct-plays trailer-3 from it; the server's
// conversion (not static) is the mock's normal video. Generated, nothing to download.

// EBML: an element id (its bytes as written), a size as an 8-byte vint, the payload.
const el = (id, ...parts) => {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(body.length) | (1n << 56n));
  return Buffer.concat([Buffer.from(id.toString(16).padStart(id > 0xffffff ? 8 : id > 0xffff ? 6 : id > 0xff ? 4 : 2, '0'), 'hex'), size, body]);
};
const uint = (id, v) => el(id, Buffer.from([v >> 24, v >> 16, v >> 8, v].map((b) => b & 0xff)));
const str = (id, s) => el(id, Buffer.from(s, 'ascii'));
const float = (id, v) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return el(id, b);
};

export function vc1Trailer(seconds = 30) {
  // BITMAPINFOHEADER (40 bytes, compression WVC1), then the VC-1 sequence header start code ExoPlayer looks for.
  const bih = Buffer.alloc(40);
  bih.writeUInt32LE(40, 0);
  bih.writeInt32LE(1920, 4);
  bih.writeInt32LE(1080, 8);
  bih.writeUInt16LE(1, 12);
  bih.writeUInt16LE(24, 14);
  bih.write('WVC1', 16, 'ascii');
  const priv = Buffer.concat([bih, Buffer.from([0, 0, 1, 0x0f, 0xdb, 0xfe, 0x3b, 0xf2, 0x1b, 0xca, 0x3f, 0x80, 0, 0, 1, 0x0e])]);
  const header = el(0x1a45dfa3, uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(0x4282, 'matroska'), uint(0x4287, 4), uint(0x4285, 2));
  const info = el(0x1549a966, uint(0x2ad7b1, 1_000_000), float(0x4489, seconds * 1000), str(0x4d80, 'wicaby-mock'), str(0x5741, 'wicaby-mock'));
  const tracks = el(
    0x1654ae6b,
    el(0xae, uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1), str(0x86, 'V_MS/VFW/FOURCC'), el(0x63a2, priv), el(0xe0, uint(0xb0, 1920), uint(0xba, 1080))),
    el(0xae, uint(0xd7, 2), uint(0x73c5, 2), uint(0x83, 2), str(0x86, 'A_PCM/INT/LIT'), el(0xe1, float(0xb5, 8000), uint(0x9f, 1), uint(0x6264, 16))),
  );
  // One cluster a second: 10 video frames and 10 blocks of 100 ms of silence.
  const block = (track, rel, data) => {
    const h = Buffer.from([0x80 | track, (rel >> 8) & 0xff, rel & 0xff, 0x80]);
    return el(0xa3, h, data);
  };
  const frame = Buffer.concat([Buffer.from([0, 0, 1, 0x0d]), Buffer.alloc(256)]);
  const pcm = Buffer.alloc(1600);
  const clusters = [];
  for (let s = 0; s < seconds; s++) {
    const blocks = [];
    for (let i = 0; i < 10; i++) blocks.push(block(1, i * 100, frame), block(2, i * 100, pcm));
    clusters.push(el(0x1f43b675, uint(0xe7, s * 1000), ...blocks));
  }
  return Buffer.concat([header, el(0x18538067, info, tracks, ...clusters)]);
}
