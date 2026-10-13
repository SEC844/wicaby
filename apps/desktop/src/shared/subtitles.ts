// X-03 remote subtitles (feature-specs.md §3): the pure rules shared by the player's search sheet,
// the admin editor and playback-service. Erasable TypeScript: tools/checks/subtitles-check.mjs runs it
// under plain Node against the vectors shared with SubtitleSearchTest.kt (fixtures/subtitles/subtitles.json).
import type { MediaStream } from './models';

// Emby RemoteSubtitleInfo and Jellyfin RemoteSubtitleInfo: common fields plus each server's flags.
export interface RemoteSubtitle {
  Id: string;
  ProviderName?: string;
  Name?: string;
  Format?: string;
  Author?: string;
  Comment?: string;
  CommunityRating?: number;
  DownloadCount?: number;
  IsHashMatch?: boolean;
  IsForced?: boolean; // Emby
  Forced?: boolean; // Jellyfin
  IsHearingImpaired?: boolean;
  HearingImpaired?: boolean; // Jellyfin
  AiTranslated?: boolean; // Jellyfin
  MachineTranslated?: boolean; // Jellyfin
  Language?: string;
  ThreeLetterISOLanguageName?: string;
}

export interface SubtitleFlags {
  forced: boolean;
  sdh: boolean;
  machine: boolean;
}

export function subtitleFlags(r: RemoteSubtitle): SubtitleFlags {
  return {
    forced: Boolean(r.IsForced ?? r.Forced),
    sdh: Boolean(r.HearingImpaired ?? r.IsHearingImpaired),
    machine: Boolean(r.AiTranslated || r.MachineTranslated),
  };
}

// The search language: the last one searched, then the preferred subtitle language, then the UI's, then English.
export function searchLanguage(last: string | undefined, preferred: string | undefined, uiLanguage: string | undefined): string {
  return last || preferred || (uiLanguage?.startsWith('fr') ? 'fre' : 'eng');
}

export type SubtitleFailure = 'noProvider' | 'forbidden' | 'failed';

// 404 = no provider plugin on the server; 401/403 = the account lacks the right. The status crosses IPC
// inside the message ("… (HTTP 403)", main/ipc.ts).
export function subtitleFailure(err: unknown): SubtitleFailure {
  const status = Number(/\bHTTP (\d{3})\b/.exec(err instanceof Error ? err.message : String(err))?.[1] ?? 0);
  return status === 404 ? 'noProvider' : status === 401 || status === 403 ? 'forbidden' : 'failed';
}

// Emby EnableSubtitleDownloading, Jellyfin EnableSubtitleManagement; admins always. false only when known.
export function canDownloadSubtitles(policy: Record<string, unknown> | undefined, jellyfin: boolean): boolean {
  if (!policy || policy.IsAdministrator === true) return true;
  return policy[jellyfin ? 'EnableSubtitleManagement' : 'EnableSubtitleDownloading'] !== false;
}

type Stream = Pick<MediaStream, 'Index' | 'Type' | 'IsExternal'> & { Path?: string };

// The external subtitle a download added: one not in the previous set (by path, since indexes can shift),
// else the highest index when the count grew. null when nothing was added yet.
export function addedSubtitle<T extends Stream>(before: readonly Stream[], after: readonly T[]): T | null {
  const subs = (l: readonly Stream[]) => l.filter((s) => s.Type === 'Subtitle');
  const ext = subs(after).filter((s) => s.IsExternal) as T[];
  const seen = new Set(subs(before).map((s) => s.Path ?? `#${s.Index}`));
  const fresh = ext.filter((s) => !seen.has(s.Path ?? `#${s.Index}`));
  if (fresh.length) return fresh.reduce((a, b) => (b.Index > a.Index ? b : a));
  if (subs(after).length <= subs(before).length || !ext.length) return null;
  return ext.reduce((a, b) => (b.Index > a.Index ? b : a));
}
