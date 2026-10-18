import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ImmichSource, ImmichTestResult, Query } from '../../shared/contract';
import { JsonStore } from '../core/json-store';
import type { CredentialVault } from '../core/vault';
import { safeExt, safeName, ZONE_INTERNET } from '../downloads/download-path';

// Immich as a second photo source (photos spec §3.2, PH-12), shown as its own library. Requests are written by hand
// from the published HTTP API reference: no Immich code or SDK (spec §0). The API key lives in the vault, bound to
// the address it was typed for, and only ever travels in the x-api-key header from main: the renderer gets JSON
// through IPC and pictures through wicaby-media://immich/<source>/…, never the key. Redirects are refused, so the
// header never follows one to another host. No Electron import: tools/checks/immich-check.mjs runs it in Node.

export const MIN_MAJOR = 2;
const VAULT = (id: string) => `immich:${id}`;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SOURCE_ID = /^[0-9a-f]{12}$/;

// The JSON calls the renderer may make, relative to /api.
const JSON_ROUTES: [string, RegExp][] = [
  ['GET', /^\/timeline\/buckets?$/],
  ['GET', new RegExp(`^/assets/${UUID}$`)],
  ['PUT', /^\/assets$/],
  ['GET', /^\/albums$/],
  ['GET', /^\/people$/],
  ['GET', /^\/map\/markers$/],
  ['GET', /^\/memories$/],
  ['POST', /^\/search\/metadata$/],
];
// The pictures and clips wicaby-media://immich serves.
const MEDIA = new RegExp(`^/(?:assets/${UUID}/(?:thumbnail|original|video/playback)|people/${UUID}/thumbnail)$`);
const SIZES = new Set(['thumbnail', 'preview', 'fullsize']);
// Probed by the test button: the feature, its endpoint and the permission it needs (asset.read comes first).
const PROBES: [string, string][] = [
  ['/albums', 'album.read'],
  ['/people', 'person.read'],
  ['/map/markers', 'map.read'],
  ['/memories', 'memory.read'],
];

export function isJsonRoute(method: string, rel: string): boolean {
  return JSON_ROUTES.some(([m, re]) => m === method && re.test(rel));
}

export function isMediaPath(rel: string, search: URLSearchParams): boolean {
  if (!MEDIA.test(rel)) return false;
  for (const [k, v] of search) if (k !== 'size' || !SIZES.has(v)) return false;
  return true;
}

