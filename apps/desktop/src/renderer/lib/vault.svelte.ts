import { w } from './bridge';
import { linux } from './platform';
import { settings } from './stores.svelte';

// Without a keyring (safeStorage basic_text) main keeps credentials in memory, or on disk unencrypted if the
// user opted in under Privacy: the "encrypted by the system keyring" notes would then be false.
// Fixed for the session (the vault picks its backend at startup), so one query is enough.
let plain = $state(false);
if (linux) void w.app.info().then((i) => (plain = i.vaultPlainText), () => undefined);

/** i18n key of a "your secrets are encrypted" note: `win` on Windows, `lin` on Linux unless there is no keyring. */
export function vaultNoteKey(win: string, lin: string): string {
  if (!linux) return win;
  if (!plain) return lin;
  return settings.value?.system.plainTextVault ? 'settings.privacy.vaultDisk' : 'settings.privacy.vaultMemory';
}
