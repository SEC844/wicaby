// HDR format of a video stream as the server describes it (Jellyfin: VideoRangeType/DvProfile,
// Emby: ExtendedVideoType/ExtendedVideoSubType). Shared by playback (main) and the item page's
// quality chips. Dependency-free so that tools/checks/hdr-check.mjs can run it under plain Node.
// Same rules as Android's VideoRange.kt: both run tools/checks/fixtures/hdr.json.
import type { MediaStream } from './models';

export type HdrKind = 'sdr' | 'hdr10' | 'hdr10+' | 'hlg' | 'dv';
export interface HdrFormat {
  kind: HdrKind;
  // "5", "8.1", "7.6": profile plus base-layer compatibility id.
  dvProfile?: string;
}

function dvLabel(profile?: number, compat?: number): string | undefined {
  if (!profile) return undefined;
  return compat ? `${profile}.${compat}` : String(profile);
}

export function hdrFromStream(s: MediaStream | undefined): HdrFormat | null {
  if (!s) return null;
  const range = (s.VideoRangeType ?? '').toLowerCase();
  const ext = (s.ExtendedVideoType ?? '').toLowerCase();
  if ((range.startsWith('dovi') && range !== 'doviinvalid') || ext === 'dolbyvision') {
    // Jellyfin's DvProfile wins; Emby spells it in the subtype ("DoviProfile76").
    const m = /doviprofile(\d)(\d)$/i.exec(s.ExtendedVideoSubType ?? '');
    return { kind: 'dv', dvProfile: dvLabel(s.DvProfile, s.DvBlSignalCompatibilityId) ?? (m ? dvLabel(Number(m[1]), Number(m[2])) : undefined) };
  }
  if (range === 'hdr10plus' || ext === 'hdr10plus') return { kind: 'hdr10+' };
  if (range === 'hlg' || ext === 'hyperloggamma' || ext === 'hlg') return { kind: 'hlg' };
  // DOVIInvalid (DV signalling Jellyfin cannot use) falls through: the transfer tells the base layer.
  if (range === 'hdr10' || ext === 'hdr10') return { kind: 'hdr10' };
  if (range === 'sdr') return { kind: 'sdr' };
  const transfer = (s.ColorTransfer ?? '').toLowerCase();
  if (transfer === 'arib-std-b67') return { kind: 'hlg' };
  const vr = (s.VideoRange ?? '').toUpperCase();
  if (transfer === 'smpte2084' || vr === 'HDR') return { kind: 'hdr10' };
  if (vr === 'SDR') return { kind: 'sdr' };
  return null;
}

// What a screen without Dolby Vision shows instead: the HDR10 or HLG base layer of profiles
// 7.6, 8.1 and 8.4 (compatibility id 6, 1, 4). Profile 5 has none; 8.2 falls back to SDR.
export function dvFallback(s: MediaStream | undefined): 'hdr10' | 'hdr10+' | 'hlg' | null {
  if (!s) return null;
  const range = (s.VideoRangeType ?? '').toLowerCase();
  // DOVIWithEL is profile 7, whose base layer is HDR10.
  if (range === 'doviwithhdr10' || range === 'doviwithel') return 'hdr10';
  if (range === 'doviwithhdr10plus' || range === 'doviwithelhdr10plus') return 'hdr10+';
  if (range === 'doviwithhlg') return 'hlg';
  const sub = /doviprofile\d(\d)$/i.exec(s.ExtendedVideoSubType ?? '');
  const compat = s.DvBlSignalCompatibilityId ?? (sub ? Number(sub[1]) : undefined);
  if (compat === undefined) {
    // Compatibility unknown (older Emby): the stream's transfer is the base layer's.
    const transfer = (s.ColorTransfer ?? '').toLowerCase();
    return transfer === 'smpte2084' ? 'hdr10' : transfer === 'arib-std-b67' ? 'hlg' : null;
  }
  return compat === 1 || compat === 6 ? 'hdr10' : compat === 4 ? 'hlg' : null;
}

const CHIP: Record<Exclude<HdrKind, 'sdr' | 'dv'>, string> = { hdr10: 'HDR10', 'hdr10+': 'HDR10+', hlg: 'HLG' };

// Item page chip: "Dolby Vision · HDR10", "HDR10+", "HLG"; nothing for SDR. Brand names, not translated.
export function hdrChip(s: MediaStream | undefined): string | null {
  const f = hdrFromStream(s);
  if (!f || f.kind === 'sdr') return null;
  // VideoRange "HDR" alone does not say PQ or HLG: plain "HDR" (playback still treats it as HDR10).
  if (f.kind === 'hdr10' && !hdrFromStream({ ...s!, VideoRange: undefined })) return 'HDR';
  if (f.kind !== 'dv') return CHIP[f.kind];
  const base = dvFallback(s);
  return base ? `Dolby Vision · ${CHIP[base]}` : 'Dolby Vision';
}
