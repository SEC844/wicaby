// "What's this song?" from the player: the last seconds mpv already holds, decoded by a second, silent mpv to 16 kHz
// mono PCM, turned into a Shazam signature (shared/song-id.ts) and sent to the discovery endpoint SongRec uses
// (github.com/marin-m/SongRec, GPL-3.0). Only that signature leaves the machine: peaks, not audio. The user asks for
// each one (OSD button or shortcut); the OSD says so before the first.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SongIdResult } from '../../shared/contract';
import { SAMPLE_RATE, SNIPPET_MS, shazamSignature, songFromShazam } from '../../shared/song-id';
import { logger } from '../core/log';
import type { MpvPlayer } from './mpv-player';

const log = logger.scope('song-id');

const SHAZAM = 'https://amp.shazam.com/discovery/v5/en/US/android/-/tag';
// SongRec's client identity: an Android user agent, which the endpoint answers.
const USER_AGENT = 'Dalvik/2.1.0 (Linux; U; Android 6.0.1; SM-G920F Build/MMB29K)';

// --ao=pcm writes as fast as it decodes (12 s in ~0.2 s); nothing reaches a sound device.
function decode(exe: string, input: string, output: string): Promise<void> {
  const args = ['--no-config', '--no-video', '--ao=pcm', `--ao-pcm-file=${output}`, '--ao-pcm-waveheader=no', '--audio-format=s16', '--audio-channels=mono', `--audio-samplerate=${SAMPLE_RATE}`, '--msg-level=all=error', '--', input];
  return new Promise((resolve, reject) => execFile(exe, args, { timeout: 20_000, windowsHide: true }, (err) => (err ? reject(err) : resolve())));
}

// The cover as a data: URL, 2 MB at most.
async function coverData(url: string): Promise<string | undefined> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!res.ok || !/^image\/(jpeg|png|webp)$/.test(type)) return undefined;
  const bytes = Buffer.from(await res.arrayBuffer());
  return bytes.length <= 2_000_000 ? `data:${type};base64,${bytes.toString('base64')}` : undefined;
}

export async function identifySong(mpv: MpvPlayer | null, exe: string | null): Promise<SongIdResult> {
  if (!mpv || !exe) return { error: 'unavailable' };
  const base = path.join(os.tmpdir(), `wicaby-songid-${randomUUID()}`);
  try {
    if (!(await mpv.dumpSnippet(`${base}.mkv`))) return { error: 'unavailable' };
    await decode(exe, `${base}.mkv`, `${base}.pcm`);
    const raw = await fs.readFile(`${base}.pcm`);
    const n = Math.min(raw.length >> 1, (SAMPLE_RATE * SNIPPET_MS) / 1000);
    const sig = shazamSignature(new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + n * 2)));
    if (!sig.peaks) return { error: 'nomatch' };
    const now = Date.now();
    const res = await fetch(`${SHAZAM}/${randomUUID().toUpperCase()}/${randomUUID()}?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&video=v3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Language': 'en_US', 'User-Agent': USER_AGENT },
      // A fixed, coarse location and zone, as SongRec sends: nothing about the user.
      body: JSON.stringify({ geolocation: { altitude: 300, latitude: 45, longitude: 2 }, signature: { samplems: sig.sampleMs, timestamp: now, uri: sig.uri }, timestamp: now, timezone: 'Europe/Paris' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429) return { error: 'rateLimited' };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const song = songFromShazam(await res.json());
    if (!song) return { error: 'nomatch' };
    song.coverUrl = song.coverUrl && (await coverData(song.coverUrl).catch(() => undefined));
    return { song };
  } catch (err) {
    log.warn('song identification failed', err);
    return { error: 'failed' };
  } finally {
    await Promise.all([fs.rm(`${base}.mkv`, { force: true }), fs.rm(`${base}.pcm`, { force: true })]);
  }
}
