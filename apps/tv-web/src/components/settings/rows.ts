// ToggleRow and ChoiceRow (Settings.kt) are SettingRows with a behaviour: helpers that build their props, so a
// section stays a flat list of <SettingRow {...toggle(...)} /> lines like the Kotlin.
import { t } from '../../lib/i18n.svelte';
import { showAlert } from '../../lib/overlay.svelte';
import type { Setting } from '../../lib/settings.svelte';

export function toggle(label: string, setting: Setting<boolean>) {
  return { label, value: t(setting.value ? 'on' : 'off'), onclick: () => (setting.value = !setting.value) };
}

// A row showing the chosen option; OK opens the picker with every option.
export function choice(label: string, options: string[], selected: number, onSelect: (i: number) => void) {
  return {
    label,
    value: options[selected] ?? '—',
    chevron: true,
    onclick: () => showAlert({ title: label, selected, actions: options.map((o, i) => ({ label: o, run: () => onSelect(i) })) }),
  };
}

// A choice stored as an index in a setting.
export function choiceOf(label: string, options: string[], setting: Setting<number>) {
  return choice(label, options, Math.max(0, setting.value), (i) => (setting.value = i));
}

// ConfirmRow: a destructive row; OK asks first (TvAlert), Cancel has the focus.
export function confirm(label: string, confirmLabel: string, run: () => void, value?: string) {
  return {
    label,
    value,
    onclick: () => showAlert({ title: label, actions: [{ label: confirmLabel, destructive: true, run }, { label: t('cancel'), run: () => {} }], focusIndex: 1 }),
  };
}
