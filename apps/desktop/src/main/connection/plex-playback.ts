// Playback for the Plex dialect (plex-spec §6, PX-08 and PX-09): what PlexClient answers for PlaybackInfo, the
// session reports, MediaSegments and the media paths of a play (the part, its BIF, a sidecar subtitle). The pure
// rules are in shared/plex/decision.ts; this holds the session state they need: the metadata of the items being
// played (parts, stream ids, markers) and which sessions already stopped or were ended by the server.
import crypto from 'node:crypto';
import type { PlaybackInfoResponse } from '../../shared/models';
import { decisionFailure, decisionRequest, remoteCapKbps, toPlaybackInfo, trackPut, type DecisionContainer, type PlaybackBody } from '../../shared/plex/decision';
import { playablePart, toSegments } from '../../shared/plex/map';
import { QUALITY_PRESETS } from '../../shared/quality-presets';
import { metadataRequest, timelineRequest, type PmsReq } from '../../shared/plex/query';
import type { PlexContainer, PlexMeta } from '../../shared/plex/types';
import { t } from '../i18n';
import { ApiError } from './api-client';

// Sends one PMS request with the server's auth and answers its JSON (a MediaContainer wrapper or the bare one).
export type PmsSend = (req: PmsReq) => Promise<unknown>;

const container = <T = PlexContainer>(raw: unknown): T => ((raw as { MediaContainer?: T } | undefined)?.MediaContainer ?? raw ?? {}) as T;
const KEEP = 32;

export class PlexPlayback {
  // ratingKey → full metadata, most recent last (parts and selected streams for the media paths and track PUTs).
  private readonly metas = new Map<string, PlexMeta>();
  private readonly stopped = new Set<string>();
  private readonly terminated = new Set<string>();

  // The remote cap a refusal taught (kbps): a shared user cannot read the owner's prefs.
  private learnedCap = 0;
  private prefsCap: Promise<number> | null = null;

  constructor(
    private readonly send: PmsSend,
    private readonly clientId: string,
    // Reached through a remote or relay address (plex-spec §6.2: the server's remote cap applies).
    private readonly remote = false,
  ) {}

  private remember(meta: PlexMeta): PlexMeta {
    this.metas.delete(meta.ratingKey);
    this.metas.set(meta.ratingKey, meta);
    if (this.metas.size > KEEP) this.metas.delete(this.metas.keys().next().value!);
    return meta;
  }

  async meta(id: string): Promise<PlexMeta> {
    const meta = container(await this.send(metadataRequest(id))).Metadata?.[0];
    if (!meta) throw new ApiError(t('plex.errors.fileUnavailable'), 404);
    return this.remember(meta);
  }

  private async decide(req: ReturnType<typeof decisionRequest>): Promise<DecisionContainer> {
    return container<DecisionContainer>(await this.send({ method: 'GET', path: '/video/:/transcode/universal/decision', query: req.query, headers: { 'X-Plex-Client-Profile-Extra': req.profile } }));
  }

  // The owner's remote cap (/:/prefs WanPerStreamMaxUploadRate, kbps), read once; 0 for a shared user (403) or none.
  private ownerCap(): Promise<number> {
    return (this.prefsCap ??= this.send({ method: 'GET', path: '/:/prefs', query: {} }).then((r) => remoteCapKbps(container(r)), () => 0));
  }

  // POST /Items/{id}/PlaybackInfo: one decision for every quality (Original included). A remote session starts at the
  // server's remote cap (§6.2: the owner's prefs, or the cap a refusal taught for a shared user); a refusal anyway
  // ("Cannot make a decision", §6.1.3) retries at the owner's cap, else down the quality presets, and the one that
  // plays is kept for the next remote play. The remote-pass gate is explained, never worked around.
  async playbackInfo(id: string, query: Record<string, unknown> = {}, body: Record<string, unknown> = {}): Promise<PlaybackInfoResponse> {
    const merged = { ...query, ...body } as PlaybackBody;
    const meta = await this.meta(id);
    // The next part of a multi-part film keeps the session of the part before (D-4: one viewing, one session).
    const session = typeof merged.PlaySessionId === 'string' && /^[\w-]{1,64}$/.test(merged.PlaySessionId) ? merged.PlaySessionId : crypto.randomUUID();
    const want = Math.floor((Number(merged.MaxStreamingBitrate) || 0) / 1000);
    const cap = this.remote ? this.learnedCap || (await this.ownerCap()) : 0;
    const first = cap && (!want || want > cap) ? cap : undefined;
    let req = decisionRequest(id, meta, merged, session, this.clientId, first);
    let answer: DecisionContainer | undefined;
    try {
      answer = await this.decide(req);
    } catch (err) {
      const why = err instanceof ApiError ? decisionFailure(err.status, err.message) : null;
      if (why === 'remoteNeedsPass') throw new ApiError(t('plex.errors.remoteNeedsPass'), 403);
      if (why !== 'lowerQuality') throw err;
      const tried = first ?? want;
      const owner = await this.ownerCap();
      const ladder = [...new Set([owner, ...QUALITY_PRESETS.map((p) => p.bitrate / 1000)])].filter((k) => k > 0 && (!tried || k < tried)).sort((a, b) => b - a);
      for (const kbps of ladder) {
        req = decisionRequest(id, meta, merged, session, this.clientId, kbps);
        try {
          answer = await this.decide(req);
          this.learnedCap = kbps;
          break;
        } catch (e) {
          const again = e instanceof ApiError ? decisionFailure(e.status, e.message) : null;
          if (again === 'lowerQuality') continue;
          throw again ? new ApiError(t(`plex.errors.${again}`), (e as ApiError).status) : e;
        }
      }
      if (!answer) throw new ApiError(t('plex.errors.lowerQuality'), 500);
    }
    const info = toPlaybackInfo(answer, meta, req);
    if (info.MediaSources[0]?.TranscodingUrl) info.PlexPass = await this.plexPass();
    return info;
  }

