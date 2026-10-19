<script lang="ts">
  // Android TV HomeTab (Main.kt): the hero over a full-bleed backdrop, then the user's rows in their order (Settings >
  // Interface > Home). The page settles the focused row at 26 % of the screen (PivotSpec); focus in the hero scrolls
  // back to the top. The backdrop follows the focused card after 280 ms, the hero at once.
  import type { BaseItem } from '$shared/models';
  import Backdrop from '../components/Backdrop.svelte';
  import Hero from '../components/Hero.svelte';
  import LiveCard from '../components/livetv/LiveCard.svelte';
  import MediaRow from '../components/MediaRow.svelte';
  import MemoryCard from '../components/MemoryCard.svelte';
  import Spinner from '../components/Spinner.svelte';
  import ThemeHint from '../components/ThemeHint.svelte';
  import type { Api } from '../lib/api';
  import { continueSubtitle, loadContinue } from '../lib/continue-watching';
  import { BECAUSE, becauseSeeds, defaults, latest, latestViewId, LIVE_NOW, MEMORIES, NEXT_UP, RESUME, UPCOMING, unseen } from '../lib/home-rows';
  import { liveTv } from '../lib/livetv.svelte';
  import { normalizeProgram } from '$shared/livetv/model';
  import { homeMemories, memoryTimeline, type MemoryGroup } from '../lib/photos.svelte';
  import { t } from '../lib/i18n.svelte';
  import { useLoad } from '../lib/load.svelte';
  import { itemRoute, nav } from '../lib/nav.svelte';
  import { play } from '../lib/playback';
  import { clamp, pivotDelta } from '../lib/scroll';
  import { arrange, homeRows, settings } from '../lib/settings.svelte';
  import { prefs } from '../lib/session.svelte';

  let { api, views, onscrolled }: { api: Api; views: BaseItem[]; onscrolled: (scrolled: boolean) => void } = $props();

  const serverId = $derived(prefs.session!.server.id);
  const user = $derived(`${serverId}/${prefs.session!.userId}`);
  const merged = $derived(settings.mergeContinue.value);
  // The libraries with a "Recently Added" row: all but playlists, Live TV and folders (HomeLayout.kt latestViews).
  const latestViews = $derived(views.filter((v) => !['playlists', 'livetv', 'folders'].includes(v.CollectionType ?? '')));
  const hasLive = $derived(views.some((v) => v.CollectionType === 'livetv'));
  const hasPhotos = $derived(views.some((v) => v.CollectionType === 'photos'));
  const homeDefaults = $derived(defaults(latestViews.map((v) => v.Id), merged, hasLive, hasPhotos));
  const pref = $derived(homeRows(user, homeDefaults));
  const shown = $derived(arrange(homeDefaults, pref).filter((id) => !pref.hidden.includes(id)));

  // #8: unwatched titles only when asked, all of them when everything is watched (Main.kt heroItems).
  const pickHero = async (unwatched: boolean) =>
    (
      await api.items({
        IncludeItemTypes: 'Movie,Series', Recursive: true, SortBy: 'Random', Limit: 8,
        ImageTypes: 'Backdrop', EnableImageTypes: 'Primary,Backdrop,Logo,Thumb', Filters: unwatched ? 'IsUnplayed' : undefined,
      })
    ).Items.filter((i) => i.BackdropImageTags?.length).slice(0, 6);
  const hideWatched = $derived(settings.heroHideWatched.value);
  const hero = useLoad(
    () => (hideWatched ? 'hero-unwatched' : 'hero'),
    async () => {
      if (!hideWatched) return pickHero(false);
      const list = await pickHero(true);
      return list.length ? list : pickHero(false);
    },
    // A new draw per launch, stable for the session (Android: refresh = false, no disk cache).
    { refresh: false },
  );
  const cont = useLoad(() => (merged ? 'continue' : 'continue-off'), () => (merged ? loadContinue(api, serverId) : Promise.resolve(null)), { persist: true });
  const resume = useLoad(() => (merged ? 'resume-off' : 'resume'), () => (merged ? Promise.resolve([]) : api.resume()), { persist: true });
  const nextUp = useLoad(() => (merged ? 'nextup-off' : 'nextup'), () => (merged ? Promise.resolve([]) : api.nextUp()), { persist: true });
  const upcoming = useLoad(() => 'upcoming', () => api.upcoming(), { persist: true });
  // One load for every Recently Added row: their order and visibility change without refetching.
  const latests = useLoad(
    () => `latest:${latestViews.map((v) => v.Id).join(',')}`,
    async () => Object.fromEntries(await Promise.all(latestViews.map(async (v) => [v.Id, await api.latest(v.Id).catch(() => [])] as const))),
    { persist: true },
  );
  // "Because you watched": titles similar to the two latest played, minus what the rows above show.
  const because = useLoad(
    () => 'because',
    async () => {
      const played = (
        await api.items({ Filters: 'IsPlayed', Recursive: true, IncludeItemTypes: 'Movie,Episode', SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: 20 })
      ).Items;
      return Promise.all(becauseSeeds(played).map(async (seed) => ({ seed, items: await api.similar(seed.Id, 16).catch(() => []) })));
    },
  );

  // Live TV now: the server's airing programmes, OK tunes; memories: one card per earlier year.
  const repo = $derived(hasLive ? liveTv(api) : null);
  const liveNow = useLoad(() => (hasLive && shown.includes(LIVE_NOW) ? 'home-live-now' : 'home-live-now-off'), () => (repo ? repo.onNow() : Promise.resolve([])));
  const memories = useLoad(() => (hasPhotos && shown.includes(MEMORIES) ? 'home-memories' : 'home-memories-off'), () => (hasPhotos ? homeMemories(api) : Promise.resolve([])));
  const memoryOf = (cover: BaseItem): MemoryGroup | undefined => (memories.value ?? []).find((g) => g.photos.some((p) => p.item.Id === cover.Id));
  let liveClock = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (liveClock = Date.now()), 30_000);
    return () => clearInterval(id);
  });
  $effect(() => {
    if (repo && !repo.loaded && liveNow.value?.length) void repo.loadChannels();
  });

  const rows = $derived.by(() => {
    let seen: BaseItem[] = [...(cont.value?.items ?? []), ...(resume.value ?? []), ...(nextUp.value ?? []), ...Object.values(latests.value ?? {}).flat()];
    const out: {
      key: string;
      title: string;
      items: BaseItem[];
      wide: boolean;
      playable: boolean;
      subtitle?: (i: BaseItem) => string | undefined;
      kind?: 'live' | 'memory';
    }[] = [];
    for (const id of shown) {
      if (id === RESUME) {
        if (merged && cont.value?.items.length) out.push({ key: 'continue', title: t('continue_watching_merged'), items: cont.value.items, wide: true, playable: true, subtitle: continueSubtitle });
        if (!merged && resume.value?.length) out.push({ key: 'resume', title: t('continue_watching'), items: resume.value, wide: true, playable: true });
      } else if (id === NEXT_UP) {
        if (nextUp.value?.length) out.push({ key: 'nextup', title: t('next_up'), items: nextUp.value, wide: true, playable: true });
      } else if (id === UPCOMING) {
        if (upcoming.value?.length) out.push({ key: 'upcoming', title: t('row_upcoming'), items: upcoming.value, wide: true, playable: false });
      } else if (id === LIVE_NOW) {
        if (liveNow.value?.length) out.push({ key: 'live-now', title: t('row_live_now'), items: liveNow.value, wide: true, playable: false, kind: 'live' });
      } else if (id === MEMORIES) {
        const covers = (memories.value ?? []).map((g) => g.photos[0]?.item).filter((i): i is BaseItem => !!i);
        if (covers.length) out.push({ key: 'memories', title: t('photos_memories_title'), items: covers, wide: true, playable: false, kind: 'memory' });
      } else if (id === BECAUSE) {
        for (const b of because.value ?? []) {
          const items = unseen(b.items, seen);
          seen = [...seen, ...items];
          if (items.length) out.push({ key: `because-${b.seed.Id}`, title: t('row_because', b.seed.Name), items, wide: false, playable: false });
        }
      } else {
        const viewId = latestViewId(id);
        const view = latestViews.find((v) => v.Id === viewId);
        const items = viewId ? latests.value?.[viewId] : undefined;
        if (view && items?.length)
          out.push({ key: id, title: t('latest_in', view.Name), items, wide: pref.thumb.includes(id), playable: false });
      }
    }
    return out;
  });

  // --- Backdrop and hero ---
  let heroIndex = $state(0);
  let heroFocused = $state(false);
  let focusedItem = $state<BaseItem | null>(null);
  let backdrop = $state<string | undefined>(undefined);
  const heroItems = $derived(settings.rowHero.value ? (hero.value ?? []) : []);
  const heroItem = $derived(heroItems[Math.min(heroIndex, heroItems.length - 1)]);
  $effect(() => {
    const target = heroFocused || !focusedItem ? heroItem : focusedItem;
    if (!target) return;
    const url = api.backdrop(target);
    if (heroFocused) {
      backdrop = url ?? backdrop;
      return;
    }
    const timer = setTimeout(() => (backdrop = url ?? backdrop), 280);
    return () => clearTimeout(timer);
  });

  // Continue Watching, Next Up and the hero's Play start playback; every other card opens its page.
  function open(item: BaseItem, playable: boolean): void {
    if (playable) play(item);
    else nav.push(itemRoute(item));
  }

  // --- Vertical scroll: rows pivot at 26 %, the hero always shows whole ---
  let page: HTMLDivElement;
  let content: HTMLDivElement;
  let y = $state(0);
  function onfocus(e: CustomEvent): void {
    const el = e.target as HTMLElement;
    heroFocused = !!el.closest('[data-hero]');
    if (heroFocused) {
      y = 0;
    } else {
      const row = el.closest('[data-home-row]') as HTMLElement | null;
      if (!row) return;
      const max = Math.max(0, content.offsetHeight - page.clientHeight);
      y = clamp(y + pivotDelta(row.offsetTop - y, page.clientHeight, 0.26), 0, max);
    }
    onscrolled(y > 80);
  }

  const loading = $derived(hero.loading && (merged ? cont.loading : resume.loading));
  const empty = $derived(!loading && !heroItems.length && !rows.length && !because.loading);
