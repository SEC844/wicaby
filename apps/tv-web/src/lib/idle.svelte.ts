// The remote's last press (Chrome.kt Idle): the in-app screensaver starts after Settings > Appearance's delay without
// one, and the now-playing screen turns ambient after 2 minutes.
export const idle = $state({ last: Date.now(), saver: false });

export function poke(): void {
  idle.last = Date.now();
}
