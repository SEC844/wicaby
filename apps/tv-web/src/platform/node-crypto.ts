// The one node:crypto call the shared code needs on a TV: createHash('md5') for Last.fm's api_sig (the desktop's
// main/features/scrobble-client.ts). Vite resolves `node:crypto` here (vite.config.ts); the TV engines have no MD5 in
// SubtleCrypto. RFC 1321 over the UTF-8 bytes.
const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const n = (((bytes.length + 8) >>> 6) + 1) * 16;
  const words = new Uint32Array(n);
  for (let i = 0; i < bytes.length; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  words[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
  words[n - 2] = (bytes.length * 8) >>> 0;
  words[n - 1] = Math.floor(bytes.length / 0x20000000);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let o = 0; o < n; o += 16) {
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      const r = i >> 4;
      const f = r === 0 ? (b & c) | (~b & d) : r === 1 ? (d & b) | (~d & c) : r === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const g = r === 0 ? i : r === 1 ? (5 * i + 1) % 16 : r === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
      const x = (a + f + K[i] + words[o + g]) >>> 0;
      const s = S[r * 4 + (i % 4)];
      [a, d, c] = [d, c, b];
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
    }
    [a0, b0, c0, d0] = [(a0 + a) >>> 0, (b0 + b) >>> 0, (c0 + c) >>> 0, (d0 + d) >>> 0];
  }
  return [a0, b0, c0, d0].map((w) => [0, 8, 16, 24].map((sh) => ((w >>> sh) & 0xff).toString(16).padStart(2, '0')).join('')).join('');
}

export function createHash(algorithm: string) {
  if (algorithm !== 'md5') throw new Error(`createHash: ${algorithm} is not available on a TV`);
  let data = '';
  const hash = {
    update(s: string, _encoding?: 'utf8') {
      data += s;
      return hash;
    },
    digest(encoding: 'hex') {
      if (encoding !== 'hex') throw new Error('createHash: hex digests only');
      return md5(data);
    },
  };
  return hash;
}
