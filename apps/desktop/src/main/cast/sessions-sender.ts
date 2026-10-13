// The Sessions-API sender ("Lire sur…", cast-spec CA-03/CA-04): the same endpoints and rules as the Android
// RemoteTargets. Every call goes to the server that owns the item, with the user's own token (header auth).
import type { CastCommand, CastControls, ServerKind } from '../../shared/contract';
import type { ApiClient } from '../connection/api-client';
import { commandBody, type SessionDto } from './targets';

// Session ids end up in a path.
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function sessionPath(sessionId: string, rest: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`invalid session id`);
  return `/Sessions/${sessionId}/${rest}`;
}

export const controllableSessions = (api: ApiClient, userId: string): Promise<SessionDto[]> =>
  api.get<SessionDto[]>('/Sessions', { ControllableByUserId: userId }).then((l) => (Array.isArray(l) ? l : []));

// The mirror's poll.
export const sessionsOfDevice = (api: ApiClient, deviceId: string): Promise<SessionDto[]> =>
  api.get<SessionDto[]>('/Sessions', { DeviceId: deviceId }).then((l) => (Array.isArray(l) ? l : []));

// Query-only, empty body (both servers).
export const sendPlay = (api: ApiClient, sessionId: string, query: Record<string, string>): Promise<unknown> => api.post(sessionPath(sessionId, 'Playing'), query);

export type SessionRequest = { playstate: string; seekTicks?: number } | { general: ReturnType<typeof commandBody> };

export function sendRequest(api: ApiClient, sessionId: string, r: SessionRequest): Promise<unknown> {
  if ('playstate' in r) return api.post(sessionPath(sessionId, `Playing/${r.playstate}`), r.seekTicks === undefined ? undefined : { SeekPositionTicks: r.seekTicks });
  return api.post(sessionPath(sessionId, 'Command'), undefined, r.general);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// A remote-sheet command as a Sessions-API request, or null when the target does not take it (the control is greyed
// out; a command is never sent to a session that does not list it) or a number is not one.
export function requestFor(cmd: CastCommand, ctx: { server: ServerKind; controls: CastControls; positionTicks: number }): SessionRequest | null {
  const c = ctx.controls;
  switch (cmd.type) {
    case 'toggle-pause':
      return { playstate: 'PlayPause' };
    case 'pause':
      return { playstate: 'Pause' };
    case 'resume':
      return { playstate: 'Unpause' };
    case 'seek':
      return finite(cmd.positionTicks) ? { playstate: 'Seek', seekTicks: Math.max(0, Math.round(cmd.positionTicks)) } : null;
    case 'seek-relative':
      if (!finite(cmd.deltaTicks)) return null;
      // SeekRelative is Emby-only; elsewhere an absolute Seek from the mirrored position.
      return c.seekRelative
        ? { playstate: 'SeekRelative', seekTicks: Math.round(cmd.deltaTicks) }
        : { playstate: 'Seek', seekTicks: Math.max(0, Math.round(ctx.positionTicks + cmd.deltaTicks)) };
    case 'next':
      return c.nextPrev ? { playstate: 'NextTrack' } : null;
    case 'previous':
      return c.nextPrev ? { playstate: 'PreviousTrack' } : null;
    case 'volume':
      return c.volume && finite(cmd.value) ? { general: commandBody('SetVolume', { Volume: Math.round(clamp(cmd.value, 0, 100)) }) } : null;
    case 'mute':
      return c.mute ? { general: commandBody(cmd.value ? 'Mute' : 'Unmute') } : null;
    case 'audio':
      return c.audio && finite(cmd.index) && Number.isInteger(cmd.index) && cmd.index >= 0 ? { general: commandBody('SetAudioStreamIndex', { Index: cmd.index }) } : null;
    case 'subtitle':
      return c.subtitles && finite(cmd.index) && Number.isInteger(cmd.index) && cmd.index >= -1 ? { general: commandBody('SetSubtitleStreamIndex', { Index: cmd.index }) } : null;
    case 'rate':
      return c.rate && finite(cmd.value) && cmd.value >= 0.25 && cmd.value <= 4 ? { general: commandBody('SetPlaybackRate', { PlaybackRate: cmd.value }) } : null;
    default:
      return null;
  }
}
