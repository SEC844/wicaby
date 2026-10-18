<script lang="ts">
  // Android TV AboutSection (Settings.kt): version, licences of what the app ships, and this device. The decoder list
  // (Android's DeviceCaps dump) joins with the capability probe of the player (M2).
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { VERSION, deviceName } from '../../lib/identity';
  import { platform } from '../../platform';

  const engine = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '?';
  // Proper names and licence identifiers stay as they are in every language.
  const system = platform === 'tizen' ? 'Tizen' : platform === 'webos' ? 'webOS' : 'Chromium';
</script>

<SettingsGroup>
  <SettingRow label={t('app_name')} value={VERSION} />
</SettingsGroup>

<SettingsGroup title={t('group_licences')} hint={t('plex_tv_not_affiliated')}>
  <SettingRow label={t('licence_geist')} value="SIL OFL 1.1" />
  <SettingRow label="Svelte" value="MIT" />
</SettingsGroup>

<SettingsGroup title={t('group_device')}>
  <SettingRow label={t('device_model')} value={deviceName} />
  <SettingRow label={system} value={`Chromium ${engine}`} mono />
</SettingsGroup>
