<script lang="ts">
  // Home's hero, as the Apple TV app opens: full-bleed artwork under the status bar, the title's logo (or its name),
  // one line of facts, a light Play pill with a round glass button for the page, and dots. Slides follow the finger
  // (a native horizontal scroll that snaps) and advance by themselves every 8 s while the hero is in view and
  // untouched. Pulling the page down stretches the artwork (the page writes --stretch).
  import type { BaseItem } from '$shared/models';
  import type { Api } from '$tv/api';
  import { t } from '$tv/i18n.svelte';
  import { placeholder } from '$tv/images';
  import { play } from '$tv/playback';
  import Info from '@lucide/svelte/icons/info';
  import Play from '@lucide/svelte/icons/play';
  import { itemRoute, nav } from '../lib/nav.svelte';
  import { factsLine } from '../lib/format';

  let { items, api }: { items: BaseItem[]; api: Api } = $props();

  const SLIDE_MS = 8000;
  const dpr = Math.min(3, window.devicePixelRatio || 2);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let track: HTMLElement;
  let index = $state(0);
  let touching = $state(false);
  let offscreen = $state(false);
  let root: HTMLElement;
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
  const logo = (item: BaseItem) => api.logo(item, Math.round(300 * dpr));
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
          <button class="title-button" onclick={() => nav.push(itemRoute(item))}>
            {#if mark}
              <img class="logo" src={mark} alt={item.Name} decoding="async" />
            {:else}
              <h2 class="title-1 name">{item.Name}</h2>
            {/if}
          </button>
          <p class="footnote facts">{factsLine(item)}</p>
          <div class="actions">
            <button class="btn-light pressable" onclick={() => play(item)}>
              <Play size={20} fill="currentColor" strokeWidth={0} aria-hidden="true" />
              {t('play')}
            </button>
            <button class="btn-round glass-media pressable" aria-label={t('more_info')} onclick={() => nav.push(itemRoute(item))}>
              <Info size={22} aria-hidden="true" />
            </button>
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
    height: min(calc(100vw * 1.32), 640px);
    /* Pulled down past the top: the artwork grows from its bottom edge to fill the gap (the page sets --stretch). */
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
  /* Legible status bar on top, the canvas rising from the bottom: no hard edge between the art and the page. */
  .shade {
    position: absolute;
    inset: 0;
    background:
      linear-gradient(to bottom, rgb(0 0 0 / 0.45), rgb(0 0 0 / 0) 22%),
      linear-gradient(to top, var(--bg) 0%, color-mix(in srgb, var(--bg) 82%, transparent) 16%, rgb(0 0 0 / 0.25) 46%, rgb(0 0 0 / 0) 64%);
  }
  .content {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 34px;
    padding: 0 max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
  }
  :global([data-theme='light']) .content {
    color: var(--label);
  }
  .title-button {
    display: grid;
    place-items: center;
    max-width: 100%;
  }
  .logo {
    max-width: min(76vw, 320px);
    max-height: 110px;
    object-fit: contain;
    filter: drop-shadow(0 2px 12px rgb(0 0 0 / 0.45));
  }
  .name {
    text-shadow: 0 2px 16px rgb(0 0 0 / 0.5);
  }
  .facts {
    color: inherit;
    opacity: 0.78;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    gap: 12px;
    margin-top: 6px;
  }
  .actions .btn-light {
    min-width: 168px;
  }
  .dots {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 12px;
    display: flex;
    justify-content: center;
    gap: 7px;
  }
  .dots span {
    width: 6px;
    height: 6px;
    border-radius: 3px;
    background: var(--label-3);
  }
  .dots span.on {
    background: var(--label);
  }
</style>
