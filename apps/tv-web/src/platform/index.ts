import { AvPlayer, avplayAvailable } from './avplay';
import { HtmlPlayer } from './html-player';
import type { VideoPlayer } from './player';

// The shipped targets are Tizen and webOS. 'dev' is a desktop Chromium: npm run dev and the smoke tests only.
export type PlatformName = 'tizen' | 'webos' | 'dev';

declare const tizen:
  | {
      tvinputdevice: { registerKeyBatch(keys: string[], ok?: () => void, fail?: (e: unknown) => void): void };
      application: { getCurrentApplication(): { exit(): void } };
    }
  | undefined;

export const platform: PlatformName =
  typeof tizen !== 'undefined' ? 'tizen' : /Web0S|webOS/i.test(navigator.userAgent) ? 'webos' : 'dev';

// Keys Tizen only delivers once registered (arrows, OK and Back always arrive).
const TIZEN_KEYS = [
  'MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
  'MediaTrackNext', 'MediaTrackPrevious', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
  'Info', 'ChannelUp', 'ChannelDown',
];

// Tizen's webapis (AVPlay, product info) load from a path its web runtime resolves; elsewhere there is nothing to load.
function loadWebapis(): Promise<void> {
  if (platform !== 'tizen') return Promise.resolve();
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = '$WEBAPIS/webapis/webapis.js';
    s.onload = s.onerror = () => resolve();
    document.head.appendChild(s);
  });
}

export async function initPlatform(): Promise<void> {
  await loadWebapis();
  if (platform === 'tizen') tizen!.tvinputdevice.registerKeyBatch(TIZEN_KEYS);
}

export function exitApp(): void {
  if (platform === 'tizen') tizen!.application.getCurrentApplication().exit();
  else if (platform === 'webos') {
    // webOS leaves an app through its system Back (back to the launcher); window.close() is the fallback.
    const palm = (window as { PalmSystem?: { platformBack?(): void } }).PalmSystem;
    if (palm?.platformBack) palm.platformBack();
    else window.close();
  }
}

// A link in another app of the TV (a remote trailer in YouTube): Tizen's app control "view", webOS's YouTube app
// through Luna. false when the TV has no app for it (the caller shows the link as a QR code instead).
export function openUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      if (platform === 'tizen') {
        const t = tizen as unknown as {
          ApplicationControl: new (op: string, uri: string) => unknown;
          application: { launchAppControl(c: unknown, id: string | null, ok: () => void, fail: () => void): void };
        };
        t.application.launchAppControl(new t.ApplicationControl('http://tizen.org/appcontrol/operation/view', url), null, () => resolve(true), () => resolve(false));
        return;
      }
      const Bridge = (window as { PalmServiceBridge?: new () => { onservicecallback?: (r: string) => void; call(uri: string, params: string): void } }).PalmServiceBridge;
      if (platform === 'webos' && Bridge && /youtu\.?be/i.test(url)) {
        const b = new Bridge();
        b.onservicecallback = (r) => resolve(/"returnValue"\s*:\s*true/.test(r));
        b.call('luna://com.webos.applicationManager/launch', JSON.stringify({ id: 'youtube.leanback.v4', params: { contentTarget: url } }));
        setTimeout(() => resolve(false), 4000);
        return;
      }
    } catch {
      // No app control: the QR code.
    }
    resolve(false);
  });
}

export function createPlayer(video: HTMLVideoElement): VideoPlayer {
  return platform === 'tizen' && avplayAvailable() ? new AvPlayer() : new HtmlPlayer(video);
}

// The connection playback starts on (Settings > Playback caps each one). Tizen tells; webOS and a browser do not
// expose it to a web app, so they count as Ethernet, the higher cap.
declare const webapis: { network?: { getActiveConnectionType?(): number } } | undefined;

export function onWifi(): boolean {
  try {
    // Tizen: 0 disconnected, 1 Wi-Fi, 2 cellular, 3 Ethernet.
    return platform === 'tizen' && typeof webapis !== 'undefined' && webapis?.network?.getActiveConnectionType?.() === 1;
  } catch {
    return false;
  }
}
