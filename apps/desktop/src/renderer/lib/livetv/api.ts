// Live TV dialect executor (spec §4.1, §5, §21.2 F9, §21.4): runs the pure request builders of
// shared/livetv/dialect.ts against one server and classifies failures.
//
// Reads go through the wicaby-media://api proxy (main adds the auth headers for the server's own
// origin, exactly as for images), because the renderer then sees the HTTP status (retry policy),
// can abort on its own deadline (tile 15 s, channels page 20 s) and can read the Date header when
// the proxy exposes it (clock skew). Writes, and reads when that transport is unavailable, go
// through w.api (IPC → main ApiClient), whose errors carry only a message.
import { MEDIA_SCHEME } from '../../../shared/contract';
import { toUrl } from '../../../shared/livetv/dialect';
import type { Req } from '../../../shared/livetv/dialect';
import { nextSkew } from '../../../shared/livetv/model';
import type { ServerKind, SkewState } from '../../../shared/livetv/model';
import { w } from '../bridge';

export const DEADLINE_TILE_MS = 15_000;
export const DEADLINE_CHANNELS_MS = 20_000;
export const DEADLINE_DEFAULT_MS = 20_000;

export type FailKind = 'timeout' | 'network' | 'http' | 'aborted';

export class LiveApiError extends Error {
  readonly kind: FailKind;
  readonly status: number; // HTTP status, 0 when unknown (network, timeout, or an IPC error without one)
  constructor(kind: FailKind, status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

// F9: retry once on connection errors and 5xx only. A timeout is never retried.
export function retryable(err: unknown): boolean {
  if (!(err instanceof LiveApiError)) return false;
  return err.kind === 'network' || (err.kind === 'http' && err.status >= 500);
}

export interface RunOpts {
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface RunResult<T> {
  data: T;
  status: number;
  date: number | null; // server Date header (ms), when readable
}

// ---- Dev counters (spec §16.3), read through window.__wicabyLive ----

export interface RequestCounters {
  sent: number;
  ok: number;
  failed: number;
  timeouts: number;
  retries: number;
  deduped: number;
  dropped: number;
  inFlight: number;
  maxInFlight: number;
  byPath: Record<string, number>;
}

export const requestCounters: RequestCounters = { sent: 0, ok: 0, failed: 0, timeouts: 0, retries: 0, deduped: 0, dropped: 0, inFlight: 0, maxInFlight: 0, byPath: {} };

// Ids become path segments of the proxy URL; the proxy refuses anything else (images.ts).
const PLAIN_ID = /^[A-Za-z0-9-]{1,64}$/;

// An HTTP status hidden in an IPC error message ("HTTP 404" when the body was empty).
function statusOf(message: string): number {
  const m = /\bHTTP (\d{3})\b/.exec(message);
  return m ? Number(m[1]) : 0;
}

export class LiveApi {
  readonly serverId: string;
  readonly kind: ServerKind;
  readonly userId: string;
  private skew: SkewState = { streak: 0, skewMs: 0 };
  private media: boolean;
  onSkew: ((ms: number) => void) | null = null;

  constructor(serverId: string, kind: ServerKind, userId: string) {
    this.serverId = serverId;
    this.kind = kind;
    this.userId = userId;
    this.media = PLAIN_ID.test(serverId) && typeof fetch === 'function';
  }

  get clockSkewMs(): number {
    return this.skew.skewMs;
  }

  async run<T>(req: Req, opts: RunOpts = {}): Promise<RunResult<T>> {
    const c = requestCounters;
    c.sent++;
    c.byPath[req.path] = (c.byPath[req.path] ?? 0) + 1;
    c.inFlight++;
    c.maxInFlight = Math.max(c.maxInFlight, c.inFlight);
    try {
      const r = req.method === 'GET' && this.media ? await this.viaMedia<T>(req, opts) : await this.viaIpc<T>(req, opts);
      c.ok++;
      return r;
    } catch (err) {
      c.failed++;
      if (err instanceof LiveApiError && err.kind === 'timeout') c.timeouts++;
      throw err;
    } finally {
      c.inFlight--;
    }
  }

  private noteDate(date: number | null): void {
    if (date === null) return;
    const before = this.skew.skewMs;
    this.skew = nextSkew(this.skew, date, Date.now());
    if (this.skew.skewMs !== before) this.onSkew?.(this.skew.skewMs);
  }

  private async viaMedia<T>(req: Req, opts: RunOpts): Promise<RunResult<T>> {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, opts.deadlineMs ?? DEADLINE_DEFAULT_MS);
    const onAbort = (): void => ctl.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let res: Response;
    try {
      res = await fetch(`${MEDIA_SCHEME}://api/${this.serverId}${toUrl(req)}`, { signal: ctl.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
    } catch (err) {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (timedOut) throw new LiveApiError('timeout', 0, 'timeout');
      if (opts.signal?.aborted) throw new LiveApiError('aborted', 0, 'aborted');
      // The proxy itself is unusable here (a test page, a refused origin): fall back to IPC for good.
      if (err instanceof TypeError) {
        this.media = false;
        return this.viaIpc<T>(req, opts);
      }
      throw new LiveApiError('network', 0, err instanceof Error ? err.message : String(err));
    }
    try {
      const dateHeader = res.headers.get('date');
      const date = dateHeader ? Date.parse(dateHeader) : NaN;
      if (Number.isFinite(date)) this.noteDate(date);
      // 502/503 from the proxy itself mean the server could not be reached.
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if ((res.status === 502 || res.status === 503) && /^(Bad gateway|offline)$/.test(text)) throw new LiveApiError('network', res.status, text);
        throw new LiveApiError('http', res.status, text.slice(0, 300) || `HTTP ${res.status}`);
      }
      const type = res.headers.get('content-type') ?? '';
      const data = (res.status === 204 || !type.includes('json') ? undefined : await res.json()) as T;
      return { data, status: res.status, date: Number.isFinite(date) ? date : null };
    } catch (err) {
      if (err instanceof LiveApiError) throw err;
      if (timedOut) throw new LiveApiError('timeout', 0, 'timeout');
      if (opts.signal?.aborted) throw new LiveApiError('aborted', 0, 'aborted');
      throw new LiveApiError('network', 0, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async viaIpc<T>(req: Req, opts: RunOpts): Promise<RunResult<T>> {
    const call = (): Promise<T> => {
      switch (req.method) {
        case 'GET':
          return w.api.get<T>(req.path, req.query, this.serverId);
        case 'POST':
          return w.api.post<T>(req.path, req.query, req.body, this.serverId);
        default:
          return w.api.del<T>(req.path, req.query, this.serverId);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LiveApiError('timeout', 0, 'timeout')), opts.deadlineMs ?? DEADLINE_DEFAULT_MS);
    });
    try {
      const data = await Promise.race([call(), deadline]);
      return { data, status: 200, date: null };
    } catch (err) {
      if (err instanceof LiveApiError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const status = statusOf(message);
      throw new LiveApiError(status ? 'http' : 'network', status, message);
    } finally {
      clearTimeout(timer);
    }
  }
}
