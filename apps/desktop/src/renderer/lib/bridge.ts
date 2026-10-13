import type { WicabyBridge } from '../../shared/contract';

declare global {
  interface Window {
    wicaby: WicabyBridge;
  }
}

export const w: WicabyBridge = window.wicaby;
