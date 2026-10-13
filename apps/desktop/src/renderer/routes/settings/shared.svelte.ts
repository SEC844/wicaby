// Shared by the Settings shell (routes/Settings.svelte) and its panes (routes/settings/*Pane.svelte).
import type { Accent, AppInfo, AudioDevice, DeepPartial, Settings, StorageUsage } from '../../../shared/contract';
import { w } from '../../lib/bridge';
import { t } from '../../lib/i18n.svelte';
import { errorMessage, settings, toast, updateSettings } from '../../lib/stores.svelte';

// What main reports, loaded per visit of the page: the search filter re-runs when any of it changes.
export class SettingsData {
  info = $state<AppInfo | null>(null);
  // ---- Audio output devices (mpv) ----
  devices = $state<AudioDevice[] | null>(null);
  devicesLoading = $state(false);
  // ---- Storage ----
  storage = $state<StorageUsage | null>(null);

  refreshInfo = async (): Promise<void> => {
    this.info = await w.app.info().catch(() => null);
  };

  loadDevices = async (): Promise<void> => {
    if (this.devicesLoading) return;
    this.devicesLoading = true;
    try {
      this.devices = await w.settings.audioDevices();
    } catch (err) {
      this.devices = [];
      toast('error', errorMessage(err));
    } finally {
      this.devicesLoading = false;
    }
  };

  loadStorage = async (): Promise<void> => {
    this.storage = await w.app.storage().catch(() => null);
  };
}

export async function set(patch: DeepPartial<Settings>): Promise<void> {
  try {
    await updateSettings(patch);
  } catch (err) {
    toast('error', errorMessage(err));
  }
}

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('info', t('settings.page.copied'));
  } catch {
    // Clipboard permission denied: nothing to do.
  }
}

export function step(sec: number): string {
  return sec < 60 ? t('settings.units.seconds', { count: sec }) : t('settings.units.minutes', { count: sec / 60 });
}

// Option lists are $derived in the panes so their labels follow a language switch.
export const languageOptions = () => [
  { value: '', label: t('settings.audio.languages.server') },
  ...(['fre', 'eng', 'ger', 'spa', 'ita', 'jpn'] as const).map((v) => ({ value: v as string, label: t(`settings.audio.languages.${v}`) })),
];

// Hovering a colour previews it across the whole app; leaving restores the saved one.
export function previewAccent(a: Accent | null): void {
  document.documentElement.dataset.accent = a ?? settings.value?.ui.accent ?? 'blue';
}
