<script lang="ts">
  // Android TV PhotosTab (ui/photos/PhotosTab.kt, spec §4.4, PH-06): a photo library (or home videos) on the TV.
  // Tabs Chronologie, Albums, Favoris; the timeline in uniform 3:2 tiles, six a row, under full-width month headers (a
  // justified grid makes D-pad focus wander), newest first. CH-/CH+ (and Page Down/Up) jump to the next month or back
  // to this month's start; the month shows in a floating label for 1.5 s when the focus enters another. Only the lines
  // around the view are mounted (a library holds thousands). OK opens the viewer; a clip, the player. An album opens
  // the same screen on its own timeline.
  import { getContext, onMount, tick } from 'svelte';
  import type { BaseItem } from '$shared/models';
  import { buckets } from '$desktop/photos/timeline';
  import { rotation } from '$desktop/photos/asset';
  import Icon from '../components/Icon.svelte';
  import Pill from '../components/Pill.svelte';
  import Spinner from '../components/Spinner.svelte';
  import type { Api } from '../lib/api';
  import { focusable, focused, setFocus } from '../lib/focus';
  import { clock } from '../lib/format';
  import { locale, plural, t } from '../lib/i18n.svelte';
  import { dpPx } from '../lib/images';
  import { useLoad } from '../lib/load.svelte';
  import { nav, onBack, SCREEN } from '../lib/nav.svelte';
  import { photoAlbums, photoDate, photoUrl, timeline, timelineKey, type Photo } from '../lib/photos.svelte';
  import { play } from '../lib/playback';
  import { dp } from '../lib/screen';
  import { clamp, edgeDelta } from '../lib/scroll';
  import { keyOf } from '../platform/keys';

  let {
    api,
    parentId,
    title,
    top = 104,
    album = false,
    onscrolled,
  }: { api: Api; parentId: string; title: string; top?: number; album?: boolean; onscrolled?: (s: boolean) => void } = $props();

  const COLS = 6;
  const SIDE = 48;
  const GAP = 12;
  const MONTH = 52;
  const HEAD = 92;
  const MARGIN = 110;

  type Tab = 'timeline' | 'albums' | 'favorites';
  let tab = $state<Tab>('timeline');
  // svelte-ignore state_referenced_locally
  const tl = $derived(timeline(api, parentId, tab === 'favorites'));
  $effect(() => {
    if (tab !== 'albums') void tl.load();
  });
  const albums = useLoad(
    () => `photo-albums-${parentId}`,
    () => photoAlbums(api, parentId),
  );

  // --- Geometry (dp) ---
  let viewW = $state(960);
  let viewH = $state(540);
  const tileW = $derived((viewW - SIDE * 2 - GAP * (COLS - 1)) / COLS);
  const tileH = $derived(tileW / 1.5);
  const photos = $derived(tl.photos);
  const months = $derived(buckets(photos.map((p) => p.asset), 'month'));

  interface Line {
    kind: 'month' | 'row';
    top: number;
    h: number;
    key: string;
    // Rows: the first photo and how many.
    start: number;
    count: number;
    month: number;
  }
  const layout = $derived.by(() => {
    const lines: Line[] = [];
    const lineOf = new Int32Array(photos.length);
    let y = top + HEAD;
    months.forEach((m, mi) => {
      lines.push({ kind: 'month', top: y, h: MONTH, key: m.key, start: m.firstIndex, count: 0, month: mi });
      y += MONTH;
      for (let i = 0; i < m.count; i += COLS) {
        const n = Math.min(COLS, m.count - i);
        for (let k = 0; k < n; k++) lineOf[m.firstIndex + i + k] = lines.length;
        lines.push({ kind: 'row', top: y, h: tileH, key: `r${m.firstIndex + i}`, start: m.firstIndex + i, count: n, month: mi });
        y += tileH + GAP;
      }
    });
    return { lines, lineOf, height: y + 56 };
  });

  // --- Scroll and the mounted window ---
  let y = $state(0);
  const mounted = $derived(layout.lines.filter((l) => l.top + l.h >= y - viewH && l.top <= y + viewH * 2));
  let focusIndex = $state(-1);
  function onfocus(e: CustomEvent): void {
    const el = e.target as HTMLElement;
    const i = Number(el.getAttribute('data-index') ?? -1);
    if (i < 0) {
      if (el.closest('.head')) {
        y = 0;
        onscrolled?.(false);
      }
      return;
    }
    focusIndex = i;
    const line = layout.lines[layout.lineOf[i]];
    if (!line) return;
    // The month header comes along with the month's first row.
    const at = line.top - (layout.lines[layout.lineOf[i] - 1]?.kind === 'month' ? MONTH : 0);
    const h = line.top + line.h - at;
    y = clamp(y + edgeDelta(at - y, h, viewH, MARGIN), 0, Math.max(0, layout.height - viewH));
    onscrolled?.(y > 60);
  }

  // The floating month label, 1.5 s on each change of month.
  let label = $state<string | null>(null);
  let lastMonth = -1;
  let labelTimer = 0;
  $effect(() => {
    if (focusIndex < 0) return;
    const m = layout.lines[layout.lineOf[focusIndex]]?.month ?? -1;
    if (m === lastMonth || m < 0) return;
    const first = lastMonth < 0;
    lastMonth = m;
    if (first) return;
    label = photoDate(`${months[m].key}-01`, locale.current, true);
    clearTimeout(labelTimer);
    labelTimer = window.setTimeout(() => (label = null), 1500);
  });

  // CH-/CH+: the next month's first photo; back: this month's start, or the one before.
  async function jump(down: boolean): Promise<void> {
    if (focusIndex < 0) return;
    const m = layout.lines[layout.lineOf[focusIndex]].month;
    const to = down ? months[m + 1] : focusIndex > months[m].firstIndex ? months[m] : months[m - 1];
    if (!to) return;
    const line = layout.lines[layout.lineOf[to.firstIndex]];
    y = clamp(line.top - MONTH - MARGIN, 0, Math.max(0, layout.height - viewH));
    await tick();
    const el = document.querySelector<HTMLElement>(`[data-screen-top] .photos [data-index="${to.firstIndex}"]`);
    if (el) setFocus(el);
  }

  function open(i: number): void {
    const p = photos[i];
    if (p.asset.kind === 'video') return play(p.item);
    const key = timelineKey(tl);
    if (key) nav.push({ name: 'photoView', key, index: i });
  }

  // Jellyfin sends the pixels as stored: a quarter-turned photo is turned here once decoded.
  let turns = $state<Record<string, number>>({});
  function loaded(p: Photo, e: Event): void {
    if (api.isEmby) return;
    const img = e.currentTarget as HTMLImageElement;
    const r = rotation(p.item.ImageOrientation, p.item.Width ?? 0, p.item.Height ?? 0, img.naturalWidth, img.naturalHeight);
    if (r) turns = { ...turns, [p.asset.id]: r };
  }
  const tilePx = $derived(dpPx(tileW));

  const screen = getContext<number>(SCREEN);
  onMount(() => {
    const measure = () => {
      viewW = window.innerWidth / dp(1);
      viewH = window.innerHeight / dp(1);
    };
    measure();
    window.addEventListener('resize', measure);
    const onKey = (e: KeyboardEvent) => {
      const key = keyOf(e);
      const page = e.keyCode === 33 || e.keyCode === 34;
      if (!focused()?.closest('[data-screen-top] .photos .grid') || (!page && key !== 'channelUp' && key !== 'channelDown')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void jump(key === 'channelDown' || e.keyCode === 34);
    };
    window.addEventListener('keydown', onKey, true);
    const stop = onBack(screen, () => {
      // Back from deep in the grid: to the top first.
      if (!focused()?.closest('[data-screen-top] .photos .grid') || y < viewH) return false;
      y = 0;
      onscrolled?.(false);
      const pill = document.querySelector<HTMLElement>('[data-screen-top] .photos .head [data-focusable]');
      if (pill) setFocus(pill);
      return true;
    });
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('keydown', onKey, true);
      clearTimeout(labelTimer);
      stop();
    };
  });
  const TABS: { key: Tab; label: string }[] = [
    { key: 'timeline', label: 'photos_tab_timeline' },
    { key: 'albums', label: 'photos_tab_albums' },
    { key: 'favorites', label: 'photos_tab_favorites' },
  ];
  function albumCover(a: BaseItem): string | undefined {
    const tag = a.ImageTags?.Primary;
    return tag ? api.image(a.Id, 'Primary', tag, { maxWidth: dpPx(tileW * 1.4) }) : undefined;
  }
