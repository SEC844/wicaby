import { app, nativeImage, type BaseWindow, type JumpListCategory, type JumpListItem, type NativeImage } from 'electron';
import { logger } from '../core/log';
import { onLanguageChange, t } from '../i18n';

const log = logger.scope('taskbar');

// Taskbar integration: thumbnail toolbar during playback, aggregated download
// progress, and jump list tasks. Emby Theater had none of these.

type Shape = (x: number, y: number) => boolean;

// 16x16 glyphs rasterised at 2x so they stay crisp on high-DPI taskbars.
function glyph(shape: Shape): NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // 4x supersampling for soft edges.
      let hits = 0;
      for (const [ox, oy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]) {
        if (shape((px + ox) / 2, (py + oy) / 2)) hits++;
      }
      const i = (py * size + px) * 4;
      // BGRA, premultiplied white.
      const a = Math.round((hits / 4) * 255);
      buf[i] = a;
      buf[i + 1] = a;
      buf[i + 2] = a;
      buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

const triangleRight = (x0: number, x1: number) => (x: number, y: number) => x >= x0 && x <= x1 && Math.abs(y - 8) <= ((x - x0) / (x1 - x0)) * -5.5 + 5.5;
const triangleLeft = (x0: number, x1: number) => (x: number, y: number) => x >= x0 && x <= x1 && Math.abs(y - 8) <= ((x - x0) / (x1 - x0)) * 5.5;
const rect = (x0: number, y0: number, x1: number, y1: number) => (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const any =
  (...shapes: Shape[]) =>
  (x: number, y: number) =>
    shapes.some((s) => s(x, y));

let icons: Record<'play' | 'pause' | 'next' | 'prev', NativeImage> | null = null;

function getIcons() {
  icons ??= {
    play: glyph(triangleRight(4.5, 12.5)),
    pause: glyph(any(rect(4, 2.5, 6.6, 13.5), rect(9.4, 2.5, 12, 13.5))),
    next: glyph(any(triangleRight(2.5, 10), rect(10.6, 2.5, 12.8, 13.5))),
    prev: glyph(any(triangleLeft(6, 13.5), rect(3.2, 2.5, 5.4, 13.5))),
  };
  return icons;
}

export interface ThumbHandlers {
  toggle: () => void;
  next: () => void;
  previous: () => void;
}

// Last buttons shown, so a language switch can re-label them in place.
let thumbar: Parameters<typeof setPlaybackThumbar> | null = null;
onLanguageChange(() => {
  if (thumbar) setPlaybackThumbar(...thumbar);
});

export function setPlaybackThumbar(win: BaseWindow | null, paused: boolean, hasPrev: boolean, hasNext: boolean, h: ThumbHandlers): void {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return;
  thumbar = [win, paused, hasPrev, hasNext, h];
  const i = getIcons();
  win.setThumbarButtons([
    { tooltip: t('main.thumbar.previous'), icon: i.prev, click: h.previous, flags: hasPrev ? [] : ['disabled'] },
    { tooltip: paused ? t('main.thumbar.play') : t('main.thumbar.pause'), icon: paused ? i.play : i.pause, click: h.toggle },
    { tooltip: t('main.thumbar.next'), icon: i.next, click: h.next, flags: hasNext ? [] : ['disabled'] },
  ]);
}

export function clearThumbar(win: BaseWindow | null): void {
  if (thumbar?.[0] === win) thumbar = null;
  if (win && !win.isDestroyed() && process.platform === 'win32') win.setThumbarButtons([]);
}

export function setTaskbarProgress(win: BaseWindow | null, fraction: number | null, mode: 'normal' | 'paused' | 'error' = 'normal'): void {
  if (!win || win.isDestroyed()) return;
  if (fraction === null) win.setProgressBar(-1);
  else win.setProgressBar(Math.max(0, Math.min(1, fraction)), { mode });
}

let jumpListFollows = false;
let continueEntries: { title: string; route: string }[] = [];
const removedArgs = new Set<string>();

// Tasks, plus a "Continue watching" category when there is something to resume.
export function installJumpList(entries = continueEntries): void {
  if (process.platform !== 'win32') return;
  continueEntries = entries;
  // In development the exe is electron.exe and needs the app path first.
  const prefix = app.isPackaged ? '' : `"${app.getAppPath()}" `;
  const task = (title: string, route: string, description: string): JumpListItem => ({
    type: 'task',
    program: process.execPath,
    args: `${prefix}--wicaby-nav=${route}`,
    iconPath: process.execPath,
    iconIndex: 0,
    title,
    description,
  });
  const categories: JumpListCategory[] = [
    {
      type: 'tasks',
      items: [
        task(t('main.jumpList.home'), '/home', t('main.jumpList.homeDesc')),
        task(t('main.jumpList.search'), '/search', t('main.jumpList.searchDesc')),
        task(t('main.jumpList.downloads'), '/downloads', t('main.jumpList.downloadsDesc')),
        task(t('main.jumpList.settings'), '/settings', t('main.jumpList.settingsDesc')),
      ],
    },
  ];
  // Windows hides the whole custom category if it gets back an item the user removed from it.
  // It only reports removals since the previous setJumpList, so they are kept for the session.
  // shortcut: forgotten on restart, persist them if removed entries come back too often.
  for (const i of app.getJumpListSettings().removedItems) if (i.args) removedArgs.add(i.args);
  const resume = entries.filter((e) => !removedArgs.has(`${prefix}--wicaby-nav=${e.route}`));
  if (resume.length) {
    categories.unshift({ type: 'custom', name: t('main.jumpList.continue'), items: resume.map((e) => task(e.title, e.route, t('main.jumpList.continueDesc'))) });
  }
  const result = app.setJumpList(categories);
  if (result !== 'ok') log.warn(`jump list: ${result}`);
  if (!jumpListFollows) {
    jumpListFollows = true;
    onLanguageChange(() => installJumpList());
  }
}
