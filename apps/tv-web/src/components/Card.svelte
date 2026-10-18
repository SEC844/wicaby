<script lang="ts">
  // Android TV PosterCard / ThumbCard (Components.kt): artwork that takes the focus (lift, sheen, shadow), the title and
  // one line below. `poster` 2:3 (120 dp), `square` 1:1 (music), `thumb` 16:9 (232 dp) with the progress line.
  import type { BaseItem } from '$shared/models';
  import type { Api } from '../lib/api';
  import { focusable } from '../lib/focus';
  import { episodeLine, progress, runtimeText } from '../lib/format';
  import { t } from '../lib/i18n.svelte';
  import { dpPx, placeholder } from '../lib/images';

  let {
    item,
    api,
    variant = 'poster',
    width = variant === 'thumb' ? 232 : 120,
    subtitle,
    server,
    inSeries = false,
    onclick,
    onfocus,
  }: {
    item: BaseItem;
    api: Api;
    variant?: 'poster' | 'square' | 'thumb';
    width?: number;
    subtitle?: string;
    server?: string;
    inSeries?: boolean;
    onclick: () => void;
    onfocus?: () => void;
  } = $props();

  const thumb = $derived(variant === 'thumb');
  const ratio = $derived(variant === 'poster' ? 1.5 : variant === 'square' ? 1 : 9 / 16);
  const url = $derived(thumb ? api.thumb(item, dpPx(width)) : api.poster(item, dpPx(width * ratio)));
  const tint = $derived(placeholder(item, thumb ? 'Thumb' : 'Primary'));
  const played = $derived(progress(item));
  const unplayed = $derived(item.Type === 'Series' ? (item.UserData?.UnplayedItemCount ?? 0) : 0);
  let loaded = $state(false);
  let failed = $state(false);

  // ThumbCard's title and line: the series for an episode outside its series, the time left of a started one.
  const title = $derived.by(() => {
    if (!thumb) return item.Name;
    const code = inSeries && item.IndexNumber != null ? `${t('episode_short', item.IndexNumber)} · ` : '';
    return item.Type === 'Episode' && !inSeries ? (item.SeriesName ?? item.Name) : code + item.Name;
  });
  const line = $derived.by(() => {
    if (!thumb) return server;
    const left = played !== undefined ? runtimeText((item.RunTimeTicks ?? 0) * (1 - played)) : undefined;
    const sub =
      subtitle ??
      (inSeries ? runtimeText(item.RunTimeTicks) : episodeLine(item)) ??
      (left ? t('time_left', left) : undefined) ??
      item.ProductionYear?.toString();
    return [sub, server].filter(Boolean).join(' · ') || undefined;
  });
</script>

<div class="card" class:thumb style="width:{width}rem">
  <button
    class="art"
    style="padding-top:{ratio * 100}%;{tint ? `background-color:${tint}` : ''}"
    aria-label={item.Name}
    use:focusable
    {onclick}
    ontvfocus={onfocus}
  >
    {#if url && !failed}
      <img src={url} alt="" class:loaded decoding="async" onload={() => (loaded = true)} onerror={() => (failed = true)} />
    {:else}
      <span class="fallback t-callout">{item.Name}</span>
    {/if}
    {#if thumb}<span class="shade"></span>{/if}
    {#if item.UserData?.Played}
      <span class="badge check"><svg viewBox="0 0 24 24"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg></span>
    {:else if unplayed > 0}
      <span class="badge count t-caption">{unplayed}</span>
    {/if}
    {#if played !== undefined}<span class="progress"><span style="transform:scaleX({played})"></span></span>{/if}
    <span class="sheen"></span>
  </button>
  <div class="title ellipsis" class:t-callout={thumb} class:t-footnote={!thumb}>{title}</div>
  {#if line}<div class="line t-footnote ellipsis">{line}</div>{/if}
</div>

<style>
  .card {
    flex-shrink: 0;
  }
  .art {
    position: relative;
    display: block;
    width: 100%;
    height: 0;
    overflow: hidden;
    border-radius: var(--r-md);
    background: var(--elevated-2);
    transition: transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow var(--t-med) var(--ease-out);
  }
  img {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity var(--t-med) var(--ease-out);
  }
  img.loaded {
    opacity: 1;
  }
  .fallback {
    position: absolute;
    top: 50%;
    left: 0;
    right: 0;
    padding: 0 12rem;
    transform: translateY(-50%);
    color: var(--label-2);
    text-align: center;
  }
  .shade {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(transparent 55%, rgba(0, 0, 0, 0.55));
  }
  .badge {
    position: absolute;
    top: 8rem;
    right: 8rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent);
    color: var(--on-accent);
  }
  .check {
    width: 22rem;
    height: 22rem;
    border-radius: 50%;
  }
  .check svg {
    width: 15rem;
    height: 15rem;
    fill: currentColor;
  }
  .count {
    padding: 2rem 7rem;
    border-radius: 999rem;
    font-size: 11rem;
  }
  .progress {
    position: absolute;
    left: 8rem;
    right: 8rem;
    bottom: 8rem;
    height: 4rem;
    border-radius: 2rem;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.28);
  }
  .thumb .progress {
    left: 12rem;
    right: 12rem;
    bottom: 10rem;
  }
  .progress span {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
  }
  .sheen {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.22), rgba(255, 255, 255, 0.04) 45%, transparent 70%);
    opacity: 0;
    transition: opacity var(--t-med);
  }
  .title {
    margin: 12rem 2rem 0;
    color: var(--label-2);
  }
  .line {
    margin: 2rem 2rem 0;
    color: var(--label-3);
  }
  .art:global(.focused) {
    transform: scale(1.08);
    box-shadow: 0 16rem 32rem rgba(0, 0, 0, 0.5);
  }
  .thumb .art:global(.focused) {
    transform: scale(1.07);
  }
  .art:global(.focused.pressed) {
    transform: scale(1.04);
  }
  .art:global(.focused) .sheen {
    opacity: 1;
  }
  .art:global(.focused) ~ .title {
    color: var(--label);
  }
  :global(:root[data-lite]) .art:global(.focused) {
    box-shadow: none;
  }
</style>
