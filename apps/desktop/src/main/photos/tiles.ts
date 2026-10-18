import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// wicaby-media://tile/<z>/<x>/<y>: the photo map's raster tiles (photos spec PH-09, §6.2). The renderer's CSP stays
// closed to the web; main fetches from the one tile host the user configured (default tile.openstreetmap.org) and
// follows the OSM tile usage policy: an identifying User-Agent, at most 2 requests at a time, zoom 19 at most, no
// prefetch (only what the map shows asks), cached on disk for at least 7 days whatever the headers say, never a
// no-cache request. Nothing here logs a tile address: z/x/y tell where the photos were taken (§6.1).
// No Electron import: tools/checks/tiles-check.mjs runs it in Node against a fake tile server.

export const MAX_ZOOM = 19;
export const MIN_TTL_MS = 7 * 86_400_000;
export const CACHE_BYTES = 200 * 1024 * 1024;
const MAX_TILE_BYTES = 2 * 1024 * 1024;
const PARALLEL = 2;
const TILE_TIMEOUT_MS = 15_000;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export interface TileDeps {
  // The current settings: read on every request, so turning the map off stops tiles at once.
  config: () => { enabled: boolean; tileUrl: string };
  userAgent: string;
  dir: string;
  fetch?: typeof fetch;
  now?: () => number;
  maxBytes?: number;
}

// The upstream URL of a tile, or null: map off, a malformed path, zoom past 19, x/y off the world.
export function tileTarget(tileUrl: string, pathname: string): URL | null {
  const m = /^\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})(?:\.png)?$/.exec(pathname);
  if (!m) return null;
  const [z, x, y] = m.slice(1).map(Number);
  if (z > MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) return null;
  let u: URL;
  try {
    u = new URL(tileUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
  } catch {
    return null;
  }
  return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u : null;
}

// When a fetched tile goes stale: its Cache-Control max-age or Expires, never sooner than 7 days.
export function expiresAt(headers: Headers, now: number): number {
  const age = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(headers.get('cache-control') ?? '')?.[1];
  const expires = Date.parse(headers.get('expires') ?? '');
  const given = age !== undefined ? now + Number(age) * 1000 : Number.isFinite(expires) ? expires : 0;
  return Math.max(given, now + MIN_TTL_MS);
}

interface Entry {
  file: string;
  size: number;
  expires: number;
  used: number;
}

// Disk cache: one file per tile, named <sha1 of the URL>-<expiry ms>.<ext>; least recently used out past the cap.
// The index is rebuilt from the folder on first use (mtime = last use).
export class TileCache {
  private index: Map<string, Entry> | null = null;
  private bytes = 0;
  private dir: string;
  private maxBytes: number;

  constructor(dir: string, maxBytes: number) {
    this.dir = dir;
    this.maxBytes = maxBytes;
  }

  private load(): Map<string, Entry> {
    if (this.index) return this.index;
    this.index = new Map();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      // No cache yet.
    }
    for (const name of names) {
      const m = /^([0-9a-f]{40})-(\d+)\.(png|jpg|webp)$/.exec(name);
      const file = path.join(this.dir, name);
      try {
        const st = fs.statSync(file);
        if (!m || this.index.has(m[1])) fs.rmSync(file, { force: true });
        else this.add(m[1], { file, size: st.size, expires: Number(m[2]), used: st.mtimeMs });
      } catch {
        // Gone meanwhile.
      }
    }
    return this.index;
  }

  private add(key: string, e: Entry): void {
    this.index!.set(key, e);
    this.bytes += e.size;
  }

  private drop(key: string): void {
    const e = this.index!.get(key);
    if (!e) return;
    this.index!.delete(key);
    this.bytes -= e.size;
    fs.rmSync(e.file, { force: true });
  }

  get(key: string, now: number): { body: Buffer; type: string; fresh: boolean } | null {
    const e = this.load().get(key);
    if (!e) return null;
    try {
      const body = fs.readFileSync(e.file);
      e.used = now;
      fs.utimesSync(e.file, new Date(now), new Date(now));
      return { body, type: TYPE[e.file.split('.').pop()!], fresh: now < e.expires };
    } catch {
      this.drop(key);
      return null;
    }
  }

  put(key: string, body: Buffer, type: string, expires: number, now: number): void {
    const idx = this.load();
    this.drop(key);
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${key}-${expires}.${EXT[type]}`);
    fs.writeFileSync(file, body);
    this.add(key, { file, size: body.length, expires, used: now });
    if (this.bytes <= this.maxBytes) return;
    for (const [k] of [...idx].sort((a, b) => a[1].used - b[1].used)) {
      if (this.bytes <= this.maxBytes) break;
      if (k !== key) this.drop(k);
    }
  }

  get size(): number {
    this.load();
    return this.bytes;
  }
}

export function tileService(deps: TileDeps): (pathname: string, signal?: AbortSignal) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const get = deps.fetch ?? fetch;
  const cache = new TileCache(deps.dir, deps.maxBytes ?? CACHE_BYTES);
  let active = 0;
  const waiting: (() => void)[] = [];
  // A tile panned away before its turn is not fetched (its turn goes to the next one).
  const slot = async <T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> => {
    if (active >= PARALLEL) await new Promise<void>((r) => waiting.push(r));
    if (signal?.aborted) {
      waiting.shift()?.();
      throw new Error('aborted');
    }
    active++;
    try {
      return await run();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
  const image = (body: Buffer, type: string) =>
    new Response(new Uint8Array(body), { headers: { 'Content-Type': type, 'Content-Length': String(body.length), 'Cache-Control': 'private, max-age=86400' } });

  return async (pathname, signal) => {
    const cfg = deps.config();
    const target = cfg.enabled ? tileTarget(cfg.tileUrl, pathname) : null;
    if (!target) return new Response('Not found', { status: 404 });
    const key = createHash('sha1').update(target.href).digest('hex');
    const hit = cache.get(key, now());
    if (hit?.fresh) return image(hit.body, hit.type);
    try {
      // A host that accepts and stalls must not hold the two slots for minutes; the clock starts with the slot,
      // not in the queue (a map view asks for dozens of tiles at once).
      const res = await slot(signal, () => {
        const cut = signal ? AbortSignal.any([signal, AbortSignal.timeout(TILE_TIMEOUT_MS)]) : AbortSignal.timeout(TILE_TIMEOUT_MS);
        return get(target, { headers: { 'User-Agent': deps.userAgent, Accept: 'image/png,image/jpeg,image/webp' }, redirect: 'error', signal: cut });
      });
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!res.ok || !EXT[type] || Number(res.headers.get('content-length') ?? 0) > MAX_TILE_BYTES) {
        void res.body?.cancel();
        throw new Error(`tile ${res.status}`);
      }
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_TILE_BYTES) throw new Error('tile too large');
      cache.put(key, body, type, expiresAt(res.headers, now()), now());
      return image(body, type);
    } catch {
      // Offline or refused: a stale tile beats a hole in the map.
      return hit ? image(hit.body, hit.type) : new Response('Bad gateway', { status: 502 });
    }
  };
}
