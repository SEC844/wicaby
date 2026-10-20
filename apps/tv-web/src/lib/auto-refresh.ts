// HomeRefresh at work (Android MainActivity: auto.run(Core.socketMessages) { Cache.changed() }).
import type { Api } from './api';
import { HomeRefresh, TICK_MS } from './home-refresh';
import { changed } from './load.svelte';
import { stack } from './nav.svelte';
import { ServerSocket } from './server-socket';

const FRONT = ['player', 'live', 'reader'];
const busy = (): boolean => FRONT.includes(stack[stack.length - 1]?.route.name ?? '');

// From the main screen's mount to its unmount (a sign-out, a server switch).
export function runHomeRefresh(api: Api): () => void {
  const r = new HomeRefresh();
  const socket = new ServerSocket(api, (type) => r.onMessage(type));
  socket.open();
  const tick = setInterval(() => {
    if (!document.hidden && !busy() && r.due()) changed();
  }, TICK_MS);
  const onVisibility = (): void => {
    if (document.hidden || busy()) return;
    r.done();
    changed();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    clearInterval(tick);
    document.removeEventListener('visibilitychange', onVisibility);
    socket.close();
  };
}
