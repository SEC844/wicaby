// Live TV and DVR for the Plex dialect (plex-spec §7, PX-11): what PlexClient answers for the Emby-shaped /LiveTv
// calls, a live channel's PlaybackInfo (the tune) and its reports. The pure mapping is shared/plex/livetv-map.ts; this
// holds what it needs between calls: the DVRs, the channel → DVR map, a short-lived grid cache, and the programmes the
// guide showed (detail, record defaults, the guid a recording is created from). Every PMS shape is unverified
// (PLEX-LIVETV-UNVERIFIED in livetv-map.ts).
import crypto from 'node:crypto';
import type { BaseItem, PlaybackInfoResponse } from '../../shared/models';
import {
  channelsRequest,
  createRequest,
  deleteRecordingRequests,
  deleteRequest,
  gridRequest,
  isRecording,
  liveDvrs,
  liveGate,
  parseLiveId,
  parseTimerId,
  programWindow,
  recordingRequests,
  selectPrograms,
  templateRequest,
  timerDefaults,
  toChannels,
  toLiveInfo,
  toLivePlayback,
  toPrograms,
  toSeriesTimer,
  toSeriesTimers,
  toTimers,
  tuneRequest,
  updateRequest,
  type LiveDvr,
} from '../../shared/plex/livetv-map';
import { itemKey, PlexUnmapped, transcodeRequest, type PmsReq, type Query } from '../../shared/plex/query';
import type { PlexContainer, PlexMeta } from '../../shared/plex/types';
import { logger } from '../core/log';
import { ApiError } from './api-client';

const log = logger.scope('plex-livetv');

type J = Record<string, unknown>;
const TTL_MS = 60_000;
const GRID_TTL_MS = 60_000;
const MAX_PROGRAMS = 5000;

export interface PlexLiveDeps {
  send(r: PmsReq): Promise<PlexContainer | undefined>;
  clientId: string;
  plexPass(): Promise<boolean | undefined>;
  items(metas: PlexMeta[]): Promise<BaseItem[]>;
}

const list = (Items: unknown[]) => ({ Items, TotalRecordCount: Items.length, StartIndex: 0 });

export class PlexLiveTv {
  private dvrList: { at: number; list: Promise<LiveDvr[]> } | null = null;
  private channelList: { at: number; list: Promise<{ channels: J[]; dvrOf: Map<string, LiveDvr> }> } | null = null;
  private grids = new Map<string, { at: number; list: Promise<J[]> }>();
  private programs = new Map<string, J>();
  private loggedGate = '';

  constructor(private readonly d: PlexLiveDeps) {}

