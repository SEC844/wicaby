// Cast targets (docs/specs/cast-spec.md §2.1-2.3): the picker's rows, their order and dedupe, and which remote
// controls each one gets. Pure, so tools/checks/cast-check.mjs runs it on the golden fixtures in
// tools/checks/fixtures/cast/ (the :core Kotlin tests read the same files).
import type { CastControls, CastStartOptions, CastTarget, ServerKind } from '../../shared/contract';

// GET /Sessions, the fields the sender reads (both servers).
export interface SessionDto {
  Id: string;
  DeviceId?: string;
  DeviceName?: string;
  Client?: string;
  ApplicationVersion?: string;
  SupportsRemoteControl?: boolean;
  PlayableMediaTypes?: string[];
  SupportedCommands?: string[];
  NowPlayingItem?: { Id: string; Name?: string; Type?: string; SeriesName?: string; RunTimeTicks?: number };
  PlayState?: {
    PositionTicks?: number;
    IsPaused?: boolean;
    IsMuted?: boolean;
    VolumeLevel?: number;
    MediaSourceId?: string;
    AudioStreamIndex?: number;
    SubtitleStreamIndex?: number;
  };
}

// Command names compare case-insensitively on both sides (§2.3: Jellyfin spells it PlayState).
export const hasCommand = (commands: readonly string[] | undefined, name: string): boolean =>
  (commands ?? []).some((c) => typeof c === 'string' && c.toLowerCase() === name.toLowerCase());

// Channels, programmes and recordings still being made go only to session targets (§1 Live TV): their receiver tunes
// its own live stream.
export function sessionsOnly(item: { Type?: string; Status?: string } | null | undefined): boolean {
  return item?.Type === 'TvChannel' || item?.Type === 'Program' || item?.Status === 'InProgress';
}

// §2.2 section 1, on the server that owns the item. Neither server removes the caller, so its own DeviceId goes here.
export function sessionTargets(
  sessions: readonly SessionDto[],
  ctx: { serverId: string; serverName: string; ownDeviceId: string; mediaType?: string },
): CastTarget[] {
  const mediaType = ctx.mediaType?.toLowerCase();
  return sessions
    .filter((s) => typeof s?.Id === 'string' && s.DeviceId !== ctx.ownDeviceId && s.SupportsRemoteControl !== false)
    .filter((s) => !mediaType || (s.PlayableMediaTypes ?? []).some((m) => m.toLowerCase() === mediaType))
    .map((s) => {
      const dlna = s.Client?.toLowerCase() === 'dlna';
      return {
        key: `s:${ctx.serverId}:${s.Id}`,
        kind: 'session' as const,
        section: dlna ? ('dlna' as const) : ('apps' as const),
        name: s.DeviceName || s.Client || s.Id,
        detail: dlna ? '' : [s.Client, s.ApplicationVersion].filter(Boolean).join(' '),
        via: dlna ? ctx.serverName : undefined,
        serverId: ctx.serverId,
        deviceId: s.DeviceId,
        commands: (s.SupportedCommands ?? []).filter((c) => typeof c === 'string'),
        mediaTypes: (s.PlayableMediaTypes ?? []).filter((m): m is 'Audio' | 'Video' => m === 'Audio' || m === 'Video'),
      };
    });
}

// The picker's one list (§2.2): Applications, then DLNA (server sessions before SSDP renderers), then Chromecast.
// A renderer whose UDN equals a server DLNA session's DeviceId is shown once, as that session.
export function mergeTargets(sessions: readonly CastTarget[], dlna: readonly CastTarget[] = [], cast: readonly CastTarget[] = []): CastTarget[] {
  const udn = (id: string | undefined) => (id ?? '').replace(/^uuid:/i, '').toLowerCase();
  const viaServer = new Set(sessions.filter((t) => t.section === 'dlna').map((t) => udn(t.deviceId)));
  return [
    ...sessions.filter((t) => t.section === 'apps'),
    ...sessions.filter((t) => t.section === 'dlna'),
    ...dlna.filter((t) => !viaServer.has(udn(t.key.slice(2)))),
    ...cast,
  ];
}

// §2.3: the remote controls a target gets. Transport is never gated (servers do not gate Playstate on
// SupportedCommands); general commands are, and Emby-only ones only on Emby.
export function controlsFor(target: Pick<CastTarget, 'kind' | 'commands'>, server: ServerKind, queueLength: number): CastControls {
  const has = (n: string) => hasCommand(target.commands, n);
  const session = target.kind === 'session';
  return {
    transport: true,
    seekRelative: session && server === 'emby',
    nextPrev: session ? queueLength > 1 : has('NextTrack'),
    volume: has('SetVolume'),
    mute: has('Mute') || has('ToggleMute'),
    audio: has('SetAudioStreamIndex'),
    subtitles: has('SetSubtitleStreamIndex'),
    rate: server === 'emby' && has('SetPlaybackRate'),
    message: has('DisplayMessage'),
  };
}

const int = (v: number | undefined): string | undefined => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : undefined);

// Query-only POST /Sessions/{id}/Playing (Jellyfin reads the query only; Emby takes it too, with an empty body).
// A channel carries no position, source or stream indexes: the receiver opens its own live stream (§1 Live TV).
export function playQuery(o: CastStartOptions, live = false, command = 'PlayNow'): Record<string, string> {
  const q: Record<string, string | undefined> = {
    ItemIds: o.itemIds.join(','),
    PlayCommand: command,
    StartIndex: o.itemIds.length > 1 ? int(o.startIndex ?? 0) : undefined,
  };
  if (!live) {
    q.StartPositionTicks = o.positionTicks ? int(Math.max(0, o.positionTicks)) : undefined;
    q.MediaSourceId = o.msid || undefined;
    q.AudioStreamIndex = int(o.audio);
    q.SubtitleStreamIndex = int(o.sub);
  }
  return Object.fromEntries(Object.entries(q).filter((e): e is [string, string] => e[1] !== undefined));
}

// POST /Sessions/{id}/Command body: Arguments values are strings on both servers.
export function commandBody(name: string, args: Record<string, string | number | boolean> = {}): { Name: string; Arguments: Record<string, string> } {
  return { Name: name, Arguments: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])) };
}
