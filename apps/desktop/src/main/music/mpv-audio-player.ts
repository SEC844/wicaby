import { EventEmitter } from 'node:events';
import type { BaseWindow } from 'electron';
import type { Settings } from '../../shared/contract';
import { audioMpvArgs, mpvAtLeast, parseMpvArgs } from '../../shared/mpv-args';
import { logger } from '../core/log';
import { t } from '../i18n';
import { MpvController, mpvVersion } from '../playback/mpv-controller';
import type { ActivePlayer, LoadParams, MusicLoad, TimeUpdate } from '../playback/player';
import type { WindowManager } from '../windows/window-manager';

const log = logger.scope('mpv-audio');

// The gain a file plays at: its ReplayGain tags ('tags') or the untagged value (server gain or fallback).
export interface GainInfo {
  source: 'tags' | 'server' | 'none';
  db: number;
}

// mpv's per-file option list: %n% quotes each value byte for byte.
function fileOptions(p: LoadParams, first: boolean): string {
  const headers = p.httpHeaders.join(',');
  const m = p.music;
  const opts: [string, string][] = [
    ...(headers ? ([['http-header-fields', headers]] as [string, string][]) : []),
    ...(m ? ([['replaygain', m.replayGain], ['replaygain-fallback', m.untaggedDb.toFixed(2)]] as [string, string][]) : []),
    // Global in mpv: only the first file of a run resumes, never one appended after it.
    ['start', first && p.startMs > 0 ? `+${(p.startMs / 1000).toFixed(3)}` : 'none'],
  ];
  return opts.map(([k, v]) => `${k}=%${Buffer.byteLength(v)}%${v}`).join(',');
}

// Music engine (music-spec §4.1, D1): mpv with no window at all, audio only, one entry playing and at most one
// prefetched after it, so mpv plays them back to back (gapless). The control pipe and the watchdog are
// MpvController's, as for video. Events: those of ActivePlayer, plus 'advance' (mpv moved on to the prefetched
// entry by itself) and 'gain' (GainInfo, once a file is loaded).
export class MpvAudioPlayer extends EventEmitter implements ActivePlayer {
  readonly kind = 'mpv' as const;
  private readonly ctl: MpvController;
  private position = 0;
  private duration = 0;
  private paused = false;
  private buffering = false;
  // From a load or an advance to file-loaded: time-pos and duration still describe the previous file.
  private loading = false;
  // A start-file we caused (load) rather than mpv's own move to the prefetched entry.
  private ownStart = false;
  private params: LoadParams | null = null;
  private queued: LoadParams | null = null;
  private destroyed = false;
  private hung = false;
  private timer: NodeJS.Timeout | null = null;
  private audioDevice = 'auto';

  private constructor(
    exe: string,
    private readonly windows: WindowManager,
    private readonly settings: () => Settings,
  ) {
    super();
    this.ctl = new MpvController(exe);
  }

  // SMTC, the thumbar and the tray follow the main window: there is no other.
  get hostWindow(): BaseWindow | null {
    return this.windows.main;
  }

  static async create(exe: string, windows: WindowManager, settings: () => Settings): Promise<MpvAudioPlayer> {
    const s = settings();
    const p = s.playback;
    const version = process.platform === 'win32' ? null : await mpvVersion(exe);
    if (process.platform !== 'win32' && !mpvAtLeast(version, 37)) throw new Error(t('errors.playback.mpvTooOld', { version: String(version), min: '0.37' }));
    const player = new MpvAudioPlayer(exe, windows, settings);
    const extra = parseMpvArgs(p.mpvArgs);
    const args = [
      '--no-config',
      // No window, no video, no cover art shown, nothing but audio.
      '--idle=yes',
      '--force-window=no',
      '--vid=no',
      '--audio-display=no',
      '--osc=no',
      '--input-default-bindings=no',
      '--terminal=yes',
      '--msg-level=all=warn',
      '--ytdl=no',
      '--load-scripts=no',
      '--keep-open=no',
      // Wicaby runs the one SMTC session (main window, renderer media-session.svelte.ts).
      ...(process.platform === 'win32' ? ['--media-controls=no', '--ao=wasapi'] : ['--ao=pipewire,pulse,alsa']),
      '--cache=yes',
      '--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=5',
      '--network-timeout=20',
      ...player.globalArgs(),
      `--audio-device=${p.audioDevice}`,
      // Bit-perfect path: WASAPI exclusive takes the file's own format; with ReplayGain off and the volume at 100 %
      // mpv hands the samples over untouched (no filter is ever set here, dynaudnorm included).
      `--audio-exclusive=${p.audioExclusive ? 'yes' : 'no'}`,
      // The user's own audio options last (allow-listed, audio subset only).
      ...audioMpvArgs(extra.args),
    ];
    player.audioDevice = p.audioDevice;
    try {
      await player.ctl.start(args);
      player.wire();
    } catch (err) {
      await player.destroy();
      throw err;
    }
    return player;
  }

