// Jellyfin 12-flavoured mock server: the mock-emby.mjs catalogue behind Jellyfin's routes and auth rules.
//   node tools/mock-server/mock-jellyfin.mjs [port] [video-file]      (MOCK_DURATION_S as for mock-emby)
// Login: user "Wika", password "wicaby" (or Quick Connect, see below).
//
// Behaves like a default Jellyfin 12 (legacy authorization disabled):
// - auth only through `Authorization: MediaBrowser …, Token="…"` or the ApiKey query parameter;
//   api_key, X-Emby-Token, X-Emby-Authorization, X-MediaBrowser-Token and the Emby scheme get a 401;
// - no /emby prefix, no /embywebsocket; realtime channel on /socket?ApiKey=…;
// - modern user routes (/UserViews, /Items?userId=, /UserItems/Resume, /UserFavoriteItems, /UserPlayedItems,
//   /UserItems/{id}/UserData, /UserImage); the obsolete /Users/{id}/Items|Views|… routes get a 404;
// - routes Jellyfin dropped (WakeOnLanInfo, DELETE /Videos/ActiveEncodings) and Emby-only ones (index.bif) get a 404;
// - MediaSegments (Recap, Intro, Commercial, Preview, Outro), Trickplay (BaseItemDto.Trickplay on movies, tiles.m3u8 for everything), chapters without MarkerType.
// - remote control (sessions.mjs, cast spec CA-01): GET /Sessions?controllableByUserId= lists the clients with
//   capabilities and an open /socket (with what they report playing); POST /Sessions/{id}/Playing[/{command}],
//   /Command[/{name}] and /Message reach that socket as Play / Playstate / GeneralCommand; names outside
//   Jellyfin's enums get a 400; SessionsStart pushes Sessions. MOCK_SHARED_DEVICE_CONTROL=0, MOCK_NON_ADMIN=1 and
//   MOCK_NO_SESSIONS_PUSH=1 as described in sessions.mjs.
// - SyncPlay (watch together): /GetUtcTime and a single /SyncPlay group, its updates and commands on every /socket.
// Every rejected or unknown call is logged with a LEGACY / EMBY-ONLY / UNMAPPED tag, so a run's log is a bug list.
//
// Mock-only helpers (no auth): GET /Mock/State (sockets, reports, user data, remote[]), POST /Mock/Broadcast {MessageType, Data},
// POST /Mock/Sessions {DeviceName, Client, DeviceId, PlayableMediaTypes, SupportedCommands, ignore, UserId} (a virtual
// controllable session), POST /Mock/Sessions/{id}/{Pause|Unpause|Seek}?PositionTicks= (its own user acts on it),
// POST /Mock/QuickConnect/Approve?code=… (approves a pending Quick Connect code as Wika), POST /Mock/Sessions/Drop?deviceId=…
// (that device's sessions leave GET /Sessions, as after a server's idle timeout; their tokens stay valid until Logout).
// Quick Connect (cast spec CA-11: a disposable token per cast): Enabled, Initiate, Connect, Authorize,
// /Users/AuthenticateWithQuickConnect; MOCK_QC=0 turns it off (Enabled false, Initiate 401). POST /Sessions/Logout
// revokes the calling token: any later use of it gets a 401.
import crypto from 'node:crypto';
import http from 'node:http';
import * as E from './mock-emby.mjs';
import { jellyfinPhoto } from './photos-fixture.mjs';
import { GAIN, LOG as MUSIC_LOG, logReport, LYRICS } from './music-fixture.mjs';
import { createSessions } from './sessions.mjs';

const PORT = E.PORT;
const SERVER_ID = process.env.MOCK_SERVER_ID ?? '7e1f0c2a9b8d4e6fa1c3b5d7e9f02468';
const USER_ID = '4b9e2f6a1c8d4e3f9a7b5c2d1e0f3a6b';
const INTERNAL = crypto.randomBytes(16).toString('hex');
E.tokens.add(INTERNAL);
E.hooks.log = () => {};

