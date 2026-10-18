<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { BaseItem } from '../../shared/models';
  import Card from '../components/Card.svelte';
  import Icon from '../components/Icon.svelte';
  import Row from '../components/Row.svelte';
  import { atParam, dayKey } from '../../shared/livetv/anchor';
  import { fanOut, itemKey, merge } from '../lib/api';
  import { liveServer } from '../lib/livetv.svelte';
  import type { Channel, Program } from '../lib/livetv.svelte';
  import { scrollMemory } from '../lib/motion';
  import { w } from '../lib/bridge';
  import { fmt, t } from '../lib/i18n.svelte';
  import { navigate, router } from '../lib/router.svelte';
  import { errorMessage, multiServer, onlineSessions } from '../lib/stores.svelte';

  // Every signed-in server is searched at once; cards name their server when there are several.
  const multi = $derived(multiServer());

  const RECENT_KEY = 'wicaby.search.recent';
  const GROUPS: { type: string; labelKey: string; variant: 'poster' | 'thumb' | 'square' }[] = [
    { type: 'Movie', labelKey: 'browse.groups.movies', variant: 'poster' },
    { type: 'Series', labelKey: 'browse.groups.series', variant: 'poster' },
    { type: 'Episode', labelKey: 'browse.groups.episodes', variant: 'thumb' },
    { type: 'MusicAlbum', labelKey: 'browse.groups.albums', variant: 'square' },
    { type: 'MusicArtist', labelKey: 'browse.groups.artists', variant: 'square' },
    { type: 'Audio', labelKey: 'browse.groups.songs', variant: 'square' },
    { type: 'BoxSet', labelKey: 'browse.groups.collections', variant: 'poster' },
  ];

  function readRecent(): string[] {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 8) : [];
    } catch {
      return [];
    }
  }

  function pushRecent(term: string): void {
    recent = [term, ...recent.filter((r) => r.toLowerCase() !== term.toLowerCase())].slice(0, 8);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      // Best effort.
    }
  }

  function clearRecent(): void {
    recent = [];
    try {
      localStorage.removeItem(RECENT_KEY);
    } catch {
      // Best effort.
    }
  }

  let term = $state(router.route.query.get('q') ?? '');
  let results = $state<BaseItem[]>([]);
  let live = $state<(Program | Channel)[]>([]);
  let searching = $state(false);
  let error = $state('');
  let recent = $state<string[]>(readRecent());
  let genres = $state<string[]>([]);
  let input: HTMLInputElement | undefined = $state();
  let category = $state('all');
  let seq = 0;

  let genreResults = $state<BaseItem[]>([]);
  let genreLabel = $state('');
  let genreLoading = $state(false);
  let genreSeq = 0;

  const shown = $derived(term.trim().length >= 2 ? results : genreLabel ? genreResults : []);
  const grouped = $derived(GROUPS.map((g) => ({ ...g, label: t(g.labelKey), items: shown.filter((r) => r.Type === g.type) })).filter((g) => g.items.length > 0));
  const picked = $derived(grouped.find((g) => g.type === category));

  onMount(() => {
    // Coming back to results: keep the place instead of jumping to the field.
    // Arriving from the title-bar field (query already set) leaves focus there.
    if (!term) input?.focus({ preventScroll: true });
    Promise.all(
      onlineSessions().map((s) =>
        w.api
          .get<{ Items: { Name: string }[] }>('/Genres', { UserId: s.user?.id, SortBy: 'SortName', Recursive: true, IncludeItemTypes: 'Movie,Series' }, s.server.id)
          .catch(() => ({ Items: [] })),
      ),
    )
      .then((lists) => {
        const all = [...new Set(lists.flatMap((r) => (r.Items ?? []).map((g) => g.Name)))];
        // A handful of random picks keeps the empty state from looking static.
        genres = all.sort(() => Math.random() - 0.5).slice(0, 12);
      })
      .catch(() => undefined);
    return scrollMemory();
  });

  // The title-bar field drives this page through ?q= without remounting it.
  $effect(() => {
    const q = router.route.query.get('q') ?? '';
    if (q.trim() !== untrack(() => term).trim()) term = q;
  });

  $effect(() => {
    const q = term.trim();
    const mine = ++seq;
    if (q.length < 2) {
      results = [];
      live = [];
      searching = false;
      error = '';
      return;
    }
    searching = true;
    const timer = setTimeout(async () => {
      try {
        const [found, liveFound] = await Promise.all([fanOut((a) => a.search(q)), fanOut((a) => a.searchLive(q))]);
        if (mine !== seq) return;
        if (found.length > 0 && found.every((r) => r === null)) throw new Error(t('browse.search.unreachable'));
        results = merge(found.map((r) => r?.Items));
        // Ended programmes lead nowhere in the guide.
        live = (merge(liveFound.map((r) => r?.Items)) as (Program | Channel)[]).filter((x) => x.Type !== 'Program' || !(Date.parse(x.EndDate ?? '') <= Date.now()));
        error = '';
        if (results.length > 0) pushRecent(q);
        history.replaceState(null, '', `#/search?q=${encodeURIComponent(q)}`);
      } catch (err) {
        if (mine === seq) error = errorMessage(err);
      } finally {
        if (mine === seq) searching = false;
      }
    }, 280);
    // Bumping seq drops a late answer after leaving the page, so it never rewrites another page's URL.
    return () => {
      clearTimeout(timer);
      seq++;
    };
  });

  // A category that no longer has results falls back to everything.
  $effect(() => {
    if (category !== 'all' && !picked) category = 'all';
  });

  // A channel or programme opens the guide on it (URL state of the Live TV page).
  function openLive(item: Program | Channel): void {
    if (item.ServerId) liveServer.id = item.ServerId;
    const prog = item.Type === 'Program' ? (item as Program) : null;
    const qs = new URLSearchParams({ tab: 'guide', ch: (prog ? prog.ChannelId : item.Id) ?? '' });
    const start = prog?.StartDate ? Date.parse(prog.StartDate) : NaN;
    if (prog) qs.set('prog', prog.Id);
    if (start > 0) (qs.set('day', dayKey(start)), qs.set('at', atParam(start)));
    navigate(`/livetv?${qs}`);
  }

  function liveLabel(item: Program | Channel): string {
    if (item.Type !== 'Program') {
      const c = item as Channel;
      return [c.ChannelNumber ?? c.Number, c.Name].filter(Boolean).join(' ');
    }
    const p = item as Program;
    const start = p.StartDate ? Date.parse(p.StartDate) : NaN;
    const when = start > 0 ? `${fmt.day(start)} ${fmt.time(start)}` : '';
    return [p.Name, p.ChannelName, when].filter(Boolean).join(' · ');
  }

  async function searchGenre(g: string): Promise<void> {
    const mine = ++genreSeq;
    term = '';
    genreLabel = g;
    genreLoading = true;
    try {
      const found = await fanOut((a) =>
        a.items({ Genres: g, Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'CommunityRating,SortName', SortOrder: 'Descending', Limit: 60 }),
      );
      if (mine === genreSeq) genreResults = merge(found.map((r) => r?.Items));
    } catch (err) {
      if (mine === genreSeq) error = errorMessage(err);
    } finally {
      if (mine === genreSeq) genreLoading = false;
    }
  }

  function clearGenre(): void {
    genreSeq++;
    genreLabel = '';
    genreResults = [];
    genreLoading = false;
  }

  $effect(() => {
    if (term) clearGenre();
  });
