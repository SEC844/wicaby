// TP-10: a saved profile's 4-digit PIN (core Profiles.kt Pin), stored as "salt:hash" in hex, PBKDF2-HMAC-SHA1 with
// 20,000 rounds as on Android. The engine's own PBKDF2 when it has one (SubtleCrypto), else the same derivation in
// JavaScript. shortcut: 10^4 PINs stay brute-forceable from the TV's storage; it is a household lock, not a secret.
export const PIN_LENGTH = 4;
const ROUNDS = 20_000;
// Wrong PINs in a row allowed at once; then each further try waits 30 s, doubling, at most 1 h.
const FREE_TRIES = 5;

export const validPin = (pin: string): boolean => pin.length === PIN_LENGTH && /^\d+$/.test(pin);

export const pinWaitMs = (fails: number): number => (fails < FREE_TRIES ? 0 : Math.min(30_000 * 2 ** Math.min(fails - FREE_TRIES, 7), 3_600_000));

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function unhex(s: string): Uint8Array | null {
  if (!s || s.length % 2 || !/^[0-9a-f]+$/i.test(s)) return null;
  return Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16));
}

// SHA-1 of the bytes (FIPS 180-4), for the fallback.
function sha1(data: Uint8Array): Uint8Array {
  const n = ((data.length + 8) >> 6) + 1;
  const w = new Uint32Array(n * 16);
  for (let i = 0; i < data.length; i++) w[i >> 2] |= data[i] << (24 - (i % 4) * 8);
  w[data.length >> 2] |= 0x80 << (24 - (data.length % 4) * 8);
  w[n * 16 - 1] = data.length * 8;
  let [a0, b0, c0, d0, e0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const m = new Uint32Array(80);
  for (let o = 0; o < w.length; o += 16) {
    for (let i = 0; i < 80; i++) m[i] = i < 16 ? w[o + i] : ((m[i - 3] ^ m[i - 8] ^ m[i - 14] ^ m[i - 16]) << 1) | ((m[i - 3] ^ m[i - 8] ^ m[i - 14] ^ m[i - 16]) >>> 31);
    let [a, b, c, d, e] = [a0, b0, c0, d0, e0];
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + m[i]) >>> 0;
      [e, d, c, b, a] = [d, c, ((b << 30) | (b >>> 2)) >>> 0, a, t];
    }
    [a0, b0, c0, d0, e0] = [(a0 + a) >>> 0, (b0 + b) >>> 0, (c0 + c) >>> 0, (d0 + d) >>> 0, (e0 + e) >>> 0];
  }
  const out = new Uint8Array(20);
  [a0, b0, c0, d0, e0].forEach((v, i) => out.set([v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff], i * 4));
  return out;
}

function hmac(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha1(key) : key);
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(84);
  for (let i = 0; i < 64; i++) {
    inner[i] = k[i] ^ 0x36;
    outer[i] = k[i] ^ 0x5c;
  }
  inner.set(msg, 64);
  outer.set(sha1(inner), 64);
  return sha1(outer);
}

function pbkdf2Js(pin: Uint8Array, salt: Uint8Array, rounds: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let block = 1, at = 0; at < bytes; block++, at += 20) {
    const s = new Uint8Array(salt.length + 4);
    s.set(salt);
    s.set([block >>> 24, (block >>> 16) & 0xff, (block >>> 8) & 0xff, block & 0xff], salt.length);
    let u = hmac(pin, s);
    const t = u.slice();
    for (let r = 1; r < rounds; r++) {
      u = hmac(pin, u);
      for (let i = 0; i < 20; i++) t[i] ^= u[i];
    }
    out.set(t.subarray(0, Math.min(20, bytes - at)), at);
  }
  return out;
}

async function derive(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(pin);
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (subtle) {
    try {
      const key = await subtle.importKey('raw', bytes as BufferSource, 'PBKDF2', false, ['deriveBits']);
      return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-1', salt: salt as BufferSource, iterations: ROUNDS }, key, 256));
    } catch {
      // No PBKDF2 in this engine (or not here): the same derivation in JavaScript.
    }
  }
  return pbkdf2Js(bytes, salt, ROUNDS, 32);
}

export async function hashPin(pin: string): Promise<string> {
  if (!validPin(pin)) throw new Error(`PIN must be ${PIN_LENGTH} digits`);
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return `${hex(salt)}:${hex(await derive(pin, salt))}`;
}

export async function pinMatches(pin: string, stored: string | undefined): Promise<boolean> {
  const [s, h] = stored?.split(':') ?? [];
  const salt = unhex(s ?? '');
  const want = unhex(h ?? '');
  if (!salt || !want || !validPin(pin)) return false;
  const got = await derive(pin, salt);
  let diff = got.length ^ want.length;
  for (let i = 0; i < Math.min(got.length, want.length); i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

// Exported for tools/checks/tv-web-check.mjs: the JavaScript derivation against Node's.
export const pbkdf2Sha1 = pbkdf2Js;
