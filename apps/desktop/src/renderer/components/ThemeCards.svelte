<script lang="ts">
  // The theme choice with a mini screenshot per theme: Settings > Appearance and the first-run setup.
  import { t } from '../lib/i18n.svelte';
  import { linux } from '../lib/platform';
  import { settings } from '../lib/stores.svelte';
  import { set } from '../routes/settings/shared.svelte';

  const THEMES = ['dark', 'oled'] as const;
  const current = $derived(settings.value?.ui.theme ?? 'dark');
</script>

<div class="themes" role="radiogroup" aria-label={t('settings.appearance.theme.title')}>
  {#each THEMES as theme (theme)}
    <button type="button" class="theme" role="radio" data-theme-card={theme} aria-checked={current === theme} class:on={current === theme} onclick={() => set({ ui: { theme } })}>
      <span class="shot" class:oled={theme === 'oled'}>
        <span class="sb"><i></i><i></i><i></i></span>
        <span class="hero-bar"></span>
        <span class="tiles"><i></i><i></i><i></i></span>
      </span>
      <span class="theme-txt">
        <span class="theme-label">{t(`settings.appearance.theme.${theme}`)}</span>
        <span class="theme-desc">{t(`settings.appearance.theme.${theme}Desc${linux ? 'Linux' : ''}`)}</span>
      </span>
    </button>
  {/each}
</div>

<style>
  .themes {
    display: flex;
    gap: 16px;
    padding: 18px;
  }
  .theme {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    border-radius: var(--r-sm);
    text-align: left;
  }
  .shot {
    position: relative;
    width: 148px;
    height: 92px;
    border-radius: var(--r-xs);
    overflow: hidden;
    background: #0b0b0d;
    box-shadow: inset 0 0 0 1px var(--hairline);
  }
  .shot.oled {
    background: #000;
  }
  /* Selection: a thin neutral ring, offset from the tile. */
  .shot::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1.5px var(--label);
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .theme.on .shot::after {
    opacity: 1;
  }
  .theme:not(.on):hover .shot::after,
  .theme:not(.on):focus-visible .shot::after {
    opacity: 0.3;
  }
  .sb {
    position: absolute;
    inset: 0 auto 0 0;
    width: 32px;
    padding: 10px 7px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    background: #1a1a1d;
  }
  .sb i {
    height: 3px;
    border-radius: 2px;
    background: #2e2e33;
  }
  .shot.oled .sb {
    background: #000;
  }
  .shot.oled .sb i {
    background: #1f1f22;
  }
  .hero-bar {
    position: absolute;
    left: 40px;
    right: 8px;
    top: 9px;
    height: 34px;
    border-radius: 3px;
    background: #26262a;
  }
  .shot.oled .hero-bar {
    background: #18181b;
  }
  .tiles {
    position: absolute;
    left: 40px;
    right: 8px;
    bottom: 9px;
    display: flex;
    gap: 5px;
  }
  .tiles i {
    flex: 1;
    height: 30px;
    border-radius: 3px;
    background: #1e1e21;
  }
  .shot.oled .tiles i {
    background: #121214;
  }
  .theme-txt {
    display: flex;
    flex-direction: column;
    padding-left: 1px;
  }
  .theme-label {
    font-size: var(--fs-callout);
    font-weight: 500;
    color: var(--label-2);
    transition: color var(--t-fast) var(--ease);
  }
  .theme-desc {
    font-size: var(--fs-caption);
    color: var(--label-3);
  }
  .theme.on .theme-label {
    color: var(--label);
  }
  :global(.searching) .themes {
    display: none;
  }
</style>
