// A WebDAV PROPFIND (Depth 1) reply read into folder entries (file-sources-spec §3.3, §7.4). Regex-based
// like cast/dlna.ts: never a DTD-aware parser. Every href is resolved against the request URL and kept only
// when it stays on the source's origin, under its base path, and names a direct child of the folder asked
// for; anything else counts as dropped (the HREF-ESCAPE tag of the mock). Pure; vectors in
// tools/checks/fixtures/files/propfind.json.
import { guardRel } from './ids';

export const MAX_PROPFIND_BYTES = 8 * 1024 * 1024;

export interface DavEntry {
  name: string;
  dir: boolean;
  size: number;
  // Milliseconds since the epoch, 0 when the server sent no usable date.
  mtime: number;
}

export interface DavListing {
  entries: DavEntry[];
  // The folder itself, when the reply describes it (Depth 0 or 1).
  self?: DavEntry;
  dropped: number;
}

const tag = (name: string) => new RegExp(`<(?:[A-Za-z][\\w.-]*:)?${name}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[A-Za-z][\\w.-]*:)?${name}\\s*>)`, 'i');
const RESPONSE = /<(?:[A-Za-z][\w.-]*:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?response\s*>/gi;
const PROPSTAT = /<(?:[A-Za-z][\w.-]*:)?propstat(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?propstat\s*>/gi;

function text(body: string, name: string): string | undefined {
  const m = tag(name).exec(body);
  return m ? (m[1] ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim() : undefined;
}

function decodePath(p: string): string | null {
  try {
    return decodeURIComponent(p);
  } catch {
    return null;
  }
}

// baseUrl: the source root (https://dav.example/media); rel: the folder asked for ('' = root).
export function parseMultistatus(xml: string, baseUrl: string, rel: string): DavListing {
  const base = new URL(baseUrl);
  const basePath = (decodePath(base.pathname) ?? '').replace(/\/+$/, '');
  const requestUrl = `${base.origin}${base.pathname.replace(/\/+$/, '')}/${rel.split('/').filter(Boolean).map(encodeURIComponent).join('/')}${rel ? '/' : ''}`;
  const out: DavListing = { entries: [], dropped: 0 };
  for (const r of xml.matchAll(RESPONSE)) {
    const body = r[1];
    const href = text(body, 'href');
    if (!href) continue;
    // Only properties a 200 propstat carries.
    const props = [...body.matchAll(PROPSTAT)].filter((p) => / 200 /.test(text(p[1], 'status') ?? ' 200 ')).map((p) => p[1]).join('\n');
    let url: URL;
    try {
      url = new URL(href, requestUrl);
    } catch {
      out.dropped++;
      continue;
    }
    const path = decodePath(url.pathname);
    if (url.origin !== base.origin || path === null || (path !== basePath && path !== `${basePath}/` && !path.startsWith(`${basePath}/`))) {
      out.dropped++;
      continue;
    }
    const entryRel = path.slice(basePath.length).replace(/^\/+|\/+$/g, '');
    const dir = /<(?:[A-Za-z][\w.-]*:)?collection\b/i.test(tag('resourcetype').exec(props)?.[1] ?? '');
    const size = Number(text(props, 'getcontentlength') ?? 0);
    const mtime = Date.parse(text(props, 'getlastmodified') ?? '');
    const entry: DavEntry = { name: entryRel.slice(entryRel.lastIndexOf('/') + 1), dir, size: Number.isFinite(size) && size >= 0 ? size : 0, mtime: Number.isFinite(mtime) ? mtime : 0 };
    if (entryRel === rel) {
      out.self = entry;
      continue;
    }
    const parent = entryRel.includes('/') ? entryRel.slice(0, entryRel.lastIndexOf('/')) : '';
    // A deeper entry (Depth: infinity), an encoded slash or an unsafe name.
    if (parent !== rel || guardRel(entryRel) === null) {
      out.dropped++;
      continue;
    }
    out.entries.push(entry);
  }
  return out;
}
