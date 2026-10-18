// Web TV entry (docs/webtv.md). window.wicaby must exist before any desktop renderer module loads (lib/bridge.ts
// reads it once), so the renderer is imported dynamically, after it is set.
import './polyfills';
import { aspectRatioFallback } from './aspect';
import { createWebBridge } from './bridge';
import { DEMO_ADDRESS, DEMO_ID, demoAvailable, loadDemo } from './demo';
import { initTv } from './tv';
import './tv.css';

const { bridge, mediaBase, playing } = createWebBridge();
window.wicaby = bridge;

window.addEventListener('error', (e) => bridge.app.log('error', `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => bridge.app.log('warn', `unhandled: ${String((e.reason as Error | undefined)?.stack ?? e.reason)}`));
initTv({ playing, command: (c) => void bridge.playback.command(c) });

async function start(): Promise<void> {
  await import('@fontsource-variable/geist');
  await import('../../desktop/src/renderer/app.css');
  const [{ mount }, { setMediaBase }, { default: App }] = await Promise.all([
    import('svelte'),
    import('../../desktop/src/renderer/lib/images'),
    import('../../desktop/src/renderer/App.svelte'),
  ]);
  // Images come straight from the server (Emby and Jellyfin serve them without a token), or the demo's files.
  setMediaBase(mediaBase);
  if (demoAvailable) await startDemo();
  mount(App, { target: document.getElementById('app')! });
  // ?aspect-fallback forces it in a modern browser (tools/checks/webtv-cdp.mjs).
  aspectRatioFallback(new URLSearchParams(location.search).has('aspect-fallback'));
}

// Pages demo: the first visit opens signed in to the demo server, with a "Demo" badge and a way to a real server.
async function startDemo(): Promise<void> {
  const FLAG = 'wicaby.demo.started';
  let first = false;
  try {
    first = !localStorage.getItem(FLAG);
    localStorage.setItem(FLAG, '1');
  } catch {
    first = true;
  }
  if (first && (await bridge.servers.list()).length === 0) {
    try {
      const c = await loadDemo();
      await bridge.servers.add(DEMO_ADDRESS);
      await bridge.session.login(c.user.Name, '', DEMO_ID);
    } catch (err) {
      bridge.app.log('warn', `demo: ${String(err)}`);
    }
  }
  const [{ t }, { navigate }] = await Promise.all([
    import('../../desktop/src/renderer/lib/i18n.svelte'),
    import('../../desktop/src/renderer/lib/router.svelte'),
  ]);
  const bar = document.createElement('div');
  bar.className = 'webtv-demo';
  bar.setAttribute('role', 'status');
  const badge = document.createElement('strong');
  badge.textContent = t('errors.web.demo');
  const connect = document.createElement('button');
  connect.type = 'button';
  connect.textContent = t('errors.web.demoConnect');
  connect.addEventListener('click', () => navigate('/servers'));
  // TV look: the remote's arrows stay on the content (Settings > Server adds one too).
  if (document.documentElement.dataset.tv) connect.tabIndex = -1;
  bar.append(badge, connect);
  document.body.append(bar);
  // Shown while the demo is the current server, hidden over the player.
  let server: string | undefined;
  const show = () => document.documentElement.classList.toggle('webtv-demo-on', !(bar.hidden = server !== DEMO_ID || playing()));
  const onSession = (s: { server?: { id: string } }) => ((server = s.server?.id), show());
  bridge.session.onChange(onSession);
  bridge.playback.onState(show);
  onSession(await bridge.session.get());
}

void start();
