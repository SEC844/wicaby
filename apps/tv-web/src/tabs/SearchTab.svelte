<script lang="ts">
  // Android TV SearchTab (Main.kt): the field at the top (the TV keyboard covers the lower half), then a 7-column grid
  // of posters. Queries of 2 characters or more run 350 ms after the last keystroke; the previous results stay until
  // the new ones arrive. Left on the first column and Right on the last are dead ends (dpadEdges).
  // Not here: voice search (Tizen and webOS give web apps no speech recognizer) and the Live TV hits (TP-12, with
  // Live TV).
  import type { BaseItem } from '$shared/models';
  import { itemKey } from '$desktop/items';
  import Card from '../components/Card.svelte';
  import TextField from '../components/TextField.svelte';
  import type { Api } from '../lib/api';
  import { t } from '../lib/i18n.svelte';
  import { itemRoute, nav } from '../lib/nav.svelte';
  import { merged } from '../lib/servers';
  import { settings } from '../lib/settings.svelte';
  import { dp } from '../lib/screen';
  import { clamp, edgeDelta } from '../lib/scroll';

  let { api }: { api: Api } = $props();

  const COLUMNS = 7;
  // 960 dp less the 48 dp side padding, less six 20 dp gaps, over seven columns.
  const CARD = (960 - 96 - (COLUMNS - 1) * 20) / COLUMNS;

  let query = $state('');
  const q = $derived(query.trim());
  let results = $state<BaseItem[] | null>(null);

  $effect(() => {
    const term = q;
    if (term.length < 2) {
      results = null;
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      // Every signed-in server (TP-06), one copy of a title found on several.
      // Settings > Home: episodes among the results, or only films and series.
      const types = settings.searchEpisodes.value ? 'Movie,Series,Episode' : 'Movie,Series';
      merged((a) => a.items({ SearchTerm: term, IncludeItemTypes: types, Recursive: true, Limit: 60 }).then((r) => r.Items)).then(
        (r) => !stale && (results = r),
        () => !stale && (results = []),
      );
    }, 350);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  });

  // The grid scrolls only as far as the focused row needs (Compose's default for a lazy grid).
  let viewport = $state<HTMLDivElement>();
  let grid = $state<HTMLDivElement>();
  let y = $state(0);
  function onfocus(e: CustomEvent): void {
    const cell = (e.target as HTMLElement).closest('[data-cell]') as HTMLElement | null;
    if (!cell || !grid || !viewport || !grid.contains(cell)) return;
    const max = Math.max(0, grid.offsetHeight - viewport.clientHeight);
    y = clamp(y + edgeDelta(cell.offsetTop - y, cell.offsetHeight, viewport.clientHeight, dp(24)), 0, max);
  }

  function onmove(e: CustomEvent<'up' | 'down' | 'left' | 'right'>): void {
    const cell = (e.target as HTMLElement).closest('[data-cell]');
    if (!cell) return;
    const i = Number(cell.getAttribute('data-cell'));
    const last = (results?.length ?? 0) - 1;
    if ((e.detail === 'left' && i % COLUMNS === 0) || (e.detail === 'right' && (i % COLUMNS === COLUMNS - 1 || i === last))) e.preventDefault();
  }
</script>

<div class="search">
  <div class="field">
    <TextField bind:value={query} placeholder={t('search_hint')} autofocus />
  </div>
  {#if results === null}
    <p class="center t-body label-3">{t('search_prompt')}</p>
  {:else if results.length === 0}
    <p class="center t-title3 label-2">{t('search_empty')}</p>
  {:else}
    <div class="viewport" bind:this={viewport} ontvfocus={onfocus} ontvmove={onmove}>
      <div class="grid" bind:this={grid} style="transform:translate3d(0,{-y}px,0)">
        {#each results as item, i (itemKey(item))}
          <div class="cell" data-cell={i}>
            <Card {item} {api} width={CARD} onclick={() => nav.push(itemRoute(item))} />
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .search {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    padding-top: 100rem;
  }
  .field {
    align-self: center;
    width: 560rem;
    margin-bottom: 18rem;
  }
  .center {
    margin: auto;
  }
  .viewport {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .grid {
    display: flex;
    flex-wrap: wrap;
    padding: 12rem 48rem 56rem;
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  .cell {
    margin: 0 20rem 24rem 0;
  }
  .cell:nth-child(7n) {
    margin-right: 0;
  }
</style>
