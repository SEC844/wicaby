<script lang="ts">
  // Home's hero (Android HeroCarousel, the desktop's Hero): the backdrop full bleed under the status bar, fading into
  // the canvas; at its foot, aligned left, the type and genres in small caps, the title's logo (or its name, large
  // and bold), the facts, then Play (the accent) and More info. Slides follow the finger (a native horizontal scroll that
  // snaps) and advance every 8 s while the hero is in view and untouched; the dots below mark the current one.
  // Pulling the page down stretches the artwork (the page writes --stretch).
  import type { BaseItem } from '$shared/models';
  import type { Api } from '$tv/api';
  import { t } from '$tv/i18n.svelte';
  import { placeholder } from '$tv/images';
  import { play } from '$tv/playback';
  import Play from '@lucide/svelte/icons/play';
  import { eyebrowLine, metaLine } from '../lib/format';
  import { itemRoute, nav } from '../lib/nav.svelte';

  // onslide: the title on show (its index), as the slides move.
  let { items, api, onslide }: { items: BaseItem[]; api: Api; onslide?: (item: BaseItem) => void } = $props();

  const SLIDE_MS = 8000;
  const dpr = Math.min(3, window.devicePixelRatio || 2);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let track: HTMLElement;
  let root: HTMLElement;
  let index = $state(0);
  let touching = $state(false);
  let offscreen = $state(false);
  // Artwork loads for the slide shown and its neighbours, then stays.
  let warm = $state(new Set<number>([0, 1]));

  function onScroll(): void {
    const i = Math.round(track.scrollLeft / track.clientWidth);
    if (i !== index) {
      index = i;
      warm = new Set([...warm, i - 1, i, i + 1]);
    }
  }

  $effect(() => {
    const item = items[index];
    if (item) onslide?.(item);
  });

  $effect(() => {
    if (reduced || touching || offscreen || items.length < 2) return;
    const id = setTimeout(() => {
      const next = (index + 1) % items.length;
      track.scrollTo({ left: next * track.clientWidth, behavior: next === 0 ? 'instant' : 'smooth' });
    }, SLIDE_MS);
    return () => clearTimeout(id);
  });

  $effect(() => {
    const io = new IntersectionObserver(([e]) => (offscreen = !e.isIntersecting), { threshold: 0.3 });
    io.observe(root);
    return () => io.disconnect();
  });

  const backdrop = (item: BaseItem) => api.backdrop(item, Math.round(1100 * (dpr / 3) * (16 / 9)));
  const logo = (item: BaseItem) => api.logo(item, Math.round(280 * dpr));
</script>

<section class="hero" bind:this={root} aria-roledescription="carousel">
  <!-- svelte-ignore a11y_no_static_element_interactions (touches only hold the timer; the slides scroll natively) -->
  <div class="track" bind:this={track} onscroll={onScroll} ontouchstart={() => (touching = true)} ontouchend={() => (touching = false)} ontouchcancel={() => (touching = false)}>
    {#each items as item, i (item.Id)}
      {@const art = warm.has(i) ? backdrop(item) : undefined}
      {@const mark = logo(item)}
      <article class="slide" aria-roledescription="slide" aria-label={item.Name} style:background-color={placeholder(item, 'Backdrop') ?? '#111'}>
        {#if art}<img class="art" src={art} alt="" decoding="async" fetchpriority={i === 0 ? 'high' : 'low'} />{/if}
        <div class="shade"></div>
        <div class="content">
          <p class="eyebrow on">{eyebrowLine(item)}</p>
          <button class="title-button" onclick={() => nav.push(itemRoute(item))}>
            {#if mark}
              <img class="logo" src={mark} alt={item.Name} decoding="async" />
            {:else}
              <h2 class="name">{item.Name}</h2>
            {/if}
          </button>
          <p class="subhead meta">{metaLine(item)}</p>
          <div class="actions">
            <button class="pill primary pressable" onclick={() => play(item)}>
              <Play size={18} fill="currentColor" strokeWidth={0} aria-hidden="true" />
              {t('play')}
            </button>
            <button class="pill text pressable" onclick={() => nav.push(itemRoute(item))}>{t('more_info')}</button>
          </div>
        </div>
      </article>
    {/each}
  </div>
  {#if items.length > 1}
    <div class="dots" aria-hidden="true">
      {#each items as item, i (item.Id)}<span class:on={i === index}></span>{/each}
    </div>
  {/if}
</section>

<style>
  .hero {
    position: relative;
    /* Short enough that Continue watching shows under it at first sight. */
    height: min(calc(100vw * 1.12), 560px);
    transform-origin: 50% 100%;
    transform: scale(var(--stretch, 1));
  }
  .track {
    height: 100%;
    display: flex;
    overflow-x: auto;
    overflow-y: hidden;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
    overscroll-behavior-x: contain;
  }
  .slide {
    position: relative;
    flex: 0 0 100%;
    height: 100%;
    scroll-snap-align: center;
    scroll-snap-stop: always;
    overflow: hidden;
    color: #fff;
  }
  .art {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: 50% 30%;
  }
  /* The status bar stays legible on top; the canvas rises from the bottom with no hard edge (design.md). */
  .shade {
    position: absolute;
    inset: 0;
    background:
      linear-gradient(to bottom, rgb(0 0 0 / 0.4), rgb(0 0 0 / 0) 20%),
      linear-gradient(to top, var(--bg) 0%, color-mix(in srgb, var(--bg) 78%, transparent) 20%, rgb(0 0 0 / 0.2) 50%, rgb(0 0 0 / 0) 66%);
  }
  .content {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 30px;
    padding: 0 max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .eyebrow.on {
    color: rgb(255 255 255 / 0.75);
  }
  .title-button {
    display: block;
    max-width: 100%;
    text-align: left;
  }
  .logo {
    display: block;
    max-width: min(72vw, 300px);
    max-height: 96px;
    object-fit: contain;
    object-position: left bottom;
    filter: drop-shadow(0 2px 12px rgb(0 0 0 / 0.45));
  }
  .name {
    font-size: calc(40px * var(--text-scale));
    font-weight: 800;
    letter-spacing: -0.035em;
    line-height: 1.05;
    text-shadow: 0 2px 16px rgb(0 0 0 / 0.45);
  }
  .meta {
    color: rgb(255 255 255 / 0.78);
  }
  :global([data-theme='light']) .content {
    color: var(--label);
  }
  :global([data-theme='light']) .meta,
  :global([data-theme='light']) .eyebrow.on {
    color: var(--label-2);
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  /* "Plus d'infos" as Android's: a plain label beside Play. */
  .pill.text {
    background: transparent;
    color: inherit;
  }
  .dots {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 10px;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 6px;
  }
  .dots span {
    width: 6px;
    height: 6px;
    border-radius: 3px;
    background: var(--label-3);
  }
  .dots span.on {
    width: 18px;
    background: var(--label);
  }
</style>
