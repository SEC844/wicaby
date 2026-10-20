<script lang="ts">
  // Android TV AboutSection (Settings.kt): version, licences of what the app ships, and this device, with what its
  // decoders and panel play (the capability probe the device profile is built from, as Android's DeviceCaps dump).
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { VERSION, deviceName } from '../../lib/identity';
  import { platform } from '../../platform';
  import { caps, type Caps } from '../../platform/caps';

  const engine = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? '?';
  // Proper names and licence identifiers stay as they are in every language.
  const system = platform === 'tizen' ? 'Tizen' : platform === 'webos' ? 'webOS' : 'Chromium';

  // Codec names are the same in every language.
  const video = (c: Caps) => {
    const codecs = [c.h264 && 'H.264', c.hevc && (c.hevc10 ? 'HEVC (10 bits)' : 'HEVC'), c.vp9 && 'VP9', c.av1 && 'AV1'].filter(Boolean);
    const ranges = [c.hdr10 && 'HDR10', c.hlg && 'HLG', c.dolbyVision && 'Dolby Vision'].filter(Boolean);
    return [codecs.join(', ') || t('none'), c.maxHeight ? `${c.maxHeight}p` : undefined, ranges.join(', ') || undefined].filter(Boolean).join(' · ');
  };
  const audio = (c: Caps) => ['AAC', c.ac3 && 'AC3', c.eac3 && 'E-AC3', c.dts && 'DTS'].filter(Boolean).join(', ');
</script>

<SettingsGroup>
  <SettingRow label={t('app_name')} value={VERSION} />
</SettingsGroup>

<SettingsGroup title={t('group_licences')} hint={t('plex_tv_not_affiliated')}>
  <SettingRow label={t('licence_geist')} value="SIL OFL 1.1" />
  <SettingRow label="Svelte" value="MIT" />
</SettingsGroup>

<SettingsGroup title={t('group_device')}>
  <SettingRow label={t('device_model')} value={deviceName()} />
  <SettingRow label={system} value={`Chromium ${engine}`} mono />
  {#await caps()}
    <SettingRow label={t('video_decoders')} value={t('loading')} />
  {:then c}
    <SettingRow label={t('video_decoders')} value={video(c)} mono />
    <SettingRow label={t('audio_decoders')} value={audio(c)} mono />
  {/await}
</SettingsGroup>
