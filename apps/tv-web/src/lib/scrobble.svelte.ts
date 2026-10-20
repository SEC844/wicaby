// Music scrobbling to ListenBrainz and Last.fm from the TV itself, as core Scrobble.kt with the desktop's client
// (main/features/scrobble-client.ts: the rule, the payloads, the Last.fm signature): playing now on a track's start,
// then one listen once the standard rule is met; the music session counts the heard time (playback only). Off until
// the user connects a service. Listens that fail for a reason worth retrying wait in a queue (500 at most, oldest
// dropped) and go again after the next listen that goes through, and every 15 min. The tokens stay in the TV's
// storage (a TV has no keychain); the queue holds track names only.
import type { BaseItem } from '$shared/models';
import {
  LASTFM_API,
  LastfmClient,
  listenBody,
  LISTENBRAINZ_API,
  ListenBrainzClient,
  ScrobbleError,
  shouldScrobble,
  trackInfo,
  type TrackInfo,
} from '../../../desktop/src/main/features/scrobble-client';
import { VERSION } from './identity';
import { load, save } from './storage';

interface Accounts {
  lbUser?: string;
  lbToken?: string;
  fmKey: string;
  fmSecret?: string;
  fmUser?: string;
  fmSession?: string;
}
interface Queued {
  to: Service;
  at: number;
  info: TrackInfo;
}
type Service = 'listenbrainz' | 'lastfm';
// A string key and its argument, resolved by the UI in its language.
export interface ScrobbleFailure {
  key: string;
  detail?: string;
}

const ACCOUNTS = 'scrobble_accounts';
const QUEUE = 'scrobble_queue';
const QUEUE_CAP = 500;
const RETRY_MS = 15 * 60_000;
const AUTH_POLL_MS = 3000;
const AUTH_WAIT_MS = 10 * 60_000;
const LB_TOKEN_RE = /^[A-Za-z0-9-]{8,128}$/;
const LASTFM_KEY_RE = /^[A-Za-z0-9]{16,64}$/;

// What the settings show. lbUser: "" when ListenBrainz did not say; fmKey "" until entered; authUrl while waiting.
export const scrobble = $state<{ lbUser: string | null; fmKey: string; fmUser: string | null; authUrl: string | null; queued: number; error: ScrobbleFailure | null }>({
  lbUser: null,
  fmKey: '',
  fmUser: null,
  authUrl: null,
  queued: 0,
  error: null,
});

const accounts = (): Accounts => load<Accounts>(ACCOUNTS, { fmKey: '' });
const queue = (): Queued[] => load<Queued[]>(QUEUE, []);
const lb = () => new ListenBrainzClient(LISTENBRAINZ_API);
const fm = (a: Accounts) => new LastfmClient(LASTFM_API, a.fmKey, a.fmSecret ?? '');

function refresh(): void {
  const a = accounts();
  scrobble.lbUser = a.lbToken ? (a.lbUser ?? '') : null;
  scrobble.fmKey = a.fmKey;
  scrobble.fmUser = a.fmSession ? (a.fmUser ?? '') : null;
  scrobble.queued = queue().length;
}
refresh();

// Calls run one after the other: playing now before its listen, and the queue never sent twice at once.
let chain: Promise<unknown> = Promise.resolve();
function job(fn: () => Promise<void>): Promise<void> {
  const run = chain.then(fn).catch(() => {});
  chain = run;
  return run;
}

// ---- ListenBrainz ----

// False: the token is malformed or refused (unreachable: true, with the error shown).
export async function connectListenBrainz(token: string): Promise<boolean> {
  const t = token.trim();
  scrobble.error = null;
  if (!LB_TOKEN_RE.test(t)) return false;
  let user: string | null = null;
  try {
    user = await lb().validate(t);
  } catch (e) {
    if (!(e instanceof ScrobbleError && e.auth)) scrobble.error = { key: 'scrobble_error_failed', detail: e instanceof Error ? e.message : '' };
  }
  if (user !== null) save(ACCOUNTS, { ...accounts(), lbUser: user, lbToken: t });
  refresh();
  return user !== null || scrobble.error !== null;
}

export async function disconnectListenBrainz(): Promise<void> {
  scrobble.error = null;
  const { lbUser: _u, lbToken: _t, ...rest } = accounts();
  save(ACCOUNTS, rest);
  await drop('listenbrainz');
}

// ---- Last.fm (web auth: auth.getToken, the user allows it on last.fm, auth.getSession) ----

let poll: ReturnType<typeof setTimeout> | undefined;
let pollId = 0;

function stopPolling(): void {
  clearTimeout(poll);
  pollId++;
  scrobble.authUrl = null;
}

