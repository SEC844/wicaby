// Keeps an admin view fresh: runs `refresh` now, then every `every()` ms while
// the window is visible, and right away when the server pushes one of `events`
// over its WebSocket (main forwards every server message to the renderer).
import { w } from '../lib/bridge';

export function live(serverId: string, refresh: () => unknown, every: () => number, events: string[] = []): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let soon: ReturnType<typeof setTimeout> | undefined;
  let first = true;

  // The first load always happens; after that, a hidden window stops polling.
  const run = async () => {
    if (stopped) return;
    clearTimeout(timer);
    if (first || !document.hidden) {
      first = false;
      try {
        await refresh();
      } catch {
        // The view shows its own error state; keep polling.
      }
    }
    if (!stopped) timer = setTimeout(run, every());
  };

  const off = w.events.onServerEvent((ev) => {
    if (ev.serverId && ev.serverId !== serverId) return;
    if (!events.includes(ev.type)) return;
    // Bursts (several sessions changing at once) collapse into one refresh.
    clearTimeout(soon);
    soon = setTimeout(run, 250);
  });
  const onVisible = () => {
    if (!document.hidden) void run();
  };
  document.addEventListener('visibilitychange', onVisible);
  void run();

  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(soon);
    off();
    document.removeEventListener('visibilitychange', onVisible);
  };
}

// Server ticks (100 ns) to milliseconds.
export const ticksToMs = (ticks: number | undefined) => (ticks ?? 0) / 10_000;
