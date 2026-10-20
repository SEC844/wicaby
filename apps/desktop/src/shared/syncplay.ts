// Jellyfin SyncPlay clock and scheduling (main/playback/syncplay.ts), pure so syncplay-check.mjs can run it.
// Times are epoch ms; offset = server clock - local clock, as jellyfin-web's TimeSyncCore measures it.

export interface ClockSample {
  offsetMs: number;
  pingMs: number;
}

// One /GetUtcTime round trip: sent and received are local, reception and transmission the server's.
export function measure(sentMs: number, receptionMs: number, transmissionMs: number, receivedMs: number): ClockSample {
  return {
    offsetMs: (receptionMs - sentMs + (transmissionMs - receivedMs)) / 2,
    pingMs: Math.max(0, receivedMs - sentMs - (transmissionMs - receptionMs)),
  };
}

// Keeps the last 8 samples and trusts the one with the shortest round trip (the least queueing noise).
export class TimeSync {
  private samples: ClockSample[] = [];

  add(s: ClockSample): void {
    this.samples = [...this.samples, s].slice(-8);
  }

  get ready(): boolean {
    return this.samples.length > 0;
  }

  private best(): ClockSample {
    return this.samples.reduce((a, b) => (b.pingMs < a.pingMs ? b : a), { offsetMs: 0, pingMs: Infinity });
  }

  get offsetMs(): number {
    return this.ready ? this.best().offsetMs : 0;
  }

  get pingMs(): number {
    return this.ready ? this.best().pingMs : 0;
  }

  serverNow(localNow = Date.now()): number {
    return localNow + this.offsetMs;
  }

  // How long to wait locally before a command stamped `whenServer` is due (0 = already late).
  delayUntil(whenServer: number, localNow = Date.now()): number {
    return Math.max(0, whenServer - this.offsetMs - localNow);
  }

  reset(): void {
    this.samples = [];
  }
}

export interface GroupCommand {
  command: 'Unpause' | 'Pause' | 'Seek' | 'Stop';
  whenMs: number; // server time
  positionMs: number;
}

// Where the group is now: a playing group moved on since When, a paused one stays put.
export function groupPositionMs(cmd: GroupCommand, serverNow: number): number {
  return cmd.command === 'Unpause' ? cmd.positionMs + Math.max(0, serverNow - cmd.whenMs) : cmd.positionMs;
}

// The position to seek to when this player drifted more than thresholdMs from a playing group, else null.
// shortcut: seek-only correction, no speed nudging; add a rate nudge under ~2 s if users notice the jumps.
export function driftTarget(cmd: GroupCommand | null, positionMs: number, serverNow: number, thresholdMs = 2000): number | null {
  if (cmd?.command !== 'Unpause' || serverNow < cmd.whenMs) return null;
  const target = groupPositionMs(cmd, serverNow);
  return Math.abs(target - positionMs) > thresholdMs ? target : null;
}
