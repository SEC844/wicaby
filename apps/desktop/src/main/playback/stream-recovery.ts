// Network recovery and the direct-play fallback for VOD (plezy-triage WP2/WP9, desktop). A stream that
// errors, ends well before its duration or stalls is reopened at its position with backoff while the
// server is probed (connection-manager recheck(), which re-picks the address); OSD "Reconnexion…",
// with Retry after a minute. A direct-play file that fails to open or decode while the server answers
// is retried once with server transcoding. Pure: the service supplies everything through the host.

export type FailureReason = 'error' | 'decode' | 'stall' | 'early-eof';

export interface RecoveryHost<T> {
  // What to reopen (a snapshot of the item playing), or null when there is nothing to recover
  // (live TV, a downloaded file, nothing playing): the failure is then final.
  target(): T | null;
  itemId(target: T): string;
  // The stream was played directly (no server transcode).
  direct(target: T): boolean;
  // The server answers (after re-picking its address when needed).
  reachable(target: T): Promise<boolean>;
  // Reopens at the current position (transcoding once transcodes() says so). Rejects when it failed before
  // the player got a URL.
  reload(target: T): Promise<void>;
  fail(message: string): void;
  // The OSD's reconnecting state changed.
  publish(): void;
  notice(key: string): void;
  log(message: string): void;
}

export class StreamRecovery<T> {
  // Seconds between attempts, the last one repeating.
  static backoffMs = [2000, 4000, 8000, 15_000, 30_000];
  static retryAfterMs = 60_000;
  static giveUpMs = 300_000;
  static stallMs = 20_000;
  // Reopens that failed while the server answered: the file itself, not the network.
  static maxOpenFailures = 3;
  // A new loss this soon after the stream came back is a relapse of the same one (a corrupt or truncated
  // file, a stream that stalls right after each reopen); maxOpenFailures relapses in a row end the item.
  static relapseMs = 60_000;

  private item: string | null = null;
  private transcodeFor: string | null = null;
  private started = false;
  private loadPosition = 0;
  private lastProgress = Date.now();
  private progressKey = '';
  private since = 0;
  private attempts = 0;
  private openFailures = 0;
  private backAt = 0;
  private relapses = 0;
  private recovering: T | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private deciding = false;

  constructor(private readonly host: RecoveryHost<T>) {}

  // The OSD banner: since when, and whether Retry shows.
  get state(): { since: number; retry: boolean } | undefined {
    return this.since ? { since: this.since, retry: Date.now() - this.since >= StreamRecovery.retryAfterMs } : undefined;
  }

  // startItem asks before PlaybackInfo: this item fell back to a server transcode.
  transcodes(itemId: string): boolean {
    return this.transcodeFor === itemId;
  }

  // A load begins (a new item, or a reload of this one).
  onLoad(itemId: string, startMs: number): void {
    if (itemId !== this.item) {
      this.reset();
      this.item = itemId;
    }
    this.started = false;
    this.loadPosition = startMs;
    this.touch();
  }

  // First picture (mpv), or time moving while not buffering (both players).
  onStarted(): void {
    this.started = true;
    this.touch();
    if (!this.since) return;
    this.host.log(`stream back after ${this.attempts} attempt(s)`);
    this.endRecovery();
    this.backAt = Date.now();
    this.host.publish();
  }

  onTime(t: { positionMs: number; buffering: boolean; cacheBytes?: number }): void {
    if (!t.buffering && Math.abs(t.positionMs - this.loadPosition) >= 500) this.onStarted();
    const key = `${t.buffering}/${Math.round(t.positionMs / 1000)}/${t.cacheBytes ?? ''}`;
    if (key !== this.progressKey || !t.buffering) {
      this.progressKey = key;
      this.touch();
    }
  }

  // Polled every few seconds while playing: buffering with nothing moving (position, cache) after the first
  // picture is a stall. Before it, a slow server transcode may legitimately take longer than stallMs.
  tick(buffering: boolean, now = Date.now()): void {
    if (!buffering || !this.started || this.deciding || this.timer) {
      if (!buffering || !this.started) this.lastProgress = now;
      return;
    }
    if (now - this.lastProgress >= StreamRecovery.stallMs) {
      this.lastProgress = now;
      void this.onFailure('', 'stall');
    }
  }

