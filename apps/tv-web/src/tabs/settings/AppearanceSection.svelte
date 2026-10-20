<script lang="ts">
  // Android TV AppearanceSection (Settings.kt): the theme cards (each drawn in its own theme), the accent, the clock
  // and the screensaver (ScreensaverRow, ScreensaverSourceRows: its delay, what it shows, from which album).
  import Icon from '../../components/Icon.svelte';
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import { choice, toggle } from '../../components/settings/rows';
  import type { BaseItem } from '$shared/models';
  import type { Api } from '../../lib/api';
  import { useLoad } from '../../lib/load.svelte';
  import { photoAlbums } from '../../lib/photos.svelte';
  import ThemeCards from '../../components/ThemeCards.svelte';
  import { focusable } from '../../lib/focus';
  import { t } from '../../lib/i18n.svelte';
  import { settings } from '../../lib/settings.svelte';
  import { palette } from '../../lib/theme';

  let { api, views }: { api: Api; views: BaseItem[] } = $props();

  const MINS = [0, 2, 5, 10, 15, 30];
  const SOURCES = ['backdrops', 'photos', 'memories'] as const;
  // Every photo library, then its albums ("Library · Album").
  const albums = useLoad(
    () => (settings.screensaverSource.value === 'backdrops' ? 'saver-albums-off' : 'saver-albums'),
    async () => {
      if (settings.screensaverSource.value === 'backdrops') return [];
      const libs = views.filter((v) => v.CollectionType === 'photos' || v.CollectionType === 'homevideos');
      const lists = await Promise.all(libs.map(async (lib) => [[lib.Id, lib.Name], ...(await photoAlbums(api, lib.Id).catch(() => [])).map((a) => [a.Id, `${lib.Name} · ${a.Name}`])]));
      return lists.flat() as [string, string][];
    },
  );
  const albumIds = $derived(['', ...(albums.value ?? []).map(([id]) => id)]);
</script>

<SettingsGroup title={t('settings_theme')}>
  <!-- Picking a card applies it to the whole screen at once. -->
  <ThemeCards
    current={palette(settings.theme.value).id}
    onpick={(id) => {
      settings.theme.value = id;
      settings.themeHintShown.value = true;
    }}
  />
  <div class="accent-row">
    <span class="t-headline">{t('settings_accent')}</span>
    <div class="accents">
      {#each palette(settings.theme.value).accents as a, i (i)}
        <button class="accent" style="background:{a.color};color:{a.fg}" aria-label={a.color} use:focusable onclick={() => (settings.accent.value = i)}>
          {#if i === settings.accent.value}<Icon name="Check" size={16} />{/if}
        </button>
      {/each}
    </div>
  </div>
</SettingsGroup>
<SettingsGroup title={t('group_display')}>
  <SettingRow {...toggle(t('show_clock'), settings.clock)} />
</SettingsGroup>
<SettingsGroup title={t('group_screensaver')}>
  <SettingRow
    {...choice(t('screensaver_after'), MINS.map((m) => (m === 0 ? t('never') : t('minutes', m))), Math.max(0, MINS.indexOf(settings.screensaverMin.value)), (i) =>
      (settings.screensaverMin.value = MINS[i]),
    )}
  />
  <SettingRow
    {...choice(
      t('screensaver_source'),
      [t('screensaver_source_backdrops'), t('screensaver_source_photos'), t('screensaver_source_memories')],
      Math.max(0, SOURCES.indexOf(settings.screensaverSource.value)),
      (i) => (settings.screensaverSource.value = SOURCES[i]),
    )}
  />
  {#if settings.screensaverSource.value !== 'backdrops'}
    <SettingRow
      {...choice(t('screensaver_album'), [t('screensaver_album_all'), ...(albums.value ?? []).map(([, name]) => name)], Math.max(0, albumIds.indexOf(settings.screensaverAlbum.value)), (i) =>
        (settings.screensaverAlbum.value = albumIds[i]),
      )}
    />
  {/if}
</SettingsGroup>

<style>
  .accent-row {
    display: flex;
    align-items: center;
    margin-top: 4rem;
    padding: 12rem 18rem;
    border-radius: var(--r-md);
    background: var(--fill-1);
  }
  .accent-row > span {
    flex: 1;
  }
  .accents {
    display: flex;
  }
  .accent {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28rem;
    height: 28rem;
    margin-left: 12rem;
    border-radius: 50%;
    transition: transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow var(--t-med);
  }
  .accent:global(.focused) {
    transform: scale(1.3);
    box-shadow: 0 10rem 20rem rgba(0, 0, 0, 0.5);
  }
</style>
