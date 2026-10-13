<script lang="ts">
  // Step 1: welcome and language. The language applies at once (t() is reactive); untouched it stays System.
  import Logo from '../../components/Logo.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { settings } from '../../lib/stores.svelte';
  import { set } from '../settings/shared.svelte';

  const lang = $derived(settings.value?.ui.language ?? 'auto');
  // Endonyms stay untranslated (docs/i18n.md).
  const FRENCH = 'Français'; // i18n-ignore: endonym
</script>

<div class="intro">
  <span class="appicon"><Logo size={44} /></span>
  <h1>{t('welcome.intro.title')}</h1>
  <p class="lead">{t('welcome.intro.body')}</p>
  <div class="lang">
    <Segmented
      label={t('welcome.intro.language')}
      value={lang}
      options={[
        { value: 'auto', label: t('welcome.intro.system') },
        { value: 'fr', label: FRENCH },
        { value: 'en', label: 'English' },
      ]}
      onchange={(v) => set({ ui: { language: v } })}
    />
  </div>
</div>

<style>
  .intro {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 22px;
    padding-top: 4px;
  }
  .intro .lead {
    margin-top: -8px;
  }
  .appicon {
    display: grid;
    place-items: center;
    width: 72px;
    height: 72px;
    border-radius: 19px;
    color: var(--label);
    background: var(--bg-elevated-2);
    box-shadow:
      inset 0 0 0 0.5px var(--hairline),
      var(--shadow-1);
  }
  .lang {
    margin-top: 6px;
  }
</style>