const USER = {
  Name: 'Wika',
  ServerId: SERVER_ID,
  Id: USER_ID,
  PrimaryImageTag: 'avatar1',
  HasPassword: true,
  HasConfiguredPassword: true,
  HasConfiguredEasyPassword: false,
  EnableAutoLogin: false,
  LastLoginDate: new Date().toISOString(),
  LastActivityDate: new Date().toISOString(),
  Configuration: { PlayDefaultAudioTrack: true, SubtitleMode: 'Default', EnableNextEpisodeAutoPlay: true, RememberAudioSelections: true },
  Policy: { IsAdministrator: true, IsDisabled: false, EnableMediaPlayback: true, EnableContentDownloading: true, EnableRemoteControlOfOtherUsers: true },
};
// TP-11: parental schedules per user, the Emby mock's (MOCK_SCHEDULE, POST /Mock/AccessSchedules?userId=); Wika is
// E.USER there. tokenUser: the user each token was issued to, whose hours apply to its calls (and /Users/Me).
Object.defineProperty(USER.Policy, 'AccessSchedules', { enumerable: true, get: () => E.USER.Policy?.AccessSchedules ?? [] });
const embyId = (id) => (id === USER_ID ? E.USER.Id : id);
const outsideHours = async (id) => !(await E.allowedNow(embyId(id)));
const tokenUser = new Map();
// MOCK_JF_VERSION=10.10|10.11|12.2 (default 12.2): 12.2 dropped DELETE /Videos/ActiveEncodings and the grouped recording routes.
const JF_VERSION = process.env.MOCK_JF_VERSION ?? '12.2';
// MOCK_LIVETV=iptv: the Live TV mock in its Jellyfin flavour, its events through the /socket broadcaster below.
const store = createSessions({ flavour: 'jellyfin', serverId: SERVER_ID, userId: USER_ID, userName: USER.Name, items: E.items });
E.liveTv({ flavour: 'jellyfin', jfVersion: JF_VERSION, serverId: SERVER_ID, userId: USER_ID, user: USER, emit: (type, data) => store.broadcast(type, data) });

const reports = [];
const quick = new Map(); // secret -> { Code, DeviceId, Authenticated }
const QC = process.env.MOCK_QC !== '0';

