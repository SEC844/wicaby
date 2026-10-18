// Download target paths built from server-supplied item fields. Kept free of
// Electron and i18n imports, and erasable-syntax only, so
// tools/checks/download-path-check.mjs can run it directly under Node.
// Every field is untrusted: a hostile server must never place a file outside
// the downloads folder (e.g. "x/../../Startup/run.bat" in Container).
import path from 'node:path';

export interface PathSource {
  Path?: unknown;
  Container?: unknown;
}

export interface PathItem {
  Type?: unknown;
  Name?: unknown;
  SeriesName?: unknown;
  Album?: unknown;
  AlbumArtist?: unknown;
  ProductionYear?: unknown;
  ParentIndexNumber?: unknown;
  IndexNumber?: unknown;
  Path?: unknown;
}

export type FolderName = (key: string, params?: Record<string, string>) => string;

const EXT = /^[a-z0-9]{1,8}$/i;
// Extensions a download may carry. The server picks Container and Path, so a
// shape check alone would let it drop .lnk, .url, .scf, .bat, .hta or
// desktop.ini files in the folder Explorer later shows (reveal()).
const MEDIA_EXTS = new Set([
  // video
  'mkv', 'mk3d', 'mp4', 'm4v', 'avi', 'mov', 'qt', 'wmv', 'asf', 'ts', 'm2ts', 'mts', 'm2t', 'webm', 'mpg', 'mpeg', 'mpe', 'mpv', 'm2v',
  'vob', 'flv', 'f4v', 'ogv', 'ogm', '3gp', '3g2', 'divx', 'xvid', 'rm', 'rmvb', 'wtv', 'dvr', 'y4m',
  // audio
  'mp3', 'mp2', 'flac', 'm4a', 'm4b', 'aac', 'ogg', 'oga', 'opus', 'wav', 'wma', 'alac', 'ape', 'wv', 'mka', 'aiff', 'aif', 'dsf', 'dff',
  'ac3', 'eac3', 'dts', 'mpc', 'tta', 'spx',
  // books and comics (zip: plain-zip comics; the download carries Mark-of-the-Web)
  'cbz', 'zip', 'cbr', 'cb7', 'cbt', 'epub', 'pdf', 'mobi', 'azw', 'azw3', 'fb2', 'djvu',
  // subtitles
  'srt', 'ass', 'ssa', 'vtt', 'sub', 'idx', 'sup',
  // photo originals ("Enregistrer l'original"; no svg: it can carry script)
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2',
  'jxl', 'jpe', 'pef', 'srw', 'nrw', 'raw', 'rwl', '3fr', 'erf', 'x3f', 'mrw', 'srf', 'sr2', 'kdc', 'dcr', 'insp',
]);
// Windows treats a file with this stream as downloaded from the internet
// (SmartScreen, Office Protected View) instead of trusting it as local.
export const ZONE_INTERNET = '[ZoneTransfer]\r\nZoneId=3\r\n';

// Win32 device names stay devices with any extension, and with spaces before
// it ("con .txt"); COM/LPT also take superscript digits; CONIN$, CONOUT$ and
// CLOCK$ are devices too.
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)\s*(\..*)?$/i;
const UNSAFE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

// Prefixes a Win32 device name so it is an ordinary file or folder.
export function unreserve(name: string): string {
  return RESERVED.test(name) ? `_${name}` : name;
}

// One path segment: no separators, no control or reserved characters, no
// trailing dots or spaces (so "." and ".." end up empty).
function clean(name: unknown): string {
  const s = typeof name === 'string' ? name : '';
  const out = s
    .replace(UNSAFE_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  return unreserve(out);
}

export function safeName(name: unknown, fallback: string): string {
  return clean(name) || clean(fallback) || 'untitled';
}

// A known media, audio, book or subtitle extension, lower-cased; anything else is dropped.
export function safeExt(value: unknown): string | undefined {
  if (typeof value !== 'string' || !EXT.test(value)) return undefined;
  const ext = value.toLowerCase();
  return MEDIA_EXTS.has(ext) ? ext : undefined;
}

// Non-negative integers only; anything else (string, float, NaN) is dropped.
export function safeInt(value: unknown, max = 9999): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined;
}

