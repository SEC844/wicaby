<script lang="ts">
  // Android TV AppearanceSection (Settings.kt): the theme cards (each drawn in its own theme), the accent and the
  // clock. No screensaver group yet.
  import Icon from '../../components/Icon.svelte';
  import SettingRow from '../../components/settings/SettingRow.svelte';
  import SettingsGroup from '../../components/settings/SettingsGroup.svelte';
  import { toggle } from '../../components/settings/rows';
  import ThemeCards from '../../components/ThemeCards.svelte';
  import { focusable } from '../../lib/focus';
  import { t } from '../../lib/i18n.svelte';
  import { settings } from '../../lib/settings.svelte';
  import { palette } from '../../lib/theme';
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
