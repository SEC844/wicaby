// Plex Live TV and DVR (plex-spec §7, PX-11): the pure half of the adapter that answers the Emby-shaped Live TV calls
// (shared/livetv/dialect.ts) from a PMS. PlexClient's PlexLiveTv (main/connection/plex-livetv.ts) sends these
// requests and maps the answers with these functions; C/plex/LiveTvMap.kt is the Kotlin twin (vectors:
// tools/checks/fixtures/plex/livetv.json).
//
// PLEX-LIVETV-UNVERIFIED: every PMS path, query and field carrying this tag comes from the public developer.plex.tv
// documentation and was never checked against a real PMS with a tuner (the PX-11 capture gate is still open). The mock
// (tools/mock-server/mock-plex.mjs, MOCK_PLEX_LIVETV=1) answers the same guesses, so the checks prove the mapping, not
// the shapes. Grep the tag before trusting one.
//
// Live TV is on for a plex server only when the owner has Plex Pass (the PMS root's myPlexSubscription) and a DVR
// lists at least one tuner; otherwise /LiveTv/Info says IsEnabled false and the section stays hidden.
import { epochToIso } from './map';
import { PlexUnmapped, type PmsReq, type Query } from './query';
import type { PlaybackInfoResponse } from '../models';

type J = Record<string, unknown>;

const arr = (v: unknown): J[] => (Array.isArray(v) ? v.filter((x): x is J => !!x && typeof x === 'object' && !Array.isArray(x)) : []);
const obj = (v: unknown): J | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? (v === '' ? undefined : v) : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const on = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';
const enc = encodeURIComponent;

// ---- Ids ----

// Every id passes validId ([A-Za-z0-9-]{1,64}): a channel identifier ("5.1") rides hex-encoded.
export function liveChannelId(ident: string): string | null {
  if (!/^[!-~]{1,20}$/.test(ident)) return null;
  let h = '';
  for (let i = 0; i < ident.length; i++) h += ident.charCodeAt(i).toString(16).padStart(2, '0');
  return `livetv-${h}`;
}

// A channel id, or a programme id (its channel and start, epoch seconds). Null for anything else.
export function parseLiveId(id: string): { ident: string; beginsAt?: number } | null {
  const m = /^livetv-((?:[0-9a-f]{2}){1,20})(?:-(\d{1,12}))?$/.exec(id);
  if (!m) return null;
  let ident = '';
  for (let i = 0; i < m[1].length; i += 2) ident += String.fromCharCode(parseInt(m[1].slice(i, i + 2), 16));
  if (!/^[!-~]+$/.test(ident)) return null;
  return m[2] ? { ident, beginsAt: Number(m[2]) } : { ident };
}

// ---- DVRs and the capability ----

export interface LiveDvr {
  key: string;
  lineup: string;
  epg: string;
  tuners: number;
  // The enabled channel identifiers (ChannelMapping, #489); null when the DVR sends no mapping (every lineup channel).
  enabled: string[] | null;
}

// PLEX-LIVETV-UNVERIFIED: GET /livetv/dvrs → Dvr[] {key, lineup, epgIdentifier, Device[] {tuners, ChannelMapping[]
// {lineupIdentifier, enabled}}}.
export function liveDvrs(c: J | undefined): LiveDvr[] {
  const out: LiveDvr[] = [];
  for (const d of arr(c?.Dvr)) {
    const key = str(d.key);
    const lineup = str(d.lineup);
    const epg = str(d.epgIdentifier);
    if (!key || !lineup || !epg) continue;
    const devices = arr(d.Device);
    const maps = devices.flatMap((x) => arr(x.ChannelMapping));
    const tuners = devices.reduce((n, x) => n + (num(x.tuners) ?? 1), 0);
    const enabled = maps.length ? maps.filter((m) => on(m.enabled)).flatMap((m) => str(m.lineupIdentifier) ?? []) : null;
    out.push({ key, lineup, epg, tuners, enabled });
  }
  return out;
}