// False: the API key or secret is malformed. An empty secret keeps the stored one for the same API key.
export async function connectLastfm(apiKey: string, secret: string): Promise<boolean> {
  const key = apiKey.trim();
  const prev = accounts();
  const sec = secret.trim() || (prev.fmKey === key ? (prev.fmSecret ?? '') : '');
  stopPolling();
  scrobble.error = null;
  if (!LASTFM_KEY_RE.test(key) || !LASTFM_KEY_RE.test(sec)) return false;
  const a: Accounts = { ...prev, fmKey: key, fmSecret: sec, fmUser: undefined, fmSession: undefined };
  save(ACCOUNTS, a);
  const client = fm(a);
  let token: string;
  try {
    token = await client.getToken();
  } catch (e) {
    scrobble.error = e instanceof ScrobbleError && e.auth ? { key: 'scrobble_error_invalid_key' } : { key: 'scrobble_error_failed', detail: e instanceof Error ? e.message : '' };
    refresh();
    return true;
  }
  scrobble.authUrl = client.authUrl(token);
  refresh();
  const id = ++pollId;
  const until = Date.now() + AUTH_WAIT_MS;
  const failed = (f: ScrobbleFailure) => {
    scrobble.authUrl = null;
    scrobble.error = f;
  };
  const tick = async (): Promise<void> => {
    if (id !== pollId) return;
    if (Date.now() > until) return failed({ key: 'scrobble_error_expired' });
    let s: { key: string; name: string } | null;
    try {
      s = await client.getSession(token);
    } catch (e) {
      if (id !== pollId) return;
      return failed(e instanceof ScrobbleError && e.code === 15 ? { key: 'scrobble_error_expired' } : { key: 'scrobble_error_failed', detail: e instanceof Error ? e.message : '' });
    }
    if (id !== pollId) return;
    if (!s) {
      poll = setTimeout(() => void tick(), AUTH_POLL_MS);
      return;
    }
    save(ACCOUNTS, { ...accounts(), fmUser: s.name, fmSession: s.key });
    scrobble.authUrl = null;
    refresh();
  };
  poll = setTimeout(() => void tick(), AUTH_POLL_MS);
  return true;
}

export function cancelLastfm(): void {
  stopPolling();
  scrobble.error = null;
}

export async function disconnectLastfm(): Promise<void> {
  stopPolling();
  scrobble.error = null;
  const { fmUser: _u, fmSession: _s, ...rest } = accounts();
  save(ACCOUNTS, { ...rest, fmKey: rest.fmKey ?? '' });
  await drop('lastfm');
}

// ---- Playback (the music session) ----

export function scrobbleNowPlaying(item: BaseItem): void {
  const info = trackInfo(item);
  if (!info) return;
  // Playing now is never queued: late, it would be wrong.
  void job(async () => {
    const a = accounts();
    if (a.lbToken) await lb().submit(a.lbToken, listenBody(info, null, VERSION)).catch((e) => failed('listenbrainz', e));
    if (a.fmSession) await fm(a).nowPlaying(a.fmSession, info).catch((e) => failed('lastfm', e));
  });
}

// The track ended or was left: [startedAt] in Unix seconds, [listenedMs] heard (pauses and seeks not counted).
export function scrobbleListened(item: BaseItem, startedAt: number, listenedMs: number): void {
  const info = trackInfo(item);
  if (!info || !shouldScrobble(info.durationMs ?? 0, listenedMs)) return;
  void job(async () => {
    let sent = false;
    for (const to of ['listenbrainz', 'lastfm'] as const) {
      const q: Queued = { to, at: startedAt, info };
      try {
        if (await send(q)) sent = true;
      } catch (e) {
        if (failed(to, e)) enqueue(q);
      }
    }
    if (sent) await drain();
  });
}

// False: that service is not connected.
async function send(q: Queued): Promise<boolean> {
  const a = accounts();
  if (q.to === 'listenbrainz') {
    if (!a.lbToken) return false;
    await lb().submit(a.lbToken, listenBody(q.info, q.at, VERSION));
  } else {
    if (!a.fmSession) return false;
    await fm(a).scrobble(a.fmSession, q.info, q.at);
  }
  return true;
}

// True when the listen is worth keeping for later (network, rate limit, server error, or a refused token the user
// can fix by connecting again).
function failed(to: Service, e: unknown): boolean {
  const s = e instanceof ScrobbleError ? e : null;
  if (s?.auth) scrobble.error = { key: to === 'lastfm' ? 'scrobble_error_lastfm_reauthorize' : 'scrobble_error_listenbrainz_reauthorize' };
  return !s || s.retry || s.auth;
}

function enqueue(q: Queued): void {
  save(QUEUE, [...queue(), q].slice(-QUEUE_CAP));
  refresh();
}

function drop(to: Service): Promise<void> {
  return job(async () => {
    save(QUEUE, queue().filter((q) => q.to !== to));
    refresh();
  });
}

// Oldest first; a service stops at its first failure worth retrying.
async function drain(): Promise<void> {
  const waiting = queue();
  if (!waiting.length) return;
  const stalled = new Set<Service>();
  const done = new Set<number>();
  for (const [i, q] of waiting.entries()) {
    if (stalled.has(q.to)) continue;
    try {
      if (!(await send(q))) continue;
    } catch (e) {
      if (failed(q.to, e)) {
        stalled.add(q.to);
        continue;
      }
    }
    done.add(i);
  }
  if (done.size) {
    // Nothing else writes the queue meanwhile: every job runs on the chain, one at a time.
    save(QUEUE, waiting.filter((_, i) => !done.has(i)));
    refresh();
  }
}

// The waiting listens go again 30 s after the start, then every 15 min (from the main screen's mount to its unmount).
export function runScrobbleRetries(): () => void {
  let timer = setTimeout(function flush() {
    void job(drain);
    timer = setTimeout(flush, RETRY_MS);
  }, 30_000);
  return () => clearTimeout(timer);
}
