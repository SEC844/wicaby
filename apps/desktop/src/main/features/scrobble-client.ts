// Music scrobbling to ListenBrainz and Last.fm: the scrobble rule, the payloads, the Last.fm signature and the
// few calls Wicaby needs. No Electron import, so tools/checks/scrobble-check.mjs runs it as is.
// Error messages never carry a token, a session key or a secret.
import { createHash } from 'node:crypto';
import type { BaseItem } from '../../shared/models';

export const LISTENBRAINZ_API = 'https://api.listenbrainz.org';
export const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';
export const LASTFM_AUTH = 'https://www.last.fm/api/auth/';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
// The global fetch, called as a plain function: a browser throws "Illegal invocation" when it is called as a method
// of another object (this.fetcher(...)), which Node allows.
const globalFetch: Fetch = (url, init) => fetch(url, init);

// A form from a record, built pair by pair: URLSearchParams takes a record only from Chromium 61 (the TV web app
// runs this from 53, where the record becomes "[object Object]=").
function formOf(fields: Record<string, string>): URLSearchParams {
  const form = new URLSearchParams();
  for (const k of Object.keys(fields)) form.append(k, fields[k]);
  return form;
}

// retry: worth sending again later (network, 429, 5xx, Last.fm "try again"); auth: the token or session is refused.
export class ScrobbleError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
    readonly auth = false,
    readonly code = 0,
  ) {
    super(message);
  }
}

export interface TrackInfo {
  artists: string[];
  track: string;
  album?: string;
  albumArtist?: string;
  durationMs?: number;
  trackNumber?: number;
  // ListenBrainz additional_info keys (recording_mbid, release_mbid…), validated UUIDs only.
  mbids?: Record<string, string>;
}

// The standard rule (Last.fm and ListenBrainz alike): a track of 30 s or more, heard for 4 min or half its length.
// Unknown length: 4 min heard.
export function shouldScrobble(durationMs: number, listenedMs: number): boolean {
  if (!(durationMs > 0)) return listenedMs >= 240_000;
  return durationMs >= 30_000 && listenedMs >= Math.min(240_000, durationMs / 2);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Server provider id → ListenBrainz additional_info key.
const MBID_KEYS: Record<string, string> = {
  musicbrainzrecording: 'recording_mbid',
  musicbrainztrack: 'track_mbid',
  musicbrainzalbum: 'release_mbid',
  musicbrainzreleasegroup: 'release_group_mbid',
};

// What a track says about itself; null when it is not a song with a title and an artist.
export function trackInfo(item: BaseItem): TrackInfo | null {
  if (item.Type !== 'Audio') return null;
  const clean = (s: unknown) => (typeof s === 'string' ? s.trim() : '');
  const track = clean(item.Name);
  const artists = (item.Artists ?? []).map(clean).filter(Boolean);
  const albumArtist = clean(item.AlbumArtist) || undefined;
  if (!artists.length && albumArtist) artists.push(albumArtist);
  if (!track || !artists.length) return null;
  const mbids: Record<string, string> = {};
  for (const [k, v] of Object.entries(item.ProviderIds ?? {})) {
    const key = MBID_KEYS[k.toLowerCase()];
    if (key && typeof v === 'string' && UUID.test(v)) mbids[key] = v.toLowerCase();
  }
  const durationMs = item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10_000) : undefined;
  return {
    artists,
    track,
    album: clean(item.Album) || undefined,
    albumArtist,
    durationMs: durationMs && durationMs > 0 ? durationMs : undefined,
    trackNumber: Number.isInteger(item.IndexNumber) && item.IndexNumber! > 0 ? item.IndexNumber : undefined,
    mbids: Object.keys(mbids).length ? mbids : undefined,
  };
}

// ---- ListenBrainz ----

// One listen (listenedAt in Unix seconds) or the playing-now notice (no listenedAt).
export function listenBody(info: TrackInfo, listenedAt: number | null, version: string): object {
  const extra = {
    duration_ms: info.durationMs,
    tracknumber: info.trackNumber,
    artist_names: info.artists.length > 1 ? info.artists : undefined,
    ...info.mbids,
    media_player: 'Wicaby',
    submission_client: 'Wicaby',
    submission_client_version: version,
  };
  const track_metadata = { artist_name: info.artists.join(', '), track_name: info.track, release_name: info.album, additional_info: extra };
  return listenedAt === null ? { listen_type: 'playing_now', payload: [{ track_metadata }] } : { listen_type: 'single', payload: [{ listened_at: listenedAt, track_metadata }] };
}

export class ListenBrainzClient {
  constructor(
    private readonly base: string,
    private readonly fetcher: Fetch = globalFetch,
  ) {}