// "photos.local:2283", "https://nas/immich/" or ".../api" -> "http(s)://host[:port][/prefix]" without a trailing
// slash, or null. No credentials in the URL.
export function normalizeImmichUrl(input: string): string | null {
  let t = input.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  if (!t) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = `http://${t}`;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

// An Immich answer the renderer maps to a caption: status 403 = a missing permission, 401 = a revoked key.
export class ImmichError extends Error {
  constructor(readonly status: number) {
    super(`immich:${status}`);
  }
}

export interface ImmichDeps {
  file: string;
  vault: Pick<CredentialVault, 'get' | 'set' | 'delete'>;
  fetch?: typeof fetch;
  // The downloads folder, for "save the original".
  downloads: () => string;
}

export class ImmichService extends EventEmitter {
  private readonly store: JsonStore<{ sources: ImmichSource[] }>;
  private readonly fetcher: typeof fetch;

  constructor(private readonly deps: ImmichDeps) {
    super();
    this.store = new JsonStore(deps.file, { sources: [] });
    this.fetcher = deps.fetch ?? fetch;
  }

  list(): ImmichSource[] {
    return this.store.value.sources.filter((s) => this.key(s));
  }

  private source(id: string): { src: ImmichSource; key: string } {
    const src = SOURCE_ID.test(id) ? this.store.value.sources.find((s) => s.id === id) : undefined;
    const key = src && this.key(src);
    if (!src || !key) throw new ImmichError(404);
    return { src, key };
  }

  // The key is bound to the address it was typed for: an edited address never gets it.
  private key(src: ImmichSource): string {
    const c = this.deps.vault.get(VAULT(src.id));
    return c && c.userId === src.url ? c.token : '';
  }

  private call(base: string, key: string, method: string, rel: string, query?: Query, body?: unknown, signal?: AbortSignal, headers: Record<string, string> = {}): Promise<Response> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) q.set(k, String(v));
    const qs = q.size ? `?${q}` : '';
    return this.fetcher(`${base}/api${rel}${qs}`, {
      method,
      headers: { ...headers, 'x-api-key': key, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Accept: headers.Accept ?? 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(20_000),
    });
  }

  // Nothing is stored. Checks the version (2.0 or later) and the key, then which optional permissions it lacks.
  async test(input: string, key: string): Promise<ImmichTestResult> {
    const url = normalizeImmichUrl(input);
    if (!url) return { ok: false, error: 'url', missing: [] };
    if (!key.trim()) return { ok: false, error: 'auth', missing: [] };
    try {
      const v = await this.fetcher(`${url}/api/server/version`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!v.ok) return { ok: false, error: 'server', missing: [] };
      const ver = (await v.json()) as { major?: unknown; minor?: unknown; patch?: unknown };
      if (typeof ver.major !== 'number') return { ok: false, error: 'server', missing: [] };
      const version = `${ver.major}.${Number(ver.minor) || 0}.${Number(ver.patch) || 0}`;
      if (ver.major < MIN_MAJOR) return { ok: false, error: 'version', version, missing: [] };
      const k = key.trim();
      const tl = await this.call(url, k, 'GET', '/timeline/buckets', { visibility: 'timeline' });
      if (tl.status === 401) return { ok: false, error: 'auth', version, missing: [] };
      if (tl.status === 403) return { ok: false, error: 'scope', version, missing: ['asset.read'] };
      if (!tl.ok) return { ok: false, error: 'server', version, missing: [] };
      const missing: string[] = [];
      const buckets = (await tl.json()) as { timeBucket?: string }[];
      // asset.view: one thumbnail of the newest month, when there is one.
      if (Array.isArray(buckets) && buckets[0]?.timeBucket) {
        const b = await this.call(url, k, 'GET', '/timeline/bucket', { visibility: 'timeline', timeBucket: buckets[0].timeBucket });
        const id = b.ok ? ((await b.json()) as { id?: unknown }).id : undefined;
        if (Array.isArray(id) && typeof id[0] === 'string' && new RegExp(`^${UUID}$`).test(id[0])) {
          const t = await this.call(url, k, 'GET', `/assets/${id[0]}/thumbnail`, { size: 'thumbnail' }, undefined, undefined, { Accept: 'image/*' });
          void t.body?.cancel();
          if (t.status === 403) missing.push('asset.view');
        }
      }
      for (const [rel, scope] of PROBES) {
        const r = await this.call(url, k, 'GET', rel);
        void r.body?.cancel();
        if (r.status === 403) missing.push(scope);
      }
      return { ok: true, version, missing };
    } catch {
      return { ok: false, error: 'network', missing: [] };
    }
  }

  async add(input: string, key: string): Promise<ImmichTestResult & { source?: ImmichSource }> {
    const r = await this.test(input, key);
    if (!r.ok) return r;
    const url = normalizeImmichUrl(input)!;
    const existing = this.store.value.sources.find((s) => s.url === url);
    const source: ImmichSource = existing ?? { id: randomBytes(6).toString('hex'), url, name: new URL(url).host };
    await this.deps.vault.set(VAULT(source.id), { userId: url, userName: 'x-api-key', token: key.trim() });
    if (!existing) this.store.update((d) => void d.sources.push(source));
    this.store.flush();
    this.emit('change', this.list());
    return { ...r, source };
  }

  async remove(id: string): Promise<void> {
    await this.deps.vault.delete(VAULT(id));
    this.store.update((d) => void (d.sources = d.sources.filter((s) => s.id !== id)));
    this.store.flush();
    this.emit('change', this.list());
  }

  // A JSON call from the renderer: allow-listed method and path, the key added here.
  async request(id: string, method: string, rel: string, query?: Query, body?: unknown): Promise<unknown> {
    if (!isJsonRoute(method, rel)) throw new ImmichError(400);
    const { src, key } = this.source(id);
    const r = await this.call(src.url, key, method, rel, query, body);
    if (!r.ok) {
      void r.body?.cancel();
      throw new ImmichError(r.status);
    }
    return r.status === 204 ? null : r.json();
  }

  // wicaby-media://immich/<source>/<rel>?size=…: a thumbnail, preview, original, face or clip, Range passed on.
  async media(pathname: string, search: URLSearchParams, header: (name: string) => string | null, signal?: AbortSignal): Promise<Response> {
    const [, id = '', ...rest] = pathname.split('/');
    const rel = `/${rest.join('/')}`;
    if (!isMediaPath(rel, search)) return new Response('Bad request', { status: 400 });
    let s: { src: ImmichSource; key: string };
    try {
      s = this.source(id);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const plain: Record<string, string> = { Accept: '*/*' };
    for (const h of ['range', 'if-none-match', 'if-modified-since']) {
      const v = header(h);
      if (v) plain[h] = v;
    }
    const r = await this.call(s.src.url, s.key, 'GET', rel, Object.fromEntries(search), undefined, signal, plain);
    const out = new Headers();
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control']) {
      const v = r.headers.get(h);
      if (v) out.set(h, v);
    }
    out.set('Access-Control-Allow-Origin', '*');
    return new Response(r.body, { status: r.status, headers: out });
  }

  // "Save the original" (F15): into the downloads folder under the asset's file name, never over another file.
  async saveOriginal(id: string, assetId: string): Promise<string> {
    if (!new RegExp(`^${UUID}$`).test(assetId)) throw new ImmichError(400);
    const { src, key } = this.source(id);
    const meta = (await this.request(id, 'GET', `/assets/${assetId}`)) as { originalFileName?: unknown };
    const r = await this.call(src.url, key, 'GET', `/assets/${assetId}/original`, undefined, undefined, AbortSignal.timeout(300_000), { Accept: '*/*' });
    if (!r.ok) {
      void r.body?.cancel();
      throw new ImmichError(r.status);
    }
    if (!r.body) throw new ImmichError(502);
    const dir = this.deps.downloads();
    fs.mkdirSync(dir, { recursive: true });
    // The name comes from whoever uploaded the asset: a media extension only (an .lnk, .hta or "x.jpg.exe"
    // would run from Downloads), the stem cleaned like a download's (separators, device names).
    const raw = typeof meta.originalFileName === 'string' ? path.basename(meta.originalFileName) : '';
    const dot = raw.lastIndexOf('.');
    const ext = safeExt(dot > 0 ? raw.slice(dot + 1) : '') ?? 'bin';
    const stem = safeName(dot > 0 ? raw.slice(0, dot) : raw, assetId);
    let file = path.join(dir, `${stem}.${ext}`);
    for (let n = 1; fs.existsSync(file); n++) file = path.join(dir, `${stem} (${n}).${ext}`);
    // Streamed: a video original can be gigabytes, never held whole in main.
    try {
      await pipeline(Readable.fromWeb(r.body as import('node:stream/web').ReadableStream), fs.createWriteStream(file, { flags: 'wx' }));
    } catch (err) {
      // EEXIST: the name was taken after the check, and that file is someone else's.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') fs.rmSync(file, { force: true });
      throw err;
    }
    if (process.platform === 'win32') {
      try {
        fs.writeFileSync(`${file}:Zone.Identifier`, ZONE_INTERNET);
      } catch {
        // FAT and exFAT drives have no alternate streams.
      }
    }
    return file;
  }
}
