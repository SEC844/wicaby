// PDF comics: pages are drawn by pdf.js (Apache-2.0) in a hidden, sandboxed renderer window
// (src/renderer/pdf.html), which reads the book through wicaby-media://comic-file with Range
// requests. Main gets JPEG pages back, so the reader, its thumbnails and the covers see PDF
// pages exactly as they see archive pages.
import { BrowserWindow } from 'electron';
import { logger } from '../core/log';

const log = logger.scope('comics');

// The window goes once nothing has been drawn for this long.
const IDLE_MS = 60_000;
// One page that takes longer than this is a broken or hostile file: the window is dropped.
const CALL_TIMEOUT = 60_000;

export interface PdfInfo {
  count: number;
  // Page sizes in points, page order.
  sizes: [number, number][];
}

export class PdfPages {
  private win: BrowserWindow | null = null;
  private loading: Promise<BrowserWindow> | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;
  // One call at a time: pdf.js holds one page bitmap at once, whatever the thumbnail strip asks for.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly pageUrl: () => string) {}

  info(url: string): Promise<PdfInfo> {
    return this.call(`wicabyPdf.info(${JSON.stringify(url)})`);
  }

  // Page [index] (from 0) drawn [height] pixels high, as JPEG.
  async render(url: string, index: number, height: number): Promise<Buffer> {
    const data = await this.call<Uint8Array>(`wicabyPdf.render(${JSON.stringify(url)}, ${Math.trunc(index)}, ${Math.trunc(height)})`);
    return Buffer.from(data);
  }

  private call<T>(expr: string): Promise<T> {
    const run = async (): Promise<T> => {
      clearTimeout(this.idle);
      const win = await this.window();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          win.webContents.executeJavaScript(expr, true) as Promise<T>,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              this.close();
              reject(new Error('PDF page timed out'));
            }, CALL_TIMEOUT);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        this.idle = setTimeout(() => this.close(), IDLE_MS);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private window(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed()) return Promise.resolve(this.win);
    this.loading ??= (async () => {
      const win = new BrowserWindow({
        show: false,
        width: 400,
        height: 400,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false },
      });
      const wc = win.webContents;
      wc.on('will-navigate', (e) => e.preventDefault());
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('render-process-gone', (_e, d) => {
        log.warn(`PDF renderer gone: ${d.reason}`);
        this.close();
      });
      try {
        await win.loadURL(this.pageUrl());
      } catch (err) {
        win.destroy();
        throw err;
      }
      this.win = win;
      return win;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  close(): void {
    clearTimeout(this.idle);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