  private async call(path: string, token: string, body?: object): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetcher(this.base + path, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Token ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
      });
    } catch (err) {
      throw new ScrobbleError(`ListenBrainz unreachable: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    if (res.ok) return res.json().catch(() => null);
    throw new ScrobbleError(`ListenBrainz HTTP ${res.status}`, res.status === 429 || res.status >= 500, res.status === 401, res.status);
  }

  // The user name of a valid token, else null.
  async validate(token: string): Promise<string | null> {
    const r = (await this.call('/1/validate-token', token)) as { valid?: boolean; user_name?: string } | null;
    return r?.valid ? (r.user_name ?? '') : null;
  }

  submit(token: string, body: object): Promise<unknown> {
    return this.call('/1/submit-listens', token, body);
  }
}

// ---- Last.fm ----

// api_sig: every parameter but format and callback, sorted by name, as name+value, then the secret, md5 in UTF-8.
export function lastfmSign(params: Record<string, string>, secret: string): string {
  const s = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort()
    .map((k) => k + params[k])
    .join('');
  return createHash('md5').update(s + secret, 'utf8').digest('hex');
}

// track.updateNowPlaying (timestamp null) or track.scrobble parameters, before the key, session and signature.
export function lastfmTrackParams(info: TrackInfo, timestamp: number | null): Record<string, string> {
  const p: Record<string, string> = { artist: info.artists[0], track: info.track };
  if (info.album) p.album = info.album;
  if (info.albumArtist) p.albumArtist = info.albumArtist;
  if (info.trackNumber) p.trackNumber = String(info.trackNumber);
  if (info.durationMs) p.duration = String(Math.round(info.durationMs / 1000));
  if (info.mbids?.recording_mbid) p.mbid = info.mbids.recording_mbid;
  if (timestamp !== null) p.timestamp = String(timestamp);
  return p;
}

// Error codes worth a retry: operation failed, service offline, temporarily unavailable, rate limit.
const LASTFM_RETRY = new Set([8, 11, 16, 29]);
// Invalid session key, invalid API key, suspended key.
const LASTFM_AUTH_CODES = new Set([4, 9, 10, 26]);

export class LastfmClient {
  constructor(
    private readonly base: string,
    private readonly apiKey: string,
    private readonly secret: string,
    private readonly fetcher: Fetch = globalFetch,
  ) {}

  private async call<T>(method: string, params: Record<string, string>, post: boolean): Promise<T> {
    const all: Record<string, string> = { ...params, method, api_key: this.apiKey };
    const form = formOf({ ...all, api_sig: lastfmSign(all, this.secret), format: 'json' });
    let res: Response;
    try {
      res = post
        ? await this.fetcher(this.base, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), redirect: 'error' })
        : await this.fetcher(`${this.base}?${form}`, { method: 'GET', redirect: 'error' });
    } catch (err) {
      throw new ScrobbleError(`Last.fm unreachable: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: number; message?: string }) | null;
    if (data && typeof data.error === 'number') {
      throw new ScrobbleError(`Last.fm error ${data.error}${data.message ? `: ${data.message}` : ''}`, LASTFM_RETRY.has(data.error), LASTFM_AUTH_CODES.has(data.error), data.error);
    }
    if (!res.ok || !data) throw new ScrobbleError(`Last.fm HTTP ${res.status}`, res.status === 429 || res.status >= 500, false, 0);
    return data;
  }

  async getToken(): Promise<string> {
    const r = await this.call<{ token?: string }>('auth.getToken', {}, false);
    if (!r.token) throw new ScrobbleError('Last.fm sent no token', false);
    return r.token;
  }

  authUrl(token: string): string {
    return `${LASTFM_AUTH}?${formOf({ api_key: this.apiKey, token })}`;
  }

  // The session once the user allowed the token on last.fm; null while they have not yet (error 14).
  async getSession(token: string): Promise<{ key: string; name: string } | null> {
    try {
      const r = await this.call<{ session?: { key?: string; name?: string } }>('auth.getSession', { token }, false);
      if (!r.session?.key) throw new ScrobbleError('Last.fm sent no session', false);
      return { key: r.session.key, name: r.session.name ?? '' };
    } catch (err) {
      if (err instanceof ScrobbleError && err.code === 14) return null;
      throw err;
    }
  }

  nowPlaying(sk: string, info: TrackInfo): Promise<unknown> {
    return this.call('track.updateNowPlaying', { ...lastfmTrackParams(info, null), sk }, true);
  }

  scrobble(sk: string, info: TrackInfo, timestamp: number): Promise<unknown> {
    return this.call('track.scrobble', { ...lastfmTrackParams(info, timestamp), sk }, true);
  }
}
