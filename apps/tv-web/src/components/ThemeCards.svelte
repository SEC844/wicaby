<script lang="ts">
  // Android TV ThemeCardRow + ThemeCard (ThemeCards.kt): every TV theme as a small picture of the app, drawn with that
  // theme's own tokens whatever theme the TV is in (its canvas, cards, the accent in its tone, its name in its label
  // colour). The row scrolls sideways with the focus; entering it lands on the selected card.
  import { focusable } from '../lib/focus';
  import { t } from '../lib/i18n.svelte';
  import { settings } from '../lib/settings.svelte';
  import { accentOf, THEMES } from '../lib/theme';
  import HScroll from './HScroll.svelte';
  import Icon from './Icon.svelte';

  let { current, onpick }: { current: string; onpick: (id: string) => void } = $props();

  // core ui/Themes.kt themeLabel.
  const LABELS: Record<string, string> = {
    oled: 'theme_oled',
    slate: 'theme_slate',
    cinema: 'theme_cinema',
    contrast: 'theme_contrast',
  };
</script>

<HScroll spacing={16} padding={[12, 24, 12, 24]}>
  {#each THEMES as p (p.id)}
    {@const accent = accentOf(p, settings.accent.value).color}
    <div data-row-item>
      <button
        class="card"
        style="background:{p.vars['--bg']};border-color:{current === p.id ? accent : 'var(--fill-4)'}"
        data-focus-default={current === p.id ? '' : undefined}
        use:focusable
        onclick={() => onpick(p.id)}
      >
        <span class="preview">
          <span class="tile" style="background:{p.vars['--elevated-2']}"></span>
          <span class="tile" style="background:{p.vars['--elevated-2']}"></span>
          <span class="tile" style="background:{p.vars['--elevated-2']}"></span>
          <!-- The check sits on the preview, so the label keeps the full width (Contraste élevé). -->
          {#if current === p.id}<span class="check" style="color:{accent}"><Icon name="Check" size={18} /></span>{/if}
        </span>
        <span class="bar" style="background:{accent}"></span>
        <span class="name t-headline ellipsis" style="color:{p.vars['--label']}">{t(LABELS[p.id] ?? 'theme_graphite')}</span>
      </button>
    </div>
  {/each}
</HScroll>

<style>
  .card {
    display: block;
    width: 176rem;
    padding: 12rem;
    /* Always outlined: the OLED card is as black as an OLED canvas. */
    border: 2rem solid;
    border-radius: var(--r-lg);
    text-align: left;
    transition: transform var(--t-fast) var(--ease-out);
  }
  .card:global(.focused) {
    transform: scale(1.06);
    box-shadow: 0 8rem 24rem rgba(0, 0, 0, 0.5);
  }
  .card:global(.pressed) {
    transform: scale(1.02);
  }
  .preview {
    display: flex;
  }
  .tile {
    width: 28rem;
    height: 36rem;
    margin-right: 6rem;
    border-radius: var(--r-xs);
  }
  .check {
    margin-left: auto;
  }
  .bar {
    display: block;
    width: 48rem;
    height: 7rem;
    margin: 6rem 0;
    border-radius: 4rem;
  }
  .name {
    display: block;
  }
</style>