// /LiveTv/Info. Without Plex Pass PMS may also refuse /livetv/dvrs (403): the adapter passes [] then.
export function toLiveInfo(dvrs: readonly LiveDvr[], pass: boolean | undefined): J {
  const tuners: string[] = [];
  for (const d of dvrs) for (let i = 0; i < d.tuners; i++) tuners.push(`${d.key}-${i}`);
  const enabled = pass === true && tuners.length > 0;
  const info: J = { IsEnabled: enabled, EnabledUsers: [], Services: enabled ? [{ Name: 'Plex DVR', Status: 'Ok', Tuners: tuners }] : [] };
  if (typeof pass === 'boolean') info.PlexPass = pass;
  return info;
}

// Why Live TV is off, for the log ('ok' when it is on).
export function liveGate(dvrs: readonly LiveDvr[], pass: boolean | undefined): 'ok' | 'noPass' | 'noTuner' {
  if (pass !== true) return 'noPass';
  return dvrs.some((d) => d.tuners > 0) ? 'ok' : 'noTuner';
}

// ---- Channels ----

// PLEX-LIVETV-UNVERIFIED: GET /livetv/epg/channels?lineup= → Channel[] {identifier, title, callSign, channelVcn}.
export const channelsRequest = (d: LiveDvr): PmsReq => ({ method: 'GET', path: '/livetv/epg/channels', query: { lineup: d.lineup } });

// The DVR's enabled lineup channels as Emby channels. shortcut: no logos (lineup thumbs point at the EPG provider, not
// the PMS); add them through /photo/:/transcode once a real capture shows the field.
export function toChannels(c: J | undefined, d: LiveDvr): J[] {
  const out: J[] = [];
  for (const ch of arr(c?.Channel)) {
    const ident = str(ch.identifier);
    const id = ident ? liveChannelId(ident) : null;
    if (!ident || !id || (d.enabled && !d.enabled.includes(ident))) continue;
    out.push({ Id: id, Name: str(ch.title) ?? str(ch.callSign) ?? ident, ChannelNumber: str(ch.channelVcn) ?? ident, Type: 'TvChannel', ChannelType: 'TV' });
  }
  return out;
}

// ---- Guide ----

// PLEX-LIVETV-UNVERIFIED: GET /{epgIdentifier}/grid?type=1,4 with the PMS filter operators endsAt>> and beginsAt<<
// (epoch seconds). One request covers every channel of the lineup; selectPrograms() trims it to the Emby query.
export function gridRequest(d: LiveDvr, from: number, to: number): PmsReq {
  if (!/^[\w.:-]{1,128}$/.test(d.epg)) throw new PlexUnmapped(`EPG provider ${d.epg}`);
  return { method: 'GET', path: `/${d.epg}/grid`, query: { type: '1,4', sort: 'beginsAt', 'endsAt>>': String(Math.floor(from / 1000)), 'beginsAt<<': String(Math.floor(to / 1000) + 1) } };
}

// PLEX-LIVETV-UNVERIFIED: grid Metadata[] {type (movie | episode), title, grandparentTitle, parentIndex, index, summary,
// year, guid, Genre[], Media[] {channelIdentifier, beginsAt, endsAt, premiere}}: one Emby programme per airing (Media).
// PlexGuid is not Emby's: the adapter needs it to record the programme.
export function toPrograms(c: J | undefined): J[] {
  const out: J[] = [];
  for (const m of arr(c?.Metadata)) {
    const episode = m.type === 'episode';
    const title = str(m.title);
    const genres = arr(m.Genre).flatMap((g) => str(g.tag) ?? []);
    for (const md of arr(m.Media)) {
      const ident = str(md.channelIdentifier);
      const ch = ident ? liveChannelId(ident) : null;
      const b = num(md.beginsAt);
      const e = num(md.endsAt);
      if (!ch || b === undefined || e === undefined || !Number.isInteger(b) || b <= 0 || e <= b) continue;
      const p: J = { Id: `${ch}-${b}`, ChannelId: ch, StartDate: epochToIso(b), EndDate: epochToIso(e), Name: (episode ? str(m.grandparentTitle) : undefined) ?? title ?? '', Type: 'Program' };
      if (episode && title) p.EpisodeTitle = title;
      const season = num(m.parentIndex);
      if (episode && season !== undefined && Number.isInteger(season)) p.ParentIndexNumber = season;
      const ep = num(m.index);
      if (episode && ep !== undefined && Number.isInteger(ep)) p.IndexNumber = ep;
      const summary = str(m.summary);
      if (summary) p.Overview = summary;
      const year = num(m.year);
      if (year !== undefined && Number.isInteger(year)) p.ProductionYear = year;
      if (genres.length) p.Genres = genres;
      p.IsMovie = m.type === 'movie';
      p.IsSeries = episode;
      if (on(md.premiere)) p.IsPremiere = true;
      const guid = str(m.guid);
      if (guid) p.PlexGuid = guid;
      out.push(p);
    }
  }
  return out.sort((a, b) => cmp(a.StartDate, b.StartDate) || cmp(a.Id, b.Id));
}

