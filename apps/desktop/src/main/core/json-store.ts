import fs from 'node:fs';
import path from 'node:path';

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
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      this.data = JSON.parse(raw) as T;
    } catch {
      // Missing or corrupt file: start from defaults.
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
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