</script>

<div class="home" bind:this={page} ontvfocus={onfocus}>
  <Backdrop url={backdrop} dim={heroFocused ? 0 : 0.42} />
  <div class="content" bind:this={content} style="transform:translate3d(0,{-y}px,0)">
    {#if heroItem}
      <div data-hero>
        <Hero
          {api}
          items={heroItems}
          bind:index={heroIndex}
          focused={heroFocused}
          onplay={(i) => open(i, true)}
          oninfo={(i) => open(i, false)}
        />
      </div>
    {:else}
      <div class="top"></div>
    {/if}
    <!-- The one-time living-room theme suggestion. -->
    {#if settings.theme.value === 'graphite' && !settings.themeHintShown.value}
      <div data-home-row><ThemeHint /></div>
    {/if}
    {#snippet liveCard(p: BaseItem)}
      {@const lite = normalizeProgram(p as never, { kind: api.kind })}
      {@const tag = p.ImageTags?.Primary ?? p.ImageTags?.Thumb}
      {#if repo && lite}
        <LiveCard
          {repo}
          row={repo.channel(lite.channelId)}
          program={lite}
          image={tag ? { id: p.Id, tag } : undefined}
          airingCard
          now={liveClock}
          onclick={() => nav.push({ name: 'live', id: lite.channelId })}
        />
      {/if}
    {/snippet}
    {#snippet memoryCard(cover: BaseItem)}
      {@const g = memoryOf(cover)}
      {#if g}<MemoryCard {api} group={g} onclick={() => nav.push({ name: 'photoView', key: memoryTimeline(g), index: 0 })} />{/if}
    {/snippet}
    {#each rows as row (row.key)}
      <div data-home-row>
        <MediaRow
          title={row.title}
          items={row.items}
          {api}
          wide={row.wide}
          subtitle={row.subtitle}
          onclick={(i) => open(i, row.playable)}
          onfocusitem={(i) => (focusedItem = i)}
          card={row.kind === 'live' ? liveCard : row.kind === 'memory' ? memoryCard : undefined}
        />
      </div>
    {/each}
  </div>
  {#if loading}
    <div class="center"><Spinner size={40} /></div>
  {:else if empty}
    <div class="center t-title3 label-2">{t('empty_home')}</div>
  {/if}
</div>

<style>
  .home {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
  }
  .content {
    position: relative;
    padding-bottom: 80rem;
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  .top {
    height: 104rem;
  }
  .center {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }
</style>
