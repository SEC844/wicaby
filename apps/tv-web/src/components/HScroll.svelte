<script lang="ts">
  // A horizontal row of focusable items (Android LazyRow + EdgeSpec + dpadEdges + focusRestorer): the track moves with
  // a GPU transform only when the focused item comes within 56 dp of an edge, Left on the first item and Right on the
  // last are dead ends, and the row gives focus back to its last item when entered again. Each child is wrapped by the
  // caller in an element with `data-row-item`.
  import type { Snippet } from 'svelte';
  import { dp } from '../lib/screen';
  import { clamp, edgeDelta } from '../lib/scroll';

  let {
    spacing = 20,
    padding = [6, 48, 6, 48],
    children,
  }: {
    // Gap between items, in dp (flexbox gap is newer than the oldest engine).
    spacing?: number;
    // Track padding in dp: top, right, bottom, left.
    padding?: [number, number, number, number];
    children: Snippet;
  } = $props();

  let viewport: HTMLDivElement;
  let track: HTMLDivElement;
  let x = $state(0);

  function onfocus(e: CustomEvent): void {
    const el = e.target as HTMLElement;
    if (!track.contains(el)) return;
    // The focused element's offset in the track: its own offsetLeft when the track is its offsetParent, else its row item's.
    const item = el.offsetParent === track ? el : (el.closest('[data-row-item]') as HTMLElement | null);
    if (!item) return;
    const max = Math.max(0, track.scrollWidth - viewport.clientWidth);
    x = clamp(x + edgeDelta(item.offsetLeft - x, item.offsetWidth, viewport.clientWidth, dp(56)), 0, max);
  }

  function onmove(e: CustomEvent<'up' | 'down' | 'left' | 'right'>): void {
    const item = (e.target as HTMLElement).closest('[data-row-item]');
    if (!item || !track.contains(item)) return;
    if ((e.detail === 'left' && !item.previousElementSibling) || (e.detail === 'right' && !item.nextElementSibling)) e.preventDefault();
  }
</script>

<div class="viewport" bind:this={viewport} data-focus-group ontvfocus={onfocus} ontvmove={onmove}>
  <div
    class="track"
    bind:this={track}
    style="--spacing:{spacing}rem;padding:{padding[0]}rem {padding[1]}rem {padding[2]}rem {padding[3]}rem;transform:translate3d({-x}px,0,0)"
  >
    {@render children()}
  </div>
</div>

<style>
  .viewport {
    overflow: hidden;
    /* Room for the focus lift and shadow above and below the items. */
    padding: 12rem 0 18rem;
    margin: -6rem 0 -12rem;
  }
  .track {
    position: relative;
    display: flex;
    align-items: flex-start;
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  .track > :global([data-row-item]) {
    flex-shrink: 0;
    margin-right: var(--spacing);
  }
  .track > :global([data-row-item]:last-child) {
    margin-right: 0;
  }
</style>
