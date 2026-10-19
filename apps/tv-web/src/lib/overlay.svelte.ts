// One dialog at a time over the screens (Android TV LocalOverlay + TvAlert): a title, an optional message and actions.
// Focus is trapped inside it (data-focus-trap) and comes back to where it was when it closes.
import { focused, setFocus } from './focus';

export interface AlertAction {
  label: string;
  destructive?: boolean;
  run: () => void;
}

export interface Alert {
  title: string;
  message?: string;
  actions: AlertAction[];
  focusIndex?: number;
  // A picker (Android TvPicker): the chosen action gets a check and the focus.
  selected?: number;
  // A link to open on a phone: shown as a QR code with the link below it (Android TrailerQr).
  qr?: string;
}

export const overlay = $state<{ alert: Alert | null }>({ alert: null });
let returnTo: HTMLElement | null = null;

export function showAlert(alert: Alert): void {
  returnTo = focused();
  overlay.alert = alert;
}

export function closeAlert(): void {
  overlay.alert = null;
  const el = returnTo;
  returnTo = null;
  requestAnimationFrame(() => {
    if (el && el.isConnected) setFocus(el);
  });
}