// ---- Trickplay: 320x180 thumbnails every 10 s, 10x10 per sheet ----
const TRICK = { Width: 320, Height: 180, TileWidth: 10, TileHeight: 10, Interval: 10_000 };
function trickInfo(item) {
  const spanMs = (E.MARKER_SPAN || item.RunTimeTicks || 0) / 10_000;
  const count = Math.max(1, Math.ceil(spanMs / TRICK.Interval));
  return { ...TRICK, ThumbnailCount: count, Bandwidth: 120_000 };
}
function trickSheet(n, info) {
  const per = info.TileWidth * info.TileHeight;
  const first = n * per;
  const rows = Math.max(1, Math.ceil(Math.min(per, info.ThumbnailCount - first) / info.TileWidth));
  const W = info.Width * info.TileWidth;
  const H = info.Height * rows;
  let cells = '';
  for (let i = 0; i < per && first + i < info.ThumbnailCount; i++) {
    const k = first + i;
    const x = (i % info.TileWidth) * info.Width;
    const y = Math.floor(i / info.TileWidth) * info.Height;
    const s = Math.round((k * info.Interval) / 1000);
    cells += `<rect x="${x}" y="${y}" width="${info.Width}" height="${info.Height}" fill="hsl(${(k * 37) % 360},55%,35%)"/><text x="${x + 16}" y="${y + 120}" font-family="Arial" font-weight="700" font-size="72" fill="#fff">${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${cells}</svg>`;
}

// Jellyfin item shape: own ServerId, UserData with Key/ItemId, chapters without markers, Trickplay on movies.
E.hooks.view = (out, item) => {
  out.ServerId = SERVER_ID;
  out.UserData = { ...out.UserData, Key: item.Id, ItemId: item.Id };
  if (out.Chapters) out.Chapters = out.Chapters.filter((c) => c.MarkerType === 'Chapter').map(({ MarkerType: _m, ChapterIndex: _i, ...c }) => ({ ...c, ImageDateModified: '2026-01-01T00:00:00.0000000Z' }));
  if (out.MediaSources) out.MediaSources = out.MediaSources.map((s) => ({ ...s, HasSegments: true }));
  // Episodes keep no Trickplay field so clients exercise the tiles.m3u8 fallback.
  if (item.Type === 'Movie' && item.RunTimeTicks) out.Trickplay = { [item.Id]: { [TRICK.Width]: trickInfo(item) } };
  // Music (spec §3.5, §3.6): NormalizationGain on tracks and albums, HasLyrics instead of Emby's lrc subtitle stream.
  if (GAIN.has(item.Id)) out.NormalizationGain = GAIN.get(item.Id);
  if (item.Type === 'Audio') {
    out.HasLyrics = LYRICS.has(item.Id);
    out.MediaStreams = out.MediaStreams?.filter((st) => st.Type !== 'Subtitle');
    out.MediaSources = out.MediaSources?.map((src) => ({ ...src, MediaStreams: src.MediaStreams.filter((st) => st.Type !== 'Subtitle') }));
  }
  return jellyfinPhoto(out, item);
};

// ---- WebSocket (/socket): sessions.mjs ----
const broadcast = (MessageType, Data) => store.broadcast(MessageType, Data);
function userDataChanged(itemId) {
  broadcast('UserDataChanged', { UserId: USER_ID, UserDataList: [{ ...E.ud(itemId), Key: itemId, ItemId: itemId }] });
}

// ---- SyncPlay: one group that every /socket is in, enough for the desktop's "Watch together" flow ----
// (GroupJoined, PlayQueue on SetNewQueue, Unpause once a member is Ready, Pause/Unpause/Seek as SyncPlayCommand.)
let sp = null;
const spInfo = () => ({ GroupId: sp.GroupId, GroupName: sp.GroupName, State: sp.State, Participants: [USER.Name], LastUpdatedAt: new Date().toISOString() });
const spPos = () => sp.ticks + (sp.State === 'Playing' ? (Date.now() - sp.at) * 10_000 : 0);
const spUpdate = (Type, Data) => broadcast('SyncPlayGroupUpdate', { GroupId: sp.GroupId, Type, Data });
function spCommand(Command, ticks) {
  [sp.ticks, sp.at] = [ticks, Date.now() + 500];
  sp.State = Command === 'Unpause' ? 'Playing' : Command === 'Pause' ? 'Paused' : 'Waiting';
  broadcast('SyncPlayCommand', { GroupId: sp.GroupId, PlaylistItemId: `pl-${sp.index}`, When: new Date(sp.at).toISOString(), EmittedAt: new Date().toISOString(), PositionTicks: ticks, Command });
}
async function syncPlay(req, res, lp) {
  const b = req.method === 'POST' ? await E.body(req).catch(() => ({})) : {};
  if (lp[1] === 'list') return send(res, 200, sp ? [spInfo()] : []);
  if (lp[1] === 'new') {
    sp = { GroupId: crypto.randomUUID(), GroupName: b.GroupName ?? 'Group', State: 'Idle', queue: [], index: -1, ticks: 0, at: Date.now() };
    spUpdate('GroupJoined', spInfo());
  } else if (!sp) {
    broadcast('SyncPlayGroupUpdate', { GroupId: b.GroupId ?? '', Type: lp[1] === 'join' ? 'GroupDoesNotExist' : 'NotInGroup', Data: '' });
  } else if (lp[1] === 'join') {
    spUpdate('GroupJoined', spInfo());
  } else if (lp[1] === 'leave') {
    spUpdate('GroupLeft', sp.GroupId);
    sp = null;
  } else if (lp[1] === 'setnewqueue') {
    Object.assign(sp, { queue: b.PlayingQueue ?? [], index: b.PlayingItemPosition ?? 0, ticks: b.StartPositionTicks ?? 0, State: 'Waiting' });
    const Playlist = sp.queue.map((ItemId, i) => ({ ItemId, PlaylistItemId: `pl-${i}` }));
    spUpdate('PlayQueue', { Reason: 'NewPlaylist', LastUpdate: new Date().toISOString(), Playlist, PlayingItemIndex: sp.index, StartPositionTicks: sp.ticks, IsPlaying: true });
  } else if (lp[1] === 'ready') {
    if (sp.State === 'Waiting') spCommand('Unpause', b.PositionTicks ?? sp.ticks);
  } else if (lp[1] === 'pause' || lp[1] === 'unpause') {
    spCommand(lp[1] === 'pause' ? 'Pause' : 'Unpause', spPos());
  } else if (lp[1] === 'seek') {
    spCommand('Seek', b.PositionTicks ?? 0);
  }
  return send(res, 204);
}

// ---- Auth ----
const LEGACY_HEADERS = ['x-emby-token', 'x-emby-authorization', 'x-mediabrowser-token'];
function qget(q, name) {
  for (const [k, v] of q) if (k.toLowerCase() === name.toLowerCase()) return v;
  return null;
}
function auth(req, q) {
  const raw = String(req.headers.authorization ?? '');
  const fields = {};
  let legacy = LEGACY_HEADERS.find((h) => req.headers[h]) ?? (qget(q, 'api_key') !== null ? 'api_key query' : null);
  const scheme = /^(\S+)/.exec(raw)?.[1];
  if (scheme?.toLowerCase() === 'mediabrowser') {
    for (const m of raw.matchAll(/(\w+)="([^"]*)"/g)) {
      try {
        fields[m[1]] = decodeURIComponent(m[2]);
      } catch {
        fields[m[1]] = m[2];
      }
    }
  } else if (raw) legacy ??= `Authorization scheme ${scheme}`;
  const token = fields.Token ?? qget(q, 'ApiKey');
  const session = token ? store.forToken(token) : null;
  return { legacy, fields, token, session, via: fields.Token ? 'header' : token ? 'ApiKey' : 'anon' };
}

const send = E.send;
const tag = (label, req, url, extra = '') => console.log(`${label} ${req.method} ${url.pathname}${url.search}${extra ? ` (${extra})` : ''}`);

