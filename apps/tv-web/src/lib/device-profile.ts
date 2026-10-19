// The DeviceProfile sent with PlaybackInfo (Android core DeviceProfile.kt), built from what this TV really decodes
// (platform/caps.ts): the server direct plays what the TV takes and converts only the rest. The Settings
// passthrough choices win over the probe: On offers a codec even when the TV does not claim it (a receiver behind
// it decodes), Off has the server convert it.
import type { Caps } from '../platform/caps';
import type { ServerKind } from './api';
import { PASS_OFF, PASS_ON, settings } from './settings.svelte';

// Jellyfin tone-maps or strips HDR in a transcode unless the codec profile lists the range.
function ranges(c: Caps): string {
  const out = ['SDR'];
  if (c.hdr10) out.push('HDR10', 'HDR10Plus', 'DOVIWithHDR10', 'DOVIWithHDR10Plus');
  if (c.hlg) out.push('HLG', 'DOVIWithHLG');
  // A Dolby Vision file with an SDR or HDR10 base layer plays its base layer on a TV without Dolby Vision.
  out.push('DOVIWithSDR');
  if (c.dolbyVision) out.push('DOVI', 'DOVIWithEL', 'DOVIWithELHDR10Plus');
  return out.join('|');
}

function audioCodecs(c: Caps): string[] {
  const pass = (codec: 'ac3' | 'eac3' | 'dts' | 'truehd', probed: boolean) => {
    const v = settings.passthrough[codec].value;
    return v === PASS_ON || (v !== PASS_OFF && probed);
  };
  return [
    'aac', 'mp3', 'mp2', 'flac', 'opus', 'vorbis', 'pcm_s16le', 'pcm_s24le',
    ...(pass('ac3', c.ac3) ? ['ac3'] : []),
    ...(pass('eac3', c.eac3) ? ['eac3'] : []),
    ...(pass('dts', c.dts) ? ['dts', 'dca'] : []),
    ...(pass('truehd', false) ? ['truehd'] : []),
  ];
}

// burnText: the server burns text subtitles in too (the app could not fetch the WebVTT file, lib/playback.svelte.ts).
export function deviceProfile(c: Caps, server: ServerKind, maxBitrate: number, maxHeight = 0, burnText = false): Record<string, unknown> {
  const video = ['h264', ...(c.hevc ? ['hevc'] : []), ...(c.av1 ? ['av1'] : []), ...(c.vp9 ? ['vp9'] : [])].join(',');
  const audio = audioCodecs(c);
  const height = maxHeight ? Math.min(maxHeight, c.maxHeight) : c.maxHeight;
  const width = Math.round((height * 16) / 9);
  // Transcodes: HEVC when the TV decodes it (the same picture at about half the bitrate), multichannel AC3/EAC3
  // when it takes them, so 5.1 stays 5.1.
  const hlsAudio = ['aac', ...audio.filter((a) => a === 'ac3' || a === 'eac3')].join(',');
  return {
    Name: 'Wicaby TV web',
    MaxStreamingBitrate: maxBitrate,
    MaxStaticBitrate: maxBitrate,
    MusicStreamingTranscodingBitrate: 320_000,
    DirectPlayProfiles: [
      { Container: `mp4,m4v,mov,ts,m2ts,mpegts${c.mkv ? ',mkv' : ''}`, Type: 'Video', VideoCodec: video, AudioCodec: audio.join(',') },
      ...(c.vp9 || c.av1 ? [{ Container: 'webm', Type: 'Video', VideoCodec: 'vp8,vp9,av1', AudioCodec: 'opus,vorbis' }] : []),
      { Container: 'mp3', Type: 'Audio' },
      { Container: 'aac,m4a,m4b', Type: 'Audio', AudioCodec: 'aac' },
      { Container: 'flac', Type: 'Audio' },
      { Container: 'wav', Type: 'Audio' },
      { Container: 'ogg,oga,opus,webm', Type: 'Audio', AudioCodec: 'opus,vorbis' },
    ],
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: 'Video',
        VideoCodec: c.hevc ? 'hevc,h264' : 'h264',
        AudioCodec: hlsAudio,
        Context: 'Streaming',
        Protocol: 'hls',
        MaxAudioChannels: hlsAudio.includes('ac3') ? '6' : '2',
        MinSegments: 1,
        BreakOnNonKeyFrames: false,
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
      // 10-bit HEVC (HDR) only when the decoder takes it.
      ...(c.hevc && !c.hevc10 ? [{ Type: 'Video', Codec: 'hevc', Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false }] }] : []),
      // Emby has no VideoRangeType condition.
      ...(server === 'jellyfin'
        ? ['hevc', 'av1'].map((Codec) => ({ Type: 'Video', Codec, Conditions: [{ Condition: 'EqualsAny', Property: 'VideoRangeType', Value: ranges(c), IsRequired: false }] }))
        : []),
    ],
    ResponseProfiles: [],
    // Text subtitles (SRT, ASS, embedded or not) come as WebVTT files the server converts and the app draws itself
    // (lib/subtitles.ts), the same on AVPlay and <video>, with the Settings look, and the video still direct plays.
    // Image subtitles (PGS, VobSub) cannot be converted: the server burns them in.
    SubtitleProfiles: [
      ...(burnText ? ['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text'].map((Format) => ({ Format, Method: 'Encode' })) : [{ Format: 'vtt', Method: 'External' }]),
      ...['pgs', 'pgssub', 'dvdsub', 'dvbsub', 'vobsub', 'sub', 'idx'].map((Format) => ({ Format, Method: 'Encode' })),
    ],
  };
}
