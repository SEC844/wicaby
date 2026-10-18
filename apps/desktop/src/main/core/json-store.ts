import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log';

const log = logger.scope('store');
const isPlain = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v);

// Small JSON document persisted with write-to-temp + rename so a crash never
// leaves a half-written file. Writes are coalesced.
export class JsonStore<T> {
  private data: T;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly filePath: string,
    defaults: T,
    private readonly delayMs = 250,
  ) {
    this.data = defaults;
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return; // Missing file: start from defaults.
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPlain(defaults) && !isPlain(parsed)) throw new Error('not an object');
      this.data = parsed as T;
    } catch (err) {
      // Corrupt: kept aside for a look, since the next write replaces the file with defaults.
      const aside = `${filePath}.corrupt-${Date.now()}`;
      log.warn(`${path.basename(filePath)} unreadable, kept as ${path.basename(aside)}`, err);
      try {
        fs.renameSync(filePath, aside);
      } catch {
        // Left in place: the next write replaces it.
      }
    }
  }

  get value(): T {
    return this.data;
  }

  set(next: T): void {
    this.data = next;
    this.schedule();
  }

  update(fn: (current: T) => T | void): void {
    const result = fn(this.data);
    if (result !== undefined) this.data = result;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      // Disk full, file locked by an antivirus...: thrown from a timer it would kill the main process. Tried again later.
      log.warn(`cannot write ${path.basename(this.filePath)}`, err);
      this.timer = setTimeout(() => this.flush(), 5000).unref();
    }
  }
}
