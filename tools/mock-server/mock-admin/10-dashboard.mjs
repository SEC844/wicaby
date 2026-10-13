// Mock admin: dashboard (system info, power, sessions + remote control),
// activity log and scheduled tasks. Loaded by tools/mock-server/mock-emby.mjs.
// Restart / shutdown only log: nothing real happens.

import { DEMO_ADMIN } from '../demo/admin-demo.mjs';

const MIN = 60_000;
const TICKS_PER_MS = 10_000;
const started = Date.now() - (3 * 24 * 60 + 137) * MIN;

export const MOCK_USERS = [
  { Id: 'u-wika', Name: 'Wika' },
  { Id: 'u-lea', Name: 'Léa' },
  { Id: 'u-marc', Name: 'Marc' },
  { Id: 'u-kids', Name: 'Enfants' },
];

function authed(req, q, tokens) {
  const token = req.headers['x-emby-token'] ?? q.get('api_key') ?? /Token="([^"]+)"/.exec(String(req.headers['x-emby-authorization'] ?? ''))?.[1];
  return token && tokens.has(token);
}

// ---- Sessions ----

function itemView(items, id) {
  const it = items.get(id);
  if (!it) return undefined;
  const { UserData: _u, ...rest } = it;
  return rest;
}

const STREAMS_HD = [
  { Index: 0, Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 },
  { Index: 1, Type: 'Audio', Codec: 'aac', Channels: 2 },
];
const STREAMS_4K = [
  { Index: 0, Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160, VideoRange: 'HDR' },
  { Index: 1, Type: 'Audio', Codec: 'truehd', Channels: 8 },
];

let sessions;
function initSessions(items, SERVER_ID) {
  const now = Date.now();
  const movie = items.get('movie-2') ? 'movie-2' : [...items.keys()].find((k) => items.get(k).Type === 'Movie');
  const ep = items.get('ep-1-3') ? 'ep-1-3' : [...items.keys()].find((k) => items.get(k).Type === 'Episode');
  const movie2 = items.get('movie-5') ? 'movie-5' : movie;
  sessions = [
    {
      Id: 'sess-tv', UserId: 'u-lea', UserName: 'Léa', Client: 'Emby for Android TV', ApplicationVersion: '2.1.14', DeviceName: 'Living room · Shield TV', DeviceId: 'dev-shield',
      RemoteEndPoint: '192.168.1.42', SupportsRemoteControl: true, ServerId: SERVER_ID,
      itemId: movie, startedAt: now - 23 * MIN, paused: false, offset: 11 * MIN,
      PlayMethod: 'Transcode', streams: STREAMS_4K,
      TranscodingInfo: {
        AudioCodec: 'aac', VideoCodec: 'h264', Container: 'ts', IsVideoDirect: false, IsAudioDirect: false, Bitrate: 12_400_000, Framerate: 58.4,
        CompletionPercentage: 41.2, Width: 1920, Height: 1080, AudioChannels: 2, TranscodeReasons: ['VideoCodecNotSupported', 'ContainerBitrateExceedsLimit', 'AudioChannelsNotSupported'],
        VideoDecoderIsHardware: true, VideoDecoderHwAccel: 'qsv', VideoEncoderIsHardware: true, VideoEncoderHwAccel: 'qsv', CurrentCpuUsage: 14,
      },
    },
    {
      Id: 'sess-ios', UserId: 'u-wika', UserName: 'Wika', Client: 'Emby for iOS', ApplicationVersion: '2.2.30', DeviceName: 'iPhone de Wika', DeviceId: 'dev-iphone',
      RemoteEndPoint: '192.168.1.17', SupportsRemoteControl: true, ServerId: SERVER_ID,
      itemId: ep, startedAt: now - 9 * MIN, paused: true, offset: 4 * MIN, pausedAt: now - 2 * MIN,
      PlayMethod: 'DirectPlay',
    },
    {
      Id: 'sess-web', UserId: 'u-marc', UserName: 'Marc', Client: 'Emby Web', ApplicationVersion: '4.9.1.0', DeviceName: 'Chrome · Windows', DeviceId: 'dev-chrome',
      RemoteEndPoint: '203.0.113.42', SupportsRemoteControl: true, ServerId: SERVER_ID,
      itemId: movie2, startedAt: now - 48 * MIN, paused: false, offset: 0,
      PlayMethod: 'DirectStream', streams: [{ Index: 0, Type: 'Video', Codec: 'hevc', Width: 1920, Height: 1080 }, { Index: 1, Type: 'Audio', Codec: 'eac3', Channels: 6 }],
      TranscodingInfo: { AudioCodec: 'aac', VideoCodec: 'hevc', Container: 'mp4', IsVideoDirect: true, IsAudioDirect: false, Bitrate: 8_100_000, AudioChannels: 2, TranscodeReasons: ['AudioCodecNotSupported'] },
    },
    {
      Id: 'sess-theater', UserId: 'u-kids', UserName: 'Enfants', Client: 'Emby Theater', ApplicationVersion: '3.0.20', DeviceName: 'Bedroom · PC', DeviceId: 'dev-theater',
      RemoteEndPoint: '192.168.1.60', SupportsRemoteControl: true, ServerId: SERVER_ID, lastActivity: now - 6 * MIN,
    },
    {
      Id: 'sess-ipad', UserId: 'u-lea', UserName: 'Léa', Client: 'Emby for iOS', ApplicationVersion: '2.2.30', DeviceName: 'iPad de Léa', DeviceId: 'dev-ipad',
      RemoteEndPoint: '192.168.1.23', SupportsRemoteControl: false, ServerId: SERVER_ID, lastActivity: now - 13 * MIN,
    },
  ];
}

