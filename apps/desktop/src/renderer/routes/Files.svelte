<script lang="ts">
  // Folder browser of a file source (file-sources-spec §9.1): breadcrumbs, sort (name, date modified, size),
  // grid or list (remembered per source), Refresh, and at the root the source's own Continue row.
  // Folders open here; a video plays from the list, or opens its page from a grid card.
  import { onMount, untrack } from 'svelte';
  import { crumbs as crumbsOf, decodeId, ROOT_ID } from '../../shared/files/ids';
  import type { BaseItem } from '../../shared/models';
  import BrowseMenu from '../components/BrowseMenu.svelte';
  import Card from '../components/Card.svelte';
  import Icon, { type IconName } from '../components/Icon.svelte';
  import Row from '../components/Row.svelte';
  import { apiFor, dedupe, invalidateApiCache, itemKey, itemPath, playQueueFor } from '../lib/api';
  import { w } from '../lib/bridge';
  import { progress, runtime } from '../lib/format';
  import { fmt, t } from '../lib/i18n.svelte';
  import { scrollMemory } from '../lib/motion';
  import { resumeAt } from '../lib/resume.svelte';
  import { navigate } from '../lib/router.svelte';
  import { dataVersion, errorMessage, sessionFor, toast } from '../lib/stores.svelte';

  let { id, server }: { id: string; server?: string } = $props();
  const sid = untrack(() => server ?? '');
  const api = apiFor(sid);
  const PAGE = 200;
  const PREFS = 'wicaby.files.prefs';

  const session = $derived(sessionFor(sid));
  const offline = $derived(session?.status === 'offline');
  const rel = $derived(decodeId(id));
  const trail = $derived(rel === null ? [] : crumbsOf(rel));

  type Sort = 'SortName' | 'DateModified' | 'Size';
  function loadPrefs(): { view: 'grid' | 'list'; sort: Sort; desc: boolean } {
    try {
      const all = JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Record<string, { view?: string; sort?: string; desc?: boolean }>;
      const p = all[sid] ?? {};
      return { view: p.view === 'list' ? 'list' : 'grid', sort: (['SortName', 'DateModified', 'Size'] as const).find((s) => s === p.sort) ?? 'SortName', desc: p.desc === true };
    } catch {
      return { view: 'grid', sort: 'SortName', desc: false };
    }
  }
  const initial = loadPrefs();
  let view = $state(initial.view);
  let sort = $state<Sort>(initial.sort);
  let desc = $state(initial.desc);

  function savePrefs(): void {
    try {
      const all = JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Record<string, unknown>;
      all[sid] = { view, sort, desc };
      localStorage.setItem(PREFS, JSON.stringify(all));
    } catch {
      // Best effort: the defaults apply next time.
    }
  }

  let items = $state<BaseItem[]>([]);
  let total = $state(0);
  let truncated = $state(false);
  let loading = $state(true);
  let error = $state('');
  let resume = $state<BaseItem[]>([]);
  let sentinel: HTMLDivElement | undefined = $state();
  let generation = 0;

  async function page(start: number) {
    return (await api.items({ ParentId: id, SortBy: sort, SortOrder: desc ? 'Descending' : 'Ascending', StartIndex: start, Limit: PAGE })) as Awaited<ReturnType<typeof api.items>> & { Truncated?: boolean };
  }

  async function reset(): Promise<void> {
    const gen = ++generation;
    loading = true;
    error = '';
    try {
      const res = await page(0);
      if (gen !== generation) return;
      items = dedupe(res.Items);
      total = res.TotalRecordCount;
      truncated = Boolean(res.Truncated);
    } catch (err) {
      if (gen === generation) {
        items = [];
        error = errorMessage(err);
      }
    } finally {
      if (gen === generation) loading = false;
    }
    if (id === ROOT_ID) void api.resume(24).then((r) => gen === generation && (resume = r.Items), () => (resume = []));
  }

  async function more(): Promise<void> {
    if (loading || items.length >= total) return;
    const gen = generation;
    loading = true;
    try {
      const res = await page(items.length);
      if (gen === generation) items = dedupe([...items, ...res.Items]);
    } catch (err) {
      if (gen === generation) error = errorMessage(err);
    } finally {
      if (gen === generation) loading = false;
    }
  }

  $effect(() => {
    void sort;
    void desc;
    void dataVersion.userData;
    void offline;
    // Untracked: page() reads the session store (api.items), and a session push must not reload page 1.
    untrack(() => void reset());
  });

  $effect(() => {
    if (!sentinel || loading || error) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && void more(), { root: document.getElementById('main-scroller'), rootMargin: '1200px 0px' });
    io.observe(sentinel);
    return () => io.disconnect();
  });

  onMount(scrollMemory);

  async function refresh(): Promise<void> {
    try {
      await w.files.refresh(sid);
    } catch (err) {
      toast('error', errorMessage(err));
    }
    invalidateApiCache();
    await reset();
  }

  function onSort(v: string): void {
    if (v === 'asc' || v === 'desc') desc = v === 'desc';
    else sort = v as Sort;
    savePrefs();
  }

  function setView(v: 'grid' | 'list'): void {
    view = v;
    savePrefs();
  }

  async function open(item: BaseItem): Promise<void> {
    if (item.IsFolder) return navigate(itemPath(item));
    try {
      const q = await playQueueFor(item);
      const at = await resumeAt(item.UserData?.PlaybackPositionTicks, item.Name);
      if (at === null) return;
      await w.playback.play({ ...q, startPositionTicks: at });
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  const SORTS: { key: Sort; label: string }[] = [
    { key: 'SortName', label: 'files.sort.name' },
    { key: 'DateModified', label: 'files.sort.modified' },
    { key: 'Size', label: 'files.sort.size' },
  ];
  const sortLabel = $derived(t(SORTS.find((s) => s.key === sort)?.label ?? 'files.sort.name'));
  const protocolIcon = (p?: string): IconName => (p === 'webdav' ? 'globe' : p === 'smb' ? 'server' : 'folder');
  const lineIcon = (it: BaseItem): IconName => (it.IsFolder ? 'folder' : 'film'); // i18n-ignore (icon name)
  const folderName = $derived(trail.length > 1 ? trail[trail.length - 1].name : (session?.server.name ?? ''));
</script>

<div class="files">
  <header class="head">
    <nav class="crumbs" aria-label={t('files.section')}>
      {#each trail as c, i (c.id)}
        {#if i > 0}<Icon name="chevronRight" size={13} />{/if}
        {#if i === trail.length - 1}
          <span class="crumb current" aria-current="page">{i === 0 ? (session?.server.name ?? '') : c.name}</span>
        {:else}
          <button type="button" class="crumb" onclick={() => navigate(`/files/${sid}/${c.id}`)}>
            {#if i === 0}<Icon name={protocolIcon(session?.server.files?.protocol)} size={14} />{/if}
            {i === 0 ? (session?.server.name ?? '') : c.name}
          </button>
        {/if}
      {/each}
    </nav>
    <h1 class="large-title">{folderName}</h1>
    {#if session?.server.files?.display && id === ROOT_ID}<p class="where">{session.server.files.display}</p>{/if}
  </header>

  {#if id === ROOT_ID && resume.length > 0}
    <Row title={t('files.continue')} items={resume} variant="thumb" />
  {/if}

  <div class="toolbar">
    {#if total > 0}<span class="count">{t('common.count.items', { count: total })}</span>{/if}
    <div class="spacer"></div>
    <div class="segmented" role="tablist" aria-label={t('files.view.grid')}>
      <button role="tab" class:on={view === 'grid'} aria-selected={view === 'grid'} title={t('files.view.grid')} aria-label={t('files.view.grid')} onclick={() => setView('grid')}><Icon name="grid" size={15} /></button>
      <button role="tab" class:on={view === 'list'} aria-selected={view === 'list'} title={t('files.view.list')} aria-label={t('files.view.list')} onclick={() => setView('list')}><Icon name="list" size={15} /></button>
    </div>
    <BrowseMenu
      label={sortLabel}
      icon="sort"
      align="end"
      options={[
        ...SORTS.map((s) => ({ value: s.key, label: t(s.label), checked: sort === s.key })),
        { value: 'asc', label: t('browse.library.order.asc'), checked: !desc, section: t('browse.library.order.label') },
        { value: 'desc', label: t('browse.library.order.desc'), checked: desc },
      ]}
      onselect={onSort}
    />
    <button type="button" class="btn icon-btn" onclick={refresh} title={t('files.refresh')} aria-label={t('files.refresh')}><Icon name="refresh" size={16} /></button>
  </div>

  {#if error}
    <div class="error"><Icon name="exclamation" size={16} /> {error}</div>
  {/if}
  {#if truncated}<p class="note">{t('files.list.truncated')}</p>{/if}

  {#if view === 'grid'}
    <div class="grid">
      {#each items as item (itemKey(item))}
        <div class="cell"><Card {item} variant="poster" /></div>
      {/each}
      {#if loading && items.length === 0}
        {#each Array(12) as _, i (i)}
          <div aria-hidden="true"><div class="sk-frame skeleton"></div></div>
        {/each}
      {/if}
    </div>
  {:else}
    <ul class="rows" role="list">
      {#each items as item (itemKey(item))}
        {@const pct = progress(item)}
        <li>
          <button type="button" class="line" onclick={() => open(item)}>
            <span class="glyph"><Icon name={lineIcon(item)} size={17} /></span>
            <span class="name">{item.Name}</span>
            {#if pct > 0 && !item.UserData?.Played}<span class="bar" aria-hidden="true"><span style:transform="scaleX({pct / 100})"></span></span>{/if}
            {#if item.UserData?.Played}<span class="done"><Icon name="check" size={13} stroke={2.4} /></span>{/if}
            <span class="meta">{item.RunTimeTicks ? runtime(item.RunTimeTicks) : ''}</span>
            <span class="meta date">{item.DateCreated ? fmt.date(item.DateCreated, { dateStyle: 'medium' }) : ''}</span>
            {#if item.IsFolder}<Icon name="chevronRight" size={14} />{:else}<span class="play"><Icon name="play" size={12} fill stroke={0} /></span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if !loading && items.length === 0 && !error}
    <div class="empty">
      <Icon name="folderOpen" size={36} stroke={1.5} />
      <p class="headline">{t('files.list.empty')}</p>
    </div>
  {/if}
  <div bind:this={sentinel} class="sentinel"></div>
</div>

<style>
  .files {
    padding: 22px 0 72px;
  }
  .head {
    padding: 0 var(--gutter);
  }
  .head .large-title {
    margin: 4px 0 0;
  }
  .where {
    margin: 4px 0 0;
    font-size: var(--fs-callout);
    color: var(--label-3);
  }
  .crumbs {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    color: var(--label-3);
    font-size: var(--fs-callout);
  }
  .crumb {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border-radius: 999px;
    color: var(--label-2);
  }
  .crumb:hover,
  .crumb:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  .crumb.current {
    color: var(--label);
    font-weight: 560;
  }
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px var(--gutter);
    margin: 10px 0 6px;
  }
  .toolbar::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background: var(--material);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    box-shadow: 0 1px 0 var(--separator);
    opacity: 0;
    animation: bar-in linear both;
    animation-timeline: scroll(nearest block);
    animation-range: 40px 110px;
  }
  @keyframes bar-in {
    to {
      opacity: 1;
    }
  }
  .count {
    font-size: var(--fs-callout);
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
  }
  .spacer {
    flex: 1;
  }
  .icon-btn {
    width: 34px;
    padding: 0;
    justify-content: center;
  }
  .segmented {
    display: inline-flex;
    padding: 3px;
    gap: 2px;
    border-radius: 999px;
    background: var(--fill-2);
  }
  .segmented button {
    display: inline-grid;
    place-items: center;
    height: 28px;
    width: 34px;
    border-radius: 999px;
    color: var(--label-2);
  }
  .segmented button.on {
    background: var(--fill-4);
    color: var(--label);
    box-shadow: var(--shadow-1);
  }
  .grid {
    --min: calc(clamp(140px, 11vw, 200px) * var(--card-scale, 1));
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--min), 1fr));
    gap: calc(28px * var(--density, 1)) calc(clamp(14px, 1.3vw, 22px) * var(--density, 1));
    padding: 8px var(--gutter) 0;
  }
  .cell:hover,
  .cell:focus-within {
    position: relative;
    z-index: 1;
  }
  .sk-frame {
    border-radius: var(--r-md);
    aspect-ratio: 2 / 3;
  }
  .rows {
    list-style: none;
    margin: 4px var(--gutter) 0;
    padding: 4px;
    border-radius: var(--r-md);
    background: var(--fill-1);
  }
  .line {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 44px;
    padding: 6px 12px;
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--label);
  }
  .line:hover,
  .line:focus-visible {
    background: var(--fill-2);
  }
  .glyph {
    display: inline-grid;
    place-items: center;
    width: 28px;
    color: var(--label-2);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-body);
  }
  .meta {
    color: var(--label-3);
    font-size: var(--fs-footnote);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .meta.date {
    min-width: 96px;
    text-align: right;
  }
  .bar {
    width: 64px;
    height: 4px;
    border-radius: 2px;
    background: var(--fill-3);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
  }
  .done {
    color: var(--accent);
  }
  .play {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--fill-3);
    color: var(--label);
  }
  .error,
  .note {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 var(--gutter) 12px;
    padding: 10px 14px;
    border-radius: var(--r-sm);
    background: var(--fill-1);
    color: var(--label-2);
    font-size: var(--fs-callout);
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: 4px;
    padding: 72px var(--gutter);
    color: var(--label-3);
    text-align: center;
  }
  .empty p {
    margin: 0;
  }
  .empty .headline {
    margin-top: 10px;
    color: var(--label);
  }
  .sentinel {
    height: 1px;
  }
</style>
