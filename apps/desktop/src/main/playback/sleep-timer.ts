// X-04 sleep timer of the playback service (state.sleep). The check runs every second in main,
// so it survives the OSD window.
import type { PlaybackState } from '../../shared/contract';
import type { Current } from './playback-model';

const SLEEP_PROMPT_MS = 30_000;

// What the playback service lends the timer (its own fields, read and written in place).
export interface SleepHost {
  readonly state: PlaybackState;
  readonly current: Current | null;
  publish(immediate?: boolean): void;
  stop(): Promise<void>;
  // No answer on VOD: pause and let the display sleep.
  pause(): void;
}

export class SleepTimer {
  // The 1 s check, the live programme it waits for, and whether "end of video" fired at the real
  // end (Continue then starts the next item).
  private timer: NodeJS.Timeout | null = null;
  private watch: { channelId?: string; programId?: string } = {};
  atEnd = false;

  constructor(private readonly host: SleepHost) {}

  // minutes: a duration, 'eov' (end of this video, or of this programme in live), or null to cancel.
  set(minutes: number | 'eov' | null, publish = true): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.atEnd = false;
    this.watch = {};
    const valid = minutes === 'eov' || (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 && minutes <= 1440);
    this.host.state.sleep = valid ? { minutes, endsAt: minutes === 'eov' ? undefined : Date.now() + minutes * 60_000 } : undefined;
    if (valid) this.timer = setInterval(() => this.tick(), 1000);
    if (valid) this.tick();
    if (publish) this.host.publish(true);
  }

  private tick(): void {
    const sl = this.host.state.sleep;
    if (!sl) return;
    if (sl.promptUntil) {
      if (Date.now() >= sl.promptUntil) void this.expire();
      return;
    }
    const live = this.host.current?.live ? this.host.state.live : undefined;
    if (sl.minutes === 'eov' && live) {
      // "Fin de ce programme": the airing programme's end, re-read after a zap and when the guide moves it.
      const now = live.now;
      const w = this.watch;
      if (live.channel.id !== w.channelId || !w.programId) {
        this.watch = { channelId: live.channel.id, programId: now?.id };
        sl.endsAt = now?.end;
      } else if (now?.id === w.programId) {
        sl.endsAt = now.end;
      } else if (now) {
        sl.endsAt = 0; // the programme changed: its boundary has passed
      }
    }
    if (sl.endsAt !== undefined && Date.now() >= sl.endsAt) this.fire();
  }

  // "Still watching?" for 30 s (the OSD shows it from state.sleep.promptUntil).
  fire(): void {
    const sl = this.host.state.sleep;
    if (!sl) return;
    sl.promptUntil = Date.now() + SLEEP_PROMPT_MS;
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000);
    this.host.publish(true);
  }

  // No answer: VOD pauses; live stops the stream and releases the tuner (Stopped report).
  private async expire(): Promise<void> {
    const live = Boolean(this.host.current?.live);
    this.set(null);
    if (live) return this.host.stop();
    this.host.pause();
  }
}
