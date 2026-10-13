// File source item ids and the path guard (file-sources-spec §0 D3, §7.4). Pure: no Node or Electron
// import, so the renderer (breadcrumbs) and the checks use the same code as main.
// Golden vectors: tools/checks/fixtures/files/paths.json.

// An item id is 'p.' + base64url (no padding) of the UTF-8 path relative to the source root; the root is 'p.'.
export const ROOT_ID = 'p.';
export const MAX_REL_BYTES = 4096;
// shortcut: ids travel in IPC paths (1,024 chars) and hash routes, so a path past 750 bytes gets no id and is
// left out of listings; move the id to a query parameter if real libraries ever nest that deep.
export const MAX_ID_REL_BYTES = 750;
export const FILES_ID = /^p\.[A-Za-z0-9_-]{0,1000}$/;

export const isFilesId = (id: unknown): id is string => typeof id === 'string' && FILES_ID.test(id);

// Windows device names, alone or with an extension (CON.txt still opens the console).
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
// Control characters, the backslash and ':' (alternate data streams, drive letters).
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f\\:]/;
// An encoded dot, slash, backslash or NUL: no file name needs one, and a layer that decodes would see '..'.
const ENCODED = /%(2e|2f|5c|00)/i;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// The relative path when it is safe to join to a source root, else null. '' is the root.
// '/'-separated; no empty, '.' or '..' segment; no '\', NUL, control character or ':'; no Windows device name;
// NFC; at most MAX_REL_BYTES bytes of UTF-8.
export function guardRel(rel: unknown): string | null {
  if (typeof rel !== 'string') return null;
  if (rel === '') return '';
  if (rel.normalize('NFC') !== rel) return null;
  if (utf8(rel).length > MAX_REL_BYTES) return null;
  if (BAD_CHARS.test(rel)) return null;
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..' || DEVICE.test(seg) || ENCODED.test(seg)) return null;
    // A lone surrogate cannot be written as UTF-8: TextEncoder would turn it into U+FFFD.
    if (/[\ud800-\udfff]/.test(seg.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''))) return null;
  }
  return rel;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// The id of a guarded path, or null (unsafe, or too long to address: MAX_ID_REL_BYTES).
export function encodeId(rel: string): string | null {
  if (guardRel(rel) === null) return null;
  const bytes = utf8(rel);
  return bytes.length > MAX_ID_REL_BYTES ? null : ROOT_ID + toBase64Url(bytes);
}

// The guarded path of an id, or null. Only the canonical encoding is accepted (one id per path).
export function decodeId(id: unknown): string | null {
  if (!isFilesId(id)) return null;
  const bytes = fromBase64Url(id.slice(2));
  if (!bytes) return null;
  let rel: string;
  try {
    rel = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return guardRel(rel) !== null && encodeId(rel) === id ? rel : null;
}

export function parentRel(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

export function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

export function joinRel(rel: string, name: string): string {
  return rel ? `${rel}/${name}` : name;
}

// Root first, then each folder down to rel: [{ id, name }] ('' names the root).
export function crumbs(rel: string): { id: string; name: string }[] {
  const out = [{ id: ROOT_ID, name: '' }];
  if (!rel) return out;
  const segs = rel.split('/');
  segs.forEach((name, i) => {
    const id = encodeId(segs.slice(0, i + 1).join('/'));
    if (id) out.push({ id, name });
  });
  return out;
}
