// "What's this song?": the Shazam audio signature and the reading of its answer, shared by main and the renderer.
// Ported from SongRec (Marin M., GPL-3.0, github.com/marin-m/SongRec, python-version/fingerprinting/algorithm.py and
// signature_format.py), itself a reimplementation of Shazam's own fingerprinting. The Kotlin twin is
// core/songid/ShazamSignature.kt; both run tools/checks/fixtures/song-id/signature.json.

export const SAMPLE_RATE = 16_000;
// What one recognition sends: 12 s of 16 kHz mono, as SongRec does.
export const SNIPPET_MS = 12_000;

interface Peak {
  pass: number;
  magnitude: number;
  bin: number;
}

// numpy.hanning(2050)[1:-1]: the window without its zero ends.
const HANNING = Float64Array.from({ length: 2048 }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / 2049));

// In-place radix-2 FFT of 2048 points.
const COS = Float64Array.from({ length: 1024 }, (_, i) => Math.cos((-2 * Math.PI * i) / 2048));
const SIN = Float64Array.from({ length: 1024 }, (_, i) => Math.sin((-2 * Math.PI * i) / 2048));
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = COS[k * step], wi = SIN[k * step];
        const a = i + k, b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

// 0..3: 250-520 Hz, 520-1450 Hz, 1450-3500 Hz, 3500-5500 Hz; -1 outside.
function bandOf(hz: number): number {
  if (hz < 250) return -1;
  if (hz < 520) return 0;
  if (hz < 1450) return 1;
  if (hz < 3500) return 2;
  return hz <= 5500 ? 3 : -1;
}

const magnitudeOf = (v: number) => Math.log(Math.max(1 / 64, v)) * 1477.3 + 6144;

