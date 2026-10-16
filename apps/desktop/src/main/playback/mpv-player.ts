import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { app, screen, type BaseWindow } from 'electron';
import type { Settings, SubtitleStyle, VideoAspect } from '../../shared/contract';
import { mpvAtLeast, mpvOutputArgs, parseMpvArgs } from '../../shared/mpv-args';
import { logger } from '../core/log';
import { t } from '../i18n';
import { LIVE_MPV_OPTIONS } from '../livetv/live-session';
import type { WindowManager } from '../windows/window-manager';
import { hdrFromMpv, hdrLabel, hdrOutputShown, mergeHdr, type HdrFormat, type MpvVideoParams } from './hdr';
import { MpvController, mpvVersion } from './mpv-controller';
import { EXIT_FADE_MS, EXIT_REVEAL_MS, type ActivePlayer, type LoadParams, type PlaybackStats, type TimeUpdate } from './player';

const log = logger.scope('mpv-player');

// Audio devices that refused the bitstream: a new mpv starts without --audio-spdif for them instead of failing at
// the start of every AC3/DTS file. shortcut: keyed on the configured device ('auto' = the Windows default), kept until
// the app restarts; key on the resolved endpoint if the default device often changes to a receiver.
const spdifRefused = new Set<string>();

// Picture-in-guide tile as video-margin-ratio [left, right, top, bottom]: 30 % of the width, 2 % from the
// right edge, 3 % from the top. GuideOverlay.svelte cuts its transparent hole at the same place.
export const GUIDE_TILE = [0.68, 0.02, 0.03, 0.67] as const;

interface MpvTrack {
  id: number;
  type: 'video' | 'audio' | 'sub';
  'ff-index'?: number;
  external?: boolean;
  selected?: boolean;
  codec?: string;
  'demux-channels'?: string;
  'demux-channel-count'?: number;
}

// libass only sees system fonts and sub-fonts-dir, so Geist (the default subtitle font) is
// copied there from the renderer's bundled woff2 files. Returns the folder.
function ensureSubFonts(configDir: string): string {
  const dir = path.join(configDir, 'fonts');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const geist = path.join('node_modules', '@fontsource-variable', 'geist', 'files');
    // npm workspaces hoist node_modules to the repo root in development.
    const sources = [path.join(__dirname, '..', 'renderer', 'assets'), path.join(app.getAppPath(), geist), path.join(app.getAppPath(), '..', '..', geist)];
    for (const subset of ['latin', 'latin-ext']) {
      const target = path.join(dir, `geist-${subset}.woff2`);
      if (fs.existsSync(target)) continue;
      const re = new RegExp(`^geist-${subset}-wght-normal(-[\\w-]+)?\\.woff2$`);
      for (const src of sources) {
        const name = fs.existsSync(src) ? fs.readdirSync(src).find((f) => re.test(f)) : undefined;
        if (name) {
          fs.writeFileSync(target, fs.readFileSync(path.join(src, name)));
          break;
        }
      }
    }
  } catch (err) {
    log.warn('could not prepare subtitle fonts', err);
  }
  return dir;
}

// Text subtitle look (mpv defaults: size 38 at 720p, outline 1.65).
function subtitleProps(s: SubtitleStyle): [string, unknown][] {
  const look: [string, unknown][] =
    s.border === 'box'
      ? [['sub-border-style', 'background-box'], ['sub-outline-size', 2.5], ['sub-shadow-offset', 0], ['sub-back-color', '#B0000000']]
      : s.border === 'shadow'
        ? [['sub-border-style', 'outline-and-shadow'], ['sub-outline-size', 0.6], ['sub-shadow-offset', 2.2], ['sub-back-color', '#C0000000']]
        : [['sub-border-style', 'outline-and-shadow'], ['sub-outline-size', 2.2], ['sub-shadow-offset', 0], ['sub-outline-color', '#FF000000']];
  return [
    ['sub-font', s.font],
    ['sub-font-size', Math.round((38 * s.size) / 100)],
    ['sub-color', s.color],
    ['sub-pos', s.position],
    // scale keeps typeset ASS (signs, karaoke) intact; force restyles it like plain text.
    ['sub-ass-override', s.overrideAss ? 'force' : 'scale'],
    // "Taille selon la résolution": scale with the video picture, not the window (letterbox included).
    ['sub-scale-with-window', !s.scaleWithVideo],
    ...look,
  ];
}

