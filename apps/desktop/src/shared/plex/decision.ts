// The Plex playback decision (plex-spec §6.1 to §6.3, PX-08): PlaybackInfo's body → the client profile header and
// the /video/:/transcode/universal/decision query; the decision answer → one Emby MediaSource (direct play through
// the part, else an HLS start.m3u8 that starts at the offset); the failures the UI explains. Pure.
import type { MediaSource, PlaybackInfoResponse } from '../models';
import { msToTicks, playablePart, ticksToMs, toMediaSources } from './map';
import { itemKey } from './query';
import type { PlexContainer, PlexMeta } from './types';

// The parts of an Emby DeviceProfile (shared/device-profile.ts) the decision reads.
export interface EmbyProfile {
  DirectPlayProfiles?: { Type?: string; Container?: string; VideoCodec?: string; AudioCodec?: string }[];
  TranscodingProfiles?: { Type?: string; Container?: string; VideoCodec?: string; AudioCodec?: string; Protocol?: string }[];
  SubtitleProfiles?: { Format?: string; Method?: string }[];
  CodecProfiles?: { Type?: string; Conditions?: { Condition?: string; Property?: string; Value?: string }[] }[];
}

// mpv's profile names no codec (FFmpeg decodes them all); Plex wants them listed.
const ANY_CONTAINER = 'mkv,mp4,m4v,mov,avi,webm,mpegts,ts,m2ts,wmv,asf,flv,ogg,3gp';
const ANY_VIDEO = 'h264,hevc,av1,vp9,vp8,mpeg2video,mpeg4,msmpeg4v3,vc1,wmv3,mpeg1video,h263';
const ANY_AUDIO = 'aac,ac3,eac3,dca,dts,truehd,flac,mp3,mp2,opus,vorbis,pcm,alac,wmav2';
const IMAGE_SUBS = new Set(['pgs', 'pgssub', 'hdmv_pgs_subtitle', 'dvdsub', 'dvd_subtitle', 'vobsub', 'dvbsub', 'dvb_subtitle']);

const plexContainer = (c: string | undefined): string => (c === 'ts' ? 'mpegts' : (c ?? 'mpegts'));

// X-Plex-Client-Profile-Extra: what this player plays as is, and what a transcode should produce (video only:
// music keeps the stream route).
export function profileExtra(p: EmbyProfile): string {
  const out: string[] = [];
  for (const d of p.DirectPlayProfiles ?? []) {
    if (d.Type !== 'Video') continue;
    out.push(`add-direct-play-profile(type=videoProfile&container=${d.Container ?? ANY_CONTAINER}&videoCodec=${d.VideoCodec ?? ANY_VIDEO}&audioCodec=${d.AudioCodec ?? ANY_AUDIO})`);
  }
  for (const t of p.TranscodingProfiles ?? []) {
    if (t.Type !== 'Video' || (t.Protocol ?? '').toLowerCase() !== 'hls') continue;
    out.push(`add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=${plexContainer(t.Container)}&videoCodec=${t.VideoCodec ?? 'h264'}&audioCodec=${t.AudioCodec ?? 'aac'})`);
  }
  return out.join('+');
}

// The height cap a profile carries (device-profile.ts resolutionCap), 0 for none.
function maxHeightOf(p: EmbyProfile): number {
  for (const c of p.CodecProfiles ?? []) for (const k of c.Conditions ?? []) if (k.Property === 'Height' && k.Condition === 'LessThanEqual') return Number(k.Value) || 0;
  return 0;
}

// An image subtitle the player cannot draw, or one in a stream the server must transcode, is burned in (Plezy #1398).
function burnIn(codec: string | undefined, p: EmbyProfile, directStream: boolean): boolean {
  const c = (codec ?? '').toLowerCase();
  if (!IMAGE_SUBS.has(c)) return false;
  if (!directStream) return true;
  return !(p.SubtitleProfiles ?? []).some((s) => (s.Format ?? '').toLowerCase() === c && (s.Method === 'Embed' || s.Method === 'External'));
}

// PlaybackInfo's query and body, merged (playback-service sends both, cast senders the body only).
export interface PlaybackBody {
  MediaSourceId?: string;
  // The session to continue (the next part of a multi-part film, D-4); a new one otherwise.
  PlaySessionId?: string;
  StartTimeTicks?: number;
  MaxStreamingBitrate?: number;
  AudioStreamIndex?: number;
  SubtitleStreamIndex?: number;
  EnableDirectPlay?: boolean;
  EnableDirectStream?: boolean;
  AllowVideoStreamCopy?: boolean;
  DeviceProfile?: EmbyProfile;
}

export interface DecisionRequest {
  // The decision and start.m3u8 query (the same parameters for both).
  query: Record<string, string>;
  // X-Plex-Client-Profile-Extra.
  profile: string;
  mediaIndex: number;
  // Where the part asked for (partIndex) starts in the whole item, in ms (absent: 0): offset counts inside that part.
  partStartMs?: number;
}