  // Without Plex Pass PMS refuses the DVR list (401/403): no DVR then, so no Live TV.
  private dvrs(): Promise<LiveDvr[]> {
    if (this.dvrList && Date.now() - this.dvrList.at < TTL_MS) return this.dvrList.list;
    const p = this.d.send({ method: 'GET', path: '/livetv/dvrs', query: {} }).then(
      (c) => liveDvrs(c as J | undefined),
      (err) => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) return [];
        throw err;
      },
    );
    this.dvrList = { at: Date.now(), list: p };
    p.catch(() => (this.dvrList = null));
    return p;
  }

  // The capability: Plex Pass on the owner and a tuner (plex-spec §7). The reason is logged once when it changes.
  async info(): Promise<J> {
    const [dvrs, pass] = await Promise.all([this.dvrs(), this.d.plexPass()]);
    const gate = liveGate(dvrs, pass);
    if (gate !== this.loggedGate) log.info(gate === 'ok' ? 'Live TV on (Plex Pass and a tuner)' : gate === 'noPass' ? 'Live TV off: the server owner has no Plex Pass' : 'Live TV off: no DVR tuner on this server');
    this.loggedGate = gate;
    return toLiveInfo(dvrs, pass);
  }

  async enabled(): Promise<boolean> {
    return (await this.info().catch(() => ({ IsEnabled: false }))).IsEnabled === true;
  }

  private channels(): Promise<{ channels: J[]; dvrOf: Map<string, LiveDvr> }> {
    if (this.channelList && Date.now() - this.channelList.at < TTL_MS) return this.channelList.list;
    const p = (async () => {
      const dvrs = await this.dvrs();
      const parts = await Promise.all(dvrs.map((d) => this.d.send(channelsRequest(d)).then((c) => toChannels(c as J | undefined, d))));
      const channels: J[] = [];
      const dvrOf = new Map<string, LiveDvr>();
      // shortcut: a channel two DVRs share is the first DVR's (one tune target); pick by free tuner if PMS ever says.
      parts.forEach((list, i) => {
        for (const ch of list) {
          if (dvrOf.has(String(ch.Id))) continue;
          dvrOf.set(String(ch.Id), dvrs[i]);
          channels.push(ch);
        }
      });
      return { channels, dvrOf };
    })();
    this.channelList = { at: Date.now(), list: p };
    p.catch(() => (this.channelList = null));
    return p;
  }

  // Every enabled channel's programmes in [from, to], from each DVR's grid (one request per EPG and window, cached).
  private async guide(from: number, to: number): Promise<J[]> {
    const [{ dvrOf }, dvrs] = await Promise.all([this.channels(), this.dvrs()]);
    const epgs = [...new Map(dvrs.map((d) => [d.epg, d])).values()];
    const now = Date.now();
    for (const [k, g] of this.grids) if (now - g.at > GRID_TTL_MS) this.grids.delete(k);
    const parts = await Promise.all(
      epgs.map((d) => {
        const key = `${d.epg}|${from}|${to}`;
        let g = this.grids.get(key);
        if (!g) {
          g = { at: now, list: this.d.send(gridRequest(d, from, to)).then((c) => toPrograms(c as J | undefined)) };
          this.grids.set(key, g);
          g.list.catch(() => this.grids.delete(key));
        }
        return g.list;
      }),
    );
    const out = parts.flat().filter((p) => dvrOf.has(String(p.ChannelId)));
    for (const p of out) this.remember(p);
    return out;
  }

  private remember(p: J): void {
    const id = String(p.Id);
    this.programs.delete(id);
    this.programs.set(id, p);
    if (this.programs.size > MAX_PROGRAMS) this.programs.delete(this.programs.keys().next().value!);
  }

  private program(id: string): J {
    const p = this.programs.get(id);
    if (!p) throw new ApiError('Programme not in the guide', 404);
    return p;
  }

  private subscriptions(): Promise<J | undefined> {
    return this.d.send({ method: 'GET', path: '/media/subscriptions', query: {} }) as Promise<J | undefined>;
  }

  private async timers(): Promise<J[]> {
    const [scheduled, subs] = await Promise.all([this.d.send({ method: 'GET', path: '/media/subscriptions/scheduled', query: {} }), this.subscriptions()]);
    return toTimers(scheduled as J | undefined, subs);
  }

  // The global search's Live TV half (GET /Users/{user}/Items?IncludeItemTypes=TvChannel,LiveTvProgram): the channels
  // whose name or number holds the term, then the programmes of the next 24 h whose title does. Empty when Live TV is off.
  async search(query: Query): Promise<ReturnType<typeof list>> {
    const term = String(query.SearchTerm ?? '').trim().toLowerCase();
    if (!term || !(await this.enabled())) return list([]);
    const now = Date.now();
    const { channels } = await this.channels();
    const name = new Map(channels.map((c) => [String(c.Id), c.Name]));
    const chans = channels.filter((c) => String(c.Name).toLowerCase().includes(term) || String(c.ChannelNumber).toLowerCase() === term);
    // An hour-aligned window, so the keystrokes of one search share the cached grid.
    const from = Math.floor(now / 3_600_000) * 3_600_000;
    const to = from + 25 * 3_600_000;
    const window = { SearchTerm: term, MinEndDate: new Date(now).toISOString(), MaxStartDate: new Date(to).toISOString() };
    const progs = selectPrograms(await this.guide(from, to), window, now).map((p) => ({ ...p, ChannelName: name.get(String(p.ChannelId)) }));
    const limit = Number(query.Limit) || 20;
    return list([...chans, ...progs].slice(0, limit));
  }

  // ---- The routes (shared/plex/routes.ts 'live*' ops) ----

  async answer(op: string, params: Record<string, string>, query: Query, body: J | undefined): Promise<unknown> {
    switch (op) {
      case 'liveInfo':
        return this.info();
      // The grid's length is not known before it is read: the guide keeps its own default range.
      case 'liveGuideInfo':
        return {};
      case 'liveChannels': {
        for (const k of ['IsMovie', 'IsSeries', 'IsSports', 'IsNews', 'IsKids', 'IsNewOrPremiere']) if (query[k] !== undefined) throw new PlexUnmapped(`LiveTv/Channels ${k}`);
        const { channels } = await this.channels();
        const start = Number(query.StartIndex) || 0;
        const limit = Number(query.Limit) || channels.length;
        return { Items: channels.slice(start, start + limit), TotalRecordCount: channels.length, StartIndex: start };
      }
      case 'livePrograms': {
        const now = Date.now();
        const { from, to } = programWindow(query, now);
        return list(selectPrograms(await this.guide(from, to), query, now));
      }
      case 'liveProgram':
        return this.program(params.id);
      case 'liveTimerDefaults':
        return timerDefaults(this.program(String(query.ProgramId ?? '')));
      case 'liveTimers': {
        const timers = await this.timers();
        return list(query.SeriesTimerId ? timers.filter((t) => t.SeriesTimerId === String(query.SeriesTimerId)) : timers);
      }
      // The record-options sheet reads the timer before editing its padding.
      case 'liveTimer': {
        const t = (await this.timers()).find((x) => x.Id === params.id);
        if (!t) throw new ApiError('Not found', 404);
        return t;
      }
      case 'liveSeriesTimers':
        return list(toSeriesTimers(await this.subscriptions()));
      case 'liveSeriesTimer': {
        const c = (await this.d.send({ method: 'GET', path: `/media/subscriptions/${encodeURIComponent(params.id)}`, query: {} })) as J | undefined;
        const rule = toSeriesTimer(((c?.MediaSubscription as J[] | undefined) ?? [])[0] ?? {});
        if (!rule) throw new ApiError('Not found', 404);
        return rule;
      }
      case 'liveCreateTimer':
      case 'liveCreateSeriesTimer': {
        const b = body ?? {};
        const guid = this.program(String(b.ProgramId ?? '')).PlexGuid;
        if (typeof guid !== 'string') throw new PlexUnmapped('a programme without a guid cannot be recorded');
        const template = (await this.d.send(templateRequest(guid))) as J | undefined;
        await this.d.send(createRequest(template, op === 'liveCreateSeriesTimer', b));
        return undefined;
      }
      case 'liveUpdateTimer':
      case 'liveCancelTimer': {
        const t = parseTimerId(params.id);
        if (!t) throw new PlexUnmapped(`timer ${params.id}`);
        // Plex changes or cancels whole subscriptions: one airing of a series rule stays as the rule says.
        if (t.airing) throw new PlexUnmapped('one airing of a Plex series rule');
        await this.d.send(op === 'liveCancelTimer' ? deleteRequest(t.sub) : updateRequest(t.sub, body ?? {}, false));
        return undefined;
      }
      case 'liveUpdateSeriesTimer':
        if (!/^\d{1,12}$/.test(params.id)) throw new PlexUnmapped(`subscription ${params.id}`);
        await this.d.send(updateRequest(params.id, body ?? {}, true));
        return undefined;
      case 'liveRecordings': {
        if (query.IsInProgress !== undefined) return list([]);
        const subs = await this.subscriptions();
        const parts = await Promise.all(recordingRequests(subs).map((r) => this.d.send(r)));
        const metas = parts.flatMap((c) => c?.Metadata ?? []).filter((m) => isRecording(m as unknown as J, subs));
        return list(await this.d.items(metas));
      }
      // Only a listed recording, and only its recorded versions (deleteRecordingRequests): never the user's own media.
      case 'liveDeleteRecording': {
        const [c, subs] = await Promise.all([this.d.send({ method: 'GET', path: `/library/metadata/${itemKey(params.id)}`, query: {} }), this.subscriptions()]);
        const reqs = deleteRecordingRequests((c?.Metadata?.[0] ?? {}) as unknown as J, subs);
        if (!reqs.length) throw new ApiError('Not a recording', 404);
        for (const r of reqs) await this.d.send(r);
        return undefined;
      }
      default:
        throw new PlexUnmapped(`Live TV ${op}`);
    }
  }

  // POST /Items/{channel}/PlaybackInfo: tune the channel on its DVR.
  async tune(channelId: string, query: Query, body: J | undefined): Promise<PlaybackInfoResponse> {
    const live = parseLiveId(channelId);
    const dvr = (await this.channels()).dvrOf.get(channelId);
    if (!live || live.beginsAt !== undefined || !dvr) throw new ApiError('Not a channel of this server', 404);
    const merged: J = { ...query, ...body };
    const session = typeof merged.PlaySessionId === 'string' && /^[\w-]{1,64}$/.test(merged.PlaySessionId) ? merged.PlaySessionId : crypto.randomUUID();
    const c = (await this.d.send(tuneRequest(dvr, live.ident))) as J | undefined;
    return toLivePlayback(c, channelId, merged, session, this.d.clientId);
  }

  // A live play's reports: nothing to tell PMS while it plays (the HLS fetches keep the transcode alive); Stopped
  // stops the transcode, which frees the tuner.
  async report(event: '' | 'Progress' | 'Stopped', body: J | undefined): Promise<J> {
    if (event === 'Stopped') await this.d.send(transcodeRequest('stop', String(body?.PlaySessionId ?? '')));
    return {};
  }
}
