<script lang="ts">
  // The accent colours: Settings > Appearance and the first-run setup. Hover and focus preview the colour
  // across the whole app; a click saves it.
  import { ACCENTS, type Accent } from '../../shared/contract';
  import { t } from '../lib/i18n.svelte';
  import { settings } from '../lib/stores.svelte';
  import { previewAccent, set } from '../routes/settings/shared.svelte';

  const accentLabel = (a: Accent) => t(`settings.appearance.accents.${a}`);
  const current = $derived(settings.value?.ui.accent ?? 'blue');
</script>

<div class="accents" role="radiogroup" tabindex="-1" aria-label={t('settings.appearance.accent.label')} onpointerleave={() => previewAccent(null)}>
  {#each ACCENTS as a (a)}
    <button
      type="button"
      class="swatch"
      role="radio"
      data-accent-swatch={a}
      aria-checked={current === a}
      aria-label={accentLabel(a)}
      title={accentLabel(a)}
      style:--c={a === 'graphite' ? '#d1d1d6' : `var(--${a})`}
      onpointerenter={() => previewAccent(a)}
      onfocus={() => previewAccent(a)}
      onblur={() => previewAccent(null)}
      onclick={() => set({ ui: { accent: a } })}
    ></button>
  {/each}
</div>

<style>
  /* Accent swatches: small dots, a thin ring marks the current one. */
  .accents {
    display: flex;
    gap: 6px;
    flex: none;
  }
  .swatch {
    position: relative;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
  }
  .swatch::before {
    content: '';
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--c);
  }
  .swatch::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--label-2);
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .swatch:hover::after,
  .swatch:focus-visible::after {
    opacity: 0.35;
  }
  .swatch[aria-checked='true']::after {
    opacity: 1;
  }
</style>
