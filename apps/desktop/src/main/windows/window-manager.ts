import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { app, BaseWindow, BrowserWindow, screen, shell, systemPreferences, type Rectangle } from 'electron';
import { APP_HOST, APP_SCHEME, Channels, type WindowState } from '../../shared/contract';
import { logger } from '../core/log';
import type { SettingsService } from '../core/settings';
import { EXIT_FADE_MS } from '../playback/player';

const log = logger.scope('windows');

export const INK = '#101114';

export function isWindows11(): boolean {
  const build = Number(os.release().split('.')[2] ?? 0);
  return process.platform === 'win32' && build >= 22000;
}

// URL.origin is "null" for a non-special scheme such as app://, so it is rebuilt from
// protocol and host there. Credentials in the URL never match.
function originOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  return u.origin !== 'null' ? u.origin : `${u.protocol}//${u.host}`;
}

// Debugging entry points the fuses leave open (remote-debugging-*) or that must stay closed
// even if a fuse is ever reverted. Exported so index.ts can refuse them before app ready.
export const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port'] as const;

export function packagedDebugSwitch(
  packaged = app.isPackaged,
  hasSwitch: (name: string) => boolean = (name) => app.commandLine.hasSwitch(name),
): string | null {
  if (!packaged) return null;
  return DEBUG_SWITCHES.find((name) => hasSwitch(name)) ?? null;
}

export interface WindowManagerOptions {
  preload: string;
  devUrl?: string;
  icon?: string;
  settings: SettingsService;
}

export interface PlaybackWindows {
  video: BaseWindow;
  osd: BrowserWindow;
}

// Owns every BrowserWindow. The main window hosts the Svelte app. mpv playback
// uses a pair: an opaque video window whose HWND mpv renders into, and a
// transparent OSD window owned by it, so the web UI floats above the video
// (Emby layered a child HWND under WebView2 for the same effect).
export class WindowManager {
  main: BrowserWindow | null = null;
  playback: PlaybackWindows | null = null;
  private readonly mica = isWindows11();
  // Main window hidden in the notification area (close-to-tray or tray click).
  inTray = false;
  // Set by index.ts: first-time explanation when closing only hides the window.
  onHiddenToTray: (() => void) | null = null;
  private quitting = false;

  // A quit vetoed later in before-quit (e.g. "confirmer avant de quitter") must not leave close-to-tray disabled.
  cancelQuit(): void {
    this.quitting = false;
  }

  constructor(private readonly opts: WindowManagerOptions) {
    // Chromium's remote debugging is not covered by the Electron fuses: a packaged build never
    // opens a window (preload API, signed-in session) with a CDP endpoint listening.
    const debugSwitch = packagedDebugSwitch();
    if (debugSwitch) {
      logger.errorSync('windows', `refusing to start: --${debugSwitch} is not allowed in a packaged build`);
      app.exit(1);
    }
    app.on('before-quit', () => {
      this.quitting = true;
    });
  }

  url(route: string, extra: Record<string, string> = {}): string {
    // linux=1: the renderer sizes the title bar from the overlay's env() values (app.css).
    const params = new URLSearchParams({ mica: this.mica ? '1' : '0', ...(process.platform === 'linux' ? { linux: '1' } : {}), ...extra }).toString();
    const base = this.opts.devUrl ? `${this.opts.devUrl}/index.html` : `${APP_SCHEME}://${APP_HOST}/index.html`;
    return `${base}?${params}#${route}`;
  }

  // Exact origin match: a prefix test let "http://localhost:5173.evil.test" or
  // "app://wicaby.evil/" through.
  isAppUrl(url: string): boolean {
    const origin = originOf(url);
    if (!origin) return false;
    if (this.opts.devUrl && origin === originOf(this.opts.devUrl)) return true;
    return origin === `${APP_SCHEME}://${APP_HOST}`;
  }

