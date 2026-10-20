// TP-10 "Who is watching?" (core Profiles.kt, Prefs): the accounts saved on this TV and their optional local PIN.
// At start the picker shows unless Settings > Accounts says to skip it and this TV has one account without a PIN.
// Wrong PINs: five at once, then a wait that doubles from 30 s up to an hour.
import { hashPin, pinMatches, pinWaitMs } from './pin';
import { prefs, type Session } from './session.svelte';
import { settings } from './settings.svelte';
import { load, save } from './storage';

interface PinEntry {
  hash: string;
  fails: number;
  lastFail: number;
}

const KEY = 'profile_pins';
const pins = $state<Record<string, PinEntry>>(load<Record<string, PinEntry>>(KEY, {}));
const keyOf = (s: Pick<Session, 'server' | 'userId'>) => `${s.server.id}|${s.userId}`;
const persist = () => save(KEY, $state.snapshot(pins));

export const hasPin = (s: Pick<Session, 'server' | 'userId'>): boolean => !!pins[keyOf(s)];

export async function setPin(s: Session, pin: string | null): Promise<void> {
  const k = keyOf(s);
  if (pin === null) delete pins[k];
  else pins[k] = { hash: await hashPin(pin), fails: 0, lastFail: 0 };
  persist();
}

// One try: ok, or wrong with how long the next try must wait (0: at once).
export async function checkPin(s: Session, pin: string): Promise<{ ok: boolean; waitMs: number }> {
  const e = pins[keyOf(s)];
  if (!e) return { ok: true, waitMs: 0 };
  const wait = e.lastFail + pinWaitMs(e.fails) - Date.now();
  if (wait > 0) return { ok: false, waitMs: wait };
  if (await pinMatches(pin, e.hash)) {
    e.fails = 0;
    persist();
    return { ok: true, waitMs: 0 };
  }
  e.fails++;
  e.lastFail = Date.now();
  persist();
  return { ok: false, waitMs: pinWaitMs(e.fails) };
}

// A signed-out profile forgets its PIN too.
export function forgetPin(s: Pick<Session, 'server' | 'userId'>): void {
  delete pins[keyOf(s)];
  persist();
}

// Straight to Home at start: the setting is on and this TV has one account on the server, without a PIN.
export function skipPicker(session: Session): boolean {
  const saved = prefs.profiles.filter((p) => p.server.id === session.server.id);
  const one = saved.length <= 1 && (!saved[0] || saved[0].userId === session.userId);
  return settings.skipPicker.value && one && !hasPin(session);
}
