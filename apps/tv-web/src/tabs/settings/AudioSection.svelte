<script lang="ts">
  // Android TV AudioSection (Settings.kt): the server's audio language, audio description (accessibility) and the
  // passthrough codecs. Not here: ExoPlayer's audio effects (AVPlay and the TV's <video> have none an app can set).
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import { choice, choiceOf } from '../../components/settings/rows';
  import type { Api } from '../../lib/api';
  import { k, t } from '../../lib/i18n.svelte';
  import { ServerConfig } from '../../lib/server-config.svelte';
  import { PASS_CODECS, settings } from '../../lib/settings.svelte';
  import { LANGS } from './langs';

  let { api }: { api: Api } = $props();
  // svelte-ignore state_referenced_locally
  const server = new ServerConfig(api);
  const AD: ['prefer' | 'avoid' | 'any', string][] = [['prefer', k('ad_prefer')], ['avoid', k('ad_avoid')], ['any', k('ad_any')]];
  const PASS_LABELS: Record<string, string> = { ac3: 'Dolby Digital (AC3)', eac3: 'Dolby Digital Plus (E-AC3)', dts: 'DTS, DTS-HD', truehd: 'Dolby TrueHD' };
  const passOptions = $derived([t('pass_auto'), t('pass_on'), t('pass_off')]);
</script>

<SettingsGroup title={t('group_language')} hint={t(server.failed ? 'server_pref_failed' : 'server_pref_hint')}>
  {#if server.config === null}
    <SettingRow label={t('audio_language')} value={t('loading')} />
  {:else}
    <SettingRow
      {...choice(t('audio_language'), LANGS.map(([, k]) => t(k)), Math.max(0, LANGS.findIndex(([code]) => code === server.str('AudioLanguagePreference'))), (i) =>
        void server.set('AudioLanguagePreference', LANGS[i][0]),
      )}
    />
  {/if}
</SettingsGroup>
<SettingsGroup title={t('a11y_group')} hint={t('a11y_hint')}>
  <SettingRow
    {...choice(t('audio_description'), AD.map(([, k]) => t(k)), Math.max(0, AD.findIndex(([v]) => v === settings.audioDescription.value)), (i) => (settings.audioDescription.value = AD[i][0]))}
  />
</SettingsGroup>
<SettingsGroup title={t('group_passthrough')} hint={t('passthrough_hint')}>
  {#each PASS_CODECS as codec (codec)}
    <SettingRow {...choiceOf(PASS_LABELS[codec], passOptions, settings.passthrough[codec])} />
  {/each}
</SettingsGroup>