// Above this a cap means "Original" (shared/quality-presets ORIGINAL_BITRATE): no maxVideoBitrate.
const ORIGINAL_BPS = 100_000_000;

// The decision for item `id` (its full metadata `meta`), session `session`, client `clientId` (rides in the query:
// mpv fetches start.m3u8 with the token header only). `capKbps` overrides the bitrate (the remote-cap retry).
export function decisionRequest(id: string, meta: PlexMeta, body: PlaybackBody, session: string, clientId: string, capKbps?: number): DecisionRequest {
  const profile = body.DeviceProfile ?? {};
  const sources = toMediaSources(meta);
  const index = Math.max(0, sources.findIndex((s) => s.Id === body.MediaSourceId));
  const source = sources[index];
  const directPlay = body.EnableDirectPlay !== false;
  const directStream = body.EnableDirectStream !== false && body.AllowVideoStreamCopy !== false;
  const startMs = ticksToMs(body.StartTimeTicks);
  const part = partAt(meta, source?.Id, startMs);
  const q: Record<string, string> = {
    path: `/library/metadata/${itemKey(id)}`,
    mediaIndex: String(index),
    partIndex: String(part.index),
    protocol: 'hls',
    directPlay: directPlay ? '1' : '0',
    directStream: directStream ? '1' : '0',
    directStreamAudio: '1',
    session,
    offset: String(Math.floor((startMs - part.startMs) / 1000)),
    hasMDE: '1',
    fastSeek: '1',
    'X-Plex-Client-Identifier': clientId,
  };
  const audio = body.AudioStreamIndex;
  if (typeof audio === 'number' && audio >= 0) q.audioStreamID = String(audio);
  const sub = body.SubtitleStreamIndex;
  if (typeof sub === 'number') q.subtitleStreamID = sub >= 0 ? String(sub) : '0';
  const subCodec = typeof sub === 'number' && sub >= 0 ? source?.MediaStreams?.find((s) => s.Type === 'Subtitle' && s.Index === sub)?.Codec : undefined;
  q.subtitles = burnIn(subCodec, profile, directPlay && directStream) ? 'burn' : 'auto';
  const bps = capKbps ? capKbps * 1000 : Number(body.MaxStreamingBitrate) || 0;
  if (bps > 0 && bps < ORIGINAL_BPS) q.maxVideoBitrate = String(Math.floor(bps / 1000));
  const height = maxHeightOf(profile);
  if (height) q.videoResolution = `${Math.round((height * 16) / 9)}x${height}`;
  return { query: q, profile: profileExtra(profile), mediaIndex: index, ...(part.startMs ? { partStartMs: part.startMs } : {}) };
}

// D-4: the part of a multi-part Media that `ms` falls in (its index in Media.Part, as PMS counts) and where it starts.
// Part 0 at 0 for a single part, or when a duration is missing (nothing to place the start with).
export function partAt(meta: PlexMeta, mediaSourceId: string | undefined, ms: number): { index: number; startMs: number } {
  const media = (meta.Media ?? []).find((m) => String(m.id) === mediaSourceId) ?? meta.Media?.find((m) => (m.Part ?? []).some((p) => p.exists !== false));
  const all = media?.Part ?? [];
  const playable = all.filter((p) => p.key && p.exists !== false && p.accessible !== false);
  const w = playable.length > 1 ? partWindow(playable.map((p) => ({ durationMs: p.duration })), ms) : null;
  return w ? { index: all.indexOf(playable[w.index]), startMs: w.startMs } : { index: Math.max(0, all.indexOf(playable[0])), startMs: 0 };
}

// The part of a multi-part film (D-4, MediaSource.PartPaths) that `ms` falls in: its index, start and end in the
// film (no end for the last part). Null when a part has no duration: nothing to place it with.
export function partWindow(parts: readonly { durationMs?: number }[], ms: number): { index: number; startMs: number; endMs?: number } | null {
  if (!parts.length || parts.some((p) => !p.durationMs)) return null;
  let start = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const end = start + parts[i].durationMs!;
    if (ms < end) return { index: i, startMs: start, endMs: end };
    start = end;
  }
  return { index: parts.length - 1, startMs: start };
}

// The decision fields PMS adds to its MediaContainer.
export interface DecisionContainer extends PlexContainer {
  generalDecisionCode?: number;
  generalDecisionText?: string;
  directPlayDecisionCode?: number;
  transcodeDecisionCode?: number;
  transcodeDecisionText?: string;
}

