// Comic book formats: which reader a file goes to (magic bytes first, the extension when
// the bytes say nothing yet), and EPUB's reading order. Erasable syntax only, no Electron:
// tools/checks/comic-formats-check.mjs runs it directly under Node.
import path from 'node:path';

// zip: CBZ and plain ZIP; epub: a ZIP read through its spine; rar, 7z and tar go through libarchive.
export type ComicFormat = 'zip' | 'epub' | 'rar' | '7z' | 'tar' | 'pdf';

const BY_EXT: Record<string, ComicFormat> = { cbz: 'zip', zip: 'zip', epub: 'epub', cbr: 'rar', rar: 'rar', cb7: '7z', '7z': '7z', cbt: 'tar', tar: 'tar', pdf: 'pdf' };

// Extensions the reader opens (lower case, no dot).
export const COMIC_EXTS = Object.keys(BY_EXT);

export function formatOfExt(ext: string): ComicFormat | null {
  return BY_EXT[ext.toLowerCase()] ?? null;
}

// The first bytes of the file (1 KiB is plenty; tar needs 262). null: not a book format we read.
export function sniff(head: Uint8Array): ComicFormat | null {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  const at = (s: string, o = 0) => b.length >= o + s.length && b.toString('latin1', o, o + s.length) === s;
  if (at('PK\x03\x04') || at('PK\x05\x06')) return at('mimetypeapplication/epub+zip', 30) ? 'epub' : 'zip';
  if (at('Rar!\x1a\x07')) return 'rar';
  if (at('7z\xbc\xaf\x27\x1c')) return '7z';
  if (at('ustar', 257)) return 'tar';
  // PDF allows junk before the header within the first 1 KiB.
  if (b.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  return null;
}

// An archive entry name turned into a flat file name inside the extraction folder: index first
// (unique, keeps names short), then the original path with separators flattened so the natural
// sort of the folder matches the natural sort of the archive. Nothing can climb out of the folder.
export function flatName(index: number, name: string): string {
  const safe = name
    .replace(/^[a-zA-Z]:/, '')
    .split(/[\\/]+/)
    .filter((p) => p && p !== '.' && p !== '..')
    .join('~')
    .replace(/[\x00-\x1f<>:"|?*]/g, '_')
    .slice(-120);
  return `${index}#${safe}`;
}

// The archive name back from a flatName (for page ordering and ComicInfo lookup).
export function archiveName(flat: string): string {
  return flat.slice(flat.indexOf('#') + 1).replace(/~/g, '/');
}

// ---- EPUB (fixed-layout comics: one image per spine page) ----

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(2).find((v) => v !== undefined);
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
// Zip paths are relative to the archive root, with forward slashes.
const resolve = (from: string, href: string) => path.posix.normalize(path.posix.join(path.posix.dirname(from), decodeURIComponent(decode(href).split('#')[0]))).replace(/^\/+/, '');

// META-INF/container.xml -> the package document's path.
export function epubRootfile(container: string): string | null {
  const tag = /<(?:\w+:)?rootfile\b[^>]*>/i.exec(container)?.[0];
  const p = tag ? attr(tag, 'full-path') : undefined;
  return p ? decode(p) : null;
}

export interface EpubPackage {
  title?: string;
  // Spine documents in reading order (archive paths).
  spine: string[];
  // The manifest's cover-image (EPUB 3) or <meta name="cover"> (EPUB 2), as an archive path.
  cover?: string;
  fixedLayout: boolean;
}

export function epubPackage(opf: string, opfPath: string): EpubPackage {
  const items = new Map<string, { href: string; props: string }>();
  for (const m of opf.matchAll(/<(?:\w+:)?item\b[^>]*>/gi)) {
    const id = attr(m[0], 'id');
    const href = attr(m[0], 'href');
    if (id && href) items.set(id, { href: resolve(opfPath, href), props: attr(m[0], 'properties') ?? '' });
  }
  const spine = [...opf.matchAll(/<(?:\w+:)?itemref\b[^>]*>/gi)]
    .filter((m) => attr(m[0], 'linear') !== 'no')
    .map((m) => items.get(attr(m[0], 'idref') ?? '')?.href)
    .filter((h): h is string => Boolean(h));
  const coverId = [...opf.matchAll(/<(?:\w+:)?meta\b[^>]*>/gi)].map((m) => m[0]).find((t) => attr(t, 'name') === 'cover');
  const cover = [...items.values()].find((i) => i.props.split(/\s+/).includes('cover-image'))?.href ?? items.get(coverId ? (attr(coverId, 'content') ?? '') : '')?.href;
  const title = /<dc:title\b[^>]*>([^<]*)<\/dc:title>/i.exec(opf)?.[1]?.trim();
  return { title: title ? decode(title) : undefined, spine, cover, fixedLayout: /rendition:layout"?\s*>\s*pre-paginated|rendition:layout\s*=\s*"pre-paginated"/i.test(opf) };
}

// The page image a spine document shows: its first <img src> or SVG <image href>. null: a text page,
// that is no image, or (in a reflowable book) more than a caption's worth of text beside it.
export function epubPageImage(xhtml: string, docPath: string, fixedLayout: boolean): string | null {
  const body = /<body\b[\s\S]*$/i.exec(xhtml)?.[0] ?? xhtml;
  if (!fixedLayout && body.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().length > 200) return null;
  const tag = /<(?:\w+:)?(?:img|image)\b[^>]*>/i.exec(xhtml)?.[0];
  const href = tag ? (/^<(?:\w+:)?img/i.test(tag) ? attr(tag, 'src') : (attr(tag, 'xlink:href') ?? attr(tag, 'href'))) : undefined;
  return href && !/^[a-z]+:/i.test(href) ? resolve(docPath, href) : null;
}

// A spine where fewer than half the documents are image pages is a text book (a novel), not a comic.
export function isTextBook(spineLength: number, imagePages: number): boolean {
  return spineLength === 0 || imagePages * 2 < spineLength;
}