  // Global options that follow the settings: gapless, preamp, clipping, volume ceiling.
  private globalArgs(): string[] {
    const { music, playback } = this.settings();
    return [
      `--gapless-audio=${music.gapless ? 'weak' : 'no'}`,
      `--prefetch-playlist=${music.gapless ? 'yes' : 'no'}`,
      `--replaygain-preamp=${music.preampDb}`,
      `--replaygain-clip=${music.preventClipping ? 'yes' : 'no'}`,
      `--volume-max=${playback.volumeBoost ? 150 : 100}`,
    ];
  }

  async applySettings(): Promise<void> {
    const sets = this.globalArgs().map((a) => /^--([^=]+)=(.*)$/.exec(a)!).map((m) => [m[1], m[2]] as const);
    const device = this.settings().playback.audioDevice;
    for (const [name, value] of sets) await this.ctl.set(name, value).catch((err) => log.warn(`set ${name} failed`, err));
    if (device !== this.audioDevice) {
      this.audioDevice = device;
      await this.ctl.set('audio-device', device).catch((err) => log.warn('set audio-device failed', err));
    }
  }

  async audioDevices(): Promise<{ name: string; description: string }[]> {
    return (await this.ctl.get<{ name: string; description: string }[]>('audio-device-list')) ?? [];
  }

  private wire(): void {
    const ctl = this.ctl;
    ctl.on('property', (name: string, value: unknown) => this.onProperty(name, value));
    ctl.on('event', (event: string, msg: Record<string, unknown>) => {
      if (event === 'start-file') {
        if (this.ownStart) this.ownStart = false;
        else if (this.queued) {
          // mpv went on to the prefetched entry: no gap, no reload. The finished entry leaves the playlist.
          this.params = this.queued;
          this.queued = null;
          this.loading = true;
          this.emit('advance');
          void ctl.command('playlist-remove', 0).catch(() => undefined);
        }
      } else if (event === 'file-loaded') {
        this.loading = false;
        void this.readGain();
      } else if (event === 'end-file') {
        const reason = msg.reason as string;
        log.info(`end-file: ${reason}${msg.file_error ? ` (${String(msg.file_error)})` : ''}`);
        // With an entry queued, mpv carries on (start-file above); otherwise the queue decides.
        if (reason === 'eof' && !this.loading && !this.queued) this.emit('ended');
        else if (reason === 'error') {
          this.queued = null;
          const fileError = String(msg.file_error ?? '');
          this.emit('failure', fileError ? t('errors.playback.fileError', { reason: fileError }) : t('errors.playback.fileErrorUnknown'), /format|codec|decod|output init/i.test(fileError) ? 'decode' : 'stream');
        }
      }
    });
    ctl.on('ao-failed', () => !this.destroyed && this.emit('decode-failure', 'audio output initialization failed'));
    ctl.on('hung', () => {
      if (this.destroyed || this.hung) return;
      this.hung = true;
      this.emit('hung');
    });
    ctl.on('exit', () => {
      setTimeout(() => {
        if (!this.destroyed && !this.hung) this.emit('failure', t('errors.playback.mpvExited'));
      }, 300);
    });
    for (const p of ['time-pos', 'duration', 'pause', 'paused-for-cache', 'seeking', 'volume', 'mute']) void ctl.observe(p).catch(() => undefined);
  }

