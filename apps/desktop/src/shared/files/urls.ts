// Source addresses (file-sources-spec §6.1, §7.2): the accepted forms of the Add sheet, the redaction used
// by logs and error toasts, the display form and the Windows UNC path of an SMB source. Pure; vectors in
// tools/checks/fixtures/files/urls.json.

export type RemoteProtocol = 'webdav' | 'smb';

export interface ParsedSource {
  protocol: RemoteProtocol;
  // Never holds userinfo, a query or a fragment. https://dav.example/media, smb://STORAGE/media/sub.
  url: string;
  user?: string;
  pass?: string;
}

// userinfo, query and fragment dropped: what a log line or a toast may show.
export function redactUrl(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1')
    .replace(/[?#].*$/s, '');
}

const SMB_HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[[0-9A-Fa-f:.]+\]$/;
const SEG_BAD = /[\u0000-\u001f\u007f<>:"|?*\\]/;

function decoded(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

// https://…, http://…, dav(s)://, webdav(s):// (aliases of http(s)), smb://HOST/share[/sub], \\HOST\share[\sub]
// and HOST/share. user:pass@ moves to the credential fields. Null for anything else.
export function parseSourceUrl(input: string): ParsedSource | null {
  let raw = input.trim();
  // A dot segment would be resolved away by the URL parser: refused as typed instead.
  if (!raw || raw.length > 2048 || /(^|[\\/])\.\.?([\\/]|$)/.test(raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''))) return null;
  if (/^\\\\/.test(raw)) raw = `smb://${raw.slice(2).replace(/\\/g, '/')}`;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase();
  if (!scheme) raw = `smb://${raw.replace(/^\/+/, '')}`;
  const alias: Record<string, string> = { dav: 'http', webdav: 'http', davs: 'https', webdavs: 'https' };
  if (scheme && alias[scheme]) raw = `${alias[scheme]}${raw.slice(scheme.length)}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const user = u.username ? decoded(u.username) ?? undefined : undefined;
  const pass = u.password ? decoded(u.password) ?? undefined : undefined;
  const creds = { ...(user ? { user } : {}), ...(pass ? { pass } : {}) };
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (!u.hostname) return null;
    const path = u.pathname.replace(/\/+$/, '');
    return { protocol: 'webdav', url: `${u.protocol}//${u.host}${path}`, ...creds };
  }
  if (u.protocol !== 'smb:') return null;
  // WHATWG leaves non-special schemes' hosts as written; check them by hand.
  const host = u.host;
  if (!SMB_HOST.test(host) || u.port) return null;
  const segs = u.pathname.split('/').filter(Boolean).map(decoded);
  if (segs.length === 0 || segs.some((s) => s === null || s === '.' || s === '..' || SEG_BAD.test(s!))) return null;
  return { protocol: 'smb', url: `smb://${host}/${segs.map((s) => encodeURIComponent(s!)).join('/')}`, ...creds };
}

// \\HOST\share\sub plus rel ('/'-separated, already guarded), for the Windows SMB client. Null when the
// source is not smb://.
export function uncPath(smbUrl: string, rel = ''): string | null {
  const m = /^smb:\/\/([^/]+)\/(.+)$/.exec(smbUrl);
  if (!m) return null;
  const segs = m[2].split('/').map(decoded);
  if (segs.some((s) => s === null)) return null;
  const tail = rel ? rel.split('/') : [];
  return `\\\\${m[1]}\\${[...(segs as string[]), ...tail].join('\\')}`;
}

// What the UI shows next to the name: dav.example/media, \\STORAGE\media, or a local path as is.
export function displayUrl(url: string): string {
  if (url.startsWith('smb://')) return uncPath(url) ?? url;
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      return `${u.host}${decoded(u.pathname.replace(/\/+$/, '')) ?? u.pathname}`;
    } catch {
      return redactUrl(url);
    }
  }
  return url;
}

// Default name: the last path segment, else the share or the host.
export function defaultName(url: string): string {
  const shown = displayUrl(url).replace(/[\\/]+$/, '');
  return shown.split(/[\\/]/).filter(Boolean).pop() ?? shown;
}