// Layouts (mpv and FFmpeg share these names) whose third channel is front centre, with their
// channel count. Channels are addressed by index so a decoder that labels them differently
// (back vs side surrounds) cannot make the pan filter fail.
const CENTER_LAYOUTS: Record<string, number> = {
  '3.0': 3,
  '3.1': 4,
  '4.0': 4,
  '4.1': 5,
  '5.0': 5,
  '5.0(side)': 5,
  '5.1': 6,
  '5.1(side)': 6,
  '6.1': 7,
  '7.1': 8,
};

// mpv --af for the selected audio track. Filters cannot touch a bitstream, so a track sent
// as S/PDIF gets none (mpv would otherwise fall back to decoding it).
export function audioFilters(p: Settings['playback'], track: Pick<MpvTrack, 'codec' | 'demux-channels'> | undefined): string {
  const codec = track?.codec ?? '';
  const spdif = p.spdif.includes(codec) || (codec === 'dts' && p.spdif.includes('dts-hd'));
  if (spdif) return '';
  const chain: string[] = [];
  if (p.dialogueBoost) {
    const layout = track?.['demux-channels'] ?? '';
    const count = CENTER_LAYOUTS[layout];
    // Multichannel: centre +3 dB, the rest -3 dB. Stereo has no centre: normalise speech instead.
    chain.push(
      count
        ? `lavfi=[pan=${layout}|${Array.from({ length: count }, (_, i) => `c${i}=${i === 2 ? 1.41 : 0.71}*c${i}`).join('|')}]`
        : 'lavfi=[speechnorm=e=6.25:r=0.00001:l=1]',
    );
  }
  // Night mode: -20 dB threshold, 4:1, +6 dB make-up; quiet dialogue rises, explosions shrink.
  if (p.nightMode) chain.push('lavfi=[acompressor=threshold=0.1:ratio=4:attack=5:release=200:makeup=2]');
  // Normalisation: evens out loudness between scenes and titles (dynamic, no look-ahead pass).
  if (p.normalize) chain.push('lavfi=[dynaudnorm=f=250:g=15:p=0.9:m=8]');
  return chain.join(',');
}

