<script lang="ts">
  // Android TV MemoryCard (ui/photos/Memories.kt): one earlier year of "Ce jour-là", a 16:9 tile of 232 dp with its
  // cover, "Il y a N ans", the date and the count. OK opens that year's photos in the viewer.
  import { focusable } from '../lib/focus';
  import { locale, plural } from '../lib/i18n.svelte';
  import { dpPx } from '../lib/images';
  import type { Api } from '../lib/api';
  import { memoryCover, photoDate, photoUrl, type MemoryGroup } from '../lib/photos.svelte';

  let { api, group, onclick }: { api: Api; group: MemoryGroup; onclick: () => void } = $props();

  const W = 232;
  const cover = $derived(memoryCover(group.photos));
  const src = $derived(photoUrl(api, cover.asset, dpPx(W)));
  let loaded = $state(false);
</script>

<div class="card" style="width:{W}rem">
  <button class="art" use:focusable {onclick} aria-label={plural('photos_memories_years_ago', group.yearsAgo, group.yearsAgo)}>
    {#if src}<img {src} alt="" class:loaded onload={() => (loaded = true)} />{/if}
    <span class="sheen"></span>
  </button>
  <p class="t-callout ellipsis title">{plural('photos_memories_years_ago', group.yearsAgo, group.yearsAgo)}</p>
  <p class="t-footnote ellipsis line">{photoDate(cover.asset.takenAt, locale.current)} · {plural('photos_count', group.photos.length, group.photos.length)}</p>
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
    padding-bottom: 56.25%;
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
  p {
    margin: 0;
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
    transform: scale(1.06);
    box-shadow: 0 16rem 32rem rgba(0, 0, 0, 0.5);
  }
  .art:global(.focused) .sheen {
    opacity: 1;
  }
  .art:global(.focused) ~ .title {
    color: var(--label);
  }
</style>