// The decision answer → PlaybackInfo: the chosen source, direct play through the part, else start.m3u8 (with
// StartTimeTicks: the stream starts at the offset, so the player must not seek there). An answer that plays
// nothing → ErrorCode (its text, from PMS).
export function toPlaybackInfo(answer: DecisionContainer | undefined, meta: PlexMeta, req: DecisionRequest): PlaybackInfoResponse {
  const session = req.query.session;
  const code = Number(answer?.generalDecisionCode ?? 0);
  const part = answer?.Metadata?.[0]?.Media?.[0]?.Part?.[0] as { decision?: string } | undefined;
  const source = toMediaSources(meta)[req.mediaIndex];
  if (!source || code >= 2000 || !part?.decision) return { MediaSources: [], PlaySessionId: session, ErrorCode: answer?.generalDecisionText || answer?.transcodeDecisionText || `Plex decision ${code || 'empty'}` };
  const direct = part.decision === 'directplay';
  const out: MediaSource = { ...source, SupportsDirectPlay: direct, SupportsDirectStream: direct, SupportsTranscoding: true };
  // A multi-part film (D-4): every part, for mpv's one timeline or a player that plays them one after the other
  // (a transcode covers the part the start falls in: partIndex).
  const parts = partPaths(meta, source.Id);
  if (parts.length > 1) out.PartPaths = parts;
  // shortcut: the BIF of a single-part file only (each part has its own); a multi-part film shows no previews.
  else if (playablePart(meta, source.Id)?.indexes === 'sd') out.Bif = true;
  if (!direct) {
    const { 'X-Plex-Client-Identifier': client, ...rest } = req.query;
    // The profile rides along: PMS sizes the transcode from it again when start.m3u8 arrives.
    const qs = new URLSearchParams({ ...rest, 'X-Plex-Client-Identifier': client, 'X-Plex-Client-Profile-Extra': req.profile }).toString();
    out.TranscodingUrl = `/video/:/transcode/universal/start.m3u8?${qs}`;
    out.TranscodingSubProtocol = 'hls';
    const offset = (req.partStartMs ?? 0) + Number(req.query.offset) * 1000;
    if (offset > 0) out.StartTimeTicks = msToTicks(offset);
    // A burned subtitle is part of the picture (playback-service keeps it selected).
    if (req.query.subtitles === 'burn') out.MediaStreams = out.MediaStreams?.map((s) => (s.Type === 'Subtitle' && String(s.Index) === req.query.subtitleStreamID ? { ...s, DeliveryMethod: 'Encode' } : s));
  }
  return { MediaSources: [out], PlaySessionId: session };
}

// Why a decision failed, for the message (plex-spec §9): remote playback needs a pass (403), or the server's
// remote cap is below the request (500 "Cannot make a decision": retry once at the cap, then lowerQuality).
export function decisionFailure(status: number, text: string): 'remoteNeedsPass' | 'lowerQuality' | null {
  if (status === 403) return 'remoteNeedsPass';
  if (status === 500 && /cannot make a decision/i.test(text)) return 'lowerQuality';
  return null;
}

// The owner's remote cap (/:/prefs WanPerStreamMaxUploadRate, kbps; 0 = none).
export function remoteCapKbps(prefs: { Setting?: { id?: string; value?: unknown }[] } | undefined): number {
  const v = Number(prefs?.Setting?.find((s) => s.id === 'WanPerStreamMaxUploadRate')?.value);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

// The tracks picked on a manual change, when they differ from what the part has selected: PUT
// /library/parts/{id}?audioStreamID=&subtitleStreamID=&allParts=1, so PMS remembers them per show (#1326).
export function trackPut(meta: PlexMeta, mediaSourceId: string | undefined, audio: number | undefined, subtitle: number | undefined): { path: string; query: Record<string, string> } | null {
  const media = (meta.Media ?? []).find((m) => String(m.id) === mediaSourceId) ?? meta.Media?.[0];
  const part = media?.Part?.find((p) => p.exists !== false && p.accessible !== false);
  if (!part) return null;
  const streams = part.Stream ?? [];
  const selected = (type: number) => streams.find((s) => s.streamType === type && s.selected)?.id;
  const q: Record<string, string> = {};
  if (typeof audio === 'number' && audio >= 0 && audio !== selected(2) && streams.some((s) => s.id === audio && s.streamType === 2)) q.audioStreamID = String(audio);
  if (typeof subtitle === 'number') {
    const want = subtitle >= 0 ? subtitle : 0;
    if (want !== (selected(3) ?? 0) && (want === 0 || streams.some((s) => s.id === want && s.streamType === 3))) q.subtitleStreamID = String(want);
  }
  if (!Object.keys(q).length) return null;
  return { path: `/library/parts/${part.id}`, query: { ...q, allParts: '1' } };
}

// The parts of a multi-part Media, in order, for one queue under one ratingKey (D-4).
export function partPaths(meta: PlexMeta, mediaSourceId: string | undefined): { path: string; durationMs?: number }[] {
  const media = (meta.Media ?? []).find((m) => String(m.id) === mediaSourceId) ?? meta.Media?.find((m) => (m.Part ?? []).some((p) => p.exists !== false));
  return (media?.Part ?? []).filter((p) => p.key && p.exists !== false && p.accessible !== false).map((p) => ({ path: p.key as string, durationMs: p.duration }));
}