// Windows: the HWND. Linux (Ozone/X11, index.ts): the X11 window id, which mpv takes the same way.
function hwndOf(win: BaseWindow): string {
  const handle = win.getNativeWindowHandle();
  return (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString();
}

export class MpvPlayer extends EventEmitter implements ActivePlayer {
  readonly kind = 'mpv' as const;
  private ctl: MpvController;
  private params: LoadParams | null = null;
  private audioMap = new Map<number, number>();
  private subMap = new Map<number, number>();
  private position = 0;
  private duration = 0;
  private paused = false;
  private buffering = false;
  private stats: PlaybackStats = {};
  private destroyed = false;
  private mpvHdr: HdrFormat | null = null;
  private dvProfile: number | undefined;
  private targetGamma: string | undefined;
  private hintMode: 'target' | 'source' = 'target';
  private audioCodec: string | undefined;
  private bitstream = false;
  private hung = false;
  private audioTracks: MpvTrack[] = [];
  private af = '';
  private audioDevice = 'auto';
  // From load() to file-loaded: time-pos, duration and eof still describe the previous file.
  private loading = false;
  private firstFrame = false;
  private cache: TimeUpdate['cache'];

  private constructor(
    exe: string,
    private readonly windows: WindowManager,
    private readonly settings: () => Settings,
    private readonly passthrough: boolean,
    // A user mpv.conf owns tone mapping and subtitle looks; Wicaby then leaves those options alone.
    private readonly tuneHdr: boolean,
  ) {
    super();
    this.ctl = new MpvController(exe);
  }

  get hostWindow(): BaseWindow | null {
    return this.windows.playback?.video ?? null;
  }

  static async create(exe: string, windows: WindowManager, settings: () => Settings, configDir: string): Promise<MpvPlayer> {
    const p = settings().playback;
    // Linux runs the system mpv: 0.37 or newer, newer options gated (probed once per path, index.ts
    // already did at startup). Windows ships its own mpv and never waits for the probe.
    const version = process.platform === 'win32' ? null : await mpvVersion(exe);
    if (process.platform !== 'win32' && !mpvAtLeast(version, 37)) throw new Error(t('errors.playback.mpvTooOld', { version: String(version), min: '0.37' }));
    const player = new MpvPlayer(exe, windows, settings, p.hdrPassthrough, !p.useMpvConfig);
    const pw = windows.createPlaybackWindows(p.startFullscreen);
    pw.osd.on('closed', () => {
      if (!player.destroyed) player.emit('closed');
    });
    // An OSD crash leaves nothing to control playback with: handled as a close (live: ledger sweep, §8.1).
    pw.osd.webContents.on('render-process-gone', () => {
      if (!player.destroyed) player.emit('closed');
    });
    const userConf = path.join(configDir, 'mpv.conf');
    // Allow-listed options only (shared/mpv-args.ts); the rest is logged and dropped.
    const extra = parseMpvArgs(p.mpvArgs);
    if (extra.rejected.length) log.warn(`ignored mpv arguments: ${extra.rejected.join(' ')}`);
    // Embedding and control: neither the user's mpv.conf nor a profile may change these.
    const fixed = [
      `--wid=${hwndOf(pw.video)}`,
      '--idle=yes',
      '--force-window=yes',
      '--keep-open=no',
      '--terminal=yes',
      '--msg-level=all=warn',
      '--osc=no',
      '--osd-level=0',
      '--osd-bar=no',
      '--input-default-bindings=no',
      '--input-vo-keyboard=no',
      '--input-cursor=no',
      '--cursor-autohide=no',
      '--ytdl=no',
      '--load-scripts=no',
      '--sub-auto=no',
    ];
    // Wicaby's defaults; with "Utiliser mpv.conf" the user's file is included after them and wins.
    const args = [
      ...(p.useMpvConfig ? ['--config=yes', `--config-dir=${configDir}`] : ['--no-config']),
      '--hr-seek=yes',
      // Remote servers: 512 MiB ahead (about 50 s of an 80 Mb/s remux), 128 MiB behind for
      // instant short rewinds, 3 s of refill after a stall instead of stuttering at 1 s.
      '--cache=yes',
      '--demuxer-max-bytes=512MiB',
      '--demuxer-max-back-bytes=128MiB',
      '--cache-pause-wait=3',
      // Survive Wi-Fi drops and server restarts: FFmpeg reconnects the HTTP stream, HLS retries segments.
      '--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=5',
      '--demuxer-lavf-o=seg_max_retry=5',
      '--network-timeout=20',
      '--embeddedfonts=yes',
      `--sub-fonts-dir=${ensureSubFonts(configDir)}`,
      ...mpvOutputArgs(p, process.platform, version),
      `--volume-max=${p.volumeBoost ? 150 : 100}`,
      '--background-color=#000000',
      // dts-hd already covers the DTS core. WASAPI switches to exclusive mode for any bitstream.
      ...(p.spdif.length && !spdifRefused.has(p.audioDevice) ? [`--audio-spdif=${p.spdif.filter((c) => c !== 'dts' || !p.spdif.includes('dts-hd')).join(',')}`] : []),
      `--audio-device=${p.audioDevice}`,
      ...(p.useMpvConfig && fs.existsSync(userConf) ? [`--include=${userConf}`] : []),
      // "Arguments mpv supplémentaires": after Wicaby's defaults, before the fixed embedding options.
      ...extra.args,
      ...fixed,
    ];
    player.audioDevice = p.audioDevice;
    try {
      await player.ctl.start(args);
      windows.onPlaybackSettled = () => player.scheduleGeometryCheck();
      player.wire();
      await player.applySettings();
    } catch (err) {
      // No playback windows left open over a hidden main window, no orphan mpv --idle.
      await player.destroy();
      throw err;
    }
    return player;
  }

  // Live settings: volume ceiling, audio filters and, without a user mpv.conf, the subtitle look.
  async applySettings(): Promise<void> {
    const p = this.settings().playback;
    const sets: [string, unknown][] = [['volume-max', p.volumeBoost ? 150 : 100], ...(this.tuneHdr ? subtitleProps(p.subtitleStyle) : [])];
    // Switching the device reopens the audio output, so only on a real change.
    if (p.audioDevice !== this.audioDevice) {
      this.audioDevice = p.audioDevice;
      sets.push(['audio-device', p.audioDevice]);
    }
    for (const [name, value] of sets) await this.ctl.set(name, value).catch((err) => log.warn(`set ${name} failed`, err));
    await this.updateFilters();
  }

  // The container's title tag (file sources cache it, file-sources-spec D5).
  async mediaTitle(): Promise<string | undefined> {
    const v = await this.ctl.get<unknown>('metadata/by-key/title').catch(() => undefined);
    return typeof v === 'string' ? v : undefined;
  }

  async audioDevices(): Promise<{ name: string; description: string }[]> {
    return (await this.ctl.get<{ name: string; description: string }[]>('audio-device-list')) ?? [];
  }

  private async updateFilters(): Promise<void> {
    const sel = this.audioTracks.find((t) => t.selected) ?? this.audioTracks[0];
    const af = audioFilters(this.settings().playback, sel);
    // Leave a user mpv.conf's own af alone until Wicaby has something to say.
    if (af === this.af) return;
    this.af = af;
    await this.ctl.set('af', af).catch((err) => log.warn(`audio filters rejected: ${af}`, err));
  }

  private wire(): void {
    const ctl = this.ctl;
    ctl.on('property', (name: string, value: unknown) => this.onProperty(name, value));
    ctl.on('event', (event: string, msg: Record<string, unknown>) => {
      if (event === 'start-file') this.firstFrame = false;
      else if (event === 'file-loaded') {
        this.loading = false;
        void this.onFileLoaded();
      }
      // The observer stays silent when the gamma does not change across files (pq to pq), so re-read it once frames flow.
      else if (event === 'playback-restart') {
        // Live TV adopts a stream on its first frame (live-session.ts).
        if (!this.firstFrame) {
          this.firstFrame = true;
          this.emit('first-frame');
        }
        void ctl.get<string>('video-target-params/gamma').then((g) => this.onTargetGamma(g), () => undefined);
      }
      else if (event === 'end-file') {
        const reason = msg.reason as string;
        log.info(`end-file: ${reason}${msg.file_error ? ` (${String(msg.file_error)})` : ''}`);
        if (reason === 'eof' && !this.loading) this.emit('ended');
        else if (reason === 'error') {
          const fileError = String(msg.file_error ?? '');
          // 'stream': the service may reopen it (stream-recovery.ts); 'decode': mpv cannot play what it got.
          const kind = /format|codec|decod|output init|no audio or video/i.test(fileError) ? 'decode' : 'stream';
          this.emit('failure', fileError ? t('errors.playback.fileError', { reason: fileError }) : t('errors.playback.fileErrorUnknown'), kind);
        }
      }
    });
    // A device that refuses the bitstream (TrueHD/DTS-HD to plain speakers) leaves mpv waiting for audio
    // forever. Decode to PCM instead for the rest of this player's life.
    ctl.on('ao-failed', () => {
      void (async () => {
        const spdif = await ctl.get<string>('audio-spdif').catch(() => '');
        if (this.destroyed) return;
        // Not a passthrough refusal: the service retries a direct-play file once with a server transcode.
        if (!spdif) return void this.emit('decode-failure', 'audio output initialization failed');
        log.warn(`audio output refused passthrough (${spdif}); falling back to PCM`);
        spdifRefused.add(this.audioDevice);
        await ctl.set('audio-spdif', '').catch(() => undefined);
        // The spdif choice is made when the decoder opens: re-select the track to rebuild the audio chain.
        const aid = await ctl.get<number | string | false>('aid').catch(() => false);
        if (aid !== false && aid !== 'no') {
          await ctl.set('aid', 'no').catch(() => undefined);
          await ctl.set('aid', aid).catch(() => undefined);
        }
        this.emit('notice', 'player.notice.passthroughRefused');
      })();
    });
    ctl.on('vo-failed', () => {
      if (!this.destroyed) this.emit('decode-failure', 'video output initialization failed');
    });
    // The watchdog's "hung" and the kill's "exit" can arrive in either order.
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
    const props = [
      'time-pos',
      'duration',
      'pause',
      'paused-for-cache',
      'seeking',
      'volume',
      'mute',
      'hwdec-current',
      'video-params',
      'video-target-params/gamma',
      'current-tracks/video/dolby-vision-profile',
      'audio-params/format',
      'video-codec',
      'audio-codec-name',
      'file-format',
      'estimated-vf-fps',
      'display-fps',
      'frame-drop-count',
      'video-bitrate',
      'demuxer-cache-state',
    ];
    for (const p of props) void ctl.observe(p).catch(() => undefined);
  }

  private timer: NodeJS.Timeout | null = null;
  private geometryTimer: NodeJS.Timeout | null = null;
  private nudged = false;

  // mpv sizes its child window from a cross-process WinEvent hook (EVENT_OBJECT_LOCATIONCHANGE,
  // delivered asynchronously, then SetWindowPos with SWP_ASYNCWINDOWPOS). If it misses the last
  // event it keeps rendering at the old size and offset. Its osd-dimensions are that child's
  // client size in pixels: compare them with the host, and if they differ, change the host by
  // one pixel and back, which raises the event again and makes mpv re-read the parent rectangle.
  scheduleGeometryCheck(): void {
    if (this.geometryTimer) clearTimeout(this.geometryTimer);
    // mpv's resize is asynchronous too: leave it time to land before judging.
    this.geometryTimer = setTimeout(() => {
      this.geometryTimer = null;
      void this.checkGeometry();
    }, 250);
  }

  private async checkGeometry(): Promise<void> {
    const win = this.hostWindow;
    if (!win || win.isDestroyed() || win.isMinimized() || this.destroyed) return;
    const dims = await this.ctl.get<{ w: number; h: number }>('osd-dimensions').catch(() => null);
    if (!dims?.w || win.isDestroyed()) return;
    const b = win.getBounds();
    // null: the display under the rectangle sets the scale (the API only takes a BrowserWindow).
    const px = screen.dipToScreenRect(null, b);
    if (Math.abs(dims.w - px.width) <= 2 && Math.abs(dims.h - px.height) <= 2) {
      this.nudged = false;
      return;
    }
    // Once per mismatch, so a size mpv never reaches does not wiggle the window on every settle.
    if (this.nudged) return;
    this.nudged = true;
    log.warn(`mpv renders at ${dims.w}×${dims.h} in a ${px.width}×${px.height} window: forcing a re-layout`);
    win.setBounds({ ...b, width: b.width + 1 });
    win.setBounds(b);
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
      case 'hwdec-current':
        this.stats.hwdec = typeof value === 'string' ? value : undefined;
        break;
      case 'video-params': {
        const v = value as (MpvVideoParams & { w?: number; h?: number }) | null;
        if (v) this.stats.resolution = v.w && v.h ? `${v.w}×${v.h}` : undefined;
        this.mpvHdr = hdrFromMpv(v, this.dvProfile);
        this.updateHdr();
        break;
      }
      case 'current-tracks/video/dolby-vision-profile':
        this.dvProfile = typeof value === 'number' ? value : undefined;
        if (this.mpvHdr?.kind === 'dv') this.mpvHdr = { kind: 'dv', dvProfile: this.dvProfile ? String(this.dvProfile) : undefined };
        this.updateHdr();
        break;
      case 'video-target-params/gamma':
        this.onTargetGamma(typeof value === 'string' ? value : undefined);
        break;
      case 'audio-params/format':
        // Bitstreams force WASAPI exclusive mode and disable display-resample, whatever the settings say.
        this.bitstream = typeof value === 'string' && value.startsWith('spdif');
        this.updateAudio();
        break;
      case 'video-codec':
        this.stats.videoCodec = typeof value === 'string' ? value.split(' ')[0] : undefined;
        break;
      case 'audio-codec-name':
        this.audioCodec = typeof value === 'string' ? value : undefined;
        this.updateAudio();
        break;
      case 'file-format':
        this.stats.container = typeof value === 'string' ? value : undefined;
        break;
      case 'estimated-vf-fps':
        this.stats.frameRate = typeof value === 'number' ? Math.round(value * 1000) / 1000 : undefined;
        break;
      case 'display-fps':
        this.stats.displayFps = typeof value === 'number' ? Math.round(value * 100) / 100 : undefined;
        break;
      case 'frame-drop-count':
        // Each burst is logged with where it happened: drops come from short mpv stalls, and the position, the
        // subtitle state and the cache say what was on screen (diagnosis of the 2-4 frame bursts).
        if (typeof value === 'number' && value > (this.stats.droppedFrames ?? 0) && !this.loading)
          log.info(`dropped ${value - (this.stats.droppedFrames ?? 0)} frame(s) at ${Math.round(this.position / 1000)} s (total ${value}, cache ${this.cache ? Math.round(((this.cache.ranges.at(-1)?.[1] ?? 0) - this.position) / 1000) : '?'} s ahead)`);
        this.stats.droppedFrames = typeof value === 'number' ? value : undefined;
        break;
      case 'video-bitrate':
        this.stats.bitrateKbps = typeof value === 'number' ? Math.round(value / 1000) : undefined;
        break;
      case 'demuxer-cache-state': {
        const c = value as { 'seekable-ranges'?: { start: number; end: number }[]; 'file-cache-bytes'?: number; 'fw-bytes'?: number } | null;
        this.cache = c
          ? { ranges: (c['seekable-ranges'] ?? []).map((r) => [r.start * 1000, r.end * 1000]), fileBytes: c['file-cache-bytes'] ?? 0, fwBytes: c['fw-bytes'] ?? 0 }
          : undefined;
        break;
      }
    }
    // Coalesce the per-frame property storm into ~5 updates per second.
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        // Until the new file opens, the spinner stays up whatever the old file's cache state was.
        this.emit('time', { positionMs: this.position, durationMs: this.duration, paused: this.paused, buffering: this.buffering || this.loading, cache: this.cache });
        this.emit('stats', { ...this.stats });
      }, 200);
    }
  }

  private updateAudio(): void {
    this.stats.audioCodec = this.audioCodec;
    this.stats.audioBitstream = Boolean(this.audioCodec && this.bitstream);
  }

  private onTargetGamma(gamma: string | undefined): void {
    this.targetGamma = gamma;
    this.updateHdr();
  }

  private updateHdr(): void {
    const g = this.targetGamma;
    const format = mergeHdr(this.params?.hdr ?? null, this.mpvHdr);
    // In target mode the output gamma tells whether Windows HDR is on. "source" on an SDR desktop
    // would write PQ into an sRGB swapchain (washed out), so it is only enabled after that check.
    // SDR content stays in target mode, which places it at the HDR reference white.
    if (this.passthrough && this.hintMode === 'target' && g === 'pq' && format && format.kind !== 'sdr') {
      this.hintMode = 'source';
      void this.ctl.set('target-colorspace-hint-mode', 'source').catch(() => undefined);
    }
    const output = !g ? undefined : g !== 'pq' && g !== 'hlg' ? 'sdr' : this.hintMode === 'source' ? 'passthrough' : 'hdr';
    this.stats.hdr = hdrLabel(format);
    this.stats.hdrOutput = hdrOutputShown(format, output);
  }

  // live: a Live TV stream, which gets the live file-local options (§8.9) on top of the defaults;
  // timeshift: its back-buffer options (§8.8, live-session.ts timeshiftPlan).
  async load(params: LoadParams & { live?: boolean; timeshift?: readonly (readonly [string, string])[] }): Promise<void> {
    this.params = params;
    this.loading = true;
    this.cache = undefined;
    // Re-armed by the new file's start-file, so a late event of the old file is not taken for it.
    this.firstFrame = true;
    this.audioMap.clear();
    this.subMap.clear();
    this.position = params.startMs;
    this.duration = 0;
    this.stats = {};
    this.mpvHdr = null;
    this.dvProfile = undefined;
    this.targetGamma = undefined;
    this.audioCodec = undefined;
    this.bitstream = false;
    const ctl = this.ctl;
    // Re-check the display on every file: Windows HDR may have been toggled since the last one.
    if (this.hintMode !== 'target') {
      this.hintMode = 'target';
      await ctl.set('target-colorspace-hint-mode', 'target').catch(() => undefined);
    }
    // HDR10+ carries per-scene ST 2094-40 curves; spline with peak detection does as well for the rest.
    if (this.tuneHdr) await ctl.set('tone-mapping', params.hdr?.kind === 'hdr10+' ? 'st2094-40' : 'spline').catch(() => undefined);
    // The auth header is a per-file option of loadfile (below); emptied here so no later file
    // or URL on another origin inherits it (older mpv sets it globally for one file).
    await ctl.set('http-header-fields', []);
    await ctl.set('start', params.startMs > 0 ? `+${(params.startMs / 1000).toFixed(3)}` : 'none');
    await ctl.set('force-media-title', params.title);
    await ctl.set('volume', params.volume);
    await ctl.set('mute', params.muted);
    // speed is global in mpv: without this the next file would inherit the last one's.
    await ctl.set('speed', params.rate ?? 1);
    await ctl.set('sid', 'no');
    await ctl.set('secondary-sid', 'no').catch(() => undefined);
    // Subtitle sync belongs to a file; the audio delay (display and receiver latency) carries over.
    await ctl.set('sub-delay', 0);
    // The next file's first track may be a bitstream, which no filter accepts; onFileLoaded sets them again.
    this.audioTracks = [];
    if (this.af) await this.updateFilters();
    await ctl.set('pause', false);
    const headers = params.httpHeaders.join(',');
    // File-local options: the auth header, and for live the live profile. They end with this file.
    const options = [
      ...(params.live ? LIVE_MPV_OPTIONS.map(([k, v]) => `${k}=${v}`) : []),
      // %n% quoting: the cache dir is a path.
      ...(params.live ? (params.timeshift ?? []).map(([k, v]) => `${k}=%${Buffer.byteLength(v)}%${v}`) : []),
      ...(headers ? [`http-header-fields=%${Buffer.byteLength(headers)}%${headers}`] : []),
    ];
    if (!options.length) await ctl.command('loadfile', params.url, 'replace');
    else {
      try {
        // loadfile <url> <flags> <index> <options> (mpv 0.38+); %n% quotes the value byte for byte.
        await ctl.command('loadfile', params.url, 'replace', -1, options.join(','));
      } catch {
        // Older mpv has no index argument and refuses the command before doing anything: the
        // global header list instead, for this file only (the next load() empties it first).
        // The live profile is skipped there rather than leaked into the next VOD file.
        if (params.live) log.warn('this mpv takes no per-file options: live profile skipped');
        if (headers) await ctl.set('http-header-fields', params.httpHeaders);
        await ctl.command('loadfile', params.url, 'replace');
      }
    }
  }

  private async onFileLoaded(): Promise<void> {
    const p = this.params;
    if (!p) return;
    const tracks = ((await this.ctl.get<MpvTrack[]>('track-list').catch(() => [])) ?? []).filter((t) => !t.external);
    const audio = tracks.filter((t) => t.type === 'audio');
    const subs = tracks.filter((t) => t.type === 'sub');
    this.audioTracks = audio;
    // Server stream index == FFmpeg stream index when the original file is streamed.
    p.embeddedAudio.forEach((serverIndex, i) => {
      const byFf = audio.find((t) => t['ff-index'] === serverIndex);
      const id = byFf?.id ?? audio[i]?.id;
      if (id !== undefined) this.audioMap.set(serverIndex, id);
    });
    p.embeddedSubtitles.forEach((serverIndex, i) => {
      const byFf = subs.find((t) => t['ff-index'] === serverIndex);
      const id = byFf?.id ?? subs[i]?.id;
      if (id !== undefined) this.subMap.set(serverIndex, id);
    });
    if (!p.tracksFixed) {
      if (p.audioIndex === null || !(await this.setAudio(p.audioIndex))) await this.updateFilters();
      await this.setSubtitle(p.subtitleIndex);
    } else {
      await this.updateFilters();
      await this.ctl.set('sid', p.subtitleIndex !== null ? 'auto' : 'no').catch(() => undefined);
    }
  }

  // Returns the new delay in ms.
  async adjustDelay(kind: 'audio' | 'subtitle', deltaMs: number): Promise<number> {
    const prop = kind === 'audio' ? 'audio-delay' : 'sub-delay';
    if (deltaMs === 0) await this.ctl.set(prop, 0);
    else await this.ctl.command('add', prop, deltaMs / 1000);
    return Math.round(((await this.ctl.get<number>(prop)) ?? 0) * 1000);
  }

  // X-05: a remembered delay, in ms.
  async setDelay(kind: 'audio' | 'subtitle', ms: number): Promise<void> {
    await this.ctl.set(kind === 'audio' ? 'audio-delay' : 'sub-delay', ms / 1000).catch(() => undefined);
  }

  // X-05: a second subtitle drawn at the top of the picture (null = none). An external one is
  // added without being selected as the primary.
  async setSecondarySubtitle(index: number | null): Promise<boolean> {
    const p = this.params;
    if (!p) return false;
    if (index === null) {
      await this.ctl.set('secondary-sid', 'no').catch(() => undefined);
      return true;
    }
    if (p.tracksFixed) return false;
    let id = this.subMap.get(index);
    if (id === undefined) {
      const ext = p.externalSubtitles.find((s) => s.index === index);
      if (!ext) return false;
      try {
        await this.ctl.command('sub-add', ext.url, 'auto', ext.label, ext.language ?? '');
        const tracks = (await this.ctl.get<(MpvTrack & { 'external-filename'?: string })[]>('track-list')) ?? [];
        id = tracks.filter((t) => t.type === 'sub' && t['external-filename'] === ext.url).pop()?.id;
        if (id === undefined) return false;
        this.subMap.set(index, id);
      } catch (err) {
        log.warn('sub-add failed', err);
        return false;
      }
    }
    await this.ctl.set('secondary-sid', id).catch(() => undefined);
    // mpv 0.38+: the top of the picture (older builds already draw it there and refuse the property).
    await this.ctl.set('secondary-sub-pos', 10).catch(() => undefined);
    return true;
  }

  // X-04 Ctrl+←/→: the previous or next subtitle line.
  subSeek(delta: 1 | -1): void {
    void this.ctl.command('sub-seek', delta).catch(() => undefined);
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

  async setAudio(index: number): Promise<boolean> {
    if (this.params?.tracksFixed) return false;
    const id = this.audioMap.get(index);
    if (id === undefined) return false;
    for (const t of this.audioTracks) t.selected = t.id === id;
    // Filters off before switching to a bitstream track, on after switching to a decoded one.
    if (!audioFilters(this.settings().playback, this.audioTracks.find((t) => t.selected))) await this.updateFilters();
    await this.ctl.set('aid', id).catch(() => undefined);
    await this.updateFilters();
    return true;
  }

  async setSubtitle(index: number | null): Promise<boolean> {
    const p = this.params;
    if (!p) return false;
    if (index === null || index < 0) {
      await this.ctl.set('sid', 'no').catch(() => undefined);
      return true;
    }
    if (p.tracksFixed) return false;
    let id = this.subMap.get(index);
    if (id === undefined) {
      const ext = p.externalSubtitles.find((s) => s.index === index);
      if (!ext) return false;
      try {
        await this.ctl.command('sub-add', ext.url, 'select', ext.label, ext.language ?? '');
        id = await this.ctl.get<number>('sid');
        if (typeof id === 'number') this.subMap.set(index, id);
        return true;
      } catch (err) {
        log.warn('sub-add failed', err);
        return false;
      }
    }
    await this.ctl.set('sid', id).catch(() => undefined);
    return true;
  }

  // These are global in mpv and outlive loadfile, so every item sets all four. While the guide overlay is
  // open they wait for its close (it owns keepaspect and the zoom).
  private aspect: VideoAspect = { mode: 'fit', zoom: 1.25 };
  private guide = false;
  setAspect(a: VideoAspect): void {
    this.aspect = a;
    if (this.guide) return;
    const props: [string, unknown][] = [
      ['keepaspect', a.mode !== 'stretch'],
      ['panscan', a.mode === 'fill' ? 1 : 0],
      // video-zoom is a power of two.
      ['video-zoom', a.mode === 'zoom' ? Math.log2(a.zoom) : 0],
      ['video-unscaled', a.mode === 'original' ? 'yes' : 'no'],
    ];
    for (const [name, value] of props) void this.ctl.set(name, value).catch((err) => log.warn(`set ${name} failed`, err));
  }

  // Picture-in-guide (§8.7, LT-17): the video in a 16:9 tile at the top right (30 % of the width), over
  // the guide's transparent hole. The margins need keepaspect=yes; subtitles are hidden so they do not land
  // in the guide. An mpv without the margin options gets video-zoom + video-pan instead. Global
  // properties: a tune in place keeps the tile. Closing restores the aspect mode (Z) and subtitles.
  async setGuideOverlay(open: boolean): Promise<void> {
    if (open === this.guide) return;
    this.guide = open;
    const set = (name: string, value: unknown) => this.ctl.set(name, value);
    const [l, r, top, bottom] = open ? GUIDE_TILE : [0, 0, 0, 0];
    await set('sub-visibility', !open).catch(() => undefined);
    if (open) await set('keepaspect', true).catch(() => undefined);
    try {
      await set('video-margin-ratio-left', l);
      await set('video-margin-ratio-right', r);
      await set('video-margin-ratio-top', top);
      await set('video-margin-ratio-bottom', bottom);
    } catch {
      // Fallback (V8): scale to the tile's width and move its centre there (pan is in video widths).
      const w = 1 - l - r;
      if (open) log.info('no video-margin-ratio: zoom/pan fallback');
      await set('video-zoom', open ? Math.log2(w) : 0).catch(() => undefined);
      await set('video-pan-x', open ? (l + w / 2 - 0.5) / w : 0).catch(() => undefined);
      await set('video-pan-y', open ? (top + (1 - top - bottom) / 2 - 0.5) / w : 0).catch(() => undefined);
    }
    if (!open) this.setAspect(this.aspect);
  }

  setFullscreen(value: boolean): void {
    this.windows.setPlaybackFullscreen(value);
  }

  isFullscreen(): boolean {
    return this.windows.isPlaybackFullscreen();
  }

  // The OSD's veil fades the paused picture to black (OsdWindow.svelte), the main window comes up and paints under
  // the veil, mpv's window goes and the veil uncovers the page. destroy() quits mpv once all this is hidden.
  async leave(reduced: boolean, phase: (p: 'out' | 'reveal') => void): Promise<void> {
    const pw = this.windows.playback;
    if (this.destroyed || !pw || pw.osd.isDestroyed()) return;
    if (!reduced) {
      phase('out');
      await sleep(EXIT_FADE_MS);
    }
    await this.windows.showMainUnder();
    if (!reduced && !pw.video.isDestroyed()) {
      pw.video.hide();
      phase('reveal');
      await sleep(EXIT_REVEAL_MS);
    }
    this.windows.hidePlayback();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.geometryTimer) clearTimeout(this.geometryTimer);
    this.removeAllListeners();
    await this.ctl.quit();
    this.windows.destroyPlaybackWindows();
  }
}