function positionMs(s) {
  const until = s.paused ? s.pausedAt ?? Date.now() : Date.now();
  return s.offset + (until - s.startedAt);
}

function sessionView(s, items) {
  const out = {
    Id: s.Id, UserId: s.UserId, UserName: s.UserName, Client: s.Client, ApplicationVersion: s.ApplicationVersion, DeviceName: s.DeviceName, DeviceId: s.DeviceId,
    RemoteEndPoint: s.RemoteEndPoint, SupportsRemoteControl: s.SupportsRemoteControl, ServerId: s.ServerId, PlayableMediaTypes: ['Audio', 'Video'],
    LastActivityDate: new Date(s.lastActivity ?? Date.now()).toISOString(),
  };
  const item = s.itemId ? itemView(items, s.itemId) : undefined;
  if (item) {
    const runtime = (item.RunTimeTicks ?? 90 * MIN * TICKS_PER_MS) / TICKS_PER_MS;
    let pos = positionMs(s);
    if (pos > runtime) {
      s.offset = 0;
      s.startedAt = Date.now();
      pos = 0;
    }
    out.NowPlayingItem = { ...item, Bitrate: s.PlayMethod === 'DirectPlay' ? 18_600_000 : 42_000_000, MediaStreams: s.streams ?? STREAMS_HD };
    out.PlayState = { PositionTicks: Math.round(pos * TICKS_PER_MS), IsPaused: s.paused, IsMuted: false, VolumeLevel: 100, PlayMethod: s.PlayMethod, CanSeek: true };
    if (s.TranscodingInfo) {
      const ti = { ...s.TranscodingInfo };
      if (ti.Framerate) ti.Framerate = Math.round((ti.Framerate + (Math.random() * 6 - 3)) * 10) / 10;
      if (ti.CurrentCpuUsage) ti.CurrentCpuUsage = Math.round(10 + Math.random() * 12);
      if (ti.CompletionPercentage) ti.CompletionPercentage = Math.min(100, (pos / runtime) * 100 + 6);
      out.TranscodingInfo = ti;
    }
  } else {
    out.PlayState = { CanSeek: false, IsPaused: false, IsMuted: false };
  }
  return out;
}

// ---- Activity log ----