  // Tags present: mpv applies them (source 'tags'); absent: the untagged value of this file's load.
  private async readGain(): Promise<void> {
    const m = this.params?.music;
    if (!m) return;
    const meta = (await this.ctl.get<Record<string, string>>('metadata').catch(() => null)) ?? {};
    const tag = (k: string) => Object.entries(meta).find(([name]) => name.toLowerCase() === k)?.[1];
    const tagged = tag(m.replayGain === 'album' ? 'replaygain_album_gain' : 'replaygain_track_gain') ?? tag('replaygain_track_gain');
    const db = Number.parseFloat(tagged ?? '');
    const info: GainInfo = m.replayGain !== 'no' && Number.isFinite(db) ? { source: 'tags', db: Math.round((db + m.preampDb) * 100) / 100 } : { source: m.untagged, db: m.untaggedDb };
    this.emit('gain', info);
  }

  private onProperty(name: string, value: unknown): void {
    switch (name) {
      case 'time-pos':
        if (typeof value === 'number' && !this.loading) this.position = value * 1000;
        break;
      case 'duration':
        if (typeof value === 'number' && !this.loading) this.duration = value * 1000;
        break;
      case 'pause':
        this.paused = Boolean(value);
        break;
      case 'paused-for-cache':
      case 'seeking':
        this.buffering = Boolean(value);
        break;
      case 'volume':
      case 'mute':
        void Promise.all([this.ctl.get<number>('volume'), this.ctl.get<boolean>('mute')])
          .then(([volume, muted]) => this.emit('volume', { volume, muted }))
          .catch(() => undefined);
        return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.emit('time', { positionMs: this.position, durationMs: this.duration, paused: this.paused, buffering: this.buffering || this.loading } satisfies TimeUpdate);
      }, 200);
    }
  }

  // A track now: whatever was playing or queued goes.
  async load(params: LoadParams): Promise<void> {
    this.params = params;
    this.queued = null;
    this.loading = true;
    this.ownStart = true;
    this.position = params.startMs;
    this.duration = 0;
    await this.ctl.set('volume', params.volume);
    await this.ctl.set('mute', params.muted);
    await this.ctl.set('speed', 1);
    await this.ctl.set('pause', params.music?.paused ?? false);
    await this.loadfile(params, 'replace');
  }

  // Prefetch: the next track, played gaplessly after the current one.
  async append(params: LoadParams): Promise<void> {
    if (this.queued) await this.dropNext();
    await this.loadfile(params, 'append');
    this.queued = params;
  }

  // The prefetched entry no longer follows (queue edited): out of mpv's playlist.
  async dropNext(): Promise<void> {
    if (!this.queued) return;
    this.queued = null;
    await this.ctl.command('playlist-remove', 1).catch(() => undefined);
  }

  get prefetched(): boolean {
    return this.queued !== null;
  }

  private async loadfile(p: LoadParams, flag: 'replace' | 'append'): Promise<void> {
    const options = fileOptions(p, flag === 'replace');
    log.info(`loadfile ${flag}`);
    try {
      // loadfile <url> <flags> <index> <options> (mpv 0.38+).
      await this.ctl.command('loadfile', p.url, flag, -1, options);
    } catch {
      // mpv 0.37 takes the options as the third argument.
      await this.ctl.command('loadfile', p.url, flag, options);
    }
  }

  play(): void {
    void this.ctl.set('pause', false).catch(() => undefined);
  }

  pause(): void {
    void this.ctl.set('pause', true).catch(() => undefined);
  }

  seek(positionMs: number): void {
    void this.ctl.command('seek', Math.max(0, positionMs / 1000), 'absolute+exact').catch(() => undefined);
  }

  setVolume(volume: number): void {
    const max = this.settings().playback.volumeBoost ? 150 : 100;
    void this.ctl.set('volume', Math.max(0, Math.min(max, volume))).catch(() => undefined);
  }

  setMuted(muted: boolean): void {
    void this.ctl.set('mute', muted).catch(() => undefined);
  }

  setRate(rate: number): void {
    void this.ctl.set('speed', rate).catch(() => undefined);
  }

  async setAudio(): Promise<boolean> {
    return false;
  }

  async setSubtitle(): Promise<boolean> {
    return false;
  }

  setFullscreen(): void {
    // No window.
  }

  isFullscreen(): boolean {
    return false;
  }

  setAspect(): void {
    // No picture.
  }

  async leave(): Promise<void> {
    // Nothing on screen to fade out.
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.removeAllListeners();
    await this.ctl.quit();
  }
}
