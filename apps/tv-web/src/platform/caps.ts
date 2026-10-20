// What this TV can decode and show, probed once at the first playback: codecs from the engine itself
// (canPlayType / MediaSource.isTypeSupported answer for the TV's hardware decoders on Tizen and webOS), the
// panel's 4K and HDR from the platform. The device profile (lib/device-profile.ts) is built from this, so a TV
// gets direct play for what it really plays, whatever its model or year.
import { platform } from './index';

export interface Caps {
  // Video codecs, decoded in hardware.
  h264: boolean;
  hevc: boolean;
  hevc10: boolean;
  av1: boolean;
  vp9: boolean;
  // Audio codecs the TV decodes (or passes to the receiver).
  ac3: boolean;
  eac3: boolean;
  dts: boolean;
  // Containers the pipeline opens as files (MKV is the common case for a library).
  mkv: boolean;
  // HLS in the engine itself: every TV; a desktop browser (development) gets progressive conversions instead.
  hls: boolean;
  // The panel: its height (2160 on a 4K TV) and its dynamic ranges.
  maxHeight: number;
  hdr10: boolean;
  hlg: boolean;
  dolbyVision: boolean;
}

const probe = document.createElement('video');

function can(type: string): boolean {
  try {
    if (probe.canPlayType(type).replace(/no/, '')) return true;
    const MS = (window as { MediaSource?: { isTypeSupported(t: string): boolean } }).MediaSource;
    return !!MS && MS.isTypeSupported(type);
  } catch {
    return false;
  }
}

declare const webapis:
  | {
      productinfo?: { isUdPanelSupported?(): boolean; is8KPanelSupported?(): boolean };
      avinfo?: { isHdrTvSupport?(): boolean };
    }
  | undefined;

// webOS system properties through the Luna bus (what webOSTV.js deviceInfo() reads), without the library.
function lunaSystemInfo(keys: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const Bridge = (window as { PalmServiceBridge?: new () => { onservicecallback: (msg: string) => void; call(uri: string, params: string): void } }).PalmServiceBridge;
    if (!Bridge) return resolve({});
    const bridge = new Bridge();
    const timer = window.setTimeout(() => resolve({}), 2000);
    bridge.onservicecallback = (msg) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(msg) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    };
    bridge.call('luna://com.webos.service.tv.systemproperty/getSystemInfo', JSON.stringify({ keys }));
  });
}

async function panel(): Promise<Pick<Caps, 'maxHeight' | 'hdr10' | 'hlg' | 'dolbyVision'>> {
  if (platform === 'tizen') {
    const pi = typeof webapis !== 'undefined' ? webapis?.productinfo : undefined;
    const uhd = !!(pi?.is8KPanelSupported?.() || pi?.isUdPanelSupported?.());
    const hdr = !!(typeof webapis !== 'undefined' && webapis?.avinfo?.isHdrTvSupport?.());
    // Samsung panels with HDR take HDR10 and HLG; Dolby Vision is not on Samsung TVs.
    return { maxHeight: uhd ? 2160 : 1080, hdr10: hdr, hlg: hdr, dolbyVision: false };
  }
  if (platform === 'webos') {
    const info = await lunaSystemInfo(['UHD', 'HDR10', 'dolbyVision']);
    const yes = (v: unknown) => v === true || v === 'true';
    const hdr = yes(info.HDR10);
    return { maxHeight: yes(info.UHD) ? 2160 : 1080, hdr10: hdr, hlg: hdr, dolbyVision: yes(info.dolbyVision) };
  }
  // A desktop browser (npm run dev, the smoke tests): what its screen is.
  const hdr = typeof matchMedia === 'function' && matchMedia('(dynamic-range: high)').matches;
  return { maxHeight: screen.height * (devicePixelRatio || 1) >= 2000 ? 2160 : 1080, hdr10: hdr, hlg: hdr, dolbyVision: false };
}

let cached: Promise<Caps> | null = null;

export function caps(): Promise<Caps> {
  return (cached ??= detect());
}

async function detect(): Promise<Caps> {
  const tv = platform !== 'dev';
  const hevc = can('video/mp4; codecs="hvc1.1.6.L120.90"') || can('video/mp4; codecs="hev1.1.6.L120.90"');
  return {
    h264: tv || can('video/mp4; codecs="avc1.640028"'),
    hevc,
    hevc10: can('video/mp4; codecs="hvc1.2.4.L153.B0"') || (tv && hevc),
    av1: can('video/mp4; codecs="av01.0.08M.08"'),
    vp9: can('video/webm; codecs="vp9"'),
    // Every Tizen and webOS TV since 2016 decodes AC3 and EAC3; a browser only says so when it does.
    ac3: tv || can('audio/mp4; codecs="ac-3"'),
    eac3: tv || can('audio/mp4; codecs="ec-3"'),
    // Samsung dropped DTS from 2018 and LG from 2020 to 2022: only when the engine claims it.
    dts: can('audio/mp4; codecs="dtsc"') || can('audio/vnd.dts'),
    mkv: tv || can('video/x-matroska') || can('video/webm; codecs="avc1.640028"'),
    hls: tv || can('application/vnd.apple.mpegurl') || can('application/x-mpegURL'),
    ...(await panel()),
  };
}
