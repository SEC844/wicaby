import { AvPlayer, avplayAvailable } from './avplay';
import { HtmlPlayer } from './html-player';
import type { VideoPlayer } from './player';

export type PlatformName = 'tizen' | 'webos' | 'browser';

declare const tizen:
  | {
      tvinputdevice: { registerKeyBatch(keys: string[], ok?: () => void, fail?: (e: unknown) => void): void };
      application: { getCurrentApplication(): { exit(): void } };
    }
  | undefined;

export const platform: PlatformName =
  typeof tizen !== 'undefined' ? 'tizen' : /Web0S|webOS/i.test(navigator.userAgent) ? 'webos' : 'browser';

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
  else if (platform === 'webos') window.close();
}

export function createPlayer(video: HTMLVideoElement): VideoPlayer {
  return platform === 'tizen' && avplayAvailable() ? new AvPlayer() : new HtmlPlayer(video);
}
