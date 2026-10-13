// X-02 quality and version switching (feature-specs.md §2): the preset table, the coversSource rule,
// the size estimate and the version signature. Pure and erasable TypeScript: tools/checks/quality-check.mjs
// runs it under plain Node against the vectors shared with QualityTest.kt (fixtures/quality/quality.json).
import type { HdrKind } from './hdr';

// "Original": always sent, because a posted profile otherwise caps the stream at 8 Mbps.
export const ORIGINAL_BITRATE = 100_000_000;
// Audio allowance added to a preset's size estimate.
const AUDIO_BITRATE = 192_000;

export interface QualityPreset {
  bitrate: number;
  height: number;
}

export const QUALITY_PRESETS: readonly QualityPreset[] = [
  { bitrate: 20_000_000, height: 1080 },
  { bitrate: 12_000_000, height: 1080 },
  { bitrate: 10_000_000, height: 1080 },
  { bitrate: 8_000_000, height: 1080 },
  { bitrate: 4_000_000, height: 720 },
  { bitrate: 3_000_000, height: 720 },
  { bitrate: 2_000_000, height: 720 },
  { bitrate: 1_500_000, height: 480 },
  { bitrate: 720_000, height: 320 },
  { bitrate: 320_000, height: 240 },
];

// A preset no smaller than the source in both bitrate and height would not lower anything.
// An unknown source bitrate or height covers nothing.
export function coversSource(p: QualityPreset, sourceBitrate?: number, sourceHeight?: number): boolean {
  return Boolean(sourceBitrate && sourceHeight) && p.bitrate >= sourceBitrate! && p.height >= sourceHeight!;
}

export function estimateSize(bitrate: number, durationMs: number): number {
  return Math.round(((bitrate + AUDIO_BITRATE) * durationMs) / 8000);
}

// One row of the Quality column. maxBitrate null = Original; size and percent only when known.
export interface QualityRow {
  maxBitrate: number | null;
  bitrate?: number;
  height?: number;
  size?: number;
  percent?: number;
}

export function qualityRows(src: { bitrate?: number; height?: number; size?: number; durationMs?: number }): QualityRow[] {
  const dur = src.durationMs && src.durationMs > 0 ? src.durationMs : 0;
  const original = src.size || (src.bitrate && dur ? estimateSize(src.bitrate, dur) : undefined);
  const rows: QualityRow[] = [{ maxBitrate: null, bitrate: src.bitrate, height: src.height, size: original, percent: original ? 100 : undefined }];
  for (const p of QUALITY_PRESETS) {
    if (coversSource(p, src.bitrate, src.height)) continue;
    const size = dur ? estimateSize(p.bitrate, dur) : undefined;
    rows.push({ maxBitrate: p.bitrate, bitrate: p.bitrate, height: p.height, size, percent: size && original ? Math.round((size / original) * 100) : undefined });
  }
  return rows;
}

// Height bucket of a version: a cropped 2160p (3840x1600) is still "2160p".
export function heightClass(width?: number, height?: number): number | undefined {
  if (!height && !width) return undefined;
  const w = width ?? 0;
  const h = height ?? 0;
  if (w >= 3200 || h >= 1600) return 2160;
  if (w >= 1800 || h >= 900) return 1080;
  if (w >= 1200 || h >= 650) return 720;
  if (h >= 500) return 576;
  return h >= 400 || w >= 640 ? 480 : h || undefined;
}

const HDR_TEXT: Record<HdrKind, string> = { sdr: '', hdr10: 'HDR10', 'hdr10+': 'HDR10+', hlg: 'HLG', dv: 'DV' };

// "2160p HEVC DV": the label of a version and, lower-cased, the signature remembered per series.
export function versionLabel(video: { Width?: number; Height?: number; Codec?: string } | undefined, hdr: HdrKind | null | undefined): string {
  const h = heightClass(video?.Width, video?.Height);
  const codec = (video?.Codec ?? '').toLowerCase().replace('h265', 'hevc').replace('h264', 'avc');
  const codecText = codec === 'avc' ? 'H.264' : codec.toUpperCase();
  return [h ? `${h}p` : '', codecText, hdr ? HDR_TEXT[hdr] : ''].filter(Boolean).join(' ');
}

export const versionSignature = (video: { Width?: number; Height?: number; Codec?: string } | undefined, hdr: HdrKind | null | undefined): string =>
  versionLabel(video, hdr).toLowerCase();
