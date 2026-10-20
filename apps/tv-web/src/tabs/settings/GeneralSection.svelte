<script lang="ts">
  // Android TV GeneralSection (Settings.kt): the language and "Control from other devices". Not here: the launcher's
  // Wicaby rows (an Android TV launcher feature) and the first-run wizard.
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import { choice, toggle } from '../../components/settings/rows';
  import { setLanguage, t } from '../../lib/i18n.svelte';
  import { settings } from '../../lib/settings.svelte';

  const LANGS = ['auto', 'fr', 'en'] as const;
</script>

<SettingsGroup title={t('group_language')}>
  <!-- The language names stay in their own language, so either reader can find theirs. -->
  <SettingRow
    {...choice(t('language'), [t('language_system'), t('language_fr'), t('language_en')], LANGS.indexOf(settings.language.value), (i) => {
      settings.language.value = LANGS[i];
      setLanguage(LANGS[i]);
    })}
  />
</SettingsGroup>
<SettingsGroup title={t('group_other_devices')} hint={t('settings_remote_control_summary')}>
  <SettingRow {...toggle(t('settings_remote_control'), settings.remoteControl)} />
</SettingsGroup>
