// What every file source backend answers (file-sources-spec §3.1): local folders and UNC shares
// (backend-local.ts), WebDAV (backend-webdav.ts). Paths are always guarded relative paths (shared/files/ids.ts).
import type { Readable } from 'node:stream';
import type { FileTestCode } from '../../shared/contract';
import { ApiError } from '../connection/api-client';
import { t } from '../i18n';
import type { PeerCert } from './tls-pin';

export interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
  // ms since the epoch
  mtime: number;
}

export interface OpenResult {
  status: 200 | 206 | 416;
  size: number;
  headers: Record<string, string>;
  body: Readable | null;
}

export interface FilesBackend {
  list(rel: string): Promise<FileEntry[]>;
  stat(rel: string): Promise<FileEntry>;
  // The whole file, refused past maxBytes (NFO, posters, subtitles).
  read(rel: string, maxBytes: number): Promise<Buffer>;
  // GET (or HEAD) with an optional Range header value.
  open(rel: string, range: string | undefined, head?: boolean): Promise<OpenResult>;
  // Local folders and UNC shares: the real path, for mpv.
  localPath?(rel: string): Promise<string>;
}

// At most this many entries per folder (§4.1); more are cut and the listing says so.
export const MAX_ENTRIES = 10_000;

export class FilesError extends ApiError {
  constructor(
    readonly code: Exclude<FileTestCode, 'ok'> | 'tooLarge',
    status: number,
    readonly cert?: PeerCert & { pinned?: string },
  ) {
    super(t(`files.error.${code}`), status);
  }
}

const STATUS: Record<string, number> = { auth: 401, notFound: 404, invalid: 400, tooLarge: 413 };
export const filesError = (code: FilesError['code'], cert?: FilesError['cert']): FilesError => new FilesError(code, STATUS[code] ?? 502, cert);

// One bytes=a-b range against a size: the inclusive bounds, 'bad' when unsatisfiable, null for the whole file.
export function byteRange(range: string | undefined, size: number): { start: number; end: number } | 'bad' | null {
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start > end || start >= size ? 'bad' : { start, end };
}

const MIME: Record<string, string> = {
  mkv: 'video/x-matroska',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  wmv: 'video/x-ms-wmv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ogv: 'video/ogg',
  flv: 'video/x-flv',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  ass: 'text/x-ssa',
  ssa: 'text/x-ssa',
  sub: 'text/plain',
};

export const mimeOf = (name: string): string => MIME[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
