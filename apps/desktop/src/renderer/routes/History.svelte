<script lang="ts" module>
  import type { BaseItem as Item } from '../../shared/models';

  let last: { items: Item[]; genres: Map<string, string[]> } | null = null;
</script>

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { daysAgo, groupByDay, watchStats } from '../../shared/history';
  import type { BaseItem } from '../../shared/models';
  import Card from '../components/Card.svelte';
  import Icon from '../components/Icon.svelte';
  import { apiFor, fanOut, itemKey, LIST_FIELDS, merge } from '../lib/api';
  import { fmt, t } from '../lib/i18n.svelte';
  import { entering, scrollMemory } from '../lib/motion';
  const enter = entering();
  import { dataVersion, multiServer, onlineSessions } from '../lib/stores.svelte';

  // Recently played, grouped by day, with simple personal stats. Same layout as Favorites.
  const multi = $derived(multiServer());

  let items = $state<BaseItem[]>(last?.items ?? []);
  let seriesGenres = $state<Map<string, string[]>>(last?.genres ?? new Map());
  let loading = $state(last === null);

  onMount(scrollMemory);

  async function load(): Promise<void> {
    // Played and in-progress items, newest play first. Emby can sort never-played items before played ones on
    // DatePlayed, so an unfiltered query may hold no history at all: the server filters, two queries per server.
    const query = { Recursive: true, IncludeItemTypes: 'Movie,Episode', SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: 200, Fields: `${LIST_FIELDS},Genres` };
    const found = await fanOut((a) =>
      Promise.all([a.items({ ...query, Filters: 'IsPlayed' }), a.items({ ...query, Filters: 'IsResumable' })]).then(([p, r]) => [...(p.Items ?? []), ...(r.Items ?? [])]),
    );
    const list = merge(found, true);
    // Episodes rarely carry genres: one lookup of their series per server.
    const missing = new Map<string, Set<string>>();
    for (const i of list) {
      if (i.Genres?.length || !i.SeriesId || !i.UserData?.LastPlayedDate) continue;
      const sid = i.ServerId ?? '';
      missing.set(sid, (missing.get(sid) ?? new Set()).add(i.SeriesId));
    }
    const genres = new Map<string, string[]>();
    await Promise.all(
      [...missing].map(async ([sid, ids]) => {
        const res = await apiFor(sid || undefined)
          .items({ Ids: [...ids].slice(0, 50).join(','), Fields: 'Genres', EnableImages: false })
          .catch(() => null);
        for (const s of res?.Items ?? []) genres.set(s.Id, s.Genres ?? []);
      }),
    );
    items = list;
    seriesGenres = genres;
    last = { items: list, genres };
    loading = false;
  }

  // Only the server count re-runs the load, not every session push.
  const online = $derived(onlineSessions().length);
  $effect(() => {
    void dataVersion.userData;
    void online;
    untrack(() => void load());
  });

  const groups = $derived(groupByDay(items));
  const stats = $derived(watchStats(items, seriesGenres));
  const total = $derived(groups.reduce((n, g) => n + g.items.length, 0));

  function dayLabel(day: number): string {
    const ago = daysAgo(day);
    if (ago === 0) return t('browse.history.today');
    if (ago === 1) return t('browse.history.yesterday');
    const otherYear = new Date(day).getFullYear() !== new Date().getFullYear();
    return fmt.date(day, { weekday: 'long', day: 'numeric', month: 'long', ...(otherYear ? { year: 'numeric' } : {}) });
  }
</script>

<div class="history">
  <header class="head">
    <h1 class="large-title">{t('browse.history.title')}</h1>
    {#if !loading && total > 0}<span class="count">{t('common.count.items', { count: total })}</span>{/if}
  </header>

  {#if loading}
    <div class="grid" aria-busy="true">
      {#each Array(8) as _, i (i)}
        <div aria-hidden="true">
          <div class="sk-frame skeleton"></div>
          <div class="sk-line skeleton"></div>
        </div>
      {/each}
    </div>
  {:else if total === 0}
    <div class="empty">
      <span class="badge"><Icon name="clock" size={30} /></span>
      <h2 class="title-2">{t('browse.history.empty.title')}</h2>
      <p class="footnote">{t('browse.history.empty.body')}</p>
    </div>
  {:else}
    <dl class="stats">
      <div class="stat">
        <dt>{t('browse.history.week')}</dt>
        <dd>{fmt.duration(stats.weekMs)}</dd>
      </div>
      <div class="stat">
        <dt>{t('browse.history.month')}</dt>
        <dd>{fmt.duration(stats.monthMs)}</dd>
      </div>
      {#if stats.genres.length}
        <div class="stat wide">
          <dt>{t('browse.history.topGenres')}</dt>
          <dd class="genres">{fmt.list(stats.genres)}</dd>
        </div>
      {/if}
    </dl>

    {#each groups as g (g.day)}
      <section>
        <h2 class="title-3">{dayLabel(g.day)}</h2>
        <div class="grid">
          {#each g.items as item, i (itemKey(item))}
            <div class:enter style:--i={Math.min(i, 12)}><Card {item} variant="thumb" showServer={multi} /></div>
          {/each}
        </div>
      </section>
    {/each}
  {/if}
</div>

<style>
  .history {
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
  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin: 18px 0 0;
    padding: 0 var(--gutter);
  }
  .stat {
    min-width: 150px;
    padding: 12px 16px;
    border-radius: var(--r-md);
    background: var(--fill-2);
  }
  .stat.wide {
    flex: 1 1 260px;
    max-width: 520px;
  }
  .stat dt {
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .stat dd {
    margin: 4px 0 0;
    font-size: var(--fs-title-3);
    font-weight: 650;
    color: var(--label);
    font-variant-numeric: tabular-nums;
  }
  .stat dd.genres {
    font-size: var(--fs-callout);
    font-weight: 560;
    line-height: 1.5;
  }
  section {
    margin-top: 30px;
  }
  section h2 {
    margin: 0;
    padding: 0 var(--gutter);
  }
  /* fmt.date gives "lundi 5 octobre" in French: a heading starts with a capital. */
  section h2::first-letter {
    text-transform: uppercase;
  }
  .grid {
    --min: calc(clamp(240px, 19vw, 340px) * var(--card-scale, 1));
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--min), 1fr));
    gap: calc(28px * var(--density, 1)) calc(clamp(14px, 1.3vw, 22px) * var(--density, 1));
    padding: 16px var(--gutter) 0;
  }
  .history > .grid {
    margin-top: 14px;
  }
  .enter {
    animation: rise var(--t-slow) var(--ease-out) both;
    animation-delay: calc(var(--i) * var(--t-stagger));
  }
  .sk-frame {
    aspect-ratio: 16 / 9;
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
  .badge {
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
