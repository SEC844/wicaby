// Remote control through the Sessions API, shared by mock-emby.mjs and mock-jellyfin.mjs (docs/specs/cast-spec.md CA-01).
// One store per mock: the signed-in sessions (one per token), their sockets, capabilities and last report, plus
// virtual sessions added with POST /Mock/Sessions that need no socket. Only the URL dialect differs per server:
// Jellyfin binds command names to its enums (400 on an unknown one), Emby also knows SeekRelative / SetPlaybackRate.
//
// Environment:
//   MOCK_SHARED_DEVICE_CONTROL=0  the user lacks EnableSharedDeviceControl: ownerless sessions leave ControllableByUserId lists
//   MOCK_NON_ADMIN=1 (Jellyfin)   Sessions pushes only carry the sessions the caller owns
//   MOCK_NO_SESSIONS_PUSH=1       SessionsStart is ignored (tests a sender's polling fallback)
import crypto from 'node:crypto';
import { acceptSocket, wsSend } from './ws.mjs';

// Jellyfin GeneralCommandType and PlaystateCommand (master, 2026-10). Case-insensitive, like System.Text.Json enum binding.
const JF_GENERAL = [
  'MoveUp', 'MoveDown', 'MoveLeft', 'MoveRight', 'PageUp', 'PageDown', 'PreviousLetter', 'NextLetter', 'ToggleOsd', 'ToggleContextMenu',
  'Select', 'Back', 'TakeScreenshot', 'SendKey', 'SendString', 'GoHome', 'GoToSettings', 'VolumeUp', 'VolumeDown', 'Mute', 'Unmute',
  'ToggleMute', 'SetVolume', 'SetAudioStreamIndex', 'SetSubtitleStreamIndex', 'ToggleFullscreen', 'DisplayContent', 'GoToSearch',
  'DisplayMessage', 'SetRepeatMode', 'ChannelUp', 'ChannelDown', 'Guide', 'ToggleStats', 'PlayMediaSource', 'PlayTrailers',
  'SetShuffleQueue', 'PlayState', 'PlayNext', 'ToggleOsdMenu', 'Play', 'SetMaxStreamingBitrate', 'SetPlaybackOrder',
];
const PLAYSTATE = ['Stop', 'Pause', 'Unpause', 'NextTrack', 'PreviousTrack', 'Seek', 'Rewind', 'FastForward', 'PlayPause'];
const PLAY_COMMANDS = ['PlayNow', 'PlayNext', 'PlayLast', 'PlayInstantMix', 'PlayShuffle'];
const canon = (list, name) => list.find((x) => x.toLowerCase() === String(name ?? '').toLowerCase());

export function qget(q, name) {
  for (const [k, v] of q) if (k.toLowerCase() === name.toLowerCase()) return v;
  return null;
}
const num = (v) => (v === null || v === undefined || v === '' ? undefined : Number(v));

