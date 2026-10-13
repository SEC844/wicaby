<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { atParam, dayKey, dayStart, leftForDay, leftForDaypart, MINUTE, PAGE_MS, parseAt, parseDayKey } from '../../shared/livetv/anchor';
  import type { DayChip, DaypartId } from '../../shared/livetv/anchor';
  import { lensFromParam, lensToParam, stepLens } from '../../shared/livetv/lens';
  import { CATEGORIES } from '../../shared/livetv/model';
  import type { Category, ChannelRow, LensRef, ProgramLite } from '../../shared/livetv/model';
  import type { PendingJump } from '../../shared/livetv/nav';
  import Guide from '../components/Guide.svelte';
  import Icon from '../components/Icon.svelte';
  import ChannelManager from '../components/livetv/ChannelManager.svelte';
  import DetailBand from '../components/livetv/DetailBand.svelte';
  import GuideSearch from '../components/livetv/GuideSearch.svelte';
  import GuideToolbar from '../components/livetv/GuideToolbar.svelte';
  import Segmented from '../components/Segmented.svelte';
  import { fmt, t } from '../lib/i18n.svelte';
  import { currentLiveServer, liveServer, storeFor } from '../lib/livetv.svelte';
  import type { LiveTvStore } from '../lib/livetv.svelte';
  import { scrollMemory } from '../lib/motion';
  import { router } from '../lib/router.svelte';
  import { liveTv, serverName, toast } from '../lib/stores.svelte';
  import OnNow from './livetv/OnNow.svelte';
  import Recordings from './livetv/Recordings.svelte';
  import Scheduled from './livetv/Scheduled.svelte';

  // Live TV (§3.1): four tabs, En direct · Guide · Enregistrements · Programmés. URL state
  // /livetv?tab=guide&lens=fav&cat=sports&day=2026-10-12&at=2100&ch=<id>&prog=<id>: lens, category
  // and day picks push a history entry and scrolling replaces the current one, so back and forward
  // restore the lens, the day and the time. ?tab=channels (the old tab) redirects to now.
  type Tab = 'now' | 'guide' | 'recordings' | 'scheduled';
  const TABS: Tab[] = ['now', 'guide', 'recordings', 'scheduled'];
  const query = $derived(router.route.query);
  const tab = $derived<Tab>(TABS.find((v) => v === query.get('tab')) ?? 'now');

  const server = $derived(currentLiveServer());
  const servers = $derived(liveTv.servers.map((id) => ({ value: id, label: serverName(id) })));
  let store = $state.raw<LiveTvStore | null>(storeFor(currentLiveServer()));
  let guide = $state<ReturnType<typeof Guide>>();
  let toolbarEl = $state<HTMLDivElement>();
  let opened: Promise<unknown> = Promise.resolve();

  onMount(scrollMemory);

  $effect(() => {
    const sid = server;
    const s = untrack(() => storeFor(sid));
    store = s;
    opened = s ? s.open().catch(() => undefined) : Promise.resolve();
  });

  // ---- URL state ----

  let applied = '';
  function writeQuery(patch: Record<string, string | null>, push: boolean): void {
    const next = new URLSearchParams(router.route.query);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    applied = qs;
    if (qs === router.route.query.toString()) return;
    history[push ? 'pushState' : 'replaceState'](null, '', `#/livetv?${qs}`);
    router.route = { ...router.route, query: next };
  }

  function timeParam(q: URLSearchParams): number | null {
    const day = parseDayKey(q.get('day'));
    return day === null ? null : parseAt(day, q.get('at'));
  }

  const catParam = (v: string | null): Category | null => (CATEGORIES.find((c) => c === v) ?? null);

  // Applies a URL that this page did not write (first open, back / forward, a link).
  $effect(() => {
    const qs = query.toString();
    const s = store;
    const g = guide;
    if (!s || qs === applied) return;
    untrack(() => {
      const first = applied === '';
      applied = qs;
      if (query.get('tab') === 'channels') return writeQuery({ tab: 'now' }, false);
      // First open without a lens keeps the synced last lens; a history entry without one means Toutes.
      if (!first || query.get('lens') !== null || query.get('cat') !== null) {
        const lp = query.get('lens');
        const cp = query.get('cat');
        const apply = (): void => {
          const { lens, category } = lensFromParam(lp);
          s.setLens(lens);
          void s.setCategory(catParam(cp) ?? category ?? null);
        };
        apply();
        // The synced lens loads after this: on first open the URL wins over it, unless a pick replaced the URL meanwhile.
        if (first)
          void opened
            .then(() => s.prefsReady())
            .then(() => {
              const q = router.route.query;
              if (store === s && q.get('lens') === lp && q.get('cat') === cp) apply();
            });
      }
      if (!g) return;
      const at = timeParam(query);
      if (at !== null && Math.abs(g.viewLeft() - at) > MINUTE) g.goTo(at);
      const ch = query.get('ch');
      if (ch) g.jump({ channelId: ch, programId: query.get('prog') ?? undefined, time: at ?? s.now() });
    });
  });

  function setTab(v: Tab): void {
    writeQuery({ tab: v }, false);
  }

  // ---- Guide wiring ----

  let viewLeft = $state(Date.now());
  let laneMs = $state(3 * 3_600_000);
  let viewTimer: ReturnType<typeof setTimeout> | undefined;
  function flushView(): void {
    clearTimeout(viewTimer);
    if (tab === 'guide') writeQuery({ day: dayKey(viewLeft), at: atParam(viewLeft) }, false);
  }
  function onview(left: number, lane: number): void {
    viewLeft = left;
    laneMs = lane;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(flushView, 400);
  }

  function pickTime(left: number): void {
    flushView();
    writeQuery({ day: dayKey(left), at: atParam(left) }, true);
    guide?.goTo(left);
  }

  function onday(d: DayChip): void {
    pickTime(leftForDay(d.start, viewLeft, store?.anchor.mode === 'live'));
  }

  function ondaypart(id: DaypartId): void {
    if (id === 'now') {
      flushView();
      guide?.goNow();
      return;
    }
    pickTime(leftForDaypart(dayStart(viewLeft + laneMs / 3), id));
  }

  function onlens(l: LensRef): void {
    if (!store) return;
    flushView();
    store.setLens(l);
    writeQuery({ lens: lensToParam(l) }, true);
  }

  function oncategory(c: Category | null): void {
    if (!store) return;
    flushView();
    void store.setCategory(c);
    writeQuery({ cat: c }, true);
  }

  function lensStep(step: -1 | 1 | 'all'): void {
    if (!store) return;
    onlens(step === 'all' ? { kind: 'all' } : stepLens(store.lenses, store.lens, step));
  }

  // The guide reopens on the last channel's row (back from the player), or the URL's channel.
  function initialFor(s: LiveTvStore): { left?: number; jump?: PendingJump } {
    const at = timeParam(query) ?? undefined;
    const ch = query.get('ch') ?? s.mru[0];
    return { left: at, jump: ch ? { channelId: ch, programId: query.get('prog') ?? undefined, time: at !== undefined ? at + 30 * MINUTE : s.now() } : undefined };
  }

  function focusToolbar(): void {
    toolbarEl?.querySelector<HTMLElement>('[data-day][aria-pressed="true"], [data-day]')?.focus();
  }

  // ---- Detail band (per device), search, channel menu, manager ----

  const BAND_KEY = 'wicaby.livetv.detailBand';
  let band = $state(false);
  try {
    band = localStorage.getItem(BAND_KEY) === '1';
  } catch {
    // default off
  }
  function toggleBand(): void {
    band = !band;
    try {
      localStorage.setItem(BAND_KEY, band ? '1' : '0');
    } catch {
      // per device only
    }
  }
  let focused = $state.raw<{ p: ProgramLite | null; c: ChannelRow | null }>({ p: null, c: null });

  let searchOpen = $state(false);
  let pendingJump = $state<PendingJump | null>(null);
  async function onpick(j: PendingJump): Promise<void> {
    if (tab !== 'guide') {
      pendingJump = j;
      setTab('guide');
      await tick();
      pendingJump = null; // the guide read it when it mounted
      return;
    }
    guide?.jump(j);
  }

  let manageOpen = $state(false);
  let manageChannel = $state<string | undefined>();
  let menu = $state<{ r: ChannelRow; x: number; y: number } | null>(null);
  let menuEl = $state<HTMLDivElement>();
  let menuOpener: HTMLElement | null = null;

  function openMenu(r: ChannelRow, x: number, y: number): void {
    menuOpener = document.activeElement as HTMLElement | null;
    menu = { r, x: Math.min(x, innerWidth - 240), y: Math.min(y, innerHeight - 160) };
    void tick().then(() => menuEl?.querySelector<HTMLElement>('button')?.focus());
  }
  function closeMenu(): void {
    menu = null;
    menuOpener?.focus({ preventScroll: true });
  }
  function menuAction(fn: () => void): void {
    fn();
    closeMenu();
  }

  const conflicts = $derived(store?.dvr.conflicts ?? 0);
  const downService = $derived(store?.services.find((s) => !s.ok) ?? null);