</script>

<div class="search">
  <h1 class="large-title">{t('browse.search.title')}</h1>
  <div class="field-wrap">
    <label class="bar">
      <span class="lead"><Icon name="search" size={20} stroke={2} /></span>
      <input
        bind:this={input}
        bind:value={term}
        type="search"
        placeholder={t('browse.search.placeholder')}
        spellcheck="false"
        autocomplete="off"
        aria-label={t('browse.search.title')}
        onkeydown={(e) => e.key === 'Escape' && (term = '')}
      />
      {#if searching || genreLoading}<span class="spin" aria-label={t('browse.search.searching')}></span>{/if}
      {#if term}
        <button class="clear" onclick={() => (term = '')} aria-label={t('browse.search.clear')}><Icon name="close" size={12} stroke={2.6} /></button>
      {/if}
    </label>
  </div>

  {#if grouped.length > 1 || genreLabel}
    <div class="categories" role="tablist" aria-label={t('browse.categories')}>
      {#if genreLabel}
        <button class="cat genre-tag" onclick={clearGenre} aria-label={t('browse.search.removeGenre', { genre: genreLabel })}>
          {genreLabel}<Icon name="close" size={11} stroke={2.6} />
        </button>
      {/if}
      <button class="cat" class:on={category === 'all'} role="tab" aria-selected={category === 'all'} onclick={() => (category = 'all')}>
        {t('browse.all')} <span class="n">{shown.length}</span>
      </button>
      {#each grouped as g (g.type)}
        <button class="cat" class:on={category === g.type} role="tab" aria-selected={category === g.type} onclick={() => (category = g.type)}>
          {g.label} <span class="n">{g.items.length}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if error}
    <p class="error"><Icon name="exclamation" size={16} /> {error}</p>
  {/if}

  {#if picked}
    {#key picked.type}
      <div class="grid {picked.variant}">
        {#each picked.items as item, i (itemKey(item))}
          <div class="enter" style:--i={Math.min(i, 12)}><Card {item} variant={picked.variant} showServer={multi} /></div>
        {/each}
      </div>
    {/key}
  {:else if grouped.length > 0}
    <div class="results">
      {#each grouped as g (g.type)}
        <Row title={g.label} items={g.items} variant={g.variant} showServer={multi} />
      {/each}
    </div>
  {:else if term.trim().length >= 2 && !searching && !live.length}
    <div class="none">
      <Icon name="search" size={40} stroke={1.5} />
      <p class="headline">{t('browse.search.noResults.title', { term: term.trim() })}</p>
      <p class="footnote">{t('browse.search.noResults.body')}</p>
    </div>
  {:else if !term && !genreLabel}
    <div class="idle">
      {#if recent.length > 0}
        <section>
          <header>
            <h2 class="title-3">{t('browse.search.recent')}</h2>
            <button class="link" onclick={clearRecent}>{t('browse.search.clear')}</button>
          </header>
          <div class="chips">
            {#each recent as r, i (r)}
              <button class="pill enter" style:--i={i} onclick={() => (term = r)}><Icon name="search" size={13} stroke={2} /> {r}</button>
            {/each}
          </div>
        </section>
      {/if}
      {#if genres.length > 0}
        <section>
          <header><h2 class="title-3">{t('browse.search.byGenre')}</h2></header>
          <div class="tiles">
            {#each genres as g, i (g)}
              <button class="tile enter" style:--i={Math.min(i, 12)} onclick={() => searchGenre(g)}>
                <span>{g}</span>
              </button>
            {/each}
          </div>
        </section>
      {/if}
    </div>
  {/if}

  {#if live.length && term.trim().length >= 2 && !picked}
    <section class="live">
      <header><h2 class="title-3">{t('browse.search.live')}</h2></header>
      <div class="chips">
        {#each live as item (itemKey(item))}
          <button class="pill" onclick={() => openLive(item)}><Icon name="live" size={13} stroke={2} /> {liveLabel(item)}</button>
        {/each}
      </div>
    </section>
  {/if}
</div>

<style>
  .search {
    padding: 28px 0 72px;
  }
  .large-title {
    padding: 0 var(--gutter);
    margin-bottom: 18px;
  }
  .field-wrap {
    padding: 0 var(--gutter);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 880px;
    height: 54px;
    padding: 0 14px 0 18px;
    border-radius: var(--r-md);
    background: var(--fill-2);
    box-shadow: inset 0 0 0 1px transparent;
    cursor: text;
  }
  .bar:hover {
    background: var(--fill-3);
  }
  .bar:focus-within {
    background: var(--fill-3);
    box-shadow: inset 0 0 0 1px var(--hairline);
  }
  .lead {
    display: grid;
    color: var(--label-3);
  }
  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    background: transparent;
    border: 0;
    padding: 0;
    font-size: var(--fs-title-3);
    font-weight: 500;
    letter-spacing: -0.014em;
    user-select: text;
  }
  input:focus-visible {
    box-shadow: none;
  }
  input::placeholder {
    color: var(--label-3);
  }
  input::-webkit-search-cancel-button {
    display: none;
  }
  .clear {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--bg);
    background: var(--label-3);
    transition:
      transform var(--t-med) var(--spring);
  }
  .clear:hover {
    background: var(--label-2);
  }
  .clear:active {
    transform: scale(0.9);
  }
  .spin {
    width: 16px;
    height: 16px;
    border: 2px solid var(--label-3);
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin var(--t-spin) linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .categories {
    display: flex;
    gap: 8px;
    padding: 18px var(--gutter) 4px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .cat {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 14px;
    border-radius: 999px;
    background: var(--fill-2);
    color: var(--label-2);
    font-size: var(--fs-callout);
    font-weight: 560;
    transition:
      transform var(--t-med) var(--spring);
  }
  .cat:not(.on):focus-visible,
  .cat:hover {
    background: var(--fill-3);
    color: var(--label);
  }
  .cat:active {
    transform: scale(0.96);
  }
  .cat:focus-visible {
    border-radius: 999px;
  }
  .cat.on {
    background: var(--label);
    color: #000;
  }
  .cat .n {
    font-size: var(--fs-caption);
    font-variant-numeric: tabular-nums;
    opacity: 0.6;
  }
  .genre-tag,
  .genre-tag:hover {
    background: var(--label);
    color: #000;
  }

  .results {
    padding-top: 18px;
  }
  .grid {
    --min: calc(clamp(140px, 11vw, 200px) * var(--card-scale, 1));
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--min), 1fr));
    gap: calc(28px * var(--density, 1)) calc(clamp(14px, 1.3vw, 22px) * var(--density, 1));
    padding: 26px var(--gutter) 0;
  }
  .grid.thumb {
    --min: calc(clamp(240px, 19vw, 340px) * var(--card-scale, 1));
  }
  .enter {
    animation: rise var(--t-slow) var(--ease-out) both;
    animation-delay: calc(var(--i) * var(--t-stagger));
  }
  .error {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 18px var(--gutter) 0;
    color: var(--danger);
    font-size: var(--fs-callout);
  }
  .none {
    display: grid;
    justify-items: center;
    gap: 4px;
    padding: 80px var(--gutter);
    text-align: center;
    color: var(--label-3);
  }
  .none p {
    margin: 0;
  }
  .none .headline {
    margin-top: 12px;
    color: var(--label);
  }

  .idle {
    display: flex;
    flex-direction: column;
    gap: 34px;
    padding: 34px var(--gutter) 0;
  }
  .live {
    padding: 34px var(--gutter) 0;
  }
  .live h2 {
    margin: 0 0 14px;
  }
  .idle header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  .idle h2 {
    margin: 0;
  }
  .link {
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .link:hover,
  .link:focus-visible {
    color: var(--label);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 34px;
    padding: 0 14px;
    border-radius: 999px;
    background: var(--fill-2);
    color: var(--label-2);
    font-size: var(--fs-callout);
    font-weight: 500;
    transition:
      transform var(--t-med) var(--spring);
  }
  .pill:focus-visible,
  .pill:hover {
    background: var(--fill-3);
    color: var(--label);
  }
  .pill:active {
    transform: scale(0.96);
  }
  .pill:focus-visible {
    border-radius: 999px;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 14px;
  }
  .tile {
    position: relative;
    isolation: isolate;
    height: 96px;
    padding: 14px 16px;
    display: flex;
    align-items: flex-end;
    border-radius: var(--r-md);
    text-align: left;
    background: var(--bg-elevated-2);
    font-size: var(--fs-headline);
    font-weight: 650;
    letter-spacing: -0.01em;
    transition: transform var(--t-slow) var(--spring);
  }
  .tile::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    box-shadow: var(--shadow-2);
    opacity: 0;
    transition: opacity var(--t-med) var(--ease);
  }
  .tile:hover,
  .tile:focus-visible {
    will-change: transform;
    transform: scale(1.04);
  }
  .tile:hover::after,
  .tile:focus-visible::after {
    opacity: 1;
  }
  .tile:active {
    transform: scale(0.98);
  }
  .tile:focus-visible {
    border-radius: var(--r-md);
  }
</style>
