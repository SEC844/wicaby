<script lang="ts">
  // A library or folder as a poster grid (Android GridScreen), under a large title with the count, Sort and Filter
  // as glass buttons, and Shuffle for libraries that play. The sort and filter are remembered per library.
  import type { BaseItem } from '$shared/models';
  import { plural, t } from '$tv/i18n.svelte';
  import { useLoad } from '$tv/load.svelte';
  import { shuffle } from '$tv/playback';
  import { apiOf } from '$tv/session.svelte';
  import { load, save } from '$tv/storage';
  import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
  import ListFilter from '@lucide/svelte/icons/list-filter';
  import ShuffleIcon from '@lucide/svelte/icons/shuffle';
  import LargeTitlePage from '../components/LargeTitlePage.svelte';
  import PosterGrid from '../components/PosterGrid.svelte';
  import { itemRoute, nav } from '../lib/nav.svelte';
  import { showAlert } from '../lib/overlay.svelte';

  let { id, title, serverId }: { id: string; title: string; serverId?: string } = $props();
  // A page is opened for one folder and never re-targeted: the initial values are the values.
  // svelte-ignore state_referenced_locally
  const client = apiOf(serverId)!;
  const folder = useLoad(() => `folder-${id}`, () => client.item(id));
  const ct = $derived(folder.value?.CollectionType);
  const types = $derived(ct === 'movies' ? 'Movie' : ct === 'tvshows' ? 'Series' : ct === 'boxsets' ? 'BoxSet' : undefined);

  const SORTS = [
    { key: 'sort_name', by: 'SortName', order: 'Ascending' },
    { key: 'sort_added', by: 'DateCreated,SortName', order: 'Descending' },
    { key: 'sort_year', by: 'ProductionYear,PremiereDate,SortName', order: 'Descending' },
    { key: 'sort_rating', by: 'CommunityRating,SortName', order: 'Descending' },
  ] as const;
  const FILTERS = [
    { key: 'filter_all', value: undefined },
    { key: 'filter_unplayed', value: 'IsUnplayed' },
    { key: 'filter_favorites', value: 'IsFavorite' },
  ] as const;
  // svelte-ignore state_referenced_locally
  const stored = load<{ sort: number; filter: number }>(`m.grid.${id}`, { sort: 0, filter: 0 });
  let sort = $state(stored.sort);
  let filter = $state(stored.filter);
  $effect(() => save(`m.grid.${id}`, { sort, filter }));

  let scroller = $state<HTMLElement>();
  let total = $state(-1);
  const key = $derived(`${id}/${types ?? ''}/${sort}/${filter}`);

  function page(start: number, limit: number) {
    const s = SORTS[sort] ?? SORTS[0];
    return client.items({
      ParentId: id,
      IncludeItemTypes: types,
      Recursive: types !== undefined,
      SortBy: s.by,
      SortOrder: s.order,
      Filters: FILTERS[filter]?.value,
      StartIndex: start,
      Limit: limit,
    });
  }

  function pickSort(): void {
    showAlert({ title: t('web_sort'), actions: SORTS.map((s, i) => ({ label: t(s.key), run: () => (sort = i) })), selected: sort });
  }

  function pickFilter(): void {
    showAlert({ title: t('web_filter'), actions: FILTERS.map((f, i) => ({ label: t(f.key), run: () => (filter = i) })), selected: filter });
  }

  const playable = $derived(!!folder.value && !['books', 'boxsets', 'playlists', 'livetv'].includes(ct ?? ''));
</script>

<LargeTitlePage {title} back bind:scroller>
  {#snippet header()}
    <div class="tools">
      <span class="footnote label-2 count">{total > 0 ? plural('items_count', total, total.toLocaleString()) : ''}</span>
      {#if playable && total > 0}
        <button class="tool glass" aria-label={t('shuffle')} onclick={() => shuffle(folder.value as BaseItem)}><ShuffleIcon size={18} aria-hidden="true" /></button>
      {/if}
      <button class="tool glass" class:on={filter > 0} aria-label={t('web_filter')} onclick={pickFilter}><ListFilter size={18} aria-hidden="true" /></button>
      <button class="tool glass wide" onclick={pickSort}><ArrowUpDown size={16} aria-hidden="true" /><span class="subhead">{t(SORTS[sort].key)}</span></button>
    </div>
  {/snippet}
  {#if folder.value}
    <PosterGrid api={client} {key} {page} {scroller} bind:total onopen={(item) => nav.push(itemRoute(item))} />
  {/if}
</LargeTitlePage>

<style>
  .tools {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px max(var(--gutter), var(--safe-right)) 18px max(var(--gutter), var(--safe-left));
  }
  .count {
    flex: 1;
  }
  .tool {
    height: 36px;
    min-width: 36px;
    border-radius: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--label);
  }
  .tool.wide {
    padding: 0 14px;
  }
  .tool.on {
    color: var(--accent);
  }
</style>
