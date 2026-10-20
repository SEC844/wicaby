// B10 (Android core HomeRefresh): when the rows on show reload by themselves. Coming back to the app (from another
// app, the TV's home): at once. A LibraryChanged or UserDataChanged from the server: 2 s after the first one of a
// burst and at most every 30 s (another device playing sends one per progress report). And every 5 min. Not while a
// player or the reader is in front: the rows reload when it closes (changed() after the Stopped report).
const TYPES = ['LibraryChanged', 'UserDataChanged'];
export const DEBOUNCE_MS = 2_000;
export const MIN_GAP_MS = 30_000;
export const PERIOD_MS = 5 * 60_000;
export const TICK_MS = 1_000;

export class HomeRefresh {
  private last: number;
  private changedAt: number | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.last = now();
  }

  onMessage(type: string): void {
    if (TYPES.includes(type) && this.changedAt === null) this.changedAt = this.now();
  }

  // Checked every second while the rows are on show: true when they should reload now.
  due(): boolean {
    const t = this.now();
    const c = this.changedAt;
    const due = (c !== null && t - c >= DEBOUNCE_MS && t - this.last >= MIN_GAP_MS) || t - this.last >= PERIOD_MS;
    if (due) this.done();
    return due;
  }

  done(): void {
    this.last = this.now();
    this.changedAt = null;
  }
}