const cmp = (a: unknown, b: unknown): number => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

// The Emby /LiveTv/Programs query keys the adapter honours; any other one (IsSports, LibrarySeriesId…) is unmapped
// rather than ignored, since an ignored filter would be a wrong answer. Categories: films and series only (the grid's
// type), the rest stays hidden.
const PROGRAM_KEYS = new Set(['UserId', 'userId', 'ChannelIds', 'MinEndDate', 'MaxStartDate', 'MinStartDate', 'SortBy', 'Limit', 'EnableImages', 'EnableImageTypes', 'ImageTypeLimit', 'EnableUserData', 'EnableTotalRecordCount', 'Fields', 'SearchTerm', 'IsAiring', 'IsMovie', 'IsSeries']);

// The guide window an Emby programme query covers (ms): IsAiring is now; else MinEndDate (or MinStartDate) to MaxStartDate.
export function programWindow(q: Query, now: number): { from: number; to: number } {
  if (on(q.IsAiring)) return { from: now, to: now };
  const to = Date.parse(String(q.MaxStartDate ?? ''));
  if (!Number.isFinite(to)) throw new PlexUnmapped('LiveTv/Programs without MaxStartDate');
  const minEnd = Date.parse(String(q.MinEndDate ?? ''));
  const minStart = Date.parse(String(q.MinStartDate ?? ''));
  return { from: Number.isFinite(minEnd) ? minEnd : Number.isFinite(minStart) ? minStart : now, to };
}

// The programmes of `all` (toPrograms output) an Emby /LiveTv/Programs query asks for, in start order.
export function selectPrograms(all: readonly J[], q: Query, now: number): J[] {
  for (const k of Object.keys(q)) if (q[k] !== undefined && !PROGRAM_KEYS.has(k)) throw new PlexUnmapped(`LiveTv/Programs ${k}`);
  const { from, to } = programWindow(q, now);
  const minStart = Date.parse(String(q.MinStartDate ?? ''));
  const channels = q.ChannelIds ? new Set(String(q.ChannelIds).split(',')) : null;
  const term = String(q.SearchTerm ?? '').trim().toLowerCase();
  const out = all.filter((p) => {
    const s = Date.parse(String(p.StartDate));
    const e = Date.parse(String(p.EndDate));
    if (!(e > from && s <= to) || (Number.isFinite(minStart) && s < minStart)) return false;
    if (channels && !channels.has(String(p.ChannelId))) return false;
    if (on(q.IsMovie) && p.IsMovie !== true) return false;
    if (on(q.IsSeries) && p.IsSeries !== true) return false;
    return !term || String(p.Name ?? '').toLowerCase().includes(term) || String(p.EpisodeTitle ?? '').toLowerCase().includes(term);
  });
  const limit = num(q.Limit);
  return limit !== undefined && limit > 0 ? out.slice(0, limit) : out;
}

// GET /LiveTv/Timers/Defaults?ProgramId=: what Emby's defaults carry, from the programme the guide showed.
export function timerDefaults(p: J): J {
  return { ProgramId: p.Id, ChannelId: p.ChannelId, StartDate: p.StartDate, EndDate: p.EndDate, Name: p.Name, PrePaddingSeconds: 0, PostPaddingSeconds: 0, RecordAnyChannel: false, RecordAnyTime: true, RecordNewOnly: false, KeepUpTo: 0 };
}