</script>

<div class="photos" ontvfocus={onfocus}>
  <div class="content" style="height:{tab === 'albums' ? viewH : layout.height}rem;transform:translate3d(0,{-y}rem,0)">
    <div class="head" style="top:{top}rem">
      <div class="titles">
        <h1 class="t-large-title ellipsis">{title}</h1>
        {#if tab !== 'albums' && tl.total >= 0}
          <p class="t-footnote label-3">{plural('photos_count', photos.length, photos.length)} · {t('photos_month_jump_hint')}</p>
        {/if}
      </div>
      {#if !album}
        <div class="tabs" data-focus-group>
          {#each TABS as x (x.key)}
            <Pill text={t(x.label)} selected={tab === x.key} onclick={() => ((tab = x.key), (y = 0), (focusIndex = -1), (lastMonth = -1))} />
          {/each}
        </div>
      {/if}
    </div>

    {#if tab === 'albums'}
      <div class="albums" style="top:{top + HEAD}rem" data-focus-group>
        {#if albums.value === undefined}
          <Spinner size={36} />
        {:else if !albums.value.length}
          <p class="t-title3 label-2">{t('photos_empty')}</p>
        {:else}
          {#each albums.value as a (a.Id)}
            {@const cover = albumCover(a)}
            <div class="album" style="width:{tileW * 1.4}rem">
              <button class="art" style="height:{(tileW * 1.4) / 1.5}rem" use:focusable onclick={() => nav.push({ name: 'photoAlbum', id: a.Id, title: a.Name })}>
                {#if cover}<img src={cover} alt="" />{/if}
              </button>
              <p class="t-headline ellipsis name">{a.Name}</p>
              {#if a.ChildCount}<p class="t-footnote label-3">{plural('photos_count', a.ChildCount, a.ChildCount)}</p>{/if}
            </div>
          {/each}
        {/if}
      </div>
    {:else if tl.failed}
      <div class="state" style="top:{top + HEAD}rem">
        <p class="t-title3 label-2">{t('load_error')}</p>
        <Pill text={t('retry')} icon="Refresh" onclick={() => tl.load()} />
      </div>
    {:else if tl.total < 0}
      <div class="state" style="top:{top + HEAD}rem"><Spinner size={40} /></div>
    {:else if !photos.length}
      <div class="state" style="top:{top + HEAD}rem">
        <p class="t-title3 label-2">{t('photos_empty')}</p>
        {#if album}<Pill text={t('photos_back')} autofocus onclick={() => nav.back()} />{/if}
      </div>
    {:else}
      <div class="grid" data-focus-group>
        {#each mounted as line (line.key)}
          {#if line.kind === 'month'}
            <h2 class="t-title3 month" style="top:{line.top}rem">{photoDate(`${line.key}-01`, locale.current, true)}</h2>
          {:else}
            <div class="row" style="top:{line.top}rem;height:{line.h}rem">
              {#each photos.slice(line.start, line.start + line.count) as p, k (p.asset.id)}
                {@const i = line.start + k}
                {@const src = photoUrl(api, p.asset, tilePx)}
                {@const turn = turns[p.asset.id] ?? 0}
                <button class="tile" style="width:{tileW}rem;height:{tileH}rem" use:focusable={album && i === 0} data-index={i} onclick={() => open(i)}>
                  {#if src}
                    <img
                      {src}
                      alt=""
                      onload={(e) => loaded(p, e)}
                      style={turn % 180 ? `width:${tileH}rem;height:${tileW}rem;left:${(tileW - tileH) / 2}rem;top:${(tileH - tileW) / 2}rem;transform:rotate(${turn}deg)` : ''}
                    />
                  {/if}
                  {#if p.asset.kind === 'video'}
                    <span class="video"><Icon name="Play" size={16} />{#if p.asset.durationMs}<span class="t-caption">{clock(p.asset.durationMs)}</span>{/if}</span>
                  {/if}
                  {#if p.asset.favorite}<span class="fav"><Icon name="Heart" size={14} /></span>{/if}
                </button>
              {/each}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
  {#if label}
    <div class="label t-title2" style="top:{top + 8}rem">{label}</div>
  {/if}
</div>

<style>
  .photos {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
  }
  .content {
    position: relative;
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  p,
  h2 {
    margin: 0;
  }
  .head {
    position: absolute;
    left: 48rem;
    right: 48rem;
    display: flex;
    align-items: center;
  }
  .titles {
    flex: 1;
    min-width: 0;
  }
  .tabs {
    display: flex;
  }
  .tabs > :global(* + *) {
    margin-left: 10rem;
  }
  .tabs > :global(.pill:not(.selected):not(.focused)) {
    background: transparent;
    color: var(--label-2);
  }
  .tabs > :global(.pill.selected:not(.focused)) {
    background: var(--fill-3);
    color: var(--label);
  }
  .month {
    position: absolute;
    left: 48rem;
    padding-top: 14rem;
  }
  .row {
    position: absolute;
    left: 48rem;
    right: 48rem;
    display: flex;
  }
  .tile + .tile {
    margin-left: 12rem;
  }
  .tile {
    position: relative;
    flex-shrink: 0;
    overflow: hidden;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    transition: transform var(--t-fast) var(--ease-out), box-shadow var(--t-med);
  }
  .tile img {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .tile:global(.focused) {
    transform: scale(1.05);
    box-shadow: 0 10rem 24rem rgba(0, 0, 0, 0.55), 0 0 0 3rem #fff;
    z-index: 1;
  }
  .video {
    position: absolute;
    left: 6rem;
    bottom: 6rem;
    display: flex;
    align-items: center;
    padding: 2rem 7rem 2rem 4rem;
    border-radius: 999rem;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
  }
  .fav {
    position: absolute;
    top: 6rem;
    right: 6rem;
    color: #fff;
  }
  .albums {
    position: absolute;
    left: 48rem;
    right: 48rem;
    display: flex;
    flex-wrap: wrap;
  }
  .album {
    margin: 0 20rem 24rem 0;
  }
  .art {
    position: relative;
    display: block;
    width: 100%;
    overflow: hidden;
    border-radius: var(--r-md);
    background: var(--fill-2);
    transition: transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow var(--t-med);
  }
  .art img {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .art:global(.focused) {
    transform: scale(1.06);
    box-shadow: 0 16rem 32rem rgba(0, 0, 0, 0.5);
  }
  .name {
    margin-top: 10rem;
  }
  .state {
    position: absolute;
    left: 48rem;
    right: 48rem;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }
  .state > :global(* + *) {
    margin-top: 16rem;
  }
  .label {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    padding: 10rem 22rem;
    border-radius: 999rem;
    background: var(--elevated-2);
    white-space: nowrap;
  }
</style>
