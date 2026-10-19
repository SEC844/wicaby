<script lang="ts">
  // Android TV ThemeHint (ThemeCards.kt): shown once on Home while the TV is on the default theme. OLED (black pixels
  // off) or Cinéma (warm, for the evening) suit a living room; any button, or a theme picked in Settings, hides it for
  // good.
  import { move } from '../lib/focus';
  import { t } from '../lib/i18n.svelte';
  import { settings } from '../lib/settings.svelte';
  import Pill from './Pill.svelte';

  // The hint leaves the page in the same frame: hand the focus to the row below first, or it falls back to the bar.
  function done(id: string | null): void {
    move('down');
    if (id) settings.theme.value = id;
    settings.themeHintShown.value = true;
  }
</script>

<div class="hint">
  <div class="card">
    <div class="text">
      <p class="t-headline">{t('theme_hint_title')}</p>
      <p class="t-callout label-2">{t('theme_hint_body')}</p>
    </div>
    <div class="pill"><Pill text={t('theme_oled')} onclick={() => done('oled')} /></div>
    <div class="pill"><Pill text={t('theme_cinema')} onclick={() => done('cinema')} /></div>
    <div class="pill"><Pill text={t('theme_hint_keep')} onclick={() => done(null)} /></div>
  </div>
</div>

<style>
  .hint {
    padding: 8rem 48rem;
  }
  /* Opaque: a translucent fill over the backdrop left the body text with weak separation. */
  .card {
    display: flex;
    align-items: center;
    padding: 18rem 24rem;
    border-radius: var(--r-lg);
    background: var(--elevated-2);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  p {
    margin: 0;
  }
  p + p {
    margin-top: 4rem;
  }
  .pill {
    margin-left: 14rem;
  }
</style>
