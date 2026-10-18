<script lang="ts">
  // Android TV MediaRow (Components.kt): a titled row of cards. The track moves with a GPU transform, only when the
  // focused card comes within 56 dp of an edge (EdgeSpec); Left on the first card and Right on the last are dead
  // ends (dpadEdges), and the row gives focus back to its last card when entered again (data-focus-group).
  import type { BaseItem } from '$shared/models';
  import type { Snippet } from 'svelte';
  import { itemKey } from '$desktop/items';
  import type { Api } from '../lib/api';
  import { dp } from '../lib/screen';
  import { clamp, edgeDelta } from '../lib/scroll';
  import Card from './Card.svelte';

  let {
    title,
    items,
    api,
    wide = false,
    square = false,
    subtitle,
    showServer,
    onclick,
    onfocusitem,
    card,
  }: {
    title: string;
    items: BaseItem[];
    api: Api;
    wide?: boolean;
    square?: boolean;
    subtitle?: (item: BaseItem) => string | undefined;
    showServer?: (item: BaseItem) => string | undefined;
    onclick: (item: BaseItem) => void;
    onfocusitem?: (item: BaseItem) => void;
    // A card of the row's own (Home's Live TV channels).
    card?: Snippet<[BaseItem]>;
  } = $props();

  let viewport: HTMLDivElement;
  let track: HTMLDivElement;
  let x = $state(0);

  function onfocus(e: CustomEvent): void {
    const el = e.target as HTMLElement;
    if (!track.contains(el)) return;
    const max = Math.max(0, track.scrollWidth - viewport.clientWidth);
    const delta = edgeDelta(el.offsetLeft - x, el.offsetWidth, viewport.clientWidth, dp(56));
    x = clamp(x + delta, 0, max);
  }

  function onmove(e: CustomEvent<'up' | 'down' | 'left' | 'right'>): void {
    const item = (e.target as HTMLElement).closest('[data-row-item]');
    if (!item) return;
    if ((e.detail === 'left' && !item.previousElementSibling) || (e.detail === 'right' && !item.nextElementSibling)) e.preventDefault();
  }
</script>

<section class="row" data-focus-group ontvfocus={onfocus} ontvmove={onmove}>
  <h3 class="t-title3">{title}</h3>
  <div class="viewport" bind:this={viewport}>
    <div class="track" class:wide bind:this={track} style="transform:translate3d({-x}px,0,0)">
      {#each items as item (itemKey(item))}
        <div class="item" data-row-item>
          {#if card}
            {@render card(item)}
          {:else}
            <Card
              {item}
              {api}
              variant={wide ? 'thumb' : square ? 'square' : 'poster'}
              subtitle={subtitle?.(item)}
              server={showServer?.(item)}
              onclick={() => onclick(item)}
              onfocus={() => onfocusitem?.(item)}
            />
          {/if}
        </div>
      {/each}
    </div>
  </div>
</section>

<style>
  .row {
    padding-top: 14rem;
  }
  h3 {
    margin: 0 0 2rem 48rem;
  }
  .viewport {
    overflow: hidden;
    /* Room for the focus lift and shadow above and below the cards. */
    padding: 12rem 0 18rem;
    margin: -6rem 0 -12rem;
  }
  .track {
    position: relative;
    display: flex;
    align-items: flex-start;
    padding: 6rem 48rem;
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  .item {
    margin-right: 20rem;
  }
  .wide .item {
    margin-right: 22rem;
  }
  .item:last-child {
    margin-right: 0;
  }
</style>
