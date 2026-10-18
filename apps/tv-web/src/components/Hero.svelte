<script lang="ts">
  // Android TV Hero (Main.kt): the featured title over the backdrop, Play / More Info, page dots. Left on Play and
  // Right on More Info step through the titles; while it holds the focus (the Home tab tells it) it advances every 9 s.
  import type { BaseItem } from '$shared/models';
  import type { Api } from '../lib/api';
  import { metaLine } from '../lib/format';
  import { locale, t } from '../lib/i18n.svelte';
  import Pill from './Pill.svelte';

  let {
    api,
    items,
    index = $bindable(0),
    focused = false,
    onplay,
    oninfo,
  }: { api: Api; items: BaseItem[]; index?: number; focused?: boolean; onplay: (item: BaseItem) => void; oninfo: (item: BaseItem) => void } =
    $props();

  const n = $derived(items.length);
  const item = $derived(items[Math.min(index, n - 1)]);
  const resume = $derived((item?.UserData?.PlaybackPositionTicks ?? 0) > 0);
  let logoFailed = $state<string | null>(null);
  const logo = $derived(item && logoFailed !== item.Id ? api.logo(item) : undefined);

  function step(d: number): void {
    if (n > 1) index = (index + d + n) % n;
  }

  $effect(() => {
    if (!focused || n < 2) return;
    void index;
    const timer = setTimeout(() => step(1), 9000);
    return () => clearTimeout(timer);
  });

  function onmove(e: CustomEvent<'up' | 'down' | 'left' | 'right'>): void {
    const pill = (e.target as HTMLElement).closest('[data-hero-pill]')?.getAttribute('data-hero-pill');
    if ((pill === 'play' && e.detail === 'left') || (pill === 'info' && e.detail === 'right')) {
      e.preventDefault();
      step(e.detail === 'left' ? -1 : 1);
    }
  }
</script>

{#if item}
  <section class="hero" data-focus-group ontvmove={onmove}>
    <div class="text">
      {#key item.Id}
        <div class="fade">
          {#if logo}
            <img class="logo" src={logo} alt={item.Name} onerror={() => (logoFailed = item.Id)} />
          {:else}
            <h1 class="t-hero">{item.Type === 'Episode' ? (item.SeriesName ?? item.Name) : item.Name}</h1>
          {/if}
          <p class="meta t-callout">{metaLine(item, locale.current)}</p>
          {#if item.Overview}<p class="overview t-body">{item.Overview}</p>{/if}
        </div>
      {/key}
      <div class="actions">
        <span data-hero-pill="play"><Pill text={t(resume ? 'resume' : 'play')} icon="Play" primary autofocus onclick={() => onplay(item)} /></span>
        <span class="gap"></span>
        <span data-hero-pill="info"><Pill text={t('more_info')} icon="Info" onclick={() => oninfo(item)} /></span>
      </div>
      <div class="dots">
        {#each items as it, i (it.Id)}<span class="dot" class:on={i === index}></span>{/each}
      </div>
    </div>
  </section>
{/if}

<style>
  .hero {
    position: relative;
    height: 430rem;
  }
  .text {
    position: absolute;
    left: 56rem;
    bottom: 34rem;
    width: 520rem;
  }
  .fade {
    animation: in 420ms 120ms var(--ease-out) both;
  }
  @keyframes in {
    from {
      opacity: 0;
    }
  }
  .logo {
    max-height: 96rem;
    max-width: 380rem;
  }
  h1 {
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .meta {
    margin: 12rem 0 0;
    color: var(--label-2);
    white-space: nowrap;
  }
  .overview {
    margin: 10rem 0 0;
    color: var(--label-2);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .actions {
    display: flex;
    margin-top: 22rem;
  }
  .gap {
    width: 12rem;
  }
  .dots {
    display: flex;
    align-items: center;
    margin-top: 20rem;
  }
  .dot {
    width: 6rem;
    height: 6rem;
    margin-right: 6rem;
    border-radius: 3rem;
    background: var(--label-3);
    transition: width var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .dot.on {
    width: 18rem;
    background: var(--label);
  }
</style>
