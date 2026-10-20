// "Play on Wicaby" and remote control from another Emby or Jellyfin app (X-06, core RemoteControl.kt): the session
// socket's Play, Playstate and GeneralCommand messages, onto the player on screen and the TV. Ignored while Settings >
// "Control from other devices" is off, except DisplayMessage: a notification, not control, shown in every state.
import { nav, stack } from './nav.svelte';
import { onSocket } from './server-socket';
import { settings } from './settings.svelte';
import { showToast } from './toast.svelte';
import { t } from './i18n.svelte';
import * as Versions from './versions';
import { setVolume } from '../platform/index';

// The player on screen, as remote commands see it (the video player, else the music session).
export interface RemoteTarget {
  pause(): void;
  unpause(): void;
  playPause(): void;
  stop(): void;
  seek(ms: number): void;
  next(): void;
  previous(): void;
  audio(index: number): void;
  subtitle(index: number): void;
}

let video: RemoteTarget | null = null;
let music: RemoteTarget | null = null;

// The video player registers itself while it plays; the music session while it has a track.
export function setVideoTarget(t: RemoteTarget | null): void {
  video = t;
}
export function setMusicTarget(t: RemoteTarget | null): void {
  music = t;
}

const TICKS_PER_MS = 10_000;
const isId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(s);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

// What this session can be asked to do (core REMOTE_COMMANDS); off, messages only. The volume only where the TV lets
// an app set it (Tizen).
export function supportedCommands(volume: boolean): string[] {
  if (!settings.remoteControl.value) return ['DisplayMessage'];
  return ['DisplayMessage', ...(volume ? ['SetVolume', 'VolumeUp', 'VolumeDown', 'ToggleMute', 'Mute', 'Unmute'] : []), 'SetAudioStreamIndex', 'SetSubtitleStreamIndex', 'GoHome', 'Play', 'Playstate'];
}

// A Play request: the item at StartIndex, from StartPositionTicks, with its version and tracks; every id as a queue.
function play(d: Record<string, unknown>): void {
  const command = typeof d.PlayCommand === 'string' ? d.PlayCommand : 'PlayNow';
  const ids = Array.isArray(d.ItemIds) ? d.ItemIds : [];
  // The server's ids only: they go into URLs. One bad id drops the request (desktop).
  if (!ids.length || !ids.every(isId)) return;
  // PlayNext / PlayLast: no queue to splice into on a TV player; they play now, as the desktop does without one.
  const start = command === 'PlayNow' ? (num(d.StartIndex) ?? 0) : 0;
  const id = ids[start];
  if (!id) return;
  const source = isId(d.MediaSourceId) ? d.MediaSourceId : undefined;
  if (source) Versions.select(id, source);
  const audio = num(d.AudioStreamIndex);
  const subtitle = num(d.SubtitleStreamIndex);
  const ticks = num(d.StartPositionTicks);
  if (stack[stack.length - 1]?.route.name === 'player') nav.back();
  nav.push({
    name: 'player',
    id,
    startMs: ticks !== undefined ? ticks / TICKS_PER_MS : undefined,
    queue: ids.length > 1 ? ids.slice(0, 1000) : undefined,
    tracks: audio !== undefined || subtitle !== undefined ? { audio, subtitle } : undefined,
  });
}

function playstate(d: Record<string, unknown>): void {
  const target = video ?? music;
  if (!target) return;
  switch (d.Command) {
    case 'Pause':
      return target.pause();
    case 'Unpause':
      return target.unpause();
    case 'PlayPause':
      return target.playPause();
    case 'Stop':
      return target.stop();
    case 'Seek': {
      const ticks = num(d.SeekPositionTicks);
      if (ticks !== undefined) target.seek(ticks / TICKS_PER_MS);
      return;
    }
    case 'NextTrack':
      return target.next();
    case 'PreviousTrack':
      return target.previous();
  }
}

function general(name: string, args: Record<string, unknown>): void {
  const target = video ?? music;
  switch (name) {
    case 'DisplayMessage': {
      const text = typeof args.Text === 'string' ? args.Text.slice(0, 500) : '';
      const header = typeof args.Header === 'string' && args.Header.trim() ? args.Header : t('remote_message');
      if (text) showToast(`${header} · ${text}`);
      return;
    }
    case 'SetVolume':
    case 'VolumeUp':
    case 'VolumeDown':
    case 'Mute':
    case 'Unmute':
    case 'ToggleMute':
      return setVolume(name, num(args.Volume));
    case 'SetAudioStreamIndex': {
      const i = num(args.Index);
      if (i !== undefined) target?.audio(i);
      return;
    }
    case 'SetSubtitleStreamIndex': {
      const i = num(args.Index);
      if (i !== undefined) target?.subtitle(i);
      return;
    }
    case 'GoHome':
      return target?.stop();
  }
}

// From the main screen's mount to its unmount: the commands of the session socket.
export function runRemoteControl(): () => void {
  return onSocket((type, data) => {
    const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    if (type === 'GeneralCommand') {
      const name = typeof d.Name === 'string' ? d.Name : '';
      const args = (d.Arguments && typeof d.Arguments === 'object' ? d.Arguments : {}) as Record<string, unknown>;
      if (name === 'DisplayMessage' || settings.remoteControl.value) general(name, args);
      return;
    }
    if (!settings.remoteControl.value) return;
    if (type === 'Play') play(d);
    else if (type === 'Playstate') playstate(d);
  });
}
