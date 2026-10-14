// The desktop update check, mirrored from main (features/app-updates.ts): the notice and Settings > About read it.
import type { AppUpdateState } from '../../shared/contract';
import { w } from './bridge';

export const appUpdate = $state<{ value: AppUpdateState | null }>({ value: null });

export function initAppUpdate(): () => void {
  void w.updates.state().then((s) => (appUpdate.value ??= s));
  return w.updates.onState((s) => {
    appUpdate.value = s;
  });
}

export async function checkForUpdates(): Promise<void> {
  appUpdate.value = await w.updates.check();
}

export async function dismissUpdate(): Promise<void> {
  appUpdate.value = await w.updates.dismiss();
}