let activity;
function initActivity() {
  const now = Date.now();
  const titles = DEMO_ADMIN?.titles ?? ['Néon Fantôme', 'La Dernière Manche', 'Clutch', 'Uplink', 'Le Signal', 'Minuit à Lyon'];
  const devices = ['Shield TV', 'iPhone de Wika', 'Chrome', 'Bedroom · PC'];
  const kinds = [
    (u) => ({ Type: 'VideoPlayback', Name: `${u.Name} a commencé la lecture de ${pick(titles)} sur ${pick(devices)}`, Severity: 'Info', UserId: u.Id }),
    (u) => ({ Type: 'VideoPlaybackStopped', Name: `${u.Name} a terminé la lecture de ${pick(titles)} sur ${pick(devices)}`, Severity: 'Info', UserId: u.Id }),
    (u) => ({ Type: 'SessionStarted', Name: `${u.Name} s’est connecté depuis ${pick(devices)}`, ShortOverview: `Adresse IP : 192.168.1.${10 + Math.floor(Math.random() * 80)}`, Severity: 'Info', UserId: u.Id }),
    (u) => ({ Type: 'SessionEnded', Name: `${u.Name} s’est déconnecté de ${pick(devices)}`, Severity: 'Info', UserId: u.Id }),
    () => ({ Type: 'ScheduledTaskCompleted', Name: 'Analyser la médiathèque terminé', ShortOverview: 'Durée : 2 minutes 14 secondes', Severity: 'Info' }),
    () => ({ Type: 'PluginUpdateInstalled', Name: 'L’extension Open Subtitles a été mise à jour vers 1.0.52', Severity: 'Info' }),
    (u) => ({ Type: 'UserLockedOut', Name: `Échec de connexion pour ${u.Name}`, ShortOverview: 'Adresse IP : 203.0.113.42', Overview: 'Mot de passe incorrect.\nTentative depuis 203.0.113.42 (Emby Web 4.9.1.0).', Severity: 'Warn', UserId: u.Id }),
    () => ({ Type: 'ScheduledTaskFailed', Name: 'Extraire les images des chapitres a échoué', ShortOverview: 'ffmpeg a quitté avec le code 1', Overview: 'MediaBrowser.Model.Dlna.TranscodingException: ffmpeg exited with code 1\n   at Emby.Server.MediaEncoding.ChapterImages.Extract(String path)\n   at Emby.Server.Implementations.ScheduledTasks.ChapterImagesTask.Execute(CancellationToken token, IProgress`1 progress)', Severity: 'Error' }),
    () => ({ Type: 'ServerStartup', Name: 'Le serveur Emby a démarré', ShortOverview: 'Version 4.9.1.0', Severity: 'Info' }),
  ];
  const weights = [6, 6, 4, 3, 2, 1, 1, 1, 0.3];
  const total = weights.reduce((a, b) => a + b, 0);
  activity = [];
  let at = now - 3 * MIN;
  for (let i = 0; i < 260; i++) {
    let r = Math.random() * total;
    let k = 0;
    while (r > weights[k]) r -= weights[k++];
    const u = pick(MOCK_USERS);
    activity.push({ Id: 5000 - i, Date: new Date(at).toISOString(), ItemId: undefined, ...kinds[k](u) });
    at -= Math.round(Math.random() * 6 * 60 * MIN);
  }
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---- Scheduled tasks ----

const TICKS_MIN = 60 * 10_000_000;
let tasks;
function initTasks() {
  const now = Date.now();
  const done = (agoMin, durSec, Status = 'Completed', extra = {}) => ({
    StartTimeUtc: new Date(now - agoMin * MIN - durSec * 1000).toISOString(),
    EndTimeUtc: new Date(now - agoMin * MIN).toISOString(),
    Status,
    ...extra,
  });
  const daily = (h, m = 0) => ({ Type: 'DailyTrigger', TimeOfDayTicks: (h * 60 + m) * TICKS_MIN });
  const every = (min) => ({ Type: 'IntervalTrigger', IntervalTicks: min * TICKS_MIN });
  const startAgo = (Date.now() - started) / MIN;
  tasks = [
    { Id: 't-scan', Key: 'RefreshLibrary', Name: 'Analyser la médiathèque', Category: 'Bibliothèque', Description: 'Recherche les nouveaux fichiers et met à jour les métadonnées.', Triggers: [every(12 * 60)], last: done(95, 134) },
    { Id: 't-chapters', Key: 'ChapterImages', Name: 'Extraire les images des chapitres', Category: 'Bibliothèque', Description: 'Crée les vignettes des chapitres des vidéos.', Triggers: [daily(2)], last: done(600, 412, 'Failed', { ErrorMessage: 'ffmpeg a quitté avec le code 1' }) },
    { Id: 't-thumbs', Key: 'ThumbnailImages', Name: 'Générer les vignettes de navigation', Category: 'Bibliothèque', Description: 'Prépare les aperçus affichés pendant l’avance rapide.', Triggers: [{ Type: 'WeeklyTrigger', DayOfWeek: 'Sunday', TimeOfDayTicks: 3 * 60 * TICKS_MIN }], last: done(3 * 1440, 1870), running: { pct: 37.5, speed: 0.6 } },
    { Id: 't-people', Key: 'RefreshPeople', Name: 'Actualiser les personnes', Category: 'Bibliothèque', Description: 'Met à jour les fiches des acteurs et réalisateurs.', Triggers: [{ Type: 'WeeklyTrigger', DayOfWeek: 'Wednesday', TimeOfDayTicks: 4 * 60 * TICKS_MIN }], last: done(5 * 1440, 63) },
    { Id: 't-logs', Key: 'CleanLogs', Name: 'Nettoyer les journaux', Category: 'Maintenance', Description: 'Supprime les journaux de plus de trois jours.', Triggers: [{ Type: 'StartupTrigger' }, every(24 * 60)], last: { StartTimeUtc: new Date(started + 20_000).toISOString(), EndTimeUtc: new Date(started + 21_000).toISOString(), Status: 'Completed' } },
    { Id: 't-cache', Key: 'DeleteCacheFiles', Name: 'Vider le cache', Category: 'Maintenance', Description: 'Supprime les fichiers du cache devenus inutiles.', Triggers: [{ Type: 'StartupTrigger' }], last: { StartTimeUtc: new Date(started + 15_000).toISOString(), EndTimeUtc: new Date(started + 18_000).toISOString(), Status: 'Completed' } },
    { Id: 't-transcode', Key: 'DeleteTranscodeFiles', Name: 'Nettoyer le dossier de transcodage', Category: 'Maintenance', Description: 'Supprime les fichiers temporaires de transcodage.', Triggers: [every(60)], last: done(14, 0.4) },
    { Id: 't-plugins', Key: 'PluginUpdates', Name: 'Mettre à jour les extensions', Category: 'Application', Description: 'Télécharge et installe les mises à jour des extensions.', Triggers: [daily(3, 30)], last: done(720, 9) },
    { Id: 't-update', Key: 'SystemUpdate', Name: 'Rechercher les mises à jour du serveur', Category: 'Application', Description: 'Vérifie si une nouvelle version d’Emby est disponible.', Triggers: [every(24 * 60)], last: done(startAgo - 1, 3, 'Cancelled') },
    { Id: 't-subs', Key: 'DownloadSubtitles', Name: 'Télécharger les sous-titres manquants', Category: 'Sous-titres', Description: 'Cherche les sous-titres manquants selon les préférences des bibliothèques.', Triggers: [], last: null },
  ];
  for (const t of tasks) if (t.running) t.running.since = Date.now();
}

function taskView(t) {
  let state = 'Idle';
  let pct;
  if (t.running) {
    if (t.running.cancelAt) state = 'Cancelling';
    else state = 'Running';
    pct = Math.min(100, t.running.pct + ((Date.now() - t.running.since) / 1000) * t.running.speed);
  }
  return {
    Id: t.Id, Key: t.Key, Name: t.Name, Category: t.Category, Description: t.Description, IsHidden: false,
    State: state, CurrentProgressPercentage: pct, Triggers: t.Triggers,
    LastExecutionResult: t.last ? { ...t.last, Name: t.Name, Key: t.Key, Id: t.Id } : undefined,
  };
}

function settleTasks() {
  for (const t of tasks) {
    const r = t.running;
    if (!r) continue;
    const pct = r.pct + ((Date.now() - r.since) / 1000) * r.speed;
    if (r.cancelAt && Date.now() - r.cancelAt > 1200) {
      t.last = { StartTimeUtc: new Date(r.startedAt ?? r.since).toISOString(), EndTimeUtc: new Date().toISOString(), Status: 'Cancelled' };
      t.running = null;
    } else if (pct >= 100) {
      t.last = { StartTimeUtc: new Date(r.startedAt ?? r.since).toISOString(), EndTimeUtc: new Date().toISOString(), Status: 'Completed' };
      t.running = null;
    }
  }
}

// ---- Router ----

export async function route({ req, res, p, parts, q, send, body, tokens, items, SERVER_ID, remote }) {
  const m = req.method;
  const isOurs =
    p === '/System/Info' || p === '/System/Restart' || p === '/System/Shutdown' ||
    (p === '/Sessions' && m === 'GET') ||
    (parts[0] === 'Sessions' && sessions?.some((s) => s.Id === parts[1])) ||
    (parts[0] === 'Sessions' && /^sess-/.test(parts[1] ?? '')) ||
    p === '/System/ActivityLog/Entries' || parts[0] === 'ScheduledTasks';
  if (!isOurs) return false;
  if (!authed(req, q, tokens)) {
    send(res, 401, 'Unauthorized', 'text/plain');
    return true;
  }
  if (!sessions) initSessions(items, SERVER_ID);
  if (!activity) initActivity();
  if (!tasks) initTasks();

  if (p === '/System/Info' && m === 'GET') {
    // MOCK_PENDING_RESTART=1: "restart required" (Wicaby's background admin alert); an update is always offered.
    send(res, 200, {
      Id: SERVER_ID, ServerName: process.env.MOCK_NAME ?? 'Wicaby Mock Emby', Version: '4.9.1.0', ProductName: 'Emby Server',
      OperatingSystem: 'Windows', OperatingSystemDisplayName: 'Windows', SystemArchitecture: 'X64',
      HasPendingRestart: process.env.MOCK_PENDING_RESTART === '1', HasUpdateAvailable: true, CanSelfRestart: true, CanSelfUpdate: true, CanLaunchWebBrowser: false, IsShuttingDown: false,
      LocalAddress: `http://127.0.0.1:${req.socket.localPort}`, LocalAddresses: [`http://127.0.0.1:${req.socket.localPort}`], WanAddress: 'https://emby.example.net:8920', RemoteAddresses: [],
      HttpServerPortNumber: req.socket.localPort, HttpsPortNumber: 8920, SupportsHttps: true,
      ProgramDataPath: 'C:\\ProgramData\\Emby-Server\\programdata', CachePath: 'C:\\ProgramData\\Emby-Server\\programdata\\cache',
      LogPath: 'C:\\ProgramData\\Emby-Server\\programdata\\logs', TranscodingTempPath: 'D:\\transcode-temp',
      InternalMetadataPath: 'C:\\ProgramData\\Emby-Server\\programdata\\metadata',
    });
    return true;
  }
  if ((p === '/System/Restart' || p === '/System/Shutdown') && m === 'POST') {
    console.log(`[mock-admin] ${p} requested — no-op`);
    send(res, 204);
    return true;
  }

  if (p === '/Sessions' && m === 'GET') {
    const within = Number(q.get('ActiveWithinSeconds') ?? q.get('activeWithinSeconds') ?? 0);
    // "Lire sur…": ControllableByUserId keeps the clients that accept remote control (the mock user is admin, so all users').
    const controllable = q.has('ControllableByUserId') || q.has('controllableByUserId');
    const id = q.get('Id') ?? q.get('id');
    const dev = q.get('DeviceId') ?? q.get('deviceId');
    const list = sessions
      .filter((s) => !within || s.itemId || Date.now() - (s.lastActivity ?? Date.now()) <= within * 1000)
      .filter((s) => !controllable || s.SupportsRemoteControl)
      .filter((s) => (!id || s.Id === id) && (!dev || s.DeviceId === dev))
      .map((s) => sessionView(s, items));
    // Plus the signed-in and virtual sessions of the remote-control store (tools/mock-server/sessions.mjs).
    send(res, 200, [...list, ...(remote?.list(q) ?? [])]);
    return true;
  }
  if (parts[0] === 'Sessions' && m === 'POST') {
    const s = sessions.find((x) => x.Id === parts[1]);
    if (!s) {
      send(res, 404, 'Session not found', 'text/plain');
      return true;
    }
    if (parts[2] === 'Playing') {
      const cmd = parts[3] ?? q.get('PlayCommand') ?? 'PlayNow';
      console.log(`[mock-admin] session ${s.Id}: ${cmd}${parts[3] ? '' : ` ${q.get('ItemIds')}`}`);
      const at = (ms) => {
        s.offset = Math.max(0, ms);
        s.startedAt = Date.now();
        if (s.paused) s.pausedAt = s.startedAt;
      };
      if (!parts[3]) {
        // POST /Sessions/{id}/Playing?ItemIds=…&PlayCommand=PlayNow&StartPositionTicks=…
        const id = (q.get('ItemIds') ?? '').split(',')[0];
        if (!items.has(id)) {
          send(res, 400, 'Unknown item', 'text/plain');
          return true;
        }
        Object.assign(s, { itemId: id, paused: false, pausedAt: undefined, PlayMethod: 'DirectPlay', TranscodingInfo: undefined });
        at(Number(q.get('StartPositionTicks') ?? 0) / TICKS_PER_MS);
      } else if (cmd === 'Seek') {
        at(Number(q.get('SeekPositionTicks') ?? 0) / TICKS_PER_MS);
      } else if (cmd === 'PlayPause') {
        if (s.paused) at(positionMs(s));
        else s.pausedAt = Date.now();
        s.paused = !s.paused;
      } else if (cmd === 'Pause' && !s.paused) {
        s.paused = true;
        s.pausedAt = Date.now();
      } else if (cmd === 'Unpause' && s.paused) {
        s.offset = positionMs(s);
        s.startedAt = Date.now();
        s.paused = false;
        s.pausedAt = undefined;
      } else if (cmd === 'Stop') {
        s.itemId = undefined;
        s.TranscodingInfo = undefined;
        s.lastActivity = Date.now();
      }
      send(res, 204);
      return true;
    }
    if (parts[2] === 'Message') {
      const b = await body(req);
      console.log(`[mock-admin] message to ${s.DeviceName}: ${JSON.stringify({ Header: b.Header ?? q.get('Header'), Text: b.Text ?? q.get('Text') })}`);
      send(res, 204);
      return true;
    }
    send(res, 204);
    return true;
  }

  if (p === '/System/ActivityLog/Entries' && m === 'GET') {
    const start = Number(q.get('StartIndex') ?? 0);
    const limit = Number(q.get('Limit') ?? 100);
    const min = q.get('MinDate') ? Date.parse(q.get('MinDate')) : 0;
    const hasUser = q.get('HasUserId');
    const list = activity.filter((e) => Date.parse(e.Date) >= min && (hasUser == null || (hasUser === 'true') === Boolean(e.UserId)));
    send(res, 200, { Items: list.slice(start, start + limit), TotalRecordCount: list.length });
    return true;
  }

  if (parts[0] === 'ScheduledTasks') {
    settleTasks();
    if (p === '/ScheduledTasks' && m === 'GET') {
      send(res, 200, tasks.map(taskView));
      return true;
    }
    if (parts[1] === 'Running' && parts[2]) {
      const t = tasks.find((x) => x.Id === parts[2]);
      if (!t) return send(res, 404, 'Task not found', 'text/plain'), true;
      if (m === 'POST' && !t.running) {
        console.log(`[mock-admin] run task ${t.Name}`);
        t.running = { pct: 0, speed: 4 + Math.random() * 6, since: Date.now(), startedAt: Date.now() };
      } else if (m === 'DELETE' && t.running) {
        console.log(`[mock-admin] stop task ${t.Name}`);
        t.running.cancelAt = Date.now();
      }
      send(res, 204);
      return true;
    }
    if (parts[2] === 'Triggers' && m === 'POST') {
      const t = tasks.find((x) => x.Id === parts[1]);
      if (!t) return send(res, 404, 'Task not found', 'text/plain'), true;
      const b = await body(req);
      t.Triggers = Array.isArray(b) ? b : [];
      console.log(`[mock-admin] triggers of ${t.Name}: ${JSON.stringify(t.Triggers)}`);
      send(res, 204);
      return true;
    }
    if (parts[1] && m === 'GET') {
      const t = tasks.find((x) => x.Id === parts[1]);
      if (!t) return send(res, 404, 'Task not found', 'text/plain'), true;
      send(res, 200, taskView(t));
      return true;
    }
  }
  return false;
}
