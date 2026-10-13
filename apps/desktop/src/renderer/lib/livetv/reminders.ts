// Live TV reminders (livetv-spec-final.md §9.6): kept and fired by main (main/features/reminders.ts).
import type { LiveReminder } from '../../../shared/contract';
import { w } from '../bridge';
import { fmt, t } from '../i18n.svelte';
import { errorMessage, toast } from '../stores.svelte';
import { storeFor } from './store.svelte';

// Sets or clears a programme's reminder and says which. Null when it failed.
export async function toggleReminder(r: LiveReminder): Promise<boolean | null> {
  try {
    const store = storeFor(r.serverId);
    // Programme times are server times: main fires on the client clock plus this skew (§21.4).
    const on = await w.reminders.toggle({ ...r, skewMs: store?.caps.clockSkewMs ?? 0 });
    if (store) store.setReminded(r.programId, on);
    toast('success', on ? t('livetv.toasts.reminderSet', { time: fmt.time(r.start) }) : t('livetv.toasts.reminderCanceled'));
    return on;
  } catch (err) {
    toast('error', errorMessage(err));
    return null;
  }
}
