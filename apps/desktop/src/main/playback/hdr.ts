// HDR format as mpv actually decodes it (video-params), merged with what the server says
// (src/shared/hdr.ts), plus labels and the Windows HDR helper reply. Dependency-free so that
// tools/checks/hdr-check.mjs can run it under plain Node.
import type { HdrFormat, HdrKind } from '../../shared/hdr';

export type { HdrFormat, HdrKind };

export interface MpvVideoParams {
  colormatrix?: string;
  gamma?: string;
  'scene-max-r'?: number;
}

export function hdrFromMpv(p: MpvVideoParams | null | undefined, dvProfile?: number): HdrFormat | null {
  if (!p?.gamma) return null;
  // mpv tags frames "dolbyvision" only when the RPU reached the renderer, i.e. libplacebo reshapes them.
  if (p.colormatrix === 'dolbyvision') return { kind: 'dv', dvProfile: dvProfile ? String(dvProfile) : undefined };
  // Decoder-side scene-max only exists with ST 2094-40 (HDR10+) side data; peak detection fills it later, in video-out-params.
  if (p.gamma === 'pq') return { kind: p['scene-max-r'] !== undefined ? 'hdr10+' : 'hdr10' };
  if (p.gamma === 'hlg') return { kind: 'hlg' };
  return { kind: 'sdr' };
}

// mpv says what is rendered; the server knows the full DV profile and HDR10+ before the first frame.
export function mergeHdr(server: HdrFormat | null, mpv: HdrFormat | null): HdrFormat | null {
  if (!mpv || !server) return mpv ?? server;
  if (mpv.kind === 'dv' && server.kind === 'dv') return { kind: 'dv', dvProfile: server.dvProfile ?? mpv.dvProfile };
  if (mpv.kind === 'hdr10' && server.kind === 'hdr10+') return server;
  return mpv;
}

const NAMES: Record<HdrKind, string> = { sdr: 'SDR', hdr10: 'HDR10', 'hdr10+': 'HDR10+', hlg: 'HLG', dv: 'Dolby Vision' };

// passthrough: PQ out with the source metadata; hdr: PQ out, mpv maps to the display's peak; sdr: tone-mapped.
// The OSD words it in the UI language (player.stats.hdrOutput).
export type HdrOutput = 'passthrough' | 'hdr' | 'sdr';

// Format name only: "Dolby Vision P8.1", "HDR10+". Technical names, never translated.
export function hdrLabel(f: HdrFormat | null): string | undefined {
  if (!f) return undefined;
  return NAMES[f.kind] + (f.kind === 'dv' && f.dvProfile ? ` P${f.dvProfile}` : '');
}

// The output worth showing next to the format: none for SDR content.
export function hdrOutputShown(f: HdrFormat | null, output?: HdrOutput): HdrOutput | undefined {
  return f && f.kind !== 'sdr' ? output : undefined;
}

// Chromium's <video> ignores the RPU: profile 5 has no HDR10/HLG base layer and turns green and purple.
export function dvNeedsReshaping(f: HdrFormat | null): boolean {
  return f?.kind === 'dv' && (!f.dvProfile || f.dvProfile === '5');
}

// Reply of the Windows HDR helper in features/hdr-mode.ts.
export interface HdrReply {
  verb: 'state' | 'keep' | 'set' | 'dry' | 'fail';
  device: string;
  supported: boolean;
  on: boolean;
}

// The only device names the helper is ever given: "\\.\DISPLAYn".
export function isDisplayDevice(device: unknown): device is string {
  return typeof device === 'string' && /^\\\\\.\\DISPLAY\d{1,3}$/.test(device);
}

// Displays named by the HDR restore token: { devices: [...] }, or { device } from older builds.
export function markerDevices(doc: unknown): string[] {
  const d = doc as { device?: unknown; devices?: unknown } | null;
  return (Array.isArray(d?.devices) ? d.devices : [d?.device]).filter(isDisplayDevice);
}

// PowerShell single-quoted literal: nothing expands inside, a quote is doubled.
export function psQuote(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, "''")}'`;
}

export function parseHdrReply(out: string): HdrReply | null {
  const m = /^(state|keep|set|dry|fail) (\\\\\.\\DISPLAY\d+) ([01]) ([01])$/.exec(out.trim());
  return m ? { verb: m[1] as HdrReply['verb'], device: m[2], supported: m[3] === '1', on: m[4] === '1' } : null;
}