// ---- Subscriptions (timers and series rules, #530) ----

const pref = (s: J, id: string): unknown => arr(s.Setting).find((x) => x.id === id)?.value;
const subKey = (s: J): string | undefined => {
  const k = str(s.key);
  return k && /^\d{1,12}$/.test(k) ? k : undefined;
};
// A subscription of type 2 (a show) is a series rule; 1 (a film) and 4 (an episode) record one airing.
const isSeries = (s: J): boolean => num(s.type) === 2;
const paddingS = (s: J, id: string): number => (num(pref(s, id)) ?? 0) * 60;

// PLEX-LIVETV-UNVERIFIED: MediaGrabOperation.status values.
const TIMER_STATUS: ReadonlyMap<string, string> = new Map([
  ['scheduled', 'New'],
  ['inprogress', 'InProgress'],
  ['error', 'Error'],
  ['complete', 'Completed'],
  ['blocked', 'ConflictedNotOk'],
]);

// Timer ids: 'rec-{subscription}' for a one-airing subscription, 'rec-{subscription}-{beginsAt}' for an airing of a
// series rule (Plex cancels whole subscriptions only).
export function parseTimerId(id: string): { sub: string; airing?: string } | null {
  const m = /^rec-(\d{1,12})(?:-(\d{1,12}))?$/.exec(id);
  return m ? (m[2] ? { sub: m[1], airing: m[2] } : { sub: m[1] }) : null;
}

// PLEX-LIVETV-UNVERIFIED: GET /media/subscriptions → MediaSubscription[] {key, type, title, Setting[] {id, value},
// Directory | Video {guid, title}}; GET /media/subscriptions/scheduled → MediaGrabOperation[] {mediaSubscriptionID,
// status, Metadata {…grid metadata, Media[0] the airing}}.
export function toTimers(scheduled: J | undefined, subs: J | undefined): J[] {
  const byKey = new Map<string, J>();
  for (const s of arr(subs?.MediaSubscription)) {
    const k = subKey(s);
    if (k) byKey.set(k, s);
  }
  const out: J[] = [];
  for (const op of arr(scheduled?.MediaGrabOperation)) {
    const k = str(op.mediaSubscriptionID);
    const sub = k ? byKey.get(k) : undefined;
    const meta = obj(op.Metadata);
    const p = meta ? toPrograms({ Metadata: [{ ...meta, Media: arr(meta.Media).slice(0, 1) }] })[0] : undefined;
    if (!k || !sub || !p) continue;
    const series = isSeries(sub);
    const beginsAt = String(p.Id).split('-').pop();
    const t: J = { Id: series ? `rec-${k}-${beginsAt}` : `rec-${k}`, ProgramId: p.Id, ChannelId: p.ChannelId, StartDate: p.StartDate, EndDate: p.EndDate, Name: p.Name, Status: TIMER_STATUS.get(String(op.status)) ?? 'New', PrePaddingSeconds: paddingS(sub, 'startOffsetMinutes'), PostPaddingSeconds: paddingS(sub, 'endOffsetMinutes') };
    if (series) t.SeriesTimerId = k;
    out.push(t);
  }
  return out;
}

// One series rule as Emby's SeriesTimerInfo, or null for a one-airing subscription.
export function toSeriesTimer(s: J): J | null {
  const k = subKey(s);
  if (!k || !isSeries(s)) return null;
  const hint = obj(s.Directory) ?? obj(s.Video);
  const lineup = str(pref(s, 'lineupChannel'));
  const channel = lineup ? liveChannelId(lineup) : null;
  const rule: J = {
    Id: k,
    Type: 'SeriesTimer',
    Name: str(s.title) ?? str(hint?.title) ?? '',
    RecordAnyChannel: !channel,
    RecordAnyTime: true,
    RecordNewOnly: on(pref(s, 'onlyNewAirings')),
    PrePaddingSeconds: paddingS(s, 'startOffsetMinutes'),
    PostPaddingSeconds: paddingS(s, 'endOffsetMinutes'),
    KeepUpTo: 0,
    Priority: 0,
  };
  if (channel) rule.ChannelId = channel;
  return rule;
}

