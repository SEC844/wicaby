// DeviceProfiles for direct casting (cast-spec §2.6.5-6), in the shape of shared/device-profile.ts. Pure and
// golden-tested (tools/checks/fixtures/cast/profiles.json, which the :core CastProfilesTest reads too).
import type { ServerKind } from '../../shared/contract';

// Sink MIME types → containers (§2.6.5).
const SINK_CONTAINERS: [RegExp, string, 'Video' | 'Audio'][] = [
  [/^video\/(mp4|x-m4v)$/, 'mp4,m4v', 'Video'],
  [/^video\/(x-matroska|x-mkv)$/, 'mkv', 'Video'],
  [/^video\/(mpeg|vnd\.dlna\.mpeg-tts|mp2t)$/, 'ts', 'Video'],
  [/^video\/(x-msvideo|avi)$/, 'avi', 'Video'],
  [/^audio\/mpeg$/, 'mp3', 'Audio'],
  [/^audio\/(x-)?flac$/, 'flac', 'Audio'],
  [/^audio\/(mp4|x-m4a)$/, 'm4a', 'Audio'],
];

// The MIME types of a GetProtocolInfo Sink ("http-get:*:video/mp4:*,…"), lower case, in order, once each.
export function sinkMimes(sinkCsv: string): string[] {
  const out = sinkCsv
    .split(',')
    .map((e) => e.trim().split(':'))
    .filter((p) => p.length >= 4 && p[0].toLowerCase() === 'http-get')
    .map((p) => p[2].toLowerCase());
  return [...new Set(out)];
}

// The MIME a renderer is told for a container: the first one its Sink lists, else the common one.
export function mimeFor(container: string, audio: boolean, sinkCsv = ''): string {
  const c = container.toLowerCase().split(',')[0];
  const mimes = sinkMimes(sinkCsv);
  const row = SINK_CONTAINERS.find(([, cs, type]) => cs.split(',').includes(c === 'mpegts' ? 'ts' : c) && (type === 'Audio') === audio);
  const listed = row && mimes.find((m) => row[0].test(m));
  if (listed) return listed;
  const fallback: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', ts: 'video/mpeg', mpegts: 'video/mpeg', avi: 'video/x-msvideo', mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/mp4' };
  return fallback[c] ?? (audio ? 'audio/mpeg' : 'video/mpeg');
}

const TEXT_SUBS = ['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt'];
const IMAGE_SUBS = ['pgs', 'pgssub', 'dvdsub', 'dvbsub', 'vobsub'];
export const isSony = (model: string): boolean => /sony|bravia/i.test(model);

