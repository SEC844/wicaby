// The /Sessions/Playing* reports' queue (Android core SessionReporter): the reports leave in order (a Stopped before
// the next Playing), one at a time; a Progress still waiting is replaced by a newer one, so a slow server never piles
// them up.
class Reporter {
  private chain: Promise<unknown> = Promise.resolve();
  private pendingProgress: (() => Promise<unknown>) | null = null;

  send(job: () => Promise<unknown>): Promise<boolean> {
    this.pendingProgress = null;
    const run = this.chain.then(job).then(
      () => true,
      () => false,
    );
    this.chain = run;
    return run;
  }

  latest(job: () => Promise<unknown>): void {
    const queued = this.pendingProgress !== null;
    this.pendingProgress = job;
    if (queued) return;
    this.chain = this.chain.then(() => {
      const j = this.pendingProgress;
      this.pendingProgress = null;
      return j?.().catch(() => {});
    });
  }
}

// One queue for the app: the video player and the music session report as the same DeviceId, so the server must get
// their reports in the order they were made.
export const reporter = new Reporter();
