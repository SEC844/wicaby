import type { ServerKind } from './contract';

// DeviceProfile sent with PlaybackInfo. The server uses it to decide between
// direct play, direct stream and transcoding.

const MPV_TEXT_SUBS = ['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'smi', 'ttml', 'mov_text'];
// "sub" is VobSub's .sub (with .idx), not MicroDVD text: an image format, so never External.
const MPV_IMAGE_SUBS = ['pgs', 'pgssub', 'dvdsub', 'dvbsub', 'vobsub', 'sub', 'idx'];
// Jellyfin tone-maps or strips DV in a transcode unless the codec profile lists the range.
const JELLYFIN_RANGES = 'SDR|HDR10|HDR10Plus|HLG|DOVI|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithHLG|DOVIWithSDR|DOVIWithEL|DOVIWithELHDR10Plus|DOVIInvalid';

// Caps direct play and transcodes alike: the server sizes a transcode from these conditions.
function resolutionCap(maxHeight: number): Record<string, unknown>[] {
  if (!maxHeight) return [];
  const width = Math.round((maxHeight * 16) / 9);
  return [
    {
      Type: 'Video',
      Conditions: [
        { Condition: 'LessThanEqual', Property: 'Width', Value: String(width), IsRequired: false },
        { Condition: 'LessThanEqual', Property: 'Height', Value: String(maxHeight), IsRequired: false },
      ],
    },
  ];
}

export function buildDeviceProfile(player: 'mpv' | 'html' | 'tv', maxBitrate: number, server: ServerKind, maxHeight = 0): Record<string, unknown> {
  const base = {
    Name: `Wicaby ${player}`,
    MaxStreamingBitrate: maxBitrate,
    MaxStaticBitrate: maxBitrate,
    MusicStreamingTranscodingBitrate: 320_000,
    ContainerProfiles: [],
    CodecProfiles: [],
    ResponseProfiles: [],
  };

  if (player === 'mpv') {
    // mpv decodes everything FFmpeg knows, so the server only transcodes
    // when bitrate or user policy forces it. Emby has no VideoRangeType condition.
    return {
      ...base,
      CodecProfiles: [
        ...(server === 'jellyfin'
          ? ['hevc', 'av1'].map((Codec) => ({
              Type: 'Video',
              Codec,
              Conditions: [{ Condition: 'EqualsAny', Property: 'VideoRangeType', Value: JELLYFIN_RANGES, IsRequired: false }],
            }))
          : []),
        ...resolutionCap(maxHeight),
      ],
      DirectPlayProfiles: [{ Type: 'Video' }, { Type: 'Audio' }],
      TranscodingProfiles: [
        {
          Container: 'ts',
          Type: 'Video',
          VideoCodec: 'hevc,h264',
          AudioCodec: 'aac,ac3,eac3,mp3,opus,flac',
          Context: 'Streaming',
          Protocol: 'hls',
          MaxAudioChannels: '8',
          MinSegments: 1,
          // With video stream copy, a segment cut between keyframes starts with undecodable frames
          // (grey smear after a seek in mpv); keyframe-aligned segments avoid it.
          BreakOnNonKeyFrames: false,
        },
        { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Context: 'Streaming', Protocol: 'http', MaxAudioChannels: '2' },
      ],
      SubtitleProfiles: [
        ...[...MPV_TEXT_SUBS, ...MPV_IMAGE_SUBS].map((Format) => ({ Format, Method: 'Embed' })),
        ...MPV_TEXT_SUBS.map((Format) => ({ Format, Method: 'External' })),
        // A transcode to TS cannot carry image subtitles: the server burns them in.
        ...MPV_IMAGE_SUBS.map((Format) => ({ Format, Method: 'Encode' })),
      ],
    };
  }

  if (player === 'tv') return tvProfile(base, maxHeight);

  // Chromium's <video>: MP4/WebM with web codecs; everything else goes HLS.
  return {
    ...base,
    CodecProfiles: resolutionCap(maxHeight),
    DirectPlayProfiles: [
      { Container: 'mp4,m4v', Type: 'Video', VideoCodec: 'h264,hevc,av1,vp9', AudioCodec: 'aac,mp3,opus,flac,alac' },
      { Container: 'webm', Type: 'Video', VideoCodec: 'vp8,vp9,av1', AudioCodec: 'opus,vorbis' },
      { Container: 'mp3', Type: 'Audio' },
      // No ALAC: Chromium does not decode it (music-spec §4.1); the server transcodes it.
      { Container: 'aac,m4a,m4b', Type: 'Audio', AudioCodec: 'aac' },
      { Container: 'flac', Type: 'Audio' },
      { Container: 'opus,ogg,oga,webm', Type: 'Audio', AudioCodec: 'opus,vorbis' },
      { Container: 'wav', Type: 'Audio' },
    ],
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: 'Video',
        VideoCodec: 'h264',
        AudioCodec: 'aac,mp3',
        Context: 'Streaming',
        Protocol: 'hls',
        MaxAudioChannels: '2',
        MinSegments: 1,
        BreakOnNonKeyFrames: true,
      },
      { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Context: 'Streaming', Protocol: 'http', MaxAudioChannels: '2' },
    ],
    SubtitleProfiles: [
      { Format: 'vtt', Method: 'External' },
      { Format: 'webvtt', Method: 'External' },
    ],
  };
}

// webOS 6+ / Tizen 6.5+ <video> (apps/webtv): the TV's hardware decoders take MKV, TS and HEVC, and pass AC3/EAC3.
// Modelled on jellyfin-web's browserDeviceProfile.js webOS/Tizen branches
// (https://github.com/jellyfin/jellyfin-web/blob/master/src/scripts/browserDeviceProfile.js), kept conservative:
// no DTS (only some models) and no TrueHD; ASS/SSA and image subtitles are burnt in by the server.
// shortcut: one profile for every model, no webOS.deviceInfo() probe (Dolby Vision, DTS, 4K); upgrade with real TVs.
function tvProfile(base: Record<string, unknown>, maxHeight: number): Record<string, unknown> {
  const video = 'h264,hevc';
  const audio = 'aac,mp3,ac3,eac3,flac,opus';
  return {
    ...base,
    CodecProfiles: resolutionCap(maxHeight),
    DirectPlayProfiles: [
      { Container: 'mp4,m4v,mkv,ts,m2ts,mov', Type: 'Video', VideoCodec: video, AudioCodec: audio },
      { Container: 'webm', Type: 'Video', VideoCodec: 'vp9,vp8', AudioCodec: 'opus,vorbis' },
      { Container: 'mp3', Type: 'Audio' },
      { Container: 'aac,m4a', Type: 'Audio', AudioCodec: 'aac' },
      { Container: 'flac', Type: 'Audio' },
      { Container: 'wav', Type: 'Audio' },
    ],
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: 'Video',
        VideoCodec: 'h264',
        AudioCodec: 'aac,ac3,eac3',
        Context: 'Streaming',
        Protocol: 'hls',
        MaxAudioChannels: '6',
        MinSegments: 1,
        BreakOnNonKeyFrames: true,
      },
      { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Context: 'Streaming', Protocol: 'http', MaxAudioChannels: '2' },
    ],
    SubtitleProfiles: [
      ...['vtt', 'webvtt', 'srt', 'subrip'].map((Format) => ({ Format, Method: 'External' })),
      ...['ass', 'ssa', 'pgs', 'pgssub', 'dvdsub', 'dvbsub', 'vobsub', 'sub', 'idx'].map((Format) => ({ Format, Method: 'Encode' })),
    ],
  };
}