export const toSeriesTimers = (subs: J | undefined): J[] => arr(subs?.MediaSubscription)
  .map(toSeriesTimer)
  .filter((x): x is J => x !== null);

// PLEX-LIVETV-UNVERIFIED: GET /media/subscriptions/template?guid= → SubscriptionTemplate[0].MediaSubscription[] {type,
// targetLibrarySectionID, targetSectionLocationID, parameters}: one entry per way to record the programme.
export const templateRequest = (guid: string): PmsReq => ({ method: 'GET', path: '/media/subscriptions/template', query: { guid } });

// The prefs[…] an Emby timer or rule body sets. PLEX-LIVETV-UNVERIFIED: the pref ids.
function prefsOf(body: J, series: boolean): Record<string, string> {
  const q: Record<string, string> = {};
  const pre = num(body.PrePaddingSeconds);
  const post = num(body.PostPaddingSeconds);
  if (pre !== undefined) q['prefs[startOffsetMinutes]'] = String(Math.round(pre / 60));
  if (post !== undefined) q['prefs[endOffsetMinutes]'] = String(Math.round(post / 60));
  if (series) {
    q['prefs[onlyNewAirings]'] = on(body.RecordNewOnly) ? '1' : '0';
    const ch = on(body.RecordAnyChannel) ? null : parseLiveId(str(body.ChannelId) ?? '');
    q['prefs[lineupChannel]'] = ch?.ident ?? '';
  } else q['prefs[oneShot]'] = 'true';
  return q;
}

// PLEX-LIVETV-UNVERIFIED: POST /media/subscriptions with the template entry's parameters, its type and target
// library, and the prefs. series: the show entry (type 2); else the one-airing entry.
export function createRequest(template: J | undefined, series: boolean, body: J): PmsReq {
  const entries = arr(arr(template?.SubscriptionTemplate)[0]?.MediaSubscription);
  const e = entries.find((x) => isSeries(x) === series);
  if (!e) throw new PlexUnmapped(series ? 'no series subscription for this programme' : 'no one-airing subscription for this programme');
  const q: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(str(e.parameters) ?? '')) q[k] = v;
  q.type = String(num(e.type) ?? '');
  const section = str(e.targetLibrarySectionID);
  const location = str(e.targetSectionLocationID);
  if (section) q.targetLibrarySectionID = section;
  if (location) q.targetSectionLocationID = location;
  return { method: 'POST', path: '/media/subscriptions', query: { ...q, ...prefsOf(body, series) } };
}

// PLEX-LIVETV-UNVERIFIED: PUT /media/subscriptions/{id}?prefs[…] (padding, new only, channel).
export const updateRequest = (sub: string, body: J, series: boolean): PmsReq => ({ method: 'PUT', path: `/media/subscriptions/${enc(sub)}`, query: prefsOf(body, series) });

// PLEX-LIVETV-UNVERIFIED: DELETE /media/subscriptions/{id}.
export const deleteRequest = (sub: string): PmsReq => ({ method: 'DELETE', path: `/media/subscriptions/${enc(sub)}`, query: {} });

// ---- Recordings ----

// PMS files a recording in its subscription's target library as an ordinary item; no recordings list is documented
// (PLEX-LIVETV-UNVERIFIED). Wicaby lists, in those libraries, the items that match a subscription (a film by its guid, an
// episode by its show's guid) AND carry a recorded version: matching a subscription alone would list, and offer to
// delete, the user's own copies of every show they subscribe to.
export function recordingRequests(subs: J | undefined): PmsReq[] {
  const seen = new Set<string>();
  const out: PmsReq[] = [];
  for (const s of arr(subs?.MediaSubscription)) {
    const section = str(s.targetLibrarySectionID);
    if (!section || !/^\d{1,12}$/.test(section)) continue;
    const type = num(s.type) === 1 ? '1' : '4';
    if (seen.has(`${section}/${type}`)) continue;
    seen.add(`${section}/${type}`);
    out.push({ method: 'GET', path: `/library/sections/${section}/all`, query: { type, sort: 'addedAt:desc' } });
  }
  return out;
}