// Forwards to the Emby mock's handler with the Emby path and an internal token; userId becomes the Emby mock's user.
function forward(req, res, embyPath, q, drop = []) {
  const out = new URLSearchParams();
  for (const [k, v] of q) {
    const lk = k.toLowerCase();
    if (lk === 'apikey' || drop.includes(lk)) continue;
    out.append(k[0].toUpperCase() + k.slice(1), lk === 'userid' ? E.USER.Id : v);
  }
  const qs = out.toString();
  req.url = `/emby${embyPath}${qs ? `?${qs}` : ''}`;
  for (const h of LEGACY_HEADERS) delete req.headers[h];
  req.headers['x-emby-token'] = INTERNAL;
  req.headers['x-mock-flavour'] = 'jellyfin'; // mock-admin answers with Jellyfin field names
  return E.handler(req, res);
}

// TP-10: [user] one of E.PROFILES (Jellyfin shape), else Wika.
const jfUser = (u) => ({ Name: u.Name, ServerId: SERVER_ID, Id: u.Id, PrimaryImageTag: u.PrimaryImageTag, HasPassword: u.HasPassword, HasConfiguredPassword: u.HasPassword, HasConfiguredEasyPassword: false, EnableAutoLogin: false, Policy: u.Policy });
// Jellyfin's UserDto carries the policy, its hours included (/Users/Public, /Users/Me).
const jfUserFull = async (u) => (u === USER ? USER : { ...jfUser(u), Policy: { ...u.Policy, AccessSchedules: await E.scheduleOf(u.Id) } });
function authResult(deviceFields, user = USER) {
  const token = crypto.randomBytes(16).toString('hex');
  tokenUser.set(token, user);
  const s = store.login(token, deviceFields);
  return { User: user, SessionInfo: { Id: s.Id, UserId: user.Id, UserName: user.Name, Client: s.Client, DeviceId: s.DeviceId, DeviceName: s.DeviceName, ApplicationVersion: s.ApplicationVersion, IsActive: true, SupportsRemoteControl: true }, AccessToken: token, ServerId: SERVER_ID };
}
const hasDevice = (f) => ['Client', 'Device', 'DeviceId', 'Version'].every((k) => f[k]);

function avatarSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="#aa5cc3"/><circle cx="128" cy="104" r="48" fill="#00a4dc"/><rect x="56" y="168" width="144" height="72" rx="36" fill="#00a4dc"/></svg>';
}

const LEGACY_USER_ROUTES = new Set(['items', 'views', 'favoriteitems', 'playeditems', 'images', 'suggestions', 'homesections']);

