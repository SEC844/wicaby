// How this TV presents itself to the server (dashboard "Devices", session list, "Play on").
import { platform } from '../platform';
import { load, save } from './storage';

declare const webapis: { productinfo?: { getRealModel?(): string; getModel?(): string } } | undefined;

export const CLIENT = 'Wicaby';
export const VERSION: string = __APP_VERSION__;

// Stable per install, like the Android app's device id.
export const deviceId: string = (() => {
  let id = load<string>('deviceId', '');
  if (!id) {
    const r = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    id = `${r()}${r()}-${r()}-${r()}-${r()}-${r()}${r()}${r()}`;
    save('deviceId', id);
  }
  return id;
})();

export const deviceName: string = (() => {
  if (platform === 'tizen') {
    try {
      const model = typeof webapis !== 'undefined' ? webapis?.productinfo?.getRealModel?.() ?? webapis?.productinfo?.getModel?.() : '';
      return model ? `Samsung ${model}` : 'Samsung TV';
    } catch {
      return 'Samsung TV';
    }
  }
  if (platform === 'webos') return 'LG TV';
  return 'TV';
})();