// Used when the server offers no allowed extension: a harmless name the user can rename.
function defaultExt(type: unknown): string {
  return type === 'Audio' ? 'mka' : type === 'Book' || type === 'Photo' ? 'bin' : 'mkv';
}

export function pickExtension(source: PathSource | undefined, item: PathItem): string {
  const srcPath = typeof source?.Path === 'string' ? source.Path : typeof item.Path === 'string' ? item.Path : '';
  const fromPath = srcPath ? safeExt(path.win32.extname(srcPath).slice(1)) : undefined;
  const container = typeof source?.Container === 'string' ? safeExt(source.Container.split(',')[0]?.trim()) : undefined;
  return fromPath ?? container ?? defaultExt(item.Type);
}

// True when target is strictly inside root (root itself does not count).
export function isInside(root: string, target: string): boolean {
  if (!root) return false;
  const r = path.resolve(root);
  const f = path.resolve(target);
  const base = r.endsWith(path.sep) ? r : r + path.sep;
  return process.platform === 'win32' ? f.toLowerCase().startsWith(base.toLowerCase()) : f.startsWith(base);
}

export function assertInside(root: string, target: string): void {
  if (!isInside(root, target)) throw new Error(`unsafe download path: ${target}`); // i18n-ignore: internal invariant, unreachable for paths built by buildTargetPath
}

const pad = (n: number | undefined) => String(n ?? 0).padStart(2, '0');
// The whole file name is checked again: Windows reads "CON .mkv" as a device too.
const file = (stem: string, ext: string) => unreserve(`${stem}.${ext}`);

export function buildTargetPath(root: string, item: PathItem, source: PathSource | undefined, folder: FolderName): string {
  const untitled = folder('untitled');
  const seg = (v: unknown, fallbackKey?: string) => safeName(v, fallbackKey ? folder(fallbackKey) : untitled);
  const dir = (k: string, params?: Record<string, string>) => safeName(folder(k, params), untitled);
  const ext = pickExtension(source, item);
  // Every piece below is already a safe segment, so joining them keeps it one.
  const name = seg(item.Name);
  let out: string;
  if (item.Type === 'Episode') {
    const season = safeInt(item.ParentIndexNumber);
    const episode = safeInt(item.IndexNumber);
    const series = seg(item.SeriesName, 'show');
    out = path.join(root, dir('series'), series, dir('season', { number: pad(season) }), file(`${series} S${pad(season)}E${pad(episode)} - ${name}`, ext));
  } else if (item.Type === 'Audio') {
    out = path.join(root, dir('music'), seg(item.AlbumArtist, 'artist'), seg(item.Album, 'album'), file(name, ext));
  } else if (item.Type === 'Book') {
    out = path.join(root, dir('books'), file(name, ext));
  } else if (item.Type === 'Photo') {
    // The original's own file name (IMG_0001.HEIC), not the title the server shows.
    const own = typeof item.Path === 'string' ? path.win32.basename(item.Path) : '';
    out = path.join(root, dir('photos'), file(seg(own.slice(0, own.length - path.win32.extname(own).length) || item.Name), ext));
  } else {
    const year = safeInt(item.ProductionYear);
    out = path.join(root, dir('movies'), file(`${name}${year ? ` (${year})` : ''}`, ext));
  }
  assertInside(root, out);
  return out;
}

const sameFile = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const stem = (p: string) => p.slice(0, p.length - path.extname(p).length);

// Records saved before the downloads folder was stored with them only carry
// filePath, and the folder setting may have changed since. The folder is
// recovered from the layout buildTargetPath produces (2 levels for movies and
// books, 4 for episodes and music) and trusted only if building the record's
// item again under it, with the folder names of any language, gives back the
// same path. The extension is compared by shape only: older builds took any.
export function legacyRoot(filePath: unknown, item: PathItem, source: PathSource | undefined, folders: FolderName[]): string | undefined {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) return undefined;
  if (!EXT.test(path.extname(filePath).slice(1))) return undefined;
  let root = filePath;
  for (let i = item.Type === 'Episode' || item.Type === 'Audio' ? 4 : 2; i > 0; i--) root = path.dirname(root);
  if (!isInside(root, filePath)) return undefined;
  for (const folder of folders) {
    try {
      if (sameFile(stem(buildTargetPath(root, item, source, folder)), stem(filePath))) return root;
    } catch {
      // Not built from this root: try the next language.
    }
  }
  return undefined;
}