async function route(req, res) {
  if (req.method === 'OPTIONS') return E.preflight(req, res);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const q = url.searchParams;
  const p = url.pathname;
  const parts = p.split('/').filter(Boolean);
  const lp = parts.map((x) => x.toLowerCase());
  const M = req.method;
  const a = auth(req, q);
  console.log(`${M} ${p}${url.search} [${a.via}${a.session ? '' : a.token ? ':bad-token' : ''}]`);

  // Mock helpers
  if (lp[0] === 'mock') {
    if (lp[1] === 'livetv' && E.liveTv()) return E.liveTv().control(req, res, p, q);
    if (lp[1] === 'state') {
      const ids = (q.get('ids') ?? 'comic-1,movie-0,movie-2,ep-1-3').split(',');
      return send(res, 200, {
        ...store.state(),
        reports: reports.slice(-20),
        music: MUSIC_LOG,
        userData: Object.fromEntries(ids.map((id) => [id, E.ud(id)])),
      });
    }
    if (lp[1] === 'accessschedules' && M === 'POST') return E.handler(req, res);
    if (lp[1] === 'broadcast' && M === 'POST') {
      const b = await E.body(req);
      return send(res, 200, { sent: broadcast(b.MessageType, b.Data) });
    }
    if (lp[1] === 'sessions' && M === 'POST') {
      if (parts.length === 2) return send(res, 200, store.addVirtual(await E.body(req)));
      if (lp[2] === 'drop' && parts.length === 3) return send(res, 200, { dropped: store.drop(qget(q, 'deviceId')) });
      if (parts.length === 4) return send(res, store.drive(parts[2], parts[3], q));
    }
    if (lp[1] === 'quickconnect' && lp[2] === 'approve') {
      const e = [...quick.values()].find((x) => x.Code === q.get('code'));
      if (!e) return send(res, 404, 'Unknown code', 'text/plain');
      e.Authenticated = true;
      return send(res, 200, true);
    }
  }

  if (lp[0] === 'emby' || lp[0] === 'mediabrowser' || lp[0] === 'embywebsocket') {
    tag('LEGACY prefix', req, url);
    return send(res, 404, '', 'text/plain');
  }
  if (a.legacy) {
    tag('LEGACY auth rejected', req, url, a.legacy);
    return send(res, 401, '', 'text/plain');
  }

  // ---- Anonymous ----
  if (p === '/System/Info/Public')
    return send(res, 200, { LocalAddress: `http://127.0.0.1:${PORT}`, ServerName: process.env.MOCK_NAME ?? 'Wicaby Mock Jellyfin', Version: `${JF_VERSION}.0`, ProductName: 'Jellyfin Server', OperatingSystem: '', Id: SERVER_ID, StartupWizardCompleted: true });
  if (p === '/System/Ping') return send(res, 200, 'Jellyfin Server', 'text/plain');
  if (p === '/GetUtcTime') return send(res, 200, { RequestReceptionTime: new Date().toISOString(), ResponseTransmissionTime: new Date().toISOString() });
  if (p === '/Branding/Configuration') return send(res, 200, { LoginDisclaimer: '', CustomCss: '', SplashscreenEnabled: false });
  if (p === '/Users/Public') return send(res, 200, await Promise.all([USER, ...E.PROFILES].map(jfUserFull)));
  if (p === '/Users/AuthenticateByName' && M === 'POST') {
    if (!hasDevice(a.fields)) {
      tag('AUTH missing Client/Device/DeviceId/Version', req, url);
      return send(res, 400, 'Client, Device, DeviceId and Version are required', 'text/plain');
    }
    const b = await E.body(req);
    const profile = E.profileFor(b.Username, b.Pw ?? '');
    const who = profile ?? (b.Username?.toLowerCase() === 'wika' && b.Pw === 'wicaby' ? USER : null);
    if (!who) return send(res, 401, 'Error processing request.', 'text/plain');
    // TP-11: Jellyfin's SecurityException "User is not allowed access at this time." reaches clients as a bare 403.
    if (await outsideHours(who.Id)) return send(res, 403, 'Error processing request.', 'text/plain');
    return send(res, 200, authResult(a.fields, profile ? jfUser(profile) : USER));
  }
  if (lp[0] === 'quickconnect') {
    if (lp[1] === 'enabled') return send(res, 200, QC);
    if (!QC) return send(res, 401, 'Quick connect is not active on this server', 'text/plain');
    if (lp[1] === 'initiate' && M === 'POST') {
      if (!hasDevice(a.fields)) return send(res, 400, 'Client, Device, DeviceId and Version are required', 'text/plain');
      const Secret = crypto.randomBytes(32).toString('hex');
      const e = { Secret, Code: String(crypto.randomInt(100000, 999999)), DeviceId: a.fields.DeviceId, DeviceName: a.fields.Device, AppName: a.fields.Client, AppVersion: a.fields.Version, DateAdded: new Date().toISOString(), Authenticated: false, fields: a.fields };
      quick.set(Secret, e);
      console.log(`QUICKCONNECT code ${e.Code}`);
      const { fields: _f, ...dto } = e;
      return send(res, 200, dto);
    }
    if (lp[1] === 'connect') {
      const e = quick.get(qget(q, 'secret') ?? '');
      if (!e) return send(res, 404, 'Unknown secret', 'text/plain');
      const { fields: _f, ...dto } = e;
      return send(res, 200, dto);
    }
    if (lp[1] === 'authorize' && M === 'POST') {
      if (!a.session) return send(res, 401, '', 'text/plain');
      const e = [...quick.values()].find((x) => x.Code === qget(q, 'code'));
      if (!e) return send(res, 404, 'Unknown code', 'text/plain');
      e.Authenticated = true;
      return send(res, 200, true);
    }
  }
  if (p === '/Users/AuthenticateWithQuickConnect' && M === 'POST') {
    const b = await E.body(req);
    const e = quick.get(b.Secret ?? '');
    if (!e?.Authenticated) return send(res, 401, '', 'text/plain');
    quick.delete(b.Secret);
    return send(res, 200, authResult(e.fields));
  }
  // Images are anonymous on Jellyfin.
  if (lp[0] === 'items' && lp[2] === 'images') return forward(req, res, p, q);
  if (p === '/UserImage') {
    const uid = qget(q, 'userId');
    if (uid !== USER_ID && !E.PROFILES.some((u) => u.Id === uid && u.PrimaryImageTag)) return send(res, 404, '', 'text/plain');
    return send(res, 200, avatarSvg(), 'image/svg+xml');
  }
  if (lp[0] === 'users' && lp[2] === 'images') {
    tag('LEGACY user image route', req, url, 'use /UserImage?userId=');
    return send(res, 404, '', 'text/plain');
  }

  // ---- Authenticated ----
  if (!a.session) {
    if (a.token) tag('AUTH unknown token', req, url);
    return send(res, 401, '', 'text/plain');
  }
  // TP-11: outside the token user's hours every call is a bare 403, but GET /Users/{id} ([Authorize(IgnoreParentalControl)]):
  // /Users/Me is the call that tells a refused saved account (core AccessSchedules.verify).
  const me = tokenUser.get(a.token) ?? USER;
  if ((await outsideHours(me.Id)) && !(M === 'GET' && lp[0] === 'users' && parts.length === 2 && lp[1] !== 'me')) return send(res, 403, '', 'text/plain');
  if (lp[0] === 'syncplay') return syncPlay(req, res, lp);
  if (E.liveTv()?.claims(lp)) return forward(req, res, p, q);
  const uidQ = qget(q, 'userId');
  if (uidQ && uidQ !== USER_ID && !E.PROFILES.some((u) => u.Id === uidQ)) tag('WARN userId mismatch', req, url, uidQ);

  if (lp[0] === 'users') {
    if (lp[1] === 'me' && parts.length === 2) return send(res, 200, await jfUserFull(me === USER ? USER : (E.PROFILES.find((u) => u.Id === me.Id) ?? me)));
    if (parts[1] === USER_ID && parts.length === 2) return send(res, 200, USER);
    if (parts[1] && LEGACY_USER_ROUTES.has(lp[2])) {
      tag('LEGACY user route', req, url);
      return send(res, 404, '', 'text/plain');
    }
    // User administration (mock-admin/20-users.mjs, its Emby-shaped store): the list, the other users, policies.
    if ((parts.length === 1 && M === 'GET') || (parts.length === 2 && parts[1] !== USER_ID) || (parts.length === 3 && lp[2] === 'policy'))
      return forward(req, res, parts[1] === USER_ID ? `/Users/${E.USER.Id}/Policy` : p, q);
    if (parts.length === 2) return send(res, 404, 'User not found', 'text/plain');
  }
  // What the user editor and the Trakt plugin check read (mock-admin/20-users.mjs, 50-server.mjs).
  if (['devices', 'channels', 'plugins'].includes(lp[0]) || (lp[0] === 'localization' && lp[1] === 'parentalratings')) return forward(req, res, p, q);
  if (p === '/UserViews') return forward(req, res, `/Users/${E.USER.Id}/Views`, q, ['userid']);
  if (p === '/UserItems/Resume') return forward(req, res, `/Users/${E.USER.Id}/Items/Resume`, q, ['userid']);
  if (lp[0] === 'useritems' && lp[2] === 'userdata' && parts.length === 3) {
    if (M === 'GET') return send(res, 200, { ...E.ud(parts[1]), Key: parts[1], ItemId: parts[1] });
    res.on('finish', () => userDataChanged(parts[1]));
    return forward(req, res, `/Users/${E.USER.Id}/Items/${parts[1]}/UserData`, q, ['userid']);
  }
  if ((lp[0] === 'userfavoriteitems' || lp[0] === 'userplayeditems') && parts.length === 2 && (M === 'POST' || M === 'DELETE')) {
    res.on('finish', () => userDataChanged(parts[1]));
    return forward(req, res, `/Users/${E.USER.Id}/${lp[0] === 'userfavoriteitems' ? 'FavoriteItems' : 'PlayedItems'}/${parts[1]}`, q, ['userid']);
  }
  if (lp[0] === 'items') {
    if (parts.length === 1) return forward(req, res, `/Users/${E.USER.Id}/Items`, q, ['userid']);
    if (lp[1] === 'latest') return forward(req, res, `/Users/${E.USER.Id}/Items/Latest`, q, ['userid']);
    // Item metadata admin (tools/mock-server/mock-admin/40-metadata.mjs): save, delete, identify, artwork, subtitles.
    if ((parts.length === 2 && req.method !== 'GET') || lp[1] === 'remotesearch' || ['metadataeditor', 'remoteimages', 'remotesearch', 'delete'].includes(lp[2])) return forward(req, res, p, q);
    if (parts.length === 2) return forward(req, res, `/Users/${E.USER.Id}/Items/${parts[1]}`, q, ['userid']);
    if (['playbackinfo', 'similar', 'file', 'download', 'refresh', 'instantmix'].includes(lp[2])) return forward(req, res, p, q);
    if (lp[2] === 'localtrailers' || lp[2] === 'specialfeatures')
      return forward(req, res, `/Users/${E.USER.Id}/Items/${parts[1]}/${lp[2] === 'localtrailers' ? 'LocalTrailers' : 'SpecialFeatures'}`, q, ['userid']);
  }
  if (p === '/System/WakeOnLanInfo') {
    tag('REMOVED in 10.11', req, url);
    return send(res, 404, '', 'text/plain');
  }
  // Music (music-fixture.mjs): artists, streams, lyrics, instant mix (12.2 dropped /Artists/InstantMix), genres.
  if (p === '/Artists/InstantMix') {
    tag('REMOVED in 12.2', req, url, 'use /Items/{id}/InstantMix');
    return send(res, 404, '', 'text/plain');
  }
  if (lp[0] === 'musicgenres') tag('DEPRECATED', req, url, 'use /Genres?includeItemTypes=MusicAlbum');
  if (['artists', 'albums', 'songs', 'musicgenres'].includes(lp[0]) || (lp[0] === 'audio' && (lp[2] === 'stream' || lp[2] === 'universal' || lp[2] === 'lyrics'))) return forward(req, res, p, q, ['userid']);
  if (lp[0] === 'videos') {
    if (lp[1] === 'activeencodings') {
      const gone = JF_VERSION === '12.2';
      E.liveTv()?.encodingsKilled(gone ? 404 : 204);
      if (!gone) return send(res, 204);
      tag('REMOVED in 12.2', req, url);
      return send(res, 404, '', 'text/plain');
    }
    if (lp[2] === 'index.bif') {
      tag('EMBY-ONLY', req, url);
      return send(res, 404, '', 'text/plain');
    }
    if (lp[2] === 'trickplay') {
      const item = E.items.get(parts[1]);
      if (!item?.RunTimeTicks || Number(parts[3]) !== TRICK.Width) return send(res, 404, '', 'text/plain');
      const info = trickInfo(item);
      const sheets = Math.ceil(info.ThumbnailCount / (info.TileWidth * info.TileHeight));
      if (lp[4] === 'tiles.m3u8') {
        const sheetSec = (info.Interval / 1000) * info.TileWidth * info.TileHeight;
        const lines = ['#EXTM3U', `#EXT-X-TARGETDURATION:${sheetSec}`, '#EXT-X-VERSION:7', '#EXT-X-MEDIA-SEQUENCE:1', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-IMAGES-ONLY'];
        for (let i = 0; i < sheets; i++) {
          lines.push(`#EXTINF:${sheetSec.toFixed(3)},`, `#EXT-X-TILES:RESOLUTION=${info.Width}x${info.Height},LAYOUT=${info.TileWidth}x${info.TileHeight},DURATION=${(info.Interval / 1000).toFixed(3)}`, `${i}.jpg?MediaSourceId=${parts[1]}&ApiKey=${a.token}`);
        }
        lines.push('#EXT-X-ENDLIST');
        return send(res, 200, lines.join('\n'), 'application/x-mpegURL');
      }
      const n = /^(\d+)\.jpg$/i.exec(parts[4] ?? '');
      if (!n || Number(n[1]) >= sheets) return send(res, 404, '', 'text/plain');
      // Real servers send JPEG; an SVG sheet keeps the mock dependency-free and shows the thumb's time.
      return send(res, 200, trickSheet(Number(n[1]), info), 'image/svg+xml');
    }
    if (lp[2] === 'stream' || lp[2]?.startsWith('stream.')) return forward(req, res, p, q);
    // The Chromecast profile's HLS remux (cast spec CA-09, the Default Media Receiver fallback).
    if (lp.length === 3 && /^(master|main)\.m3u8$/.test(lp[2])) return forward(req, res, p, q);
    // /Videos/{id}/{msid}/Subtitles/{i}/0/Stream.vtt (cast spec §2.6 VTT URL), with Jellyfin's default CORS "*".
    if (lp[3] === 'subtitles' && /^stream\.(srt|vtt)$/.test(lp.at(-1))) return forward(req, res, p, q);
  }
  if (lp[0] === 'audio' && lp[2]?.startsWith('stream')) return forward(req, res, p, q);
  if (lp[0] === 'mediasegments' && parts[1]) {
    if (!E.items.has(parts[1])) return send(res, 200, { Items: [], TotalRecordCount: 0, StartIndex: 0 });
    return forward(req, res, p, q);
  }
  if (lp[0] === 'sessions') {
    if (lp[1] === 'logout') {
      store.logout(a.token);
      return send(res, 204);
    }
    if (lp[1] === 'capabilities') {
      if (lp[2] !== 'full' || M !== 'POST') return send(res, 204);
      const err = store.capabilities(a.session, await E.body(req));
      return err ? send(res, 400, err, 'text/plain') : send(res, 204);
    }
    if (lp[1] === 'playing') {
      const b = lp[2] === 'ping' ? {} : await E.body(req);
      const kind = lp[2] ?? 'start';
      E.liveTv()?.report(kind, b, q);
      const missing = kind === 'ping' ? (qget(q, 'playSessionId') ? [] : ['PlaySessionId']) : ['ItemId', 'MediaSourceId', 'PlaySessionId', 'PlayMethod'].filter((k) => !b[k]);
      const r = { kind, at: Date.now(), ItemId: b.ItemId, PositionTicks: b.PositionTicks, IsPaused: b.IsPaused, PlayMethod: b.PlayMethod, EventName: b.EventName, PlaySessionId: b.PlaySessionId ?? qget(q, 'playSessionId'), missing };
      reports.push(r);
      logReport(E.items, kind, b);
      // What GET /Sessions shows as NowPlayingItem / PlayState ("Lire sur…" on the phone).
      store.report(a.session, kind, b);
      console.log(`REPORT ${kind} item=${r.ItemId ?? '-'} pos=${r.PositionTicks ?? '-'} method=${r.PlayMethod ?? '-'}${missing.length ? ` MISSING ${missing.join(',')}` : ''}`);
      const item = E.items.get(b.ItemId);
      if (item && (kind === 'progress' || kind === 'stopped') && typeof b.PositionTicks === 'number') {
        const d = E.ud(item.Id);
        const span = item.RunTimeTicks || 0;
        if (kind === 'stopped' && span && b.PositionTicks / span >= 0.9) Object.assign(d, { Played: true, PlaybackPositionTicks: 0, PlayCount: d.PlayCount + 1 });
        else d.PlaybackPositionTicks = b.PositionTicks;
        d.LastPlayedDate = new Date().toISOString();
        if (kind === 'stopped') userDataChanged(item.Id);
      }
      return send(res, 204);
    }
    // Remote control: /Sessions/{id}/Playing[/{command}], /Command[/{name}], /Message reach the target's socket.
    if (parts.length >= 3 && M === 'POST') {
      const r = store.command(parts[1], parts.slice(2), q, await E.body(req), USER_ID);
      if (r) return r.status === 204 ? send(res, 204) : send(res, r.status, r.text, 'text/plain');
    }
    if (parts.length === 1 && M === 'GET') return send(res, 200, store.list(q));
  }
  // Next up per series: the first unplayed episode after the last played one. Jellyfin's
  // enableResumable defaults to true; false drops an episode that is already in progress.
  if (lp[0] === 'shows' && lp[1] === 'nextup') {
    const resumable = (qget(q, 'enableResumable') ?? 'true').toLowerCase() !== 'false';
    const sid = qget(q, 'seriesId');
    const eps = [...E.items.values()].filter((x) => x.Type === 'Episode' && x.LocationType !== 'Virtual' && (!sid || x.SeriesId === sid));
    const out = [];
    for (const s of new Set(eps.map((e) => e.SeriesId))) {
      const list = eps.filter((e) => e.SeriesId === s).sort((a, b) => a.ParentIndexNumber - b.ParentIndexNumber || a.IndexNumber - b.IndexNumber);
      const last = list.findLastIndex((e) => E.ud(e.Id).Played);
      const next = list.slice(last + 1).find((e) => !E.ud(e.Id).Played);
      if (next && (resumable || !E.ud(next.Id).PlaybackPositionTicks)) out.push(next);
    }
    return send(res, 200, E.list(out, q));
  }
  if (['shows', 'genres', 'years', 'livetv', 'livestreams', 'playlists', 'collections'].includes(lp[0])) return forward(req, res, p, q);
  // Dashboard and background admin alerts (mock-admin/10-dashboard.mjs): same routes and fields on Jellyfin.
  if (lp[0] === 'scheduledtasks' || p === '/System/Info') return forward(req, res, p, q);

  // Library administration (tools/mock-server/mock-admin/30-libraries.mjs answers with Jellyfin field names).
  if (['library', 'libraries', 'environment'].includes(lp[0]) || (lp[0] === 'localization' && ['cultures', 'countries'].includes(lp[1]))) return forward(req, res, p, q);

  tag('UNMAPPED', req, url);
  return send(res, 404, '', 'text/plain');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.log('ERROR', err);
    if (!res.headersSent) send(res, 500, String(err), 'text/plain');
  });
});
server.on('upgrade', (req, sock) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const a = auth(req, url.searchParams);
  const fail = (code, label) => {
    tag(label, req, url);
    sock.end(`HTTP/1.1 ${code}\r\nContent-Length: 0\r\n\r\n`);
  };
  if (url.pathname.toLowerCase() !== '/socket') return fail('404 Not Found', url.pathname.toLowerCase().includes('emby') ? 'LEGACY socket path' : 'SOCKET bad path');
  if (a.legacy) return fail('401 Unauthorized', `LEGACY socket auth (${a.legacy})`);
  if (!a.session) return fail('401 Unauthorized', 'SOCKET unauthorized');
  store.attach(req, sock, a.session);
});
// Loopback only (MOCK_HOST widens it): a mock reachable from the LAN would show up in real clients.
server.listen(PORT, process.env.MOCK_HOST || '127.0.0.1', () => console.log(`Mock Jellyfin 12 on http://127.0.0.1:${PORT} (user Wika / wicaby)${E.VIDEO ? `, video ${E.VIDEO}` : ''}`));
