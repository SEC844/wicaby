<script module lang="ts">
  export interface PanelColumn {
    key: string;
    title: string;
    // Share of the card's width.
    weight: number;
    rows: { id: number; text: string }[];
    selected: number | null | undefined;
    // The row being switched to (a spinner instead of the check).
    busy?: number | null;
    pick: (id: number) => void;
  }
</script>

<script lang="ts">
  // Android TV TrackPanel / QualityPanel layout (PlayerActivity.kt TrackColumn): a card along the bottom with
  // columns of choices, the current one checked. It keeps the focus (data-focus-trap) and opens on the first
  // column's selected row; each column scrolls with the focus and remembers its row.
  import { onMount } from 'svelte';
  import { focusable, focusFirst } from '../../lib/focus';
  import { edgeDelta } from '../../lib/scroll';
  import Icon from '../Icon.svelte';
  import Spinner from '../Spinner.svelte';

  let { columns, height = 280 }: { columns: PanelColumn[]; height?: number } = $props();

  let card: HTMLDivElement;
  onMount(() => requestAnimationFrame(() => focusFirst(card)));

  function scroll(e: CustomEvent): void {
    const list = (e.target as HTMLElement).closest('.rows') as HTMLElement | null;
    if (!list) return;
    const r = (e.target as HTMLElement).getBoundingClientRect();
    list.scrollTop += edgeDelta(r.top - list.getBoundingClientRect().top, r.height, list.clientHeight, 0);
  }
</script>

<div class="scrim" data-focus-trap>
  <div class="card" style="height:{height}rem" bind:this={card} ontvfocus={scroll}>
    {#each columns as c, ci (c.key)}
      <div class="column" style="flex:{c.weight}" data-focus-group>
        <p class="t-eyebrow title">{c.title.toUpperCase()}</p>
        <div class="rows">
          {#each c.rows as r, ri (r.id)}
            <button
              class="row t-body"
              use:focusable={ci === 0 && (r.id === c.selected || (c.selected == null && ri === 0))}
              data-focus-default={r.id === c.selected ? '' : undefined}
              onclick={() => c.pick(r.id)}
            >
              <span class="mark">
                {#if r.id === c.busy}<Spinner size={16} color="currentColor" />{:else if r.id === c.selected}<Icon name="Check" size={18} />{/if}
              </span>
              <span class="ellipsis">{r.text}</span>
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.35);
  }
  .card {
    position: absolute;
    left: 32rem;
    right: 32rem;
    bottom: 32rem;
    display: flex;
    padding: 24rem;
    border-radius: var(--r-xl);
    background: var(--elevated);
    animation: up 220ms var(--ease-out) both;
  }
  @keyframes up {
    from {
      opacity: 0;
      transform: translateY(24rem);
    }
  }
  .column {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .column + .column {
    margin-left: 24rem;
  }
  .title {
    margin: 0 0 10rem 14rem;
    color: var(--label-3);
  }
  .rows {
    flex: 1;
    overflow: hidden;
  }
  .row {
    display: flex;
    align-items: center;
    width: 100%;
    margin-bottom: 4rem;
    padding: 10rem 14rem;
    border-radius: var(--r-sm);
    color: var(--label);
    text-align: left;
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .row:global(.focused) {
    background: #fff;
    color: #000;
    transform: scale(1.02);
  }
  .mark {
    display: flex;
    flex-shrink: 0;
    width: 26rem;
    color: var(--accent);
  }
  .row:global(.focused) .mark {
    color: #000;
  }
</style>