// §2.6.5: containers from the Sink (none listed: the common four), h264/hevc with aac/ac3/eac3/mp3, an HTTP TS
// transcode (never HLS), 40 Mbps. Sony: subtitles burned in, except those embedded in a direct-streamed MKV;
// others: srt on the side (the server converts other text formats to it).
export function dlnaProfile(sinkCsv: string, model: string): Record<string, unknown> {
  const mimes = sinkMimes(sinkCsv);
  let rows = SINK_CONTAINERS.filter(([re]) => mimes.some((m) => re.test(m)));
  if (rows.length === 0) rows = SINK_CONTAINERS.filter(([, c]) => ['mp4,m4v', 'ts', 'mp3', 'm4a'].includes(c));
  const video = rows.filter((r) => r[2] === 'Video').map((r) => r[1]);
  const audio = rows.filter((r) => r[2] === 'Audio').map((r) => r[1]);
  const max = 40_000_000;
  return {
    Name: `Wicaby DLNA${model ? ` (${model})` : ''}`,
    MaxStreamingBitrate: max,
    MaxStaticBitrate: max,
    MusicStreamingTranscodingBitrate: 320_000,
    ContainerProfiles: [],
    CodecProfiles: [],
    ResponseProfiles: [],
    DirectPlayProfiles: [
      ...(video.length ? [{ Container: video.join(','), Type: 'Video', VideoCodec: 'h264,hevc', AudioCodec: 'aac,ac3,eac3,mp3' }] : []),
      ...audio.map((Container) => ({ Container, Type: 'Audio' })),
    ],
    TranscodingProfiles: [
      { Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac,ac3', Protocol: 'http', Context: 'Streaming' },
      { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Protocol: 'http', Context: 'Streaming' },
    ],
    SubtitleProfiles: isSony(model)
      ? [...[...TEXT_SUBS, ...IMAGE_SUBS].map((Format) => ({ Format, Method: 'Embed', Container: 'mkv' })), ...[...TEXT_SUBS, ...IMAGE_SUBS].map((Format) => ({ Format, Method: 'Encode' }))]
      : [{ Format: 'srt', Method: 'External' }, ...IMAGE_SUBS.map((Format) => ({ Format, Method: 'Encode' }))],
  };
}

const FLAC_LIMITS = [
  { Condition: 'LessThanEqual', Property: 'AudioSampleRate', Value: '96000', IsRequired: false },
  { Condition: 'LessThanEqual', Property: 'AudioBitDepth', Value: '24', IsRequired: false },
];

export interface CastPrefs {
  allowHevc?: boolean;
  dolby?: boolean;
}

// §2.6.6, the Default Media Receiver (Emby; CA-09). The model is the mDNS `md` field.
export function castProfile(model: string, prefs: CastPrefs, server: ServerKind): Record<string, unknown> {
  const uhd = /ultra|chromecast with google tv|google tv streamer/i.test(model);
  const av1 = /google tv streamer/i.test(model);
  const hevc = uhd || Boolean(prefs.allowHevc);
  const audio = ['aac', 'mp3', 'opus', 'vorbis', 'flac', ...(prefs.dolby ? ['ac3', 'eac3'] : [])].join(',');
  const max = 20_000_000;
  const videoCodecs = ['h264', ...(hevc ? ['hevc'] : []), ...(av1 ? ['av1'] : []), 'vp8', 'vp9'].join(',');
  return {
    Name: `Wicaby Cast${model ? ` (${model})` : ''}`,
    MaxStreamingBitrate: max,
    MaxStaticBitrate: max,
    MusicStreamingTranscodingBitrate: 320_000,
    ContainerProfiles: [],
    ResponseProfiles: [],
    // MKV is never listed: it is always remuxed.
    DirectPlayProfiles: [
      { Container: 'mp4,m4v', Type: 'Video', VideoCodec: videoCodecs, AudioCodec: audio },
      { Container: 'webm', Type: 'Video', VideoCodec: 'vp8,vp9', AudioCodec: 'opus,vorbis' },
      { Container: 'mp3', Type: 'Audio' },
      { Container: 'aac,m4a', Type: 'Audio', AudioCodec: 'aac' },
      { Container: 'flac', Type: 'Audio' },
      { Container: 'opus,ogg,webm', Type: 'Audio', AudioCodec: 'opus,vorbis' },
    ],
    CodecProfiles: [
      { Type: 'Video', Codec: 'h264', Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoLevel', Value: uhd ? '51' : '41', IsRequired: false }] },
      // Cast plays FLAC up to 96 kHz / 24 bit (speakers included): hi-res files are transcoded.
      { Type: 'Audio', Codec: 'flac', Conditions: FLAC_LIMITS },
    ],
    TranscodingProfiles: [
      // HEVC goes out in fMP4 segments on Jellyfin; Emby transcodes it to h264.
      ...(hevc && server === 'jellyfin' ? [{ Container: 'mp4', Type: 'Video', VideoCodec: 'hevc,h264', AudioCodec: 'aac', Protocol: 'hls', Context: 'Streaming', MinSegments: 1, BreakOnNonKeyFrames: true }] : []),
      { Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Protocol: 'hls', Context: 'Streaming', MinSegments: 1, BreakOnNonKeyFrames: true },
      { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Protocol: 'http', Context: 'Streaming' },
    ],
    // The server converts text subtitles to the External format; image ones are burned in.
    SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }, ...IMAGE_SUBS.map((Format) => ({ Format, Method: 'Encode' }))],
  };
}
