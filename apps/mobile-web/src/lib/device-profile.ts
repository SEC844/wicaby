// The DeviceProfile sent with PlaybackInfo, for Safari on iPhone and iPad (same signature as the TV's,
// apps/tv-web/src/lib/device-profile.ts). Safari's own rules decide it, more than the codecs:
// - Matroska never plays: an MKV is remuxed by the server, its video copied when the HLS segments can carry it.
// - HEVC and Dolby Vision play from MP4/MOV files and from fMP4 HLS segments only, never from MPEG-TS, and only
//   tagged hvc1/dvh1. Jellyfin segments fMP4; Emby segments MPEG-TS, so its transcodes are H.264.
// - AC3 and EAC3 (Dolby Digital, Dolby Digital Plus with Atmos) pass through to AirPlay receivers and decode on the
//   device: 5.1 stays 5.1. DTS and TrueHD do not: the server converts them.
import type { Caps } from '../platform/caps';
import type { ServerKind } from '$tv/api';
import { PASS_OFF, PASS_ON, settings } from '$tv/settings.svelte';

function ranges(c: Caps): string {
  const out = ['SDR'];
  if (c.hdr10) out.push('HDR10', 'HDR10Plus', 'DOVIWithHDR10', 'DOVIWithHDR10Plus');
  if (c.hlg) out.push('HLG', 'DOVIWithHLG');
  out.push('DOVIWithSDR');
  if (c.dolbyVision) out.push('DOVI');
  return out.join('|');
}

function dolby(c: Caps): string[] {
  const pass = (codec: 'ac3' | 'eac3', probed: boolean) => {
    const v = settings.passthrough[codec].value;
    return v === PASS_ON || (v !== PASS_OFF && probed);
  };
  return [...(pass('ac3', c.ac3) ? ['ac3'] : []), ...(pass('eac3', c.eac3) ? ['eac3'] : [])];
}

export function deviceProfile(c: Caps, server: ServerKind, maxBitrate: number, maxHeight = 0, burnText = false): Record<string, unknown> {
  const video = ['h264', ...(c.hevc ? ['hevc'] : []), ...(c.av1 ? ['av1'] : [])].join(',');
  const surround = dolby(c);
  const fileAudio = ['aac', 'mp3', 'alac', 'flac', ...surround].join(',');
  const hlsAudio = ['aac', ...surround].join(',');
  const fmp4 = server === 'jellyfin';
  const height = maxHeight ? Math.min(maxHeight, c.maxHeight) : c.maxHeight;
  const width = Math.round((height * 16) / 9);
  return {
    Name: 'Wicaby iOS web',
    MaxStreamingBitrate: maxBitrate,
    MaxStaticBitrate: maxBitrate,
    MusicStreamingTranscodingBitrate: 320_000,
    DirectPlayProfiles: [
      { Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: video, AudioCodec: fileAudio },
      { Container: 'mp3', Type: 'Audio' },
      { Container: 'aac,m4a,m4b', Type: 'Audio', AudioCodec: 'aac,alac' },
      { Container: 'flac', Type: 'Audio' },
      { Container: 'wav', Type: 'Audio' },
    ],
    TranscodingProfiles: [
      {
        Container: fmp4 ? 'mp4' : 'ts',
        Type: 'Video',
        VideoCodec: fmp4 && c.hevc ? 'hevc,h264' : 'h264',
        AudioCodec: hlsAudio,
        Context: 'Streaming',
        Protocol: 'hls',
        MaxAudioChannels: surround.length ? '6' : '2',
        MinSegments: 2,
        BreakOnNonKeyFrames: true,
      },
      { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Context: 'Streaming', Protocol: 'http', MaxAudioChannels: '2' },
    ],
    ContainerProfiles: [],
    CodecProfiles: [
      {
        Type: 'Video',
        Conditions: [
          { Condition: 'LessThanEqual', Property: 'Width', Value: String(width), IsRequired: false },
          { Condition: 'LessThanEqual', Property: 'Height', Value: String(height), IsRequired: false },
        ],
      },
      // hev1-tagged HEVC (common in MKV remuxes) shows no picture in Safari: only hvc1 and Dolby Vision's dvh1.
      ...(c.hevc
        ? [{ Type: 'Video', Codec: 'hevc', Conditions: [
            { Condition: 'EqualsAny', Property: 'VideoCodecTag', Value: 'hvc1|dvh1', IsRequired: false },
            ...(c.hevc10 ? [] : [{ Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false }]),
          ] }]
        : []),
      ...(server === 'jellyfin'
        ? ['hevc', 'av1'].map((Codec) => ({ Type: 'Video', Codec, Conditions: [{ Condition: 'EqualsAny', Property: 'VideoRangeType', Value: ranges(c), IsRequired: false }] }))
        : []),
    ],
    ResponseProfiles: [],
    // As on the TV: text subtitles come as WebVTT the app draws (lib/subtitles.ts); image subtitles are burnt in.
    SubtitleProfiles: [
      ...(burnText ? ['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text'].map((Format) => ({ Format, Method: 'Encode' })) : [{ Format: 'vtt', Method: 'External' }]),
      ...['pgs', 'pgssub', 'dvdsub', 'dvbsub', 'vobsub', 'sub', 'idx'].map((Format) => ({ Format, Method: 'Encode' })),
    ],
  };
}