  private webPreferences(): Electron.WebPreferences {
    // app.exit() in the constructor is not synchronous: no preload window in the meantime.
    if (packagedDebugSwitch()) throw new Error('debugging switch in a packaged build');
    return {
      preload: this.opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // Never in a packaged build, whatever the environment says (the fuses close NODE_OPTIONS
      // and --inspect; an env-var DevTools switch would be the same kind of backdoor).
      devTools: !app.isPackaged && (Boolean(this.opts.devUrl) || process.env.WICABY_DEVTOOLS === '1'),
    };
  }

  private harden(win: BrowserWindow): void {
    const wc = win.webContents;
    wc.on('will-navigate', (event, url) => {
      if (!this.isAppUrl(url)) {
        event.preventDefault();
        log.warn(`blocked navigation to ${url}`);
      }
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('render-process-gone', (_e, details) => log.error(`renderer gone: ${details.reason}`));
    wc.on('console-message', (event) => {
      // A map tile address is a place (photos spec §6.1): never logged.
      if (event.level === 'error') log.warn(`renderer: ${event.message.replace(/wicaby-media:\/\/tile\/[^\s'")]*/g, 'wicaby-media://tile/…')}`);
    });
  }

  // hidden: started by the login item (--hidden); the tray icon brings it up.
  createMain(hidden = false): BrowserWindow {
    const saved = this.opts.settings.value.window;
    const bounds = saved.bounds ? this.placeOnScreen(saved.bounds) : { width: 1440, height: 900 };
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 960,
      minHeight: 600,
      show: false,
      title: 'Wicaby',
      icon: this.opts.icon,
      backgroundColor: this.mica ? '#00000000' : INK,
      backgroundMaterial: this.mica ? 'mica' : undefined,
      titleBarStyle: 'hidden',
      // Native caption buttons keep Snap Layouts on hover over maximize.
      titleBarOverlay: { color: '#00000000', symbolColor: '#ece8e1', height: 44 },
      webPreferences: this.webPreferences(),
    });
    this.harden(win);
    // The constructor sizes the window with the primary display's scale; setting the
    // bounds again once it exists lands it at the right size on a monitor with another DPI.
    if ('x' in bounds) win.setBounds(bounds);
    this.inTray = hidden;
    // maximize() would show a hidden window: defer it to the first show.
    if (saved.maximized) {
      if (hidden) win.once('show', () => win.maximize());
      else win.maximize();
    }
    win.once('ready-to-show', () => {
      if (!hidden) win.show();
    });

    const sendState = () => this.send(win, Channels.windowState, this.windowState(win));
    for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur'] as const) {
      win.on(ev as 'maximize', sendState);
    }
    win.on('close', (event) => {
      if (!this.quitting && this.opts.settings.value.windows.closeToTray) {
        event.preventDefault();
        this.hideMain();
        this.onHiddenToTray?.();
      } else {
        this.saveBounds(win);
      }
    });
    // A monitor unplugged or rescaled: bring the window back if it is now off screen.
    const keepOnScreen = () => {
      if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
      const b = win.getBounds();
      if (!this.visibleOnSomeDisplay(b)) win.setBounds(this.placeOnScreen(b));
    };
    screen.on('display-removed', keepOnScreen);
    screen.on('display-metrics-changed', keepOnScreen);
    win.once('closed', () => {
      screen.off('display-removed', keepOnScreen);
      screen.off('display-metrics-changed', keepOnScreen);
    });
    win.on('closed', () => {
      this.main = null;
      // A lone mini player would keep the app alive with no way back.
      if (this.mini && !this.mini.isDestroyed()) this.mini.destroy();
    });
    void win.loadURL(this.url('/'));
    this.main = win;
    return win;
  }

  // Enough of the window and its title bar is on some monitor to grab it.
  private visibleOnSomeDisplay(b: Rectangle): boolean {
    return screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y < a.y + a.height - 50 && b.y + 40 > a.y;
    });
  }

  // Saved bounds as is when still reachable; otherwise (monitor removed, layout or
  // DPI changed) the same size, shrunk if needed, centred on the nearest monitor.
  private placeOnScreen(b: Rectangle): Rectangle {
    if (this.visibleOnSomeDisplay(b)) return b;
    const a = screen.getDisplayMatching(b).workArea;
    const width = Math.min(b.width, a.width);
    const height = Math.min(b.height, a.height);
    return { x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2), width, height };
  }

  hideMain(): void {
    const win = this.main;
    if (!win || win.isDestroyed()) return;
    this.saveBounds(win);
    this.inTray = true;
    win.hide();
  }

  // A hidden window keeps the bounds saved when it was hidden.
  private saveBounds(win: BrowserWindow): void {
    if (win.isVisible()) this.opts.settings.update({ window: { bounds: win.getNormalBounds(), maximized: win.isMaximized() } });
  }

  // The app's "reduce motion" or the system's: player transitions become instant switches.
  reducedMotion(): boolean {
    return this.opts.settings.value.ui.reduceMotion || systemPreferences.getAnimationSettings().prefersReducedMotion;
  }

  windowState(win: BrowserWindow): WindowState {
    return { maximized: win.isMaximized(), fullscreen: win.isFullScreen(), focused: win.isFocused() };
  }

  createPlaybackWindows(fullscreen: boolean): PlaybackWindows {
    if (this.playback) return this.playback;
    const ref = this.main && !this.main.isMinimized() ? this.main.getBounds() : screen.getPrimaryDisplay().workArea;
    // mpv renders into a child of this window (--wid). Chromium composites the
    // window's own surface above child windows, so it must be a transparent
    // BaseWindow (no web contents); any opaque background hides the video.
    const video = new BaseWindow({
      ...ref,
      show: false,
      frame: false,
      transparent: true,
      title: 'Wicaby',
      icon: this.opts.icon,
      backgroundColor: '#00000000',
    });
    const osd = new BrowserWindow({
      ...ref,
      parent: video,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      skipTaskbar: true,
      resizable: true,
      title: 'Wicaby',
      webPreferences: this.webPreferences(),
    });
    this.harden(osd);
    void osd.loadURL(this.url('/osd', { osd: '1' }));
    // The constructors size windows with the primary display's scale; set again so both land
    // at the same pixel size on a monitor with another DPI (see createMain).
    osd.setBounds(ref);
    video.setBounds(ref);

    // The OSD is the window the user drags and snaps; the video follows it at once, then
    // settlePlayback re-checks once the moves, DPI changes and display changes are over.
    const follow = () => {
      if (video.isDestroyed() || osd.isDestroyed()) return;
      video.setBounds(osd.getBounds());
      this.settlePlayback();
    };
    osd.on('move', follow);
    osd.on('resize', follow);
    const displayChanged = () => this.settlePlayback();
    for (const ev of ['display-metrics-changed', 'display-added', 'display-removed'] as const) screen.on(ev as 'display-added', displayChanged);
    video.once('closed', () => {
      for (const ev of ['display-metrics-changed', 'display-added', 'display-removed'] as const) screen.off(ev as 'display-added', displayChanged);
    });
    // Alt+Tab or a taskbar click activates the video window; hand focus to the OSD.
    video.on('focus', () => {
      if (!osd.isDestroyed()) osd.focus();
    });
    video.on('restore', () => {
      if (!osd.isDestroyed()) osd.focus();
    });

    this.playback = { video, osd };
    video.once('closed', () => {
      if (this.playback?.video === video) this.playback = null;
    });

    if (fullscreen) this.setPlaybackFullscreen(true);
    // Opening: the OSD's veil takes the page to black first (OsdWindow.svelte), then mpv's window comes in under
    // it and the main window hides; the veil lifts on the first frame. Instant with reduced motion.
    const reduced = this.reducedMotion();
    this.playbackLeaving = false;
    const swap = () => {
      if (this.playback?.video !== video || this.playbackLeaving) return;
      video.showInactive();
      this.main?.hide();
    };
    if (reduced) video.showInactive();
    osd.once('ready-to-show', () => {
      osd.show();
      osd.focus();
      if (reduced) return swap();
      const veiled = osd.webContents.executeJavaScript('window.__wicabyVeil?.()').catch(() => undefined);
      void Promise.race([veiled, sleep(EXIT_FADE_MS * 3)]).then(swap);
    });
    return this.playback;
  }

  private savedPlaybackBounds: Rectangle | null = null;
  private playbackLeaving = false;
  private settleTimer: NodeJS.Timeout | null = null;
  // Set by the mpv player: checks that mpv's own child window followed the video window.
  onPlaybackSettled: (() => void) | null = null;

  // 150 ms after the last move, resize or display change. A window that crossed to a monitor
  // with another DPI is rescaled by Windows (WM_DPICHANGED) after our setBounds, the OSD and the
  // video each on their own, and a fullscreen pair keeps covering the old size when the display
  // changes under it (resolution, scale, HDR or refresh switch). Put both back on one rectangle.
  private settlePlayback(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      const pw = this.playback;
      if (!pw || pw.osd.isDestroyed() || pw.video.isDestroyed() || pw.video.isMinimized()) return;
      const target = this.savedPlaybackBounds ? screen.getDisplayMatching(pw.osd.getBounds()).bounds : pw.osd.getBounds();
      // DIP rounding can leave 1 px between what was asked and what getBounds reports.
      const off = (b: Rectangle) => Math.max(Math.abs(b.x - target.x), Math.abs(b.y - target.y), Math.abs(b.width - target.width), Math.abs(b.height - target.height)) > 1;
      for (const win of [pw.osd, pw.video]) {
        if (!off(win.getBounds())) continue;
        log.info(`playback window off by more than 1 px, set again: ${JSON.stringify(win.getBounds())} → ${JSON.stringify(target)}`);
        win.setBounds(target);
      }
      this.onPlaybackSettled?.();
    }, 150);
  }

  // Manual fullscreen: both windows cover the display. Windows hides the
  // taskbar because the focused window spans the monitor.
  setPlaybackFullscreen(value: boolean): void {
    const pw = this.playback;
    if (!pw) return;
    if (value && this.pipBounds) this.togglePlaybackPip();
    if (value) {
      if (!this.savedPlaybackBounds) this.savedPlaybackBounds = pw.osd.getBounds();
      const display = screen.getDisplayMatching(pw.osd.getBounds());
      pw.osd.setBounds(display.bounds);
      pw.video.setBounds(display.bounds);
    } else if (this.savedPlaybackBounds) {
      pw.osd.setBounds(this.savedPlaybackBounds);
      pw.video.setBounds(this.savedPlaybackBounds);
      this.savedPlaybackBounds = null;
    }
    this.settlePlayback();
  }

  isPlaybackFullscreen(): boolean {
    return this.savedPlaybackBounds !== null;
  }

  // The pair's bounds before picture-in-picture.
  private pipBounds: Rectangle | null = null;

  // Picture-in-picture (LT-23, §8.7): the pair becomes an always-on-top 16:9 mini window in the bottom-right
  // corner of the work area, or goes back. No --wid reparenting: mpv keeps rendering into the same window.
  togglePlaybackPip(): void {
    const pw = this.playback;
    if (!pw) return;
    const on = !this.pipBounds;
    if (on && this.savedPlaybackBounds) this.setPlaybackFullscreen(false);
    let target: Rectangle;
    if (on) {
      this.pipBounds = pw.osd.getBounds();
      const a = screen.getDisplayMatching(this.pipBounds).workArea;
      const width = Math.round(Math.min(480, a.width / 3));
      const height = Math.round((width * 9) / 16);
      target = { x: a.x + a.width - width - 16, y: a.y + a.height - height - 16, width, height };
    } else {
      target = this.pipBounds as Rectangle;
      this.pipBounds = null;
    }
    for (const win of [pw.video, pw.osd]) win.setAlwaysOnTop(on, 'floating');
    pw.osd.setBounds(target);
    pw.video.setBounds(target);
    this.settlePlayback();
  }

  isPlaybackPip(): boolean {
    return this.pipBounds !== null;
  }

  // Exit transition, once the OSD's veil is opaque: the main window shown without the focus, under the OSD, on
  // the pair's rectangle when the player is a plain window. Resolves once it painted a frame (500 ms at most).
  async showMainUnder(): Promise<void> {
    const main = this.main;
    const pw = this.playback;
    // An opening that has not swapped the windows yet (stopped within a few hundred ms) never will.
    this.playbackLeaving = true;
    if (!main || main.isDestroyed() || this.inTray) return;
    if (!main.isVisible()) {
      if (pw && !this.savedPlaybackBounds && !this.pipBounds && !pw.video.isMinimized() && !main.isMaximized() && !main.isFullScreen()) main.setBounds(pw.osd.getBounds());
      // A maximized main window comes up above the pair, inactive or not: the OSD floats over it until it hides.
      if (pw && !pw.osd.isDestroyed()) pw.osd.setAlwaysOnTop(true);
      main.showInactive();
    }
    const painted = main.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
    await Promise.race([painted.catch(() => undefined), sleep(500)]);
  }

  // End of the exit transition: the main window takes the focus and the pair goes (destroyed afterwards).
  hidePlayback(): void {
    const pw = this.playback;
    if (this.main && !this.main.isDestroyed() && this.main.isVisible()) this.main.focus();
    if (!pw) return;
    for (const win of [pw.osd, pw.video]) if (!win.isDestroyed()) win.hide();
  }

  destroyPlaybackWindows(): void {
    const pw = this.playback;
    this.playback = null;
    this.savedPlaybackBounds = null;
    this.pipBounds = null;
    this.onPlaybackSettled = null;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (!pw) return;
    // Playback started from the tray (remote "Play on") ends back in the tray. After an exit transition the
    // main window is already up, and the user may have moved on to another app since.
    if (this.main && !this.main.isDestroyed() && !this.inTray && !this.main.isVisible()) {
      this.main.show();
      this.main.focus();
    }
    if (!pw.osd.isDestroyed()) pw.osd.destroy();
    if (!pw.video.isDestroyed()) pw.video.destroy();
  }

  send(win: BrowserWindow | null | undefined, channel: string, payload: unknown): void {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }

  broadcast(channel: string, payload: unknown): void {
    this.send(this.main, channel, payload);
    if (this.playback) this.send(this.playback.osd, channel, payload);
    this.send(this.mini, channel, payload);
  }

  // Music mini player (music-spec §4.4, MU-10): 360 × 96, frameless, always on top, where it was last left. Opening
  // it sends the main window to the tray when "Réduire dans la barre" is on; closing it brings the main window back.
  mini: BrowserWindow | null = null;

  openMini(): void {
    if (this.mini && !this.mini.isDestroyed()) return this.mini.show();
    const size = { width: 360, height: 96 };
    const at = this.opts.settings.value.window.mini;
    const saved = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { ...size, x: Math.round(at.x), y: Math.round(at.y) } : null;
    const a = screen.getPrimaryDisplay().workArea;
    const bounds = saved && this.visibleOnSomeDisplay(saved) ? saved : { ...size, x: a.x + a.width - size.width - 24, y: a.y + a.height - size.height - 24 };
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      title: 'Wicaby',
      icon: this.opts.icon,
      backgroundColor: this.mica ? '#00000000' : INK,
      backgroundMaterial: this.mica ? 'acrylic' : undefined,
      webPreferences: this.webPreferences(),
    });
    this.harden(win);
    win.setAlwaysOnTop(true, 'floating');
    win.setBounds(bounds);
    const save = () => {
      if (win.isDestroyed()) return;
      const { x, y } = win.getBounds();
      this.opts.settings.update({ window: { mini: { x, y } } });
    };
    win.on('moved', save);
    win.on('close', save);
    win.on('closed', () => {
      if (this.mini === win) this.mini = null;
      // The main window comes back, unless the app is quitting.
      if (!this.quitting) this.focusMain();
    });
    win.once('ready-to-show', () => win.show());
    void win.loadURL(this.url('/mini', { mini: '1' }));
    this.mini = win;
    if (this.opts.settings.value.windows.closeToTray) this.hideMain();
  }

  closeMini(): void {
    if (this.mini && !this.mini.isDestroyed()) this.mini.close();
  }

  toggleMini(): void {
    if (this.mini && !this.mini.isDestroyed()) this.closeMini();
    else this.openMini();
  }

  focusMain(): void {
    const win = this.main;
    if (!win) return;
    this.inTray = false;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}