  async onFailure(message: string, reason: FailureReason): Promise<void> {
    if (this.recovering) {
      // A reopen that did not take: try again, unless the file is what fails.
      if (!this.started) this.openFailures++;
      return this.schedule(message);
    }
    if (this.deciding) return;
    const target = this.host.target();
    if (!target) return this.host.fail(message);
    this.deciding = true;
    try {
      const up = await this.host.reachable(target);
      // Stopped, or another item started, while probing.
      if (this.host.target() === null || this.item !== this.host.itemId(target)) return;
      const openFailed = (reason === 'error' || reason === 'decode') && (reason === 'decode' || !this.started);
      if (up && openFailed) {
        if (!this.host.direct(target) || this.transcodeFor === this.host.itemId(target)) return this.host.fail(message);
        this.transcodeFor = this.host.itemId(target);
        this.host.log(`direct play failed (${message}): retrying with server transcoding`);
        this.host.notice('player.notice.transcodeFallback');
        await this.host.reload(target).catch((err: unknown) => this.host.fail(err instanceof Error ? err.message : String(err)));
        return;
      }
      const relapse = this.backAt > 0 && Date.now() - this.backAt < StreamRecovery.relapseMs;
      this.relapses = relapse ? this.relapses + 1 : 0;
      if (this.relapses >= StreamRecovery.maxOpenFailures) {
        this.host.log(`stream lost (${reason}) again ${this.relapses} time(s) right after coming back: giving up`);
        return this.host.fail(message);
      }
      this.host.log(`stream lost (${reason}${message ? `: ${message}` : ''}), server ${up ? 'answers' : 'unreachable'}: reconnecting`);
      this.recovering = target;
      this.since = Date.now();
      this.attempts = 0;
      this.openFailures = 0;
      this.retryTimer = setTimeout(() => this.host.publish(), StreamRecovery.retryAfterMs);
      this.host.publish();
      this.schedule(message, up && !relapse ? 0 : undefined);
    } finally {
      this.deciding = false;
    }
  }

  // The OSD's Retry: an attempt now, and a fresh window before giving up.
  retry(): void {
    if (!this.recovering) return;
    this.since = Date.now();
    this.openFailures = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.host.publish(), StreamRecovery.retryAfterMs);
    this.host.publish();
    this.clearTimer();
    void this.attempt();
  }

  // Stop, or the user moved on.
  reset(): void {
    this.endRecovery();
    this.item = null;
    this.transcodeFor = null;
    this.started = false;
    this.backAt = 0;
    this.relapses = 0;
  }

  private schedule(message: string, delayMs?: number): void {
    if (!this.recovering) return;
    if (this.openFailures >= StreamRecovery.maxOpenFailures || Date.now() - this.since >= StreamRecovery.giveUpMs) {
      this.host.log(`giving up after ${this.attempts} attempt(s)`);
      this.endRecovery();
      return this.host.fail(message);
    }
    this.clearTimer();
    const steps = StreamRecovery.backoffMs;
    const wait = delayMs ?? steps[Math.min(this.attempts, steps.length - 1)];
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.attempt();
    }, wait);
  }

  private async attempt(): Promise<void> {
    const target = this.recovering;
    if (!target) return;
    this.attempts++;
    const up = await this.host.reachable(target);
    if (this.recovering !== target) return;
    if (!up) return this.schedule('');
    this.started = false;
    this.touch();
    try {
      await this.host.reload(target);
    } catch (err) {
      if (this.recovering !== target) return;
      this.openFailures++;
      this.schedule(err instanceof Error ? err.message : String(err));
    }
  }

  private touch(): void {
    this.lastProgress = Date.now();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private endRecovery(): void {
    this.clearTimer();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.recovering = null;
    this.since = 0;
  }
}