// PLEX-LIVETV-UNVERIFIED: the DVR records MPEG-TS, so a recorded airing is a Media of container 'mpegts' (PMS adds it as
// one more version when the item already exists). The ids of those versions; the user's own files are never among them.
export const recordedMedia = (meta: J): string[] => arr(meta.Media).filter((md) => md.container === 'mpegts').flatMap((md) => {
  const id = str(md.id);
  return id && /^\d{1,12}$/.test(id) ? [id] : [];
});

export function isRecording(meta: J, subs: J | undefined): boolean {
  const guids = new Set(arr(subs?.MediaSubscription).flatMap((s) => str((obj(s.Directory) ?? obj(s.Video))?.guid) ?? []));
  const own = str(meta.guid);
  const show = str(meta.grandparentGuid);
  const matches = (meta.type === 'movie' && !!own && guids.has(own)) || (meta.type === 'episode' && !!show && guids.has(show));
  return matches && recordedMedia(meta).length > 0;
}

// DELETE /LiveTv/Recordings/{id}: DELETE /library/metadata/{key}/media/{media} for each recorded version only, so the
// item and the user's own versions stay. [] (the adapter answers 404) for an item that is not a recording.
export function deleteRecordingRequests(meta: J, subs: J | undefined): PmsReq[] {
  const key = str(meta.ratingKey);
  if (!key || !/^\d{1,12}$/.test(key) || !isRecording(meta, subs)) return [];
  return recordedMedia(meta).map((id) => ({ method: 'DELETE', path: `/library/metadata/${key}/media/${id}`, query: {} }));
}

// ---- Tune ----

// PLEX-LIVETV-UNVERIFIED: POST /livetv/dvrs/{dvr}/channels/{channelIdentifier}/tune → Metadata[0] {key: the live
// session's path}, played through the universal transcoder like any Plex transcode (§6.1).
export const tuneRequest = (d: LiveDvr, ident: string): PmsReq => ({ method: 'POST', path: `/livetv/dvrs/${enc(d.key)}/channels/${enc(ident)}/tune`, query: {} });

// Above this a cap means "Original": no maxVideoBitrate (as decision.ts).
const ORIGINAL_BPS = 100_000_000;

// The tune answer → PlaybackInfo for the live ladder (main/livetv/live-session.ts pickPlay): HLS through start.m3u8,
// never direct play, and LiveStreamId = the play session, which a Stopped report or /LiveStreams/Close stops.
// body: the Emby PlaybackInfo query and body merged (MaxStreamingBitrate, AllowVideoStreamCopy).
export function toLivePlayback(c: J | undefined, channelId: string, body: J, session: string, clientId: string): PlaybackInfoResponse {
  const key = str(arr(c?.Metadata)[0]?.key);
  if (!key) return { MediaSources: [], PlaySessionId: session };
  const q: Record<string, string> = { path: key, protocol: 'hls', directPlay: '0', directStream: body.AllowVideoStreamCopy === false ? '0' : '1', directStreamAudio: '1', session, 'X-Plex-Client-Identifier': clientId };
  const bps = num(body.MaxStreamingBitrate) ?? 0;
  if (bps > 0 && bps < ORIGINAL_BPS) q.maxVideoBitrate = String(Math.floor(bps / 1000));
  return {
    MediaSources: [
      {
        Id: channelId,
        Protocol: 'Http',
        Container: 'ts',
        SupportsDirectPlay: false,
        SupportsDirectStream: false,
        SupportsTranscoding: true,
        RequiresOpening: false,
        LiveStreamId: session,
        TranscodingUrl: `/video/:/transcode/universal/start.m3u8?${new URLSearchParams(q).toString()}`,
        TranscodingSubProtocol: 'hls',
      },
    ],
    PlaySessionId: session,
  };
}