export function createSessions({ flavour, serverId, userId, userName, items, log = console.log }) {
  const jf = flavour === 'jellyfin';
  const sharedDeviceControl = process.env.MOCK_SHARED_DEVICE_CONTROL !== '0';
  const nonAdmin = jf && process.env.MOCK_NON_ADMIN === '1';
  const noPush = process.env.MOCK_NO_SESSIONS_PUSH === '1';
  const byToken = new Map(); // token -> session
  const byId = new Map(); // id -> session (signed-in and virtual)
  const sockets = new Set(); // { sock, session, deviceId, at, keepAlives, push? }
  const remote = []; // every command sent through the Sessions API, newest last
  const newId = () => crypto.randomUUID().replace(/-/g, '');

  function make(fields) {
    const s = { Id: newId(), UserId: userId, caps: null, playing: null, volume: 100, muted: false, lastActivity: Date.now(), ...fields };
    byId.set(s.Id, s);
    return s;
  }
  const socketsOf = (s) => [...sockets].filter((k) => k.session === s);
  const controllable = (s) => (s.virtual ? true : Boolean(s.caps?.SupportsMediaControl) && socketsOf(s).length > 0);
  // Virtual sessions play on by themselves; signed-in ones are where their last report put them.
  function position(s) {
    const p = s.playing;
    if (!p) return 0;
    return s.virtual && !p.IsPaused ? p.PositionTicks + (Date.now() - p.since) * 10_000 : p.PositionTicks;
  }

  function dto(s) {
    const out = {
      Id: s.Id,
      ServerId: serverId,
      UserId: s.UserId ?? undefined,
      UserName: s.UserId === userId ? userName : s.UserId ? s.UserName : undefined,
      Client: s.Client,
      DeviceId: s.DeviceId,
      DeviceName: s.DeviceName,
      ApplicationVersion: s.ApplicationVersion,
      IsActive: true,
      LastActivityDate: new Date(s.lastActivity).toISOString(),
      PlayableMediaTypes: s.caps?.PlayableMediaTypes ?? [],
      SupportedCommands: s.caps?.SupportedCommands ?? [],
      SupportsMediaControl: Boolean(s.caps?.SupportsMediaControl),
      SupportsRemoteControl: controllable(s),
      PlayState: { CanSeek: false, IsPaused: false, IsMuted: s.muted, VolumeLevel: s.volume },
    };
    const p = s.playing;
    if (p) {
      const item = items.get(p.ItemId);
      out.NowPlayingItem = item ? { Id: item.Id, Name: item.Name, Type: item.Type, MediaType: item.MediaType, RunTimeTicks: item.RunTimeTicks } : { Id: p.ItemId };
      out.PlayState = {
        PositionTicks: Math.round(position(s)),
        IsPaused: p.IsPaused,
        IsMuted: s.muted,
        VolumeLevel: s.volume,
        CanSeek: true,
        MediaSourceId: p.MediaSourceId,
        AudioStreamIndex: p.AudioStreamIndex,
        SubtitleStreamIndex: p.SubtitleStreamIndex,
        PlayMethod: p.PlayMethod,
      };
    }
    return out;
  }

  // GET /Sessions. Never removes the caller (neither server does).
  function list(q) {
    const ctl = qget(q, 'controllableByUserId');
    const dev = qget(q, 'deviceId');
    const id = jf ? null : qget(q, 'id');
    return [...byId.values()]
      .filter((s) => (!dev || s.DeviceId === dev) && (!id || s.Id === id))
      .filter((s) => ctl === null || (controllable(s) && (s.UserId || sharedDeviceControl)))
      .map(dto);
  }

  // ---- Sessions push (SessionsStart "initialDelay,interval" / SessionsStop) ----
  function pushTo(k) {
    clearTimeout(k.push.timer);
    k.push.timer = null;
    k.push.last = Date.now();
    const all = [...byId.values()].filter((s) => !nonAdmin || s.UserId === k.session.UserId);
    wsSend(k.sock, { MessageType: 'Sessions', Data: all.map(dto) });
  }
  // At most one push per interval per listener; a change inside the interval is pushed when it ends.
  function changed() {
    for (const k of sockets) {
      if (!k.push || k.push.timer) continue;
      const wait = k.push.last + k.push.interval - Date.now();
      if (wait <= 0) pushTo(k);
      else k.push.timer = setTimeout(() => pushTo(k), wait);
    }
  }
  function onMessage(msg, k) {
    if (msg.MessageType === 'SessionsStart') {
      if (noPush) return log('SOCKET SessionsStart ignored (MOCK_NO_SESSIONS_PUSH=1)');
      const [delay, interval] = String(msg.Data ?? '0,1500').split(',').map(Number);
      clearTimeout(k.push?.timer);
      k.push = { interval: interval > 0 ? interval : 1500, last: 0, timer: null };
      k.push.timer = setTimeout(() => pushTo(k), delay > 0 ? delay : 0);
    } else if (msg.MessageType === 'SessionsStop') {
      clearTimeout(k.push?.timer);
      k.push = null;
    } else log(`SOCKET recv ${msg.MessageType}`);
  }

  function attach(req, sock, session) {
    const k = acceptSocket(req, sock, {
      deviceId: session.DeviceId,
      onMessage,
      onClose: (e) => {
        clearTimeout(e.push?.timer);
        sockets.delete(e);
        log(`SOCKET closed device=${e.deviceId} (${sockets.size} open)`);
        changed();
      },
    });
    k.session = session;
    sockets.add(k);
    log(`SOCKET open device=${k.deviceId} (${sockets.size} open)`);
    changed();
    return k;
  }
  function broadcast(MessageType, Data) {
    for (const k of sockets) wsSend(k.sock, { MessageType, Data });
    return sockets.size;
  }

  // ---- Signed-in sessions ----
  function login(token, f) {
    const s = make({ Client: f.Client, DeviceName: f.Device, DeviceId: f.DeviceId, ApplicationVersion: f.Version });
    byToken.set(token, s);
    return s;
  }
  function logout(token) {
    const s = byToken.get(token);
    byToken.delete(token);
    if (!s) return;
    byId.delete(s.Id);
    for (const k of socketsOf(s)) k.sock.destroy();
    changed();
  }
  // POST /Sessions/Capabilities/Full. Returns an error text for a 400, or null.
  function capabilities(s, b) {
    const cmds = Array.isArray(b.SupportedCommands) ? b.SupportedCommands : [];
    const bad = jf ? cmds.find((c) => !canon(JF_GENERAL, c)) : undefined;
    if (bad !== undefined) {
      // [UNVERIFIED-JF]: inferred from the enum binding; not seen on a real server yet.
      log(`[UNVERIFIED-JF] capabilities rejected: "${bad}" is not a GeneralCommandType`);
      return `The JSON value could not be converted to GeneralCommandType: ${bad}`;
    }
    s.caps = { PlayableMediaTypes: Array.isArray(b.PlayableMediaTypes) ? b.PlayableMediaTypes : [], SupportedCommands: cmds, SupportsMediaControl: Boolean(b.SupportsMediaControl) };
    s.lastActivity = Date.now();
    changed();
    return null;
  }
  // /Sessions/Playing, /Progress, /Stopped: what NowPlayingItem and PlayState show.
  function report(s, kind, b) {
    if (!s) return;
    s.lastActivity = Date.now();
    if (kind === 'stopped') s.playing = null;
    else if (b.ItemId) {
      s.playing = { ItemId: b.ItemId, PositionTicks: b.PositionTicks ?? 0, IsPaused: Boolean(b.IsPaused), MediaSourceId: b.MediaSourceId, AudioStreamIndex: b.AudioStreamIndex, SubtitleStreamIndex: b.SubtitleStreamIndex, PlayMethod: b.PlayMethod };
      if (typeof b.VolumeLevel === 'number') s.volume = b.VolumeLevel;
      if (typeof b.IsMuted === 'boolean') s.muted = b.IsMuted;
    }
    changed();
  }

  // ---- Virtual sessions (POST /Mock/Sessions) ----
  function addVirtual(b) {
    const s = make({
      Client: b.Client ?? 'Mock',
      DeviceName: b.DeviceName ?? 'Mock receiver',
      DeviceId: b.DeviceId ?? newId(),
      ApplicationVersion: b.ApplicationVersion ?? '1.0.0',
      // Server Play To (DLNA) sessions have no owner until someone plays to them.
      UserId: 'UserId' in b ? b.UserId || null : b.Client === 'DLNA' ? null : userId,
      UserName: b.UserName,
      virtual: true,
      ignore: Boolean(b.ignore),
      caps: { PlayableMediaTypes: b.PlayableMediaTypes ?? ['Audio', 'Video'], SupportedCommands: b.SupportedCommands ?? [], SupportsMediaControl: true },
    });
    log(`VIRTUAL session ${s.Id} "${s.DeviceName}" (${s.Client}${s.UserId ? '' : ', ownerless'}${s.ignore ? ', ignores commands' : ''})`);
    changed();
    return dto(s);
  }
  function freeze(s) {
    if (!s.playing) return;
    s.playing.PositionTicks = position(s);
    s.playing.since = Date.now();
  }
  // What a virtual session does with a command (or its own user's action, for drive()).
  function apply(s, type, d) {
    const p = s.playing;
    freeze(s);
    if (type === 'Play') {
      if (d.PlayCommand === 'PlayNow' || !p) {
        const ItemId = d.ItemIds[d.StartIndex ?? 0] ?? d.ItemIds[0];
        s.playing = { ItemId, PositionTicks: d.StartPositionTicks ?? 0, IsPaused: false, since: Date.now(), MediaSourceId: d.MediaSourceId ?? ItemId, AudioStreamIndex: d.AudioStreamIndex, SubtitleStreamIndex: d.SubtitleStreamIndex, PlayMethod: 'DirectPlay' };
      }
    } else if (type === 'Playstate' && p) {
      const c = d.Command;
      if (c === 'Stop') s.playing = null;
      else if (c === 'Pause') p.IsPaused = true;
      else if (c === 'Unpause') p.IsPaused = false;
      else if (c === 'PlayPause') p.IsPaused = !p.IsPaused;
      else if (c === 'Seek' && Number.isFinite(d.SeekPositionTicks)) p.PositionTicks = Math.max(0, d.SeekPositionTicks);
      else if (c === 'SeekRelative' && Number.isFinite(d.SeekPositionTicks)) p.PositionTicks = Math.max(0, p.PositionTicks + d.SeekPositionTicks);
    } else if (type === 'GeneralCommand') {
      const v = Number(d.Arguments?.Volume);
      if (d.Name === 'SetVolume' && Number.isFinite(v)) s.volume = Math.min(100, Math.max(0, v));
      else if (d.Name === 'Mute') s.muted = true;
      else if (d.Name === 'Unmute') s.muted = false;
      else if (d.Name === 'ToggleMute') s.muted = !s.muted;
    }
    s.lastActivity = Date.now();
    changed();
  }
  // POST /Mock/Sessions/{id}/{Pause|Unpause|Seek}?PositionTicks=: the virtual session's own user acts on it.
  function drive(id, action, q) {
    const s = byId.get(id);
    if (!s?.virtual) return 404;
    const Command = canon(['Pause', 'Unpause', 'Seek'], action);
    if (!Command) return 400;
    apply(s, 'Playstate', { Command, SeekPositionTicks: num(qget(q, 'positionTicks') ?? qget(q, 'seekPositionTicks')) });
    return 204;
  }

  // ---- Commands: POST /Sessions/{id}/Playing[/{cmd}], /Command[/{name}], /Message ----
  // rest = the path parts after /Sessions/{id}. Returns { status, text? }, or null for a route this store does not own.
  function command(id, rest, q, b, controllerId = userId) {
    const lr = rest.map((x) => x.toLowerCase());
    let msg;
    if (lr[0] === 'playing' && rest.length === 1) {
      // Jellyfin reads the query only; Emby also takes the body.
      const g = (k) => qget(q, k) ?? (jf ? null : b[Object.keys(b).find((x) => x.toLowerCase() === k.toLowerCase())] ?? null);
      const rawIds = g('itemIds');
      const ids = (Array.isArray(rawIds) ? rawIds : String(rawIds ?? '').split(',')).map(String).filter(Boolean);
      const rawCmd = g('playCommand') ?? (jf ? null : 'PlayNow');
      const PlayCommand = canon(PLAY_COMMANDS, rawCmd);
      if (!ids.length || !PlayCommand) return { status: 400, text: `${!ids.length ? 'itemIds' : 'playCommand'} is required` };
      msg = {
        MessageType: 'Play',
        Data: { ItemIds: ids, PlayCommand, StartPositionTicks: num(g('startPositionTicks')), MediaSourceId: g('mediaSourceId') ?? undefined, AudioStreamIndex: num(g('audioStreamIndex')), SubtitleStreamIndex: num(g('subtitleStreamIndex')), StartIndex: num(g('startIndex')), ControllingUserId: controllerId },
      };
    } else if (lr[0] === 'playing' && rest.length === 2) {
      const Command = canon(jf ? PLAYSTATE : [...PLAYSTATE, 'SeekRelative'], rest[1]);
      if (!Command) return { status: 400, text: `The value '${rest[1]}' is not valid.` };
      msg = { MessageType: 'Playstate', Data: { Command, SeekPositionTicks: num(qget(q, 'seekPositionTicks')), ControllingUserId: controllerId } };
    } else if (lr[0] === 'command' && rest.length <= 2) {
      const raw = rest[1] ?? b.Name;
      // Emby also knows SetPlaybackRate (and more); Jellyfin's enum binding rejects anything outside GeneralCommandType.
      const Name = jf ? canon(JF_GENERAL, raw) : raw ? String(raw) : undefined;
      if (!Name) return { status: 400, text: `The value '${raw ?? ''}' is not valid.` };
      const Arguments = Object.fromEntries(Object.entries(b.Arguments ?? {}).map(([k, v]) => [k, String(v)]));
      msg = { MessageType: 'GeneralCommand', Data: { Name, Arguments, ControllingUserId: controllerId } };
    } else if (lr[0] === 'message' && rest.length === 1) {
      // Jellyfin binds the MessageCommand from the body only (Text required); Emby's DTO also reads the query.
      const g = (k) => b[k] ?? (jf ? undefined : qget(q, k));
      if (!g('Text')) return { status: 400, text: 'Text is required' };
      msg ={ MessageType: 'GeneralCommand', Data: { Name: 'DisplayMessage', Arguments: { Header: String(g('Header') ?? ''), Text: String(g('Text') ?? ''), TimeoutMs: String(g('TimeoutMs') ?? '') }, ControllingUserId: controllerId } };
    } else return null;
    const s = byId.get(id);
    if (!s) return { status: 404, text: 'Session not found' };
    // Drop the undefined fields, as the servers' serialisers do.
    msg.Data = JSON.parse(JSON.stringify(msg.Data));
    let sent = 0;
    if (s.virtual) {
      if (!s.ignore) apply(s, msg.MessageType, msg.Data);
    } else for (const k of socketsOf(s)) (wsSend(k.sock, msg), sent++);
    remote.push({ at: new Date().toISOString(), SessionId: s.Id, DeviceId: s.DeviceId, DeviceName: s.DeviceName, virtual: Boolean(s.virtual), sockets: sent, ...msg });
    if (remote.length > 200) remote.shift();
    const d = msg.Data;
    log(`REMOTE ${msg.MessageType} ${d.Command ?? d.Name ?? `${d.PlayCommand} ${d.ItemIds.join(',')}`} -> ${s.DeviceName}${s.virtual ? ` (virtual${s.ignore ? ', ignored' : ''})` : ` (${sent} socket${sent === 1 ? '' : 's'})`}`);
    return { status: 204 };
  }

  // A device's sessions leave the list (as a server's idle timeout does); their tokens stay valid until Logout.
  function drop(deviceId) {
    const gone = [...byId.values()].filter((s) => s.DeviceId === deviceId);
    for (const s of gone) byId.delete(s.Id);
    if (gone.length) changed();
    return gone.length;
  }

  return {
    forToken: (t) => byToken.get(t),
    login,
    logout,
    drop,
    capabilities,
    report,
    list,
    command,
    addVirtual,
    drive,
    attach,
    broadcast,
    state: () => ({
      sockets: [...sockets].map((k) => ({ deviceId: k.deviceId, since: k.at, keepAlives: k.keepAlives, sessionsPush: Boolean(k.push) })),
      sessions: byId.size,
      remote: remote.slice(),
    }),
  };
}
