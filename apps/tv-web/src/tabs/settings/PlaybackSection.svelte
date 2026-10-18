<script lang="ts">
  // Android TV PlaybackSection (Settings.kt), minus what these TVs do not let an app control: the display mode (the
  // set matches frame rate itself), ExoPlayer's audio effects, picture-in-picture, and the "away from home" bitrate
  // (it applies to Remote Access, which these TVs cannot run).
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import { choice, choiceOf, toggle } from '../../components/settings/rows';
  import type { Api } from '../../lib/api';
  import { k, t } from '../../lib/i18n.svelte';
  import { PASS_CODECS, settings } from '../../lib/settings.svelte';

  let { api }: { api: Api } = $props();

  const MBPS = [0, 120, 80, 60, 40, 20, 10, 8, 4, 2];
  const LANGS: [string, string][] = [['', k('lang_auto')], ['fre', k('lang_fre')], ['eng', k('lang_eng')], ['jpn', k('lang_jpn')], ['ger', k('lang_ger')], ['spa', k('lang_spa')], ['ita', k('lang_ita')], ['kor', k('lang_kor')]];
  const SUB_MODES: [string, string][] = [['Default', k('sub_mode_default')], ['Smart', k('sub_mode_smart')], ['OnlyForced', k('sub_mode_forced')], ['Always', k('sub_mode_always')], ['None', k('sub_mode_none')]];
  const PASS_LABELS: Record<string, string> = { ac3: 'Dolby Digital (AC3)', eac3: 'Dolby Digital Plus (E-AC3)', dts: 'DTS, DTS-HD', truehd: 'Dolby TrueHD' };
  const SECS = [5, 10, 15, 20, 30];

  const mbpsLabels = $derived(MBPS.map((m) => (m === 0 ? t('settings_bitrate_auto') : t('mbps', m))));
  const mbpsRow = (label: string, s: typeof settings.mbpsWifi) =>
    choice(label, mbpsLabels, Math.max(0, MBPS.indexOf(s.value)), (i) => (s.value = MBPS[i]));
  const skipOptions = $derived([t('skip_ask'), t('skip_auto'), t('skip_off')]);
  const passOptions = $derived([t('pass_auto'), t('pass_on'), t('pass_off')]);
  const langLabels = $derived(LANGS.map(([, k]) => t(k)));

  // The user's server-side configuration: Emby and Jellyfin pick default streams from it (ServerConfig).
  let config = $state<Record<string, unknown> | null>(null);
  let failed = $state(false);
  $effect(() => {
    api.userConfiguration().then((c) => (config = c), () => {});
  });
  async function setConfig(key: string, value: string): Promise<void> {
    const old = config;
    if (!old) return;
    config = { ...old, [key]: value };
    try {
      await api.setUserConfiguration(config);
      failed = false;
    } catch {
      failed = true;
      config = old;
    }
  }
  const str = (key: string): string => String(config?.[key] ?? '');
  const langRow = (label: string, key: string) =>
    config === null
      ? { label, value: t('loading') }
      : choice(label, langLabels, Math.max(0, LANGS.findIndex(([code]) => code === str(key))), (i) => void setConfig(key, LANGS[i][0]));
</script>

<SettingsGroup title={t('group_quality')} hint={t('bitrate_hint')}>
  <SettingRow {...mbpsRow(t('net_ethernet'), settings.mbpsEthernet)} />
  <SettingRow {...mbpsRow(t('net_wifi'), settings.mbpsWifi)} />
</SettingsGroup>

<SettingsGroup title={t('group_resume')}>
  <SettingRow {...toggle(t('autoplay_next'), settings.autoplayNext)} />
  {#if settings.autoplayNext.value}
    <SettingRow {...choice(t('countdown'), SECS.map((s) => t('seconds', s)), Math.max(0, SECS.indexOf(settings.countdown.value)), (i) => (settings.countdown.value = SECS[i]))} />
  {/if}
  <SettingRow {...choiceOf(t('skip_intro_mode'), skipOptions, settings.skipIntro)} />
  <!-- Recaps, previews and commercials are Jellyfin media segments: nothing to set on Emby. -->
  {#if !api.isEmby}
    <SettingRow {...choiceOf(t('segment_recap'), skipOptions, settings.skipRecap)} />
    <SettingRow {...choiceOf(t('segment_preview'), skipOptions, settings.skipPreview)} />
    <SettingRow {...choiceOf(t('segment_commercial'), skipOptions, settings.skipCommercial)} />
  {/if}
  <SettingRow {...choiceOf(t('resume_mode'), [t('resume_auto'), t('resume_ask'), t('resume_start')], settings.resume)} />
</SettingsGroup>

<SettingsGroup title={t('section_audio')} hint={t('passthrough_hint')}>
  <SettingRow {...langRow(t('audio_language'), 'AudioLanguagePreference')} />
  {#each PASS_CODECS as codec (codec)}
    <SettingRow {...choiceOf(PASS_LABELS[codec], passOptions, settings.passthrough[codec])} />
  {/each}
</SettingsGroup>

<SettingsGroup title={t('section_subtitles')} hint={t(failed ? 'server_pref_failed' : 'subtitle_hint')}>
  <SettingRow {...langRow(t('subtitle_language'), 'SubtitleLanguagePreference')} />
  {#if config !== null}
    <SettingRow
      {...choice(t('subtitle_mode'), SUB_MODES.map(([, k]) => t(k)), Math.max(0, SUB_MODES.findIndex(([m]) => m === (str('SubtitleMode') || 'Default'))), (i) => void setConfig('SubtitleMode', SUB_MODES[i][0]))}
    />
  {/if}
  <SettingRow {...choiceOf(t('subtitle_size'), [t('size_small'), t('size_normal'), t('size_large'), t('size_xlarge')], settings.subtitleSize)} />
  <SettingRow {...choiceOf(t('subtitle_style'), [t('style_outline'), t('style_shadow'), t('style_box')], settings.subtitleStyle)} />
  <SettingRow {...choiceOf(t('subtitle_font'), ['Geist', t('font_system'), t('font_serif')], settings.subtitleFont)} />
  <SettingRow {...choiceOf(t('subtitle_color'), [t('color_white'), t('color_yellow'), t('color_light_gray')], settings.subtitleColor)} />
  <SettingRow {...choiceOf(t('subtitle_position'), [t('sub_pos_bottom'), t('sub_pos_slightly_raised'), t('sub_pos_raised')], settings.subtitlePosition)} />
  <SettingRow {...toggle(t('subtitle_override_ass'), settings.subtitleOverrideAss)} />
</SettingsGroup>

<SettingsGroup title={t('remember_title')}>
  <SettingRow {...choiceOf(t('remember_speed'), [t('scope_off'), t('scope_global'), t('scope_library'), t('scope_title')], settings.rememberSpeed)} />
  <SettingRow {...choiceOf(t('remember_aspect'), [t('scope_off'), t('scope_global'), t('scope_library'), t('scope_title')], settings.rememberAspect)} />
</SettingsGroup>

<SettingsGroup hint={t('settings_remote_control_summary')}>
  <SettingRow {...toggle(t('settings_remote_control'), settings.remoteControl)} />
</SettingsGroup>
