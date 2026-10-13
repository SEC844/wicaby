// Remote control from another client (Emby/Jellyfin "Play on" and remote), as play requests and
// player commands of the playback service (PlaybackService.handleRemote).
// Trust boundary (cast-spec §2.7.5): ids are checked, numbers that are not numbers drop the
// command, and nothing but DisplayMessage (a notification, not control) gets through while
// "Autoriser le contrôle à distance" is off.
import { TICKS_PER_MS, type PlaybackCommand, type PlaybackState, type PlayRequest } from '../../shared/contract';
import type { SocketMessage } from '../connection/server-socket';
import type { SettingsService } from '../core/settings';
import { validId } from './playback-model';

export interface RemoteTarget {
  play(req: PlayRequest): Promise<void>;
  command(cmd: PlaybackCommand): Promise<void>;
  getState(): PlaybackState;
}

// The messages a remote sends; all of them but DisplayMessage are dropped while remote control is off.
const REMOTE_TYPES = new Set(['Play', 'Playstate', 'GeneralCommand']);

// Command names compare case-insensitively (Jellyfin spells it PlayState, Emby Playstate).
export function commandName<T extends string>(name: unknown, known: readonly T[]): T | undefined {
  return typeof name === 'string' ? known.find((k) => k.toLowerCase() === name.toLowerCase()) : undefined;
}

// A number from the wire, or NaN: Number('') and Number(null) would otherwise read as 0.
const num = (v: unknown): number => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
// Optional Play fields: absent is fine, present but not a number drops the command (null).
const optNum = (v: unknown): number | undefined | null => (v === undefined || v === null ? undefined : Number.isFinite(num(v)) ? num(v) : null);

const PLAYSTATE = ['Stop', 'Pause', 'Unpause', 'PlayPause', 'NextTrack', 'PreviousTrack', 'Rewind', 'FastForward', 'Seek', 'SeekRelative'] as const;
const GENERAL = ['SetVolume', 'VolumeUp', 'VolumeDown', 'ToggleMute', 'Mute', 'Unmute', 'SetAudioStreamIndex', 'SetSubtitleStreamIndex', 'ToggleFullscreen', 'SetPlaybackRate'] as const;

// serverId: the server whose socket carried it; its item ids are only valid there.
// true: handled (or dropped) here, and the caller must not act on it either.
export function handleRemote(target: RemoteTarget, settings: SettingsService, msg: SocketMessage, serverId?: string): boolean {
  if (!REMOTE_TYPES.has(msg.MessageType)) return false;
  const d = (msg.Data ?? {}) as Record<string, unknown>;
  // false: the caller shows DisplayMessage (index.ts), even with remote control off.
  if (!settings.value.remote.allowControl) return !(msg.MessageType === 'GeneralCommand' && commandName(d.Name, ['DisplayMessage']));
  const args = (d.Arguments ?? {}) as Record<string, unknown>;
  switch (msg.MessageType) {
    case 'Play': {
      // One bad id drops the whole request: StartIndex points into the list as sent.
      const ids = Array.isArray(d.ItemIds) ? d.ItemIds : [];
      if (!ids.length || !ids.every(validId)) return true;
      const nums = [d.StartIndex, d.StartPositionTicks, d.AudioStreamIndex, d.SubtitleStreamIndex].map(optNum);
      if (nums.includes(null)) return true;
      const [startIndex, startPositionTicks, audioStreamIndex, subtitleStreamIndex] = nums as (number | undefined)[];
      const command = commandName(d.PlayCommand, ['PlayNext', 'PlayLast'] as const);
      void target.play({
        itemIds: ids,
        serverId,
        command,
        startIndex,
        startPositionTicks,
        // Only matched against the item's own sources, never put in a URL.
        mediaSourceId: typeof d.MediaSourceId === 'string' && d.MediaSourceId.length <= 128 ? d.MediaSourceId : undefined,
        audioStreamIndex,
        subtitleStreamIndex,
      });
      return true;
    }
    case 'Playstate': {
      const step = settings.value.playback.seekShortS * 1000;
      const map: Partial<Record<(typeof PLAYSTATE)[number], PlaybackCommand>> = {
        Stop: { type: 'stop' },
        Pause: { type: 'pause' },
        Unpause: { type: 'resume' },
        PlayPause: { type: 'toggle-pause' },
        NextTrack: { type: 'next' },
        PreviousTrack: { type: 'previous' },
        Rewind: { type: 'seek-relative', deltaMs: -step },
        FastForward: { type: 'seek-relative', deltaMs: step },
      };
      const c = commandName(d.Command, PLAYSTATE);
      if (c === 'Seek' || c === 'SeekRelative') {
        // Emby's SeekRelative carries a delta in SeekPositionTicks.
        const ticks = num(d.SeekPositionTicks);
        if (!Number.isFinite(ticks)) return true;
        void target.command(c === 'Seek' ? { type: 'seek', positionMs: Math.max(0, ticks / TICKS_PER_MS) } : { type: 'seek-relative', deltaMs: ticks / TICKS_PER_MS });
      } else if (c && map[c]) void target.command(map[c]);
      return true;
    }
    case 'GeneralCommand': {
      const name = commandName(d.Name, GENERAL);
      if (!name) return false;
      const s = target.getState();
      const cmd = generalCommand(name, args, s);
      if (cmd) void target.command(cmd);
      return true;
    }
  }
  return false;
}

function generalCommand(name: (typeof GENERAL)[number], args: Record<string, unknown>, s: PlaybackState): PlaybackCommand | undefined {
  switch (name) {
    case 'SetVolume': {
      const v = num(args.Volume);
      return Number.isFinite(v) ? { type: 'volume', value: Math.max(0, Math.min(100, v)) } : undefined;
    }
    case 'VolumeUp':
    case 'VolumeDown':
      return { type: 'volume', value: s.volume + (name === 'VolumeUp' ? 5 : -5) };
    case 'ToggleMute':
      return { type: 'mute', value: !s.muted };
    case 'Mute':
    case 'Unmute':
      return { type: 'mute', value: name === 'Mute' };
    case 'SetAudioStreamIndex':
    case 'SetSubtitleStreamIndex': {
      const index = num(args.Index);
      if (!Number.isInteger(index)) return undefined;
      return name === 'SetAudioStreamIndex' ? { type: 'audio', index } : { type: 'subtitle', index };
    }
    case 'ToggleFullscreen':
      return { type: 'toggle-fullscreen' };
    case 'SetPlaybackRate': {
      // Emby only (Jellyfin has no such command); outside 0.25-4 is refused, not clamped.
      const rate = num(args.PlaybackRate);
      return rate >= 0.25 && rate <= 4 ? { type: 'rate', value: rate } : undefined;
    }
  }
}
