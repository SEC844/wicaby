<script lang="ts">
  // Android TV PlaybackSection (Settings.kt), minus what these TVs do not let an app control: the display mode (the
  // set matches frame rate itself), picture-in-picture, and the "away from home" bitrate (it applies to Remote
  // Access, which these TVs cannot run).
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import { choice, choiceOf, confirm, toggle } from '../../components/settings/rows';
  import type { Api } from '../../lib/api';
  import { t } from '../../lib/i18n.svelte';
  import { clearRemembered } from '../../lib/remembered';
  import { settings } from '../../lib/settings.svelte';
  import { showToast } from '../../lib/toast.svelte';

  let { api }: { api: Api } = $props();

  const MBPS = [0, 120, 80, 60, 40, 20, 10, 8, 4, 2];
  const SECS = [5, 10, 15, 20, 30];
  const mbpsLabels = $derived(MBPS.map((m) => (m === 0 ? t('settings_bitrate_auto') : t('mbps', m))));
  const mbpsRow = (label: string, s: typeof settings.mbpsWifi) => choice(label, mbpsLabels, Math.max(0, MBPS.indexOf(s.value)), (i) => (s.value = MBPS[i]));
  const skipOptions = $derived([t('skip_ask'), t('skip_auto'), t('skip_off')]);
  const scopes = $derived([t('scope_off'), t('scope_global'), t('scope_library'), t('scope_title')]);
</script>

<SettingsGroup title={t('group_quality')} hint={t('bitrate_hint')}>
  <SettingRow {...mbpsRow(t('net_ethernet'), settings.mbpsEthernet)} />
  <SettingRow {...mbpsRow(t('net_wifi'), settings.mbpsWifi)} />
</SettingsGroup>
<SettingsGroup title={t('group_resume')}>
  <SettingRow {...choiceOf(t('resume_mode'), [t('resume_auto'), t('resume_ask'), t('resume_start')], settings.resume)} />
  <SettingRow {...toggle(t('autoplay_next'), settings.autoplayNext)} />
  {#if settings.autoplayNext.value}
    <SettingRow {...choice(t('countdown'), SECS.map((s) => t('seconds', s)), Math.max(0, SECS.indexOf(settings.countdown.value)), (i) => (settings.countdown.value = SECS[i]))} />
  {/if}
</SettingsGroup>
<SettingsGroup title={t('group_skip')}>
  <SettingRow {...choiceOf(t('skip_intro_mode'), skipOptions, settings.skipIntro)} />
  <!-- Recaps, previews and commercials are Jellyfin media segments: nothing to set on Emby. -->
  {#if !api.isEmby}
    <SettingRow {...choiceOf(t('segment_recap'), skipOptions, settings.skipRecap)} />
    <SettingRow {...choiceOf(t('segment_preview'), skipOptions, settings.skipPreview)} />
    <SettingRow {...choiceOf(t('segment_commercial'), skipOptions, settings.skipCommercial)} />
  {/if}
</SettingsGroup>
<SettingsGroup title={t('aniskip')} hint={t('aniskip_hint')}>
  <SettingRow {...toggle(t('aniskip'), settings.aniskip)} />
</SettingsGroup>
<!-- X-05: where speed and aspect are remembered. -->
<SettingsGroup title={t('remember_title')}>
  <SettingRow {...choiceOf(t('remember_speed'), scopes, settings.rememberSpeed)} />
  <SettingRow {...choiceOf(t('remember_aspect'), scopes, settings.rememberAspect)} />
  <SettingRow
    {...confirm(t('remember_clear'), t('confirm_clear'), () => {
      clearRemembered();
      showToast(t('remember_cleared'));
    })}
  />
</SettingsGroup>