// Signed 16-bit 16 kHz mono samples -> the peaks per band (SongRec SignatureGenerator.process_input).
function peaksOf(samples: Int16Array): Peak[][] {
  const bands: Peak[][] = [[], [], [], []];
  const ring = new Int16Array(2048);
  let ringPos = 0;
  const ffts = Array.from({ length: 256 }, () => new Float64Array(1025));
  const spread = Array.from({ length: 256 }, () => new Float64Array(1025));
  let fftPos = 0, spreadPos = 0, written = 0;
  const re = new Float64Array(2048), im = new Float64Array(2048);
  const at = (pos: number, off: number) => (((pos + off) % 256) + 256) % 256;

  for (let chunk = 0; chunk + 128 <= samples.length; chunk += 128) {
    ring.set(samples.subarray(chunk, chunk + 128), ringPos);
    ringPos = (ringPos + 128) & 2047;
    for (let i = 0; i < 2048; i++) {
      re[i] = ring[(ringPos + i) & 2047] * HANNING[i];
      im[i] = 0;
    }
    fft(re, im);
    const out = ffts[fftPos];
    for (let i = 0; i < 1025; i++) out[i] = Math.max((re[i] * re[i] + im[i] * im[i]) / (1 << 17), 1e-10);
    fftPos = (fftPos + 1) % 256;

    // Peak spreading: over frequency (max of 3 bins), then into the 1st, 3rd and 6th previous outputs.
    const s = spread[spreadPos];
    s.set(out);
    for (let p = 0; p < 1025; p++) {
      if (p < 1023) s[p] = Math.max(s[p], s[p + 1], s[p + 2]);
      let max = s[p];
      for (const back of [-1, -3, -6]) {
        const former = spread[at(spreadPos, back)];
        former[p] = max = Math.max(former[p], max);
      }
    }
    spreadPos = (spreadPos + 1) % 256;
    written++;
    if (written < 46) continue;

    // Peak recognition on the output 46 passes back.
    const f46 = ffts[at(fftPos, -46)];
    const s49 = spread[at(spreadPos, -49)];
    for (let bin = 10; bin < 1015; bin++) {
      const v = f46[bin];
      if (v < 1 / 64 || v < s49[bin - 1]) continue;
      let neighbours = 0;
      for (const off of [-10, -7, -4, -3, 1, 2, 5, 8]) neighbours = Math.max(neighbours, s49[bin + off]);
      if (v <= neighbours) continue;
      for (const off of [-53, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249]) neighbours = Math.max(neighbours, spread[at(spreadPos, off)][bin - 1]);
      if (v <= neighbours) continue;
      const mag = magnitudeOf(v), before = magnitudeOf(f46[bin - 1]), after = magnitudeOf(f46[bin + 1]);
      const corrected = bin * 64 + ((after - before) * 32) / (mag * 2 - before - after);
      const band = bandOf(corrected * (SAMPLE_RATE / 2 / 1024 / 64));
      if (band >= 0) bands[band].push({ pass: written - 46, magnitude: Math.trunc(mag), bin: Math.trunc(corrected) });
    }
  }
  return bands;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// The binary signature (SongRec DecodedMessage.encode_to_binary): a 48-byte header, then one TLV per band.
function encode(bands: Peak[][], sampleCount: number): Uint8Array {
  const body: number[] = [];
  const u32 = (out: number[], v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  bands.forEach((peaks, band) => {
    if (!peaks.length) return;
    const buf: number[] = [];
    let pass = 0;
    for (const p of peaks) {
      if (p.pass - pass >= 255) {
        buf.push(0xff);
        u32(buf, p.pass);
        pass = p.pass;
      }
      buf.push(p.pass - pass, p.magnitude & 0xff, (p.magnitude >> 8) & 0xff, p.bin & 0xff, (p.bin >> 8) & 0xff);
      pass = p.pass;
    }
    u32(body, 0x60030040 + band);
    u32(body, buf.length);
    body.push(...buf, ...new Array((4 - (buf.length % 4)) % 4).fill(0));
  });
  const out: number[] = [];
  // magic1, crc32 (below), size minus header, magic2, 3 void, sample rate id 3 (16 kHz) << 27, 2 void,
  // samples + 0.24 s, a fixed value; then the 0x40000000 chunk that repeats the size.
  for (const v of [0xcafe2580, 0, body.length + 8, 0x94119c00, 0, 0, 0, 3 << 27, 0, 0, sampleCount + Math.round(SAMPLE_RATE * 0.24), (15 << 19) + 0x40000, 0x40000000, body.length + 8]) u32(out, v);
  const bytes = Uint8Array.from([...out, ...body]);
  const crc = crc32(bytes.subarray(8));
  bytes.set([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24], 4);
  return bytes;
}

// 16 kHz mono s16 PCM -> the data: URI the discovery endpoint takes.
export function shazamSignature(samples: Int16Array): { uri: string; sampleMs: number; peaks: number } {
  const bands = peaksOf(samples);
  let bin = '';
  for (const b of encode(bands, samples.length)) bin += String.fromCharCode(b);
  return { uri: `data:audio/vnd.shazam.sig;base64,${btoa(bin)}`, sampleMs: Math.trunc((samples.length / SAMPLE_RATE) * 1000), peaks: bands.reduce((n, b) => n + b.length, 0) };
}

// The stretch of mpv's demuxer cache to send, in ms of player time: mostly what was just heard (10 s back, 2 s
// ahead), slid and cut to the cached range holding the position. Null when less than 4 s is cached there.
export function snippetWindow(positionMs: number, ranges: readonly (readonly [number, number])[]): [number, number] | null {
  const r = ranges.find(([a, b]) => a <= positionMs && positionMs <= b);
  if (!r) return null;
  const start = Math.max(r[0], Math.min(positionMs - 10_000, r[1] - SNIPPET_MS));
  const end = Math.min(r[1], start + SNIPPET_MS);
  return end - start >= 4_000 ? [start, end] : null;
}

export interface SongMatch {
  title: string;
  artist: string;
  album?: string;
  // https from Shazam; main hands the renderer a data: URL (its CSP loads no remote image).
  coverUrl?: string;
  shazamUrl?: string;
}

// The parts of a discovery answer the card shows; null when nothing matched.
export function songFromShazam(json: unknown): SongMatch | null {
  const track = (json as { track?: Record<string, unknown> } | null)?.track;
  if (!track || typeof track.title !== 'string') return null;
  const images = (track.images ?? {}) as Record<string, unknown>;
  const sections = (Array.isArray(track.sections) ? track.sections : []) as { type?: string; metadata?: { title?: string; text?: string }[] }[];
  const album = sections.find((s) => s.type === 'SONG')?.metadata?.find((m) => m.title === 'Album')?.text;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const https = (v: unknown) => (typeof v === 'string' && v.startsWith('https://') ? v : undefined);
  return {
    title: track.title,
    artist: str(track.subtitle) ?? '',
    album: str(album),
    coverUrl: https(images.coverart) ?? https(images.coverarthq),
    shazamUrl: https(track.url),
  };
}

// Search links on the big services: no account, no API, the user's browser does the rest.
export function songLinks(song: Pick<SongMatch, 'title' | 'artist' | 'shazamUrl'>): { id: 'shazam' | 'spotify' | 'youtube' | 'apple'; url: string }[] {
  const q = encodeURIComponent(`${song.artist} ${song.title}`.trim());
  return [
    { id: 'shazam', url: song.shazamUrl ?? `https://www.shazam.com/search?term=${q}` },
    { id: 'spotify', url: `https://open.spotify.com/search/${q}` },
    { id: 'youtube', url: `https://www.youtube.com/results?search_query=${q}` },
    { id: 'apple', url: `https://music.apple.com/search?term=${q}` },
  ];
}
