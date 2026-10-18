<script lang="ts">
  // The photo timeline (photos spec PH-02): one spacer as tall as the whole justified layout inside the shared
  // scroller, and only the rows within the viewport ±1.5 screens as tiles (plus the focused one, so focus survives
  // scrolling). Month headers stick under the toolbar; day labels open each day at the two larger sizes.
  import { onMount, tick } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { blurhash } from '../../lib/blurhash';
  import { clock } from '../../lib/format';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { photoUrl } from '../../lib/images';
  import { reveal } from '../../lib/motion';
  import { needsRelayout, rotation } from '../../lib/photos/asset';
  import { gridLayout, rowAt, type GridLayout, type Month } from '../../lib/photos/grid';
  import type { GridAsset } from '../../lib/photos/source.svelte';
  import Icon from '../../components/Icon.svelte';
  import Scrubber from './Scrubber.svelte';

  let {
    assets,
    total,
    years,
    version,
    onopen,
    onfavorite,
    onslideshow,
  }: {
    assets: GridAsset[];
    total: number;
    years: number[];
    version: number;
    onopen: (index: number, el: HTMLElement) => void;
    onfavorite: (index: number) => void;
    onslideshow: (index: number) => void;
  } = $props();

  // Row heights (CSS px), also the thumbnail height buckets the server's resize cache shares.
  const DENSITIES = [160, 240, 360];
  const GAP = 3;
  const OVERSCAN = 1.5;
  // The page's sticky toolbar: month headers stick under it, seeks land below it.
  const STICKY = 56;
  const KEY = 'wicaby.photos.density';

  const scroller = document.getElementById('main-scroller') as HTMLElement;
  let el = $state<HTMLDivElement>();
  let width = $state(0);
  let viewTop = $state(0);
  let vh = $state(scroller?.clientHeight ?? window.innerHeight);
  let density = $state(readDensity());
  let relayout = $state(0);
  let focused = $state(-1);
  // Client-side quarter turns found on decode (spec §3.1 orientation rule).
  const turns = new SvelteMap<string, number>();

  function readDensity(): number {
    try {
      const d = Number(localStorage.getItem(KEY));
      return d >= 0 && d < DENSITIES.length ? d : 1;
    } catch {
      return 1;
    }
  }

  const EMPTY: GridLayout = { months: [], rows: [], height: 0, rowOf: new Int32Array(0) };
  const layout = $derived.by(() => {
    void relayout;
    return width > 0 ? gridLayout(assets, width, DENSITIES[density], GAP, density > 0) : EMPTY;
  });
  // Pages still loading: their assets take the average height per asset so far, so the scrollbar and the scrubber
  // span the whole library from the first page on.
  const height = $derived.by(() => {
    const missing = Math.max(0, total - assets.length);
    if (!missing) return layout.height;
    const h = DENSITIES[density];
    const per = assets.length ? layout.height / assets.length : ((h + GAP) * 1.4 * h) / Math.max(width, 1);
    return layout.height + missing * per;
  });

  interface TileView {
    a: GridAsset;
    index: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }

  const visible = $derived.by(() => {
    void version;
    const { rows, months } = layout;
    const lo = viewTop - OVERSCAN * vh;
    const hi = viewTop + vh * (1 + OVERSCAN);
    const out = new Map<number, { m: Month; tiles: TileView[] }>();
    const add = (ri: number) => {
      const r = rows[ri];
      if (!r) return;
      const m = months[r.month];
      let v = out.get(r.month);
      if (!v) out.set(r.month, (v = { m, tiles: [] }));
      for (const it of r.items) v.tiles.push({ a: assets[it.index], index: it.index, x: it.x, y: r.y - m.top, w: it.w, h: r.h });
    };
    const first = rowAt(rows, lo);
    let end = first;
    while (end < rows.length && rows[end].y <= hi) end++;
    // The focused tile stays rendered, in timeline order: a keyed block that moved would drop the focus.
    const pinned = focused >= 0 && focused < assets.length ? layout.rowOf[focused] : -1;
    if (pinned >= 0 && pinned < first) add(pinned);
    for (let i = first; i < end; i++) add(i);
    if (pinned >= end) add(pinned);
    return { lo, hi, sections: [...out.values()] };
  });

  function measure(): void {
    if (!el || !scroller) return;
    viewTop = scroller.getBoundingClientRect().top - el.getBoundingClientRect().top;
    vh = scroller.clientHeight;
  }

  let frame = 0;
  function onScroll(): void {
    if (!frame) frame = requestAnimationFrame(() => ((frame = 0), measure()));
  }

  onMount(() => {
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      width = el?.clientWidth ?? 0;
      measure();
    });
    if (el) ro.observe(el);
    if (scroller) ro.observe(scroller);
    return () => {
      scroller?.removeEventListener('scroll', onScroll);
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  });

  // Grid y at the top of the visible area (under the sticky toolbar).
  export function seek(y: number): void {
    if (!el || !scroller) return;
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + y - STICKY;
    measure();
  }

  // Density ±1 (buttons, ctrl+wheel, ctrl +/-). The first tile below the toolbar keeps its place on screen.
  export async function zoomBy(delta: number): Promise<void> {
    const next = Math.max(0, Math.min(DENSITIES.length - 1, density + delta));
    if (next === density) return;
    const r = layout.rows[rowAt(layout.rows, viewTop + STICKY)];
    const anchor = r?.items[0]?.index;
    const offset = r ? r.y - viewTop : 0;
    density = next;
    try {
      localStorage.setItem(KEY, String(next));
    } catch {
      // A remembered size is a convenience.
    }
    if (anchor === undefined) return;
    await tick();
    const row = layout.rows[layout.rowOf[anchor]];
    if (row && scroller) scroller.scrollTop += row.y - viewTop - offset;
    measure();
  }

  // Back from the viewer or the slideshow: that asset's tile, in view and focused.
  export async function focusIndex(index: number): Promise<void> {
    const row = layout.rows[layout.rowOf[index]];
    if (!row) return;
    focused = index;
    if (row.y < viewTop + STICKY + 40 || row.y + row.h > viewTop + vh) seek(Math.max(0, row.y - vh / 3));
    await tick();
    el?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus({ preventScroll: true });
  }

  let wheelAcc = 0;
  function onWheel(e: WheelEvent): void {
    if (!e.ctrlKey) return;
    e.preventDefault();
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) < 60) return;
    void zoomBy(wheelAcc < 0 ? 1 : -1);
    wheelAcc = 0;
  }

  const indexOf = (target: EventTarget | null) => Number((target as HTMLElement | null)?.closest?.<HTMLElement>('[data-index]')?.dataset.index ?? -1);

  function onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
    const i = indexOf(e.target);
    if (i < 0) return;
    if (e.key === 'f' || e.key === 'F') onfavorite(i);
    else if (e.key === 's' || e.key === 'S') onslideshow(i);
    else return;
    e.preventDefault();
  }

  function onWindowKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || !e.ctrlKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') void zoomBy(1);
    else if (e.key === '-') void zoomBy(-1);
    else return;
    e.preventDefault();
  }

  function onLoad(e: Event, v: TileView): void {
    const img = e.currentTarget as HTMLImageElement;
    const o = v.a.orient;
    const turn = o ? rotation(o.o, o.w, o.h, img.naturalWidth, img.naturalHeight) : 0;
    if (turn) {
      v.a.rotate = turn;
      turns.set(v.a.id, turn);
    }
    // A thumbnail whose shape is off the predicted one re-lays out once with the true aspect.
    if (needsRelayout(v.a.aspect, img.naturalWidth, img.naturalHeight, turn)) {
      v.a.aspect = turn % 180 ? img.naturalHeight / img.naturalWidth : img.naturalWidth / img.naturalHeight;
      relayout++;
    }
  }

  const wall = (takenAt: string) => new Date(takenAt.slice(0, 19));
  const monthLabel = (key: string) => fmt.date(new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1), { month: 'long', year: 'numeric' });
  const dayLabel = (key: string) => fmt.date(new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))), { weekday: 'short', day: 'numeric', month: 'long' });
  function label(a: GridAsset): string {
    const d = wall(a.takenAt);
    const date = `${fmt.date(d)}, ${fmt.time(d)}`;
    return a.kind === 'video' ? t('photos.tile.video', { date, duration: clock(a.durationMs ?? 0) }) : t('photos.tile.photo', { date });
  }
