<script lang="ts">
  import type { BaseItem } from '../../shared/models';
  import { itemKey, itemPath, playQueueFor } from '../lib/api';
  import { blurhash, blurhashOf } from '../lib/blurhash';
  import { w } from '../lib/bridge';
  import { episodeCode, progress, remaining } from '../lib/format';
  import { fmt, t } from '../lib/i18n.svelte';
  import { posterUrl, thumbUrl } from '../lib/images';
  import { morphFrom, prefetch, remember, reveal } from '../lib/motion';
  import { asset, lonePhoto } from '../lib/photos/source.svelte';
  import { navigate } from '../lib/router.svelte';
  import { cardMenu, queueModes } from '../lib/queue.svelte';
  import { resumeAt } from '../lib/resume.svelte';
  import { errorMessage, serverName, settings, toast } from '../lib/stores.svelte';
  import Icon from './Icon.svelte';

  let {
    item,
    variant = 'poster',
    subtitle,
    width,
    showServer = false,
  }: { item: BaseItem; variant?: 'poster' | 'thumb' | 'square'; subtitle?: string; width?: number; showServer?: boolean } = $props();

  // Merged lists name the server (set by the caller only when several are signed in).
  const server = $derived(showServer ? serverName(item.ServerId) : '');

  // Sizes match the largest rendered card (Row/Library clamp() widths) so one fetch serves every layout.
  const src = $derived(variant === 'thumb' ? thumbUrl(item, 400) : posterUrl(item, 330));
  const hash = $derived(blurhashOf(item, variant === 'thumb' && item.Type !== 'Episode' ? 'Thumb' : 'Primary'));
  const pct = $derived(progress(item));
  const played = $derived(Boolean(item.UserData?.Played));
  const unplayed = $derived(item.UserData?.UnplayedItemCount ?? 0);
  const favorite = $derived(Boolean(item.UserData?.IsFavorite));

  // Settings > Apparence: rating, age and quality chips over the artwork (off by default).
  const chips = $derived.by(() => {
    const ui = settings.value?.ui;
    if (!ui || variant === 'square') return [];
    const out: string[] = [];
    if (ui.cardQuality && (item.Width || item.Height)) {
      const w = item.Width ?? 0;
      const h = item.Height ?? 0;
      out.push(w >= 3200 || h >= 2000 ? '4K' : w >= 1200 || h >= 700 ? 'HD' : 'SD');
    }
    if (ui.cardAges && item.OfficialRating) out.push(item.OfficialRating);
    if (ui.cardRatings && item.CommunityRating) out.push(`★ ${fmt.number(item.CommunityRating, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`);
    return out;
  });

  const title = $derived(variant === 'thumb' && item.Type === 'Episode' && item.SeriesName ? item.SeriesName : item.Name);
  const sub = $derived.by(() => {
    if (subtitle !== undefined) return subtitle;
    if (item.Type === 'Episode') {
      const code = episodeCode(item);
      if (variant === 'thumb' && item.SeriesName) return [code, pct > 0 && !played ? remaining(item) : item.Name].filter(Boolean).join(' · ');
      return [code, item.SeriesName].filter(Boolean).join(' · ');
    }
    if (variant === 'thumb' && pct > 0 && !played) return remaining(item);
    if (item.Type === 'MusicAlbum') return item.AlbumArtist ?? (item.ProductionYear ? String(item.ProductionYear) : '');
    if (item.Type === 'Series' && item.ProductionYear) {
      const end = item.EndDate ? new Date(item.EndDate).getFullYear() : null;
      return item.Status === 'Continuing' ? `${item.ProductionYear} – ` : end && end !== item.ProductionYear ? `${item.ProductionYear} – ${end}` : String(item.ProductionYear);
    }
    return item.ProductionYear ? String(item.ProductionYear) : '';
  });

  let cover: HTMLAnchorElement | undefined = $state();
  let lift: HTMLDivElement | undefined = $state();
  let busy = $state(false);

  async function play(e: MouseEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    if (item.Type === 'Book') return navigate(itemPath(item, 'read'));
    if (busy) return;
    busy = true;
    try {
      const q = await playQueueFor(item);
      const at = await resumeAt(q.itemIds[q.startIndex] === item.Id ? item.UserData?.PlaybackPositionTicks : undefined, item.Name);
      if (at === null) return;
      await w.playback.play({ ...q, startPositionTicks: at });
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = false;
    }
  }

  function open(e: MouseEvent): void {
    e.preventDefault();
    // A photo opens the photo viewer, never mpv or an item page.
    if (item.Type === 'Photo') return void (lonePhoto.assets = [asset(item)]);
    remember(item, src);
    morphFrom(cover, itemKey(item));
    navigate(itemPath(item));
  }

  // Specular highlight follows the pointer; transform-only, so no repaint.
  function sheen(e: PointerEvent): void {
    if (!lift) return;
    const r = lift.getBoundingClientRect();
    lift.style.setProperty('--sx', `${((e.clientX - r.left) / r.width - 0.5) * 100}%`);
    lift.style.setProperty('--sy', `${((e.clientY - r.top) / r.height - 0.5) * 100}%`);
  }

  let intent: ReturnType<typeof setTimeout> | undefined;
  const warm = () => {
    clearTimeout(intent);
    intent = setTimeout(() => prefetch(item), 120);
  };

  const playable = $derived(!['Person', 'MusicArtist', 'CollectionFolder', 'UserView', 'Folder', 'Photo', 'PhotoAlbum'].includes(item.Type) && item.LocationType !== 'Virtual');

  // Right click, or the menu key on the focused card (no pointer position: under the artwork).
  function menu(e: MouseEvent): void {
    if (queueModes(item).length === 0) return;
    e.preventDefault();
    const r = cover?.getBoundingClientRect();
    cardMenu.value = { item, x: e.clientX || (r?.left ?? 0), y: e.clientY || (r?.bottom ?? 0), from: cover ?? null };
  }
