// Live TV DisplayPreferences sync (spec §5.4, X-08 subset): the `wicaby-livetv` document per user
// and server, under client "wicaby" (never "emby").
//
// - Loaded on each Live TV open. Changes apply locally at once and are queued (last writer wins per
//   field); a write is debounced 2 s and serialized through one queue.
// - Every write is a read-modify-write: GET the document, merge only the changed lt.* fields
//   (chunk keys a shorter value no longer uses are deleted), POST the whole DTO back with Id and
//   Client in the body (Emby reads the client from the DTO).
// - Refuse to write while the document failed to load: changes wait in memory until a read succeeds.
//
// Plain erasable TypeScript: the store injects the request runner.
import { displayPrefs, saveDisplayPrefs } from '../../../shared/livetv/dialect';
import type { Req } from '../../../shared/livetv/dialect';
import type { ServerKind } from '../../../shared/livetv/model';
import { decodePrefs, defaultPrefs, loaded, planWrite, queueChange, syncInit } from '../../../shared/livetv/prefs';
import type { LivePrefs, PrefsSync } from '../../../shared/livetv/prefs';

export const PREFS_DEBOUNCE_MS = 2_000;

export type PrefsRunner = (req: Req) => Promise<unknown>;

export interface PrefsCounters {
  loads: number;
  loadFailures: number;
  writes: number;
  writeFailures: number;
  refused: number; // flushes skipped because the document is not loaded
}

export class PrefsSyncer {
  prefs: LivePrefs = defaultPrefs();
  state: PrefsSync = syncInit();
  readonly counters: PrefsCounters = { loads: 0, loadFailures: 0, writes: 0, writeFailures: 0, refused: 0 };
  onChange: (() => void) | null = null;
  onWriteFailed: (() => void) | null = null;
  private kind: ServerKind;
  private userId: string;
  private run: PrefsRunner;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private loading: Promise<boolean> | null = null;
  private local: Partial<LivePrefs> = {}; // device copies that win until the next sync (recents)

  constructor(kind: ServerKind, userId: string, run: PrefsRunner) {
    this.kind = kind;
    this.userId = userId;
    this.run = run;
  }

  get loadState(): PrefsSync['load'] {
    return this.state.load;
  }

  // A field whose device copy wins over the server's until it is written (lt.recents, §5.4).
  setLocal(changes: Partial<LivePrefs>): void {
    this.local = { ...this.local, ...changes };
    this.prefs = { ...this.prefs, ...changes };
  }

  // The last document this device read (IndexedDB), shown until the server answers. It never makes
  // the document "loaded": writes stay refused until a real read succeeds.
  seed(cached: LivePrefs): void {
    if (this.state.load === 'ok') return;
    this.prefs = { ...cached, ...this.local, ...this.state.queued };
    this.onChange?.();
  }

  // GET the document. The queued changes stay on top of what the server holds.
  load(): Promise<boolean> {
    if (this.loading) return this.loading;
    this.counters.loads++;
    this.loading = this.run(displayPrefs(this.kind, { userId: this.userId }))
      .then(
        (dto) => {
          const custom = ((dto as Record<string, unknown> | undefined)?.CustomPrefs ?? {}) as Record<string, string>;
          this.state = loaded(this.state, true);
          this.prefs = { ...decodePrefs(custom), ...this.local, ...this.state.queued };
          if (Object.keys(this.state.queued).length) this.schedule();
          return true;
        },
        () => {
          this.counters.loadFailures++;
          this.state = loaded(this.state, false);
          return false;
        },
      )
      .finally(() => {
        this.loading = null;
        this.onChange?.();
      });
    return this.loading;
  }

  // Applied locally now; written to the server after the debounce (or held while not loaded).
  set(changes: Partial<LivePrefs>): void {
    for (const k of Object.keys(changes) as (keyof LivePrefs)[]) delete this.local[k];
    this.prefs = { ...this.prefs, ...changes };
    this.state = queueChange(this.state, changes);
    this.onChange?.();
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, PREFS_DEBOUNCE_MS);
  }

  // Serialized: one write at a time, each one a fresh read-modify-write.
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.writeOnce());
    return this.chain;
  }

  private async writeOnce(): Promise<void> {
    if (!Object.keys(this.state.queued).length) return;
    if (this.state.load !== 'ok') {
      // Refuse to write an empty or unknown document; try to read it again first.
      this.counters.refused++;
      if (!(await this.load())) return;
    }
    let server: Record<string, unknown>;
    try {
      server = ((await this.run(displayPrefs(this.kind, { userId: this.userId }))) ?? {}) as Record<string, unknown>;
    } catch {
      this.counters.writeFailures++;
      this.state = loaded(this.state, false);
      this.onWriteFailed?.();
      return;
    }
    const plan = planWrite(this.state, server);
    if (!plan) return;
    const sent = this.state.queued;
    this.state = plan.next;
    try {
      await this.run(saveDisplayPrefs(this.kind, { userId: this.userId, body: plan.body }));
      this.counters.writes++;
    } catch {
      this.counters.writeFailures++;
      // Put the changes back under anything queued meanwhile, and try again on the next change or open.
      this.state = { ...this.state, queued: { ...sent, ...this.state.queued } };
      this.onWriteFailed?.();
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
