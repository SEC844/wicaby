<script lang="ts">
  // Android TV SubtitlesSection (Settings.kt): the server's subtitle language and mode, the style of the app's own
  // subtitle renderer, and SDH first (accessibility).
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import { choice, choiceOf, toggle } from '../../components/settings/rows';
  import type { Api } from '../../lib/api';
  import { k, t } from '../../lib/i18n.svelte';
  import { ServerConfig } from '../../lib/server-config.svelte';
  import { settings } from '../../lib/settings.svelte';
  import { LANGS } from './langs';

  let { api }: { api: Api } = $props();
  // svelte-ignore state_referenced_locally
  const server = new ServerConfig(api);
  const SUB_MODES: [string, string][] = [['Default', k('sub_mode_default')], ['Smart', k('sub_mode_smart')], ['OnlyForced', k('sub_mode_forced')], ['Always', k('sub_mode_always')], ['None', k('sub_mode_none')]];
</script>

<SettingsGroup title={t('group_sub_language')} hint={t(server.failed ? 'server_pref_failed' : 'server_pref_hint')}>
  {#if server.config === null}
    <SettingRow label={t('subtitle_language')} value={t('loading')} />
  {:else}
    <SettingRow
      {...choice(t('subtitle_language'), LANGS.map(([, k]) => t(k)), Math.max(0, LANGS.findIndex(([code]) => code === server.str('SubtitleLanguagePreference'))), (i) =>
        void server.set('SubtitleLanguagePreference', LANGS[i][0]),
      )}
    />
    <SettingRow
      {...choice(t('subtitle_mode'), SUB_MODES.map(([, k]) => t(k)), Math.max(0, SUB_MODES.findIndex(([m]) => m === (server.str('SubtitleMode') || 'Default'))), (i) =>
        void server.set('SubtitleMode', SUB_MODES[i][0]),
      )}
    />
  {/if}
</SettingsGroup>
<SettingsGroup title={t('group_style')} hint={t('subtitle_hint')}>
  <SettingRow {...choiceOf(t('subtitle_size'), [t('size_small'), t('size_normal'), t('size_large'), t('size_xlarge')], settings.subtitleSize)} />
  <SettingRow {...choiceOf(t('subtitle_style'), [t('style_outline'), t('style_shadow'), t('style_box')], settings.subtitleStyle)} />
  <SettingRow {...choiceOf(t('subtitle_font'), ['Geist', t('font_system'), t('font_serif')], settings.subtitleFont)} />
  <SettingRow {...choiceOf(t('subtitle_color'), [t('color_white'), t('color_yellow'), t('color_light_gray')], settings.subtitleColor)} />
  <SettingRow {...choiceOf(t('subtitle_position'), [t('sub_pos_bottom'), t('sub_pos_slightly_raised'), t('sub_pos_raised')], settings.subtitlePosition)} />
  <SettingRow {...toggle(t('subtitle_override_ass'), settings.subtitleOverrideAss)} />
</SettingsGroup>
<SettingsGroup title={t('a11y_group')} hint={t('a11y_hint')}>
  <SettingRow {...toggle(t('prefer_sdh'), settings.preferSdh)} />
</SettingsGroup>