</script>

<div
  class="card {variant}"
  style:width={width ? `${width}px` : undefined}
  role="presentation"
  onpointerenter={warm}
  onpointerleave={() => clearTimeout(intent)}
  onfocusin={() => prefetch(item)}
  oncontextmenu={menu}
>
  <div class="lift" role="presentation" bind:this={lift} onpointermove={sheen}>
    <a
      class="cover"
      bind:this={cover}
      href={`#${itemPath(item)}`}
      onclick={open}
      aria-label={[item.Name, sub, server, played ? t('browse.card.watchedAria') : ''].filter(Boolean).join(', ')}
    >
      <div class="ph">
        {#if hash}<canvas use:blurhash={hash} aria-hidden="true"></canvas>{/if}
        {#if !src || !hash}<span class="ph-name">{item.Name}</span>{/if}
      </div>
      {#if src}
        <img class="reveal" use:reveal {src} alt="" loading="lazy" decoding="async" draggable="false" />
      {/if}

      <span class="sheen" aria-hidden="true"></span>

      {#if chips.length > 0}
        <span class="chips" aria-hidden="true">{#each chips as c (c)}<span>{c}</span>{/each}</span>
      {/if}

      {#if played}
        <span class="badge check" title={t('browse.card.watched')}><Icon name="check" size={12} stroke={3} /></span>
      {:else if unplayed > 0 && (item.Type === 'Series' || item.Type === 'Season')}
        <span class="badge count" title={t('browse.card.unplayed', { count: unplayed })}>{unplayed > 99 ? '99+' : unplayed}</span>
      {/if}

      {#if pct > 0 && !played}
        <span class="progress" aria-hidden="true"><span style:transform="scaleX({pct / 100})"></span></span>
      {/if}
    </a>

    {#if playable}
      <button class="play" onclick={play} aria-label={t('browse.card.play', { name: item.Name })} tabindex="-1">
        {#if busy}
          <span class="spin"></span>
        {:else}
          {#if item.Type === 'Book'}<Icon name="book" size={16} stroke={2} />{:else}<Icon name="play" size={variant === 'thumb' ? 18 : 16} fill stroke={0} />{/if}
        {/if}
      </button>
    {/if}
  </div>

  <a class="text" href={`#${itemPath(item)}`} onclick={open} tabindex="-1">
    <div class="title">{title}</div>
    {#if sub || favorite || server}
      <div class="sub">
        {#if favorite}<span class="fav" title={t('browse.card.favorite')}><Icon name="heart" size={11} fill stroke={0} /></span>{/if}
        {#if server}<span class="server">{server}</span>{/if}
        {sub}
      </div>
    {/if}
  </a>
</div>

<style>
  .card {
    position: relative;
    display: block;
    flex: none;
    width: 100%;
    min-width: 0;
  }

  /* The lifted layer: transform + a pre-rendered shadow whose opacity fades. */
  .lift {
    position: relative;
    isolation: isolate;
    border-radius: var(--r-md);
    transition: transform var(--t-slow) var(--spring);
  }
  .lift::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    box-shadow: var(--shadow-3);
    opacity: 0;
    transition: opacity var(--t-med) var(--ease);
    pointer-events: none;
  }
  .poster .lift {
    aspect-ratio: 2 / 3;
  }
  .thumb .lift {
    aspect-ratio: 16 / 9;
  }
  .square .lift {
    aspect-ratio: 1;
  }

  .cover {
    position: absolute;
    inset: 0;
    display: block;
    overflow: hidden;
    border-radius: var(--r-md);
    background: var(--fill-1);
    /* Hairline that keeps dark artwork from melting into the canvas. */
    box-shadow: inset 0 0 0 1px var(--fill-1);
    -webkit-user-drag: none;
  }
  /* Focus reads as the lift below (scale + shadow), never a ring. */
  .cover:focus-visible {
    border-radius: var(--r-md);
  }
  .ph {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 12px;
    background: linear-gradient(160deg, var(--bg-elevated-2), var(--bg-elevated));
  }
  .ph canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .ph-name {
    position: relative;
    text-align: center;
    font-weight: 650;
    font-size: var(--fs-callout);
    letter-spacing: -0.01em;
    color: var(--label-3);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* Soft specular highlight, tvOS focus style. */
  .sheen {
    position: absolute;
    inset: -50%;
    background: radial-gradient(closest-side, rgb(255 255 255 / 0.13), rgb(255 255 255 / 0.03) 55%, transparent);
    opacity: 0;
    transform: translate3d(var(--sx, 0%), var(--sy, -30%), 0);
    transition: opacity var(--t-med) var(--ease);
    pointer-events: none;
  }

  .badge {
    position: absolute;
    top: 8px;
    right: 8px;
    min-width: 22px;
    height: 22px;
    padding: 0 7px;
    border-radius: 999px;
    display: grid;
    place-items: center;
    font-size: var(--fs-caption);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    background: rgb(0 0 0 / 0.55);
    color: var(--label);
    box-shadow: var(--shadow-1);
  }
  .badge.check {
    padding: 0;
  }
  .chips {
    position: absolute;
    top: 8px;
    left: 8px;
    right: 40px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    pointer-events: none;
  }
  .chips span {
    height: 20px;
    padding: 0 6px;
    border-radius: var(--r-xs);
    display: grid;
    place-items: center;
    font-size: var(--fs-caption);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    background: rgb(0 0 0 / 0.55);
    color: var(--label);
  }
  .progress {
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 10px;
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
    background: rgb(255 255 255 / 0.3);
  }
  .progress span {
    display: block;
    height: 100%;
    background: var(--label);
    transform-origin: left;
  }
  .square .progress,
  .poster .progress {
    left: 8px;
    right: 8px;
    bottom: 8px;
  }

  .play {
    position: absolute;
    right: 10px;
    bottom: 10px;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--label);
    background: rgb(0 0 0 / 0.5);
    box-shadow: var(--shadow-1);
    opacity: 0;
    transform: scale(0.85);
    transition:
      opacity var(--t-fast) var(--ease),
      transform var(--t-med) var(--spring),
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .play :global(svg) {
    margin-left: 2px;
  }
  .play:hover {
    background: var(--label);
    color: #000;
  }
  .play:active {
    transform: scale(0.92);
  }
  .thumb .play {
    width: 44px;
    height: 44px;
    right: 50%;
    bottom: 50%;
    margin: 0 -22px -22px 0;
  }
  .thumb:has(.progress) .play {
    bottom: calc(50% + 4px);
  }
  .spin {
    width: 16px;
    height: 16px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin calc(0.8s * var(--tempo)) linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  a.text {
    display: block;
    padding: 10px 2px 0;
    min-width: 0;
    transition: transform var(--t-slow) var(--spring);
  }
  .title {
    font-weight: 560;
    font-size: var(--fs-callout);
    color: var(--label);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .server {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 5px;
    border-radius: var(--r-xs);
    background: var(--fill-1);
    font-size: var(--fs-caption);
    line-height: 16px;
    color: var(--label-2);
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 1px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .fav {
    display: inline-grid;
    color: var(--label);
  }

  /* Hover / keyboard focus: lift, shadow, sheen, play button. */
  .card:hover,
  .card:focus-within {
    z-index: 1;
  }
  .card:hover .lift,
  .card:focus-within .lift {
    will-change: transform;
    transform: scale(1.05);
  }
  .card:hover .lift::after,
  .card:focus-within .lift::after {
    opacity: 1;
  }
  .card:hover .sheen,
  .card:focus-within .sheen {
    opacity: 1;
  }
  /* Glass only while visible: a blur per card would cost every scrolled frame. */
  .card:hover .play,
  .card:focus-within .play {
    opacity: 1;
    transform: scale(1);
    background: var(--material);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
  }
  .card:hover a.text,
  .card:focus-within a.text {
    transform: translate3d(0, 6px, 0);
  }
  .card:active .lift {
    transform: scale(1.02);
    transition-duration: calc(120ms * var(--tempo));
  }
  .card:has(.play:active) .lift {
    transform: scale(1.05);
  }
</style>
