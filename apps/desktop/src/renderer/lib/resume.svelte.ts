// Settings > Lecture > "Reprise": what the quick play buttons (cards, hero, episode list)
// do with a saved position. The item page keeps its explicit "Reprendre" / "Depuis le
// début" buttons. Returns the ticks to start at, undefined for the beginning, or null
// when the viewer dismissed the question.
import { TICKS_PER_MS } from '../../shared/contract';
import { settings } from './stores.svelte';

export const resumePrompt = $state<{ open: boolean; name: string; ticks: number }>({ open: false, name: '', ticks: 0 });
let answer: ((choice: number | undefined | null) => void) | null = null;

export function resumeAt(ticks: number | undefined, name: string): Promise<number | undefined | null> {
  // Under 5 s there is nothing worth resuming (main also rewinds 5 s).
  if (!ticks || ticks / TICKS_PER_MS < 5000) return Promise.resolve(ticks || undefined);
  const mode = settings.value?.playback.resume ?? 'resume';
  if (mode === 'resume') return Promise.resolve(ticks);
  if (mode === 'start') return Promise.resolve(undefined);
  answer?.(null);
  resumePrompt.name = name;
  resumePrompt.ticks = ticks;
  resumePrompt.open = true;
  return new Promise((resolve) => (answer = resolve));
}

export function answerResume(choice: 'resume' | 'start' | null): void {
  const ticks = resumePrompt.ticks;
  resumePrompt.open = false;
  const done = answer;
  answer = null;
  done?.(choice === 'resume' ? ticks : choice === 'start' ? undefined : null);
}