  private pass: Promise<boolean | undefined> | null = null;
  // The server owner's Plex Pass (the PMS root's myPlexSubscription): markers and hardware transcoding need it.
  plexPass(): Promise<boolean | undefined> {
    this.pass ??= this.send({ method: 'GET', path: '/', query: {} }).then(
      (r) => {
        const v = container<{ myPlexSubscription?: boolean | number | string }>(r).myPlexSubscription;
        return v === undefined ? undefined : v === true || v === 1 || v === '1' || v === 'true';
      },
      () => undefined,
    );
    return this.pass;
  }

  // /Sessions/Playing[/Progress|/Stopped] → /:/timeline. Exactly one stopped per session and nothing after it or
  // after the server ended it; a manual track change is also stored on the part (#1326). A termination comes back
  // as TerminationText.
  async timeline(event: '' | 'Progress' | 'Stopped', body: Record<string, unknown> = {}): Promise<{ TerminationText?: string }> {
    const session = String(body.PlaySessionId ?? '');
    if (session && (this.terminated.has(session) || this.stopped.has(session))) return {};
    if (event === 'Stopped' && session) this.stopped.add(session);
    const answer = container<{ terminationCode?: number; terminationText?: string }>(await this.send(timelineRequest(event, body)));
    if (event === 'Progress' && (body.EventName === 'AudioTrackChange' || body.EventName === 'SubtitleTrackChange')) await this.storeTracks(body);
    if (answer.terminationCode !== undefined || answer.terminationText) {
      if (session) this.terminated.add(session);
      return { TerminationText: answer.terminationText || t('plex.errors.terminated') };
    }
    return {};
  }

  private async storeTracks(body: Record<string, unknown>): Promise<void> {
    const meta = this.metas.get(String(body.ItemId));
    if (!meta) return;
    const msid = body.MediaSourceId === undefined ? undefined : String(body.MediaSourceId);
    const audio = typeof body.AudioStreamIndex === 'number' ? body.AudioStreamIndex : undefined;
    const sub = typeof body.SubtitleStreamIndex === 'number' ? body.SubtitleStreamIndex : undefined;
    const put = trackPut(meta, msid, audio, sub);
    if (!put) return;
    await this.send({ method: 'PUT', path: put.path, query: put.query });
    // What PMS now has selected, so the same pick is not sent again.
    const part = (meta.Media ?? []).flatMap((m) => m.Part ?? []).find((p) => `/library/parts/${p.id}` === put.path);
    for (const s of part?.Stream ?? []) {
      if (s.streamType === 2 && put.query.audioStreamID) s.selected = String(s.id) === put.query.audioStreamID;
      if (s.streamType === 3 && put.query.subtitleStreamID) s.selected = String(s.id) === put.query.subtitleStreamID;
    }
  }

  // /MediaSegments/{id}: intro and credits markers (a Plex Pass analysis on the server; none without it).
  async segments(id: string): Promise<ReturnType<typeof toSegments> & { PlexPass?: boolean }> {
    const out = toSegments(await this.meta(id));
    return out.Items.length ? out : { ...out, PlexPass: await this.plexPass() };
  }

  // A media route of a play → its PMS path: the part (direct play, cast), its BIF, a sidecar subtitle. Null when the
  // item was not seen yet (mediaPathAsync reads it first) or has no such file.
  mediaPath(op: string, params: Record<string, string>, query: Record<string, string>): string | null {
    const meta = this.metas.get(params.id ?? '');
    if (!meta) return null;
    const part = playablePart(meta, query.MediaSourceId ?? query.mediaSourceId);
    if (op === 'stream' || op === 'download') return part?.key ? `${part.key}${op === 'download' ? '?download=1' : ''}` : null;
    if (op === 'bif') return part?.indexes === 'sd' ? `/library/parts/${part.id}/indexes/sd` : null;
    if (op === 'subtitle') {
      const s = (meta.Media ?? []).flatMap((m) => m.Part ?? []).flatMap((p) => p.Stream ?? []).find((x) => String(x.id) === params.index && x.streamType === 3);
      // shortcut: sidecar subtitles only; an embedded one would need PMS's subtitle transcoder.
      return s?.key ?? null;
    }
    return null;
  }

  async mediaPathAsync(op: string, params: Record<string, string>, query: Record<string, string>): Promise<string | null> {
    if (!this.metas.has(params.id ?? '')) await this.meta(params.id ?? '').catch(() => undefined);
    return this.mediaPath(op, params, query);
  }
}
