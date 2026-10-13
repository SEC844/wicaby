<script lang="ts" module>
  import type { BaseItem as Item } from '../../shared/models';

  let last: Record<string, Item[]> | null = null;
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import type { BaseItem } from '../../shared/models';
  import Card from '../components/Card.svelte';
  import Icon from '../components/Icon.svelte';
  import { fanOut, itemKey, merge } from '../lib/api';
  import { fmt, t } from '../lib/i18n.svelte';
  import { scrollMemory } from '../lib/motion';
  import { dataVersion, multiServer, onlineSessions } from '../lib/stores.svelte';

  const multi = $derived(multiServer());

  const GROUPS: { types: string; labelKey: string; variant: 'poster' | 'thumb' | 'square' }[] = [
    { types: 'Movie', labelKey: 'browse.groups.movies', variant: 'poster' },
    { types: 'Series', labelKey: 'browse.groups.series', variant: 'poster' },
    { types: 'Episode', labelKey: 'browse.groups.episodes', variant: 'thumb' },
    { types: 'BoxSet', labelKey: 'browse.groups.collections', variant: 'poster' },
    { types: 'MusicAlbum', labelKey: 'browse.groups.albums', variant: 'square' },
    { types: 'MusicArtist', labelKey: 'browse.groups.artists', variant: 'square' },
    { types: 'Audio', labelKey: 'browse.groups.songs', variant: 'square' },
  ];

  let rows = $state<Record<string, BaseItem[]>>(last ?? {});
  let loading = $state(last === null);

  onMount(scrollMemory);
  let category = $state('all');

  async function load(): Promise<void> {
    const entries = await Promise.all(
      GROUPS.map(async (g) => {
        // Every server's favourites in one list, by name.
        const found = await fanOut((a) => a.items({ Filters: 'IsFavorite', Recursive: true, IncludeItemTypes: g.types, SortBy: 'SortName', Limit: 100 }));
        const items = merge(found.map((r) => r?.Items));
        if (found.length > 1) items.sort((a, b) => fmt.compare(a.Name, b.Name));
        return [g.types, items] as const;
      }),
    );
    rows = Object.fromEntries(entries);
    last = rows;
    loading = false;
  }

  $effect(() => {
    void dataVersion.userData;
    void onlineSessions().length;
    void load();
  });

  const total = $derived(Object.values(rows).reduce((n, l) => n + l.length, 0));
  const present = $derived(GROUPS.filter((g) => (rows[g.types]?.length ?? 0) > 0));
  const visible = $derived(category === 'all' ? present : present.filter((g) => g.types === category));
</script>

<div class="favorites">
  <header class="head">
    <h1 class="large-title">{t('browse.favorites.title')}</h1>
    {#if !loading && total > 0}<span class="count">{t('common.count.items', { count: total })}</span>{/if}
  </header>

  {#if loading}
    <div class="grid poster" aria-busy="true">
      {#each Array(12) as _, i (i)}
        <div aria-hidden="true">
          <div class="sk-frame skeleton"></div>
          <div class="sk-line skeleton"></div>
        </div>
      {/each}
    </div>
  {:else if total === 0}
    <div class="empty">
      <span class="heart"><Icon name="heart" size={30} fill stroke={0} /></span>
      <h2 class="title-2">{t('browse.favorites.empty.title')}</h2>
      <p class="footnote">{t('browse.favorites.empty.body')}</p>
    </div>
  {:else}
    {#if present.length > 1}
      <div class="segmented" role="tablist" aria-label={t('browse.categories')}>
        <button role="tab" class:on={category === 'all'} aria-selected={category === 'all'} onclick={() => (category = 'all')}>{t('browse.all')}</button>
        {#each present as g (g.types)}
          <button role="tab" class:on={category === g.types} aria-selected={category === g.types} onclick={() => (category = g.types)}>{t(g.labelKey)}</button>
        {/each}
      </div>
    {/if}

    {#key category}
      {#each visible as g (g.types)}
        <section>
          {#if visible.length > 1}<h2 class="title-3">{t(g.labelKey)}</h2>{/if}
          <div class="grid {g.variant}">
            {#each rows[g.types] as item, i (itemKey(item))}
              <div class="enter" style:--i={Math.min(i, 12)}><Card {item} variant={g.variant} showServer={multi} /></div>
            {/each}
          </div>
        </section>
      {/each}
    {/key}
  {/if}
</div>

<style>
  .favorites {
    padding: 28px 0 72px;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 14px;
    padding: 0 var(--gutter);
  }
  .head .large-title {
    margin: 0;
  }
  .count {
    font-size: var(--fs-callout);
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
  }
  .segmented {
    display: inline-flex;
    gap: 2px;
    margin: 18px var(--gutter) 0;
    padding: 3px;
    border-radius: 999px;
    background: var(--fill-2);
    max-width: calc(100% - 2 * var(--gutter));
    overflow-x: auto;
    scrollbar-width: none;
  }
  .segmented button {
    flex: none;
    height: 30px;
    padding: 0 16px;
    border-radius: 999px;
    font-size: var(--fs-callout);
    font-weight: 560;
    color: var(--label-2);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      transform var(--t-med) var(--spring);
  }
  .segmented button:not(.on):focus-visible,
  .segmented button:hover {
    color: var(--label);
  }
  .segmented button:active {
    transform: scale(0.96);
  }
  .segmented button.on {
    background: var(--fill-4);
    color: var(--label);
    box-shadow: var(--shadow-1);
  }
  .segmented button:not(.on):focus-visible {
    background: var(--fill-3);
  }
  .segmented button:focus-visible {
    border-radius: 999px;
  }
  section {
    margin-top: 30px;
  }
  section h2 {
    margin: 0;
    padding: 0 var(--gutter);
  }
  .grid {
    --min: calc(clamp(140px, 11vw, 200px) * var(--card-scale, 1));
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--min), 1fr));
    gap: calc(28px * var(--density, 1)) calc(clamp(14px, 1.3vw, 22px) * var(--density, 1));
    padding: 16px var(--gutter) 0;
  }
  .grid.thumb {
    --min: calc(clamp(240px, 19vw, 340px) * var(--card-scale, 1));
  }
  .grid.square {
    --min: calc(clamp(150px, 11.5vw, 210px) * var(--card-scale, 1));
  }
  .favorites > .grid {
    margin-top: 14px;
  }
  .enter {
    animation: rise var(--t-slow) var(--ease-out) both;
    animation-delay: calc(var(--i) * 30ms * var(--tempo));
  }
  .sk-frame {
    aspect-ratio: 2 / 3;
    border-radius: var(--r-md);
  }
  .sk-line {
    height: 11px;
    width: 64%;
    margin-top: 12px;
    border-radius: 4px;
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: 6px;
    padding: 96px var(--gutter);
    text-align: center;
  }
  .heart {
    display: grid;
    place-items: center;
    width: 72px;
    height: 72px;
    margin-bottom: 10px;
    border-radius: 50%;
    background: var(--fill-2);
    color: var(--label-2);
  }
  .empty h2 {
    margin: 0;
  }
  .empty p {
    margin: 0;
    max-width: 44ch;
  }
</style>
