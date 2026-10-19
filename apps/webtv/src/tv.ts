// The TV around the page: which platform, the remote's keys, the look that suits a TV's browser.
import type { PlaybackCommand } from '../../desktop/src/shared/contract';

const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
export const platform: 'webos' | 'tizen' | 'browser' = /Web0S|webOS/i.test(ua) ? 'webos' : /Tizen/i.test(ua) ? 'tizen' : 'browser';
export const onTv = platform !== 'browser';

// Remote keyCodes (LG webOS and Samsung Tizen agree except Back and Play/Pause) to playback commands.
export const MEDIA_KEYS: Record<number, PlaybackCommand> = {
  415: { type: 'resume' }, // Play
  19: { type: 'pause' }, // Pause
  10252: { type: 'toggle-pause' }, // Samsung Play/Pause
  413: { type: 'stop' }, // Stop
  10233: { type: 'next' }, // Samsung track next
  10232: { type: 'previous' }, // Samsung track previous
};
// FF/RW go to the OSD's own shortcut rows: its flash, wake-up, "Sauts" step and merged presses.
const OSD_KEYS: Record<number, string> = { 417: 'MediaFastForward', 412: 'MediaRewind' };
const BACK = new Set([461, 10009]);
// Tizen sends media keys to the page only once registered (tvinputdevice); webOS sends them anyway.
const TIZEN_KEYS = ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'MediaFastForward', 'MediaRewind', 'MediaTrackNext', 'MediaTrackPrevious'];

interface TizenGlobal {
  tvinputdevice?: { registerKey(name: string): void; registerKeyBatch?(names: string[]): void };
  application?: { getCurrentApplication(): { exit(): void } };
}

export function exitApp(): void {
  const w = window as { tizen?: TizenGlobal; PalmSystem?: { platformBack?(): void } };
  try {
    if (w.tizen?.application) return w.tizen.application.getCurrentApplication().exit();
    if (w.PalmSystem?.platformBack) return w.PalmSystem.platformBack();
  } catch {
    // Fall through to window.close().
  }
  window.close();
}

export function initTv(opts: { playing: () => boolean; command: (c: PlaybackCommand) => void }): void {
  const root = document.documentElement;
  // ?tv=webos (or tizen) gives a desktop browser the TV look, for the demo and tools/checks/webtv-cdp.mjs.
  const look = onTv ? platform : new URLSearchParams(location.search).get('tv');
  if (look !== null) root.dataset.tv = look || 'tv';
  // Flex gap is Chromium 84 (webOS 6 has 79): scripts/legacy-css.mjs adds margins under this class.
  const probe = document.createElement('div');
  probe.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
  probe.append(document.createElement('div'), document.createElement('div'));
  root.append(probe);
  root.classList.toggle('no-flex-gap', probe.scrollHeight !== 1);
  probe.remove();
  if (platform === 'tizen') {
    const tz = (window as { tizen?: TizenGlobal }).tizen;
    try {
      if (tz?.tvinputdevice?.registerKeyBatch) tz.tvinputdevice.registerKeyBatch(TIZEN_KEYS);
      else for (const k of TIZEN_KEYS) tz?.tvinputdevice?.registerKey(k);
    } catch {
      // A key this model lacks: the others still work.
    }
  }
  window.addEventListener(
    'keydown',
    (e) => {
      if (BACK.has(e.keyCode) && e.key !== 'BrowserBack') {
        // Pages, sheets and menus listen for BrowserBack; the player's OSD for Escape (close a panel, else stop).
        e.preventDefault();
        e.stopImmediatePropagation();
        // A held Back would otherwise close the panel, stop the film, pop every page and exit the app.
        if (e.repeat) return;
        const key = opts.playing() ? 'Escape' : 'BrowserBack';
        // Back on Home with nothing open leaves the app, as the TV makers' guidelines ask.
        const root = !opts.playing() && /^#?\/?(home)?$/.test(location.hash) && !document.activeElement?.closest('[role="dialog"], [role="menu"]');
        if (root && onTv) return exitApp();
        (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
        return;
      }
      const osdKey = OSD_KEYS[e.keyCode];
      if (osdKey && e.key !== osdKey && opts.playing()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: osdKey, code: osdKey, repeat: e.repeat, bubbles: true, cancelable: true }));
        return;
      }
      const cmd = MEDIA_KEYS[e.keyCode];
      if (cmd && opts.playing()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        opts.command(cmd);
      }
    },
    true,
  );
}