</script>

<svelte:window onkeydown={(e) => menu && e.key === 'Escape' && (e.preventDefault(), closeMenu())} onpointerdown={(e) => menu && !menuEl?.contains(e.target as Node) && (menu = null)} />

<div class="page live" class:full={tab === 'guide'}>
  <header>
    <h1 class="page-title">{t('livetv.title')}</h1>
    <div class="tabs" role="tablist" aria-label={t('livetv.tabs.label')}>
      {#each TABS as v (v)}
        <button role="tab" aria-selected={tab === v} class:on={tab === v} onclick={() => setTab(v)}>
          {t(`livetv.tabs.${v}`)}
          {#if v === 'scheduled' && conflicts > 0}<span class="badge mono" aria-label={t('livetv.scheduled.badgeAria', { count: conflicts })}>{conflicts}</span>{/if}
        </button>
      {/each}
    </div>
    <span class="actions">
      {#if servers.length > 1 && server}
        <Segmented label={t('livetv.server')} value={server} options={servers} onchange={(v) => (liveServer.id = v)} />
      {/if}
      {#if store && (tab === 'guide' || tab === 'now')}
        <button class="btn icon" onclick={() => (searchOpen = true)} aria-label={t('livetv.actions.search')} title={t('livetv.actions.search')}><Icon name="search" size={16} /></button>
        <button class="btn icon" onclick={() => ((manageChannel = undefined), (manageOpen = true))} aria-label={t('livetv.actions.manage')} title={t('livetv.actions.manage')}><Icon name="ellipsis" size={16} /></button>
      {/if}
    </span>
  </header>

  {#if !store || !store.enabled}
    <div class="state"><Icon name="live" size={36} /><p class="footnote">{t('livetv.guide.noAccess')}</p></div>
  {:else if store.channelsState === 'error' && !store.channels.length}
    <div class="state">
      <Icon name="exclamation" size={36} />
      <p class="footnote">{store.channelsError}</p>
      <button class="btn" onclick={() => void store?.loadChannels()}>{t('livetv.guide.retry')}</button>
    </div>
  {:else}
    {#if store.offline}<p class="banner footnote">{t('livetv.guide.offline', { when: fmt.relative(store.channelsUpdatedAt) })}</p>{/if}
    {#if downService}<p class="banner footnote">{t('livetv.guide.sourceDown', { message: downService.message || downService.name })}</p>{/if}

    {#if tab === 'now'}
      <OnNow {store} onguide={() => setTab('guide')} />
    {:else if tab === 'guide'}
      <div bind:this={toolbarEl}>
        <GuideToolbar {store} at={viewLeft + laneMs / 3} detail={band} ondetail={toggleBand} {onlens} {oncategory} {onday} {ondaypart} onpage={(d) => guide?.page(d * PAGE_MS)} />
      </div>
      {#if band}<DetailBand {store} program={focused.p} channel={focused.c} />{/if}
      <div class="guide-wrap" class:band>
        {#key store}
          <Guide
            bind:this={guide}
            {store}
            initial={pendingJump ? { jump: pendingJump } : initialFor(store)}
            onexit={focusToolbar}
            {onview}
            onfocus={(p, c) => (focused = { p, c })}
            onlens={lensStep}
            onsearch={() => (searchOpen = true)}
            onmenu={openMenu}
          />
        {/key}
      </div>
    {:else if tab === 'recordings'}
      <Recordings {store} />
    {:else}
      <Scheduled {store} />
    {/if}

    <GuideSearch {store} open={searchOpen} onclose={() => (searchOpen = false)} {onpick} />
    <ChannelManager {store} open={manageOpen} onclose={() => (manageOpen = false)} channelId={manageChannel} />
  {/if}
</div>

{#if menu && store}
  {@const s = store}
  {@const r = menu.r}
  <div class="menu material" role="menu" tabindex="-1" bind:this={menuEl} style:left="{menu.x}px" style:top="{menu.y}px">
    <button role="menuitem" onclick={() => menuAction(() => void s.toggleFavorite(r.id))}>
      <Icon name="star" size={14} />{t(r.favorite ? 'livetv.channel.favoriteRemove' : 'livetv.channel.favoriteAdd')}
    </button>
    <button role="menuitem" onclick={() => menuAction(() => (s.setHidden(r.id, true), toast('info', t('livetv.channel.hiddenToast'))))}>
      <Icon name="eye" size={14} />{t('livetv.channel.hide')}
    </button>
    <button role="menuitem" onclick={() => menuAction(() => ((manageChannel = r.id), (manageOpen = true)))}>
      <Icon name="listPlus" size={14} />{t('livetv.channel.addToGroup')}
    </button>
  </div>
{/if}

<style>
  header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 16px;
    margin-bottom: 18px;
  }
  header .page-title {
    margin: 0 8px 0 0;
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 3px;
    border-radius: 12px;
    background: var(--fill-1);
  }
  .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 14px;
    border-radius: 9px;
    font-size: var(--fs-subheadline, var(--fs-footnote));
    font-weight: 560;
    color: var(--label-2);
    transition: background-color var(--t-fast) var(--ease);
  }
  .tabs button:is(:hover, :focus-visible) {
    background: var(--fill-3);
    color: var(--label);
  }
  .tabs button.on {
    background: var(--fill-4);
    color: var(--label);
  }
  .badge {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--label);
    color: var(--bg);
    font-size: 11px;
    line-height: 18px;
    text-align: center;
  }
  .actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }
  .live.full {
    padding-bottom: 24px;
  }
  .guide-wrap {
    height: max(360px, calc(100vh - var(--titlebar) - 230px));
  }
  .guide-wrap.band {
    height: max(320px, calc(100vh - var(--titlebar) - 374px));
  }
  .banner {
    margin: 0 0 12px;
    padding: 8px 14px;
    border-radius: var(--r-md);
    background: var(--fill-1);
  }
  .state {
    display: grid;
    justify-items: center;
    gap: 8px;
    padding: 80px 0;
    color: var(--label-3);
  }
  .menu {
    position: fixed;
    z-index: 50;
    display: grid;
    min-width: 220px;
    padding: 6px;
    border-radius: var(--r-md);
    box-shadow: var(--shadow-3);
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--label);
  }
  .menu button:is(:hover, :focus-visible) {
    background: var(--fill-4);
  }
  @media (forced-colors: active) {
    .tabs button.on,
    .tabs button:focus-visible {
      outline: 2px solid Highlight;
    }
  }
</style>
