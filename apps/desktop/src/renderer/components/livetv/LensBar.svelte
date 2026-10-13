<script lang="ts">
  import { SORT_MODES } from '../../../shared/livetv/channel-order';
  import type { SortMode } from '../../../shared/livetv/channel-order';
  import { lensFromParam, lensToParam, sameLens } from '../../../shared/livetv/lens';
  import { categoriesOf } from '../../../shared/livetv/model';
  import type { Category, LensRef } from '../../../shared/livetv/model';
  import { t } from '../../lib/i18n.svelte';
  import type { LiveTvStore } from '../../lib/livetv.svelte';
  import Picker from '../Picker.svelte';

  // Lens bar and category chips (§6.5, §6.6): Toutes · Favoris · Récentes · Radio · Groupes ▾, then one
  // category at a time (a second axis; hidden while the category source is unknown), then the sort.
  let { store, onlens, oncategory }: { store: LiveTvStore; onlens: (l: LensRef) => void; oncategory: (c: Category | null) => void } = $props();

  const main = $derived(store.lenses.filter((l) => l.kind === 'all' || l.kind === 'favorites' || l.kind === 'recents' || l.kind === 'radio'));
  const groupOptions = $derived([
    { value: '', label: t('livetv.lens.groups') },
    ...store.lenses
      .filter((l) => l.kind === 'tag' || l.kind === 'group')
      .map((l) => ({ value: lensToParam(l), label: l.kind === 'tag' ? l.tag : (store.prefs.groups.find((g) => g.id === l.id)?.name ?? l.id) })),
  ]);
  const groupValue = $derived(store.lens.kind === 'tag' || store.lens.kind === 'group' ? lensToParam(store.lens) : '');
  const sortOptions = $derived(SORT_MODES.map((m) => ({ value: m, label: t(`livetv.sort.${m}`) })));

  const LENS_KEY = { all: 'all', favorites: 'favorites', recents: 'recents', radio: 'radio' } as Record<string, string>;
</script>

<div class="bar">
  <div class="group" role="group" aria-label={t('livetv.lens.label')}>
    {#each main as l (l.kind)}
      <button class="pill" aria-pressed={sameLens(l, store.lens)} onclick={() => onlens(l)}>{t(`livetv.lens.${LENS_KEY[l.kind]}`)}</button>
    {/each}
    {#if groupOptions.length > 1}
      <Picker label={t('livetv.lens.groups')} value={groupValue} options={groupOptions} onchange={(v) => onlens(v ? lensFromParam(v).lens : { kind: 'all' })} />
    {/if}
  </div>
  {#if store.caps.categorySource !== 'unknown'}
    <div class="group cats" role="group" aria-label={t('livetv.category.label')}>
      {#each categoriesOf(store.kind) as c (c)}
        <button
          class="pill"
          aria-pressed={store.category === c}
          title={c === 'new' && !store.caps.newFlag ? t('livetv.category.newJellyfin') : undefined}
          onclick={() => oncategory(store.category === c ? null : c)}>{t(`livetv.category.${c}`)}</button
        >
      {/each}
    </div>
  {/if}
  <span class="sort">
    <Picker label={t('livetv.sort.label')} value={store.sort} options={sortOptions} onchange={(v: SortMode) => store.setSort(v)} />
  </span>
</div>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 16px;
    min-width: 0;
    flex-wrap: wrap;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }
  .cats {
    padding-left: 16px;
    box-shadow: -1px 0 0 var(--separator);
  }
  .sort {
    margin-left: auto;
  }
  .pill {
    height: 30px;
    padding: 0 12px;
    border-radius: 15px;
    font-size: var(--fs-footnote);
    font-weight: 560;
    color: var(--label-2);
    white-space: nowrap;
    transition: background-color var(--t-fast) var(--ease);
  }
  .pill:is(:hover, :focus-visible) {
    background: var(--fill-3);
    color: var(--label);
  }
  .pill[aria-pressed='true'] {
    background: var(--fill-4);
    color: var(--label);
  }
  @media (forced-colors: active) {
    .pill[aria-pressed='true'],
    .pill:focus-visible {
      outline: 2px solid Highlight;
    }
  }
</style>
