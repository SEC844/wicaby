// X-04 sleep timer (Android core player/SleepTimer.kt, feature-specs.md §4): one for the app, so it survives episode
// changes. The player calls check() once a second: PROMPT shows "Still watching?", EXPIRE pauses. "End of this
// video" fires from atEnd() instead, and the player then neither autoplays nor shows up next.
export const PROMPT_MS = 30_000;
export const EXTEND_MIN = 15;
export const SLEEP_MINUTES = [5, 10, 15, 30, 45, 60, 90, 120];

// minutes null: end of this video, endsAt unset then; promptUntil once it fired.
export interface SleepState {
  minutes: number | null;
  endsAt: number | null;
  promptUntil: number | null;
}

export const sleep = $state<{ state: SleepState | null }>({ state: null });

export function startSleep(minutes: number | null, now = Date.now()): void {
  sleep.state = { minutes, endsAt: minutes === null ? null : now + minutes * 60_000, promptUntil: null };
}

export function cancelSleep(): void {
  sleep.state = null;
}

// "+15 min" while a timer runs.
export function extendSleep(now = Date.now()): void {
  const s = sleep.state;
  if (!s || s.endsAt === null) return;
  sleep.state = { ...s, endsAt: Math.max(s.endsAt, now) + EXTEND_MIN * 60_000, promptUntil: null };
}

// "Continue" (or Back) on the prompt: the same duration again.
export function restartSleep(now = Date.now()): void {
  if (sleep.state) startSleep(sleep.state.minutes, now);
}

export const endOfVideo = (): boolean => !!sleep.state && sleep.state.minutes === null && sleep.state.promptUntil === null;

export function checkSleep(now = Date.now(), promptMs = PROMPT_MS): 'none' | 'prompt' | 'expire' {
  const s = sleep.state;
  if (!s) return 'none';
  if (s.promptUntil !== null) {
    if (now < s.promptUntil) return 'none';
    sleep.state = null;
    return 'expire';
  }
  if (s.endsAt === null || now < s.endsAt) return 'none';
  sleep.state = { ...s, promptUntil: now + promptMs };
  return 'prompt';
}

// The item ended: true when "end of this video" was set, which now prompts instead of going on.
export function sleepAtEnd(now = Date.now(), promptMs = PROMPT_MS): boolean {
  if (!endOfVideo()) return false;
  sleep.state = { ...sleep.state!, promptUntil: now + promptMs };
  return true;
}
