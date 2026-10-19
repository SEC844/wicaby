<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { BaseItem } from '../../shared/models';
  import { itemKey } from '../lib/api';
  import { reducedMotion } from '../lib/motion';
  import { t } from '../lib/i18n.svelte';
  import { navigate } from '../lib/router.svelte';
  import Card from './Card.svelte';
  import Icon from './Icon.svelte';

  let {
    title,
    items = [],
    variant = 'poster',
    loading = false,
    href,
    showServer = false,
    children,
  }: {
    title: string;
    items?: BaseItem[];
    variant?: 'poster' | 'thumb' | 'square';
    loading?: boolean;
    href?: string;
    showServer?: boolean;
    children?: Snippet;
  } = $props();

  let track: HTMLDivElement | undefined = $state();
  let canLeft = $state(false);
  let canRight = $state(false);

  function update(): void {
    if (!track) return;
    canLeft = track.scrollLeft > 4;
    canRight = track.scrollLeft + track.clientWidth < track.scrollWidth - 4;
  }

  // Page by whole cards so the snap lands on a clean edge.
  function page(dir: -1 | 1): void {
    if (!track) return;
    const cell = track.firstElementChild as HTMLElement | null;
    const step = cell ? cell.offsetWidth + parseFloat(getComputedStyle(track).columnGap || '0') : 200;
    const visible = Math.max(1, Math.floor((track.clientWidth - 2 * parseFloat(getComputedStyle(track).paddingLeft)) / step));
    track.scrollBy({ left: dir * visible * step, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  $effect(() => {
    void items.length;
    void loading;
    if (!track) return;
    const ro = new ResizeObserver(update);
    ro.observe(track);
    update();
    return () => ro.disconnect();
  });
</script>

{#if loading || items.length > 0 || children}
  <section class="row {variant}">
    {#if title}
    <header>
      {#if href}
        <a
          class="heading link"
          {href}
          onclick={(e) => {
            e.preventDefault();
            navigate(href.replace(/^#/, ''));
          }}
        >
          <h2>{title}</h2>
          <Icon name="chevronRight" size={17} stroke={2.2} />
        </a>
      {:else}
        <h2 class="heading">{title}</h2>
      {/if}
    </header>
    {/if}
    <div class="viewport">
      <div class="track" bind:this={track} onscroll={update}>
        {#if loading}
          {#each Array(8) as _, i (i)}
            <div class="cell" aria-hidden="true">
              <div class="sk-frame skeleton"></div>
              <div class="sk-line skeleton"></div>
            </div>
          {/each}
        {:else if children}
          {@render children()}
        {:else}
          {#each items as item, i (itemKey(item))}
            <div class="cell">
              <Card {item} {variant} {showServer} />
            </div>
          {/each}
        {/if}
      </div>
      <button class="nav left" class:show={canLeft} onclick={() => page(-1)} tabindex="-1" aria-label={t('common.actions.previous')}>
        <Icon name="chevronLeft" size={20} stroke={2.2} />
      </button>
      <button class="nav right" class:show={canRight} onclick={() => page(1)} tabindex="-1" aria-label={t('common.actions.next')}>
        <Icon name="chevronRight" size={20} stroke={2.2} />
      </button>
    </div>
  </section>
{/if}

<style>
  .row {
    --card-w: calc(clamp(138px, 10.5vw, 196px) * var(--card-scale, 1));
    margin: 0 0 calc(22px * var(--density, 1));
    /* Off-screen shelves skip layout and paint until scrolled near. */
    content-visibility: auto;
    contain-intrinsic-size: auto 380px;
  }
  .row.thumb {
    --card-w: calc(clamp(240px, 19vw, 360px) * var(--card-scale, 1));
    contain-intrinsic-size: auto 300px;
  }
  :global(#main-scroller.restoring) .row {
    content-visibility: visible;
  }
  .row.square {
    --card-w: calc(clamp(146px, 11vw, 200px) * var(--card-scale, 1));
  }
  header {
    display: flex;
    align-items: center;
    padding: 0 var(--gutter);
  }
  .heading {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    font-size: var(--fs-title-3);
    font-weight: 650;
    letter-spacing: -0.016em;
    color: var(--label);
  }
  .heading h2 {
    margin: 0;
    font: inherit;
    letter-spacing: inherit;
  }
  .link :global(svg) {
    color: var(--label-3);
  }
  .link:hover :global(svg),
  .link:focus-visible :global(svg) {
    color: var(--label);
  }
  .link:focus-visible {
    border-radius: var(--r-xs);
  }

  .viewport {
    position: relative;
  }
  /* Vertical padding leaves room for the hover lift and its shadow (the track clips). */
  .track {
    display: flex;
    column-gap: calc(clamp(14px, 1.3vw, 22px) * var(--density, 1));
    overflow-x: auto;
    overflow-y: hidden;
    padding: 18px var(--gutter) 30px;
    margin-bottom: -10px;
    scroll-snap-type: x mandatory;
    scroll-padding-inline: var(--gutter);
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .track > :global(*) {
    flex: none;
    scroll-snap-align: start;
  }
  .cell {
    width: var(--card-w);
  }

  .nav {
    position: absolute;
    top: calc(18px + var(--card-w) * 0.75 - 22px);
    z-index: 3;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--label);
    background: var(--material-thick);
    box-shadow: var(--shadow-2);
    opacity: 0;
    transform: scale(0.85);
    pointer-events: none;
    transition:
      opacity var(--t-med) var(--ease), transform var(--t-med) var(--spring);
  }
  .thumb .nav {
    top: calc(18px + var(--card-w) * 0.28125 - 22px);
  }
  .square .nav {
    top: calc(18px + var(--card-w) * 0.5 - 22px);
  }
  .nav.left {
    left: calc(var(--gutter) / 2 - 10px);
  }
  .nav.right {
    right: calc(var(--gutter) / 2 - 10px);
  }
  /* Blur only while shown: shelves scroll under them otherwise. */
  .viewport:hover .nav.show {
    background: var(--material);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    opacity: 1;
    transform: scale(1);
    pointer-events: auto;
  }
  .nav:hover {
    background: var(--material-thick);
  }
  .nav:active {
    transform: scale(0.92);
  }

  .sk-frame {
    border-radius: var(--r-md);
    aspect-ratio: 2 / 3;
  }
  .thumb .sk-frame {
    aspect-ratio: 16 / 9;
  }
  .square .sk-frame {
    aspect-ratio: 1;
  }
  .sk-line {
    height: 11px;
    width: 64%;
    margin-top: 12px;
    border-radius: 4px;
  }
</style>