</script>

<svelte:window onkeydown={onWindowKey} onresize={measure} />

<div
  class="grid"
  bind:this={el}
  style:height="{height}px"
  data-loaded={assets.length}
  style:--sticky="{STICKY}px"
  role="presentation"
  onwheel={onWheel}
  onkeydown={onKey}
  onfocusin={(e) => (focused = indexOf(e.target))}
>
  {#each visible.sections as s (s.m.key)}
    <section class="month" style:top="{s.m.top}px" style:height="{s.m.height}px">
      <h2 class="mhead title-3">{monthLabel(s.m.key)}</h2>
      {#each s.m.days as d (d.key)}
        {#if d.y + 30 >= visible.lo && d.y <= visible.hi}<span class="day footnote" style:top="{d.y - s.m.top}px">{dayLabel(d.key)}</span>{/if}
      {/each}
      {#each s.tiles as v (v.a.id)}
        {@const turn = turns.get(v.a.id) ?? 0}
        <button
          class="tile"
          data-index={v.index}
          data-id={v.a.id}
          style:transform="translate3d({v.x}px, {v.y}px, 0)"
          style:width="{v.w}px"
          style:height="{v.h}px"
          aria-label={label(v.a)}
          onclick={(e) => onopen(v.index, e.currentTarget)}
        >
          {#if v.a.blurHash}<canvas use:blurhash={v.a.blurHash} aria-hidden="true"></canvas>{/if}
          <img
            class="reveal"
            class:turned={turn !== 0}
            style:width={turn ? `${v.h}px` : undefined}
            style:height={turn ? `${v.w}px` : undefined}
            style:--turn="{turn}deg"
            use:reveal
            src={photoUrl(v.a, { maxHeight: DENSITIES[density] })}
            alt=""
            decoding="async"
            draggable="false"
            onload={(e) => onLoad(e, v)}
          />
          {#if v.a.kind === 'video'}<span class="badge caption mono"><Icon name="play" size={10} fill stroke={0} /> {clock(v.a.durationMs ?? 0)}</span>{/if}
          {#if v.a.favorite}<span class="fav" aria-hidden="true"><Icon name="heart" size={12} fill stroke={0} /></span>{/if}
        </button>
      {/each}
    </section>
  {/each}
</div>

{#if layout.months.length}
  <Scrubber months={layout.months} {height} loaded={layout.height} {years} {viewTop} {vh} sticky={STICKY} onseek={seek} />
{/if}

<style>
  .grid {
    position: relative;
    margin: 0 calc(var(--gutter) + 28px) 0 var(--gutter);
  }
  .month {
    position: absolute;
    left: 0;
    right: 0;
  }
  .mhead {
    position: sticky;
    top: var(--sticky);
    z-index: 2;
    height: 52px;
    margin: 0;
    padding: 12px 0 0;
    display: flex;
    align-items: flex-start;
    pointer-events: none;
    color: var(--label);
    /* The toolbar's material, so the stuck header reads as one bar with it. */
    background: var(--material);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    margin: 0 calc(-1 * var(--gutter) - 28px) 0 calc(-1 * var(--gutter));
    padding-left: var(--gutter);
  }
  .day {
    position: absolute;
    left: 0;
    height: 28px;
    line-height: 26px;
    color: var(--label-2);
  }
  .tile {
    position: absolute;
    top: 0;
    left: 0;
    padding: 0;
    overflow: hidden;
    border-radius: var(--r-xs);
    background: var(--fill-1);
    scroll-margin: calc(var(--sticky) + 60px) 0 24px;
    /* The tile clips rotated images, so the shadow cannot live on ::after: it switches instantly. */
    transition: scale var(--t-med) var(--spring);
  }
  .tile:hover,
  .tile:focus-visible {
    z-index: 1;
    box-shadow: var(--shadow-3), var(--focus-ring);
    scale: 1.03;
  }
  .tile:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .tile canvas,
  .tile img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .tile img.turned {
    inset: auto;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%) rotate(var(--turn));
  }
  .badge,
  .fav {
    position: absolute;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: #fff;
  }
  .badge {
    right: 6px;
    bottom: 6px;
    padding: 2px 6px;
    border-radius: 999px;
    background: var(--material-thin);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
  }
  .fav {
    left: 6px;
    bottom: 6px;
    filter: drop-shadow(0 1px 3px rgb(0 0 0 / 0.6));
  }
</style>
