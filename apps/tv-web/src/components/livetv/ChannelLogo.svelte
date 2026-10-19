<script lang="ts">
  // A channel's logo (Android livetv ChannelLogo): the server's image fitted in a box, or the channel's name in its
  // place when there is none or it fails. [plate]: on a dark plate (F1), so a white logo still reads on a focused
  // (white) row.
  import type { ChannelRow } from '$shared/livetv/model';
  import type { LiveTv } from '../../lib/livetv.svelte';
  import { dpPx } from '../../lib/images';

  let {
    repo,
    row,
    height,
    width = height * 2.2,
    fallback = true,
    plate = false,
  }: { repo: LiveTv; row: ChannelRow; height: number; width?: number; fallback?: boolean; plate?: boolean } = $props();

  const src = $derived(repo.logo(row, dpPx(height)));
  let failed = $state<string | undefined>(undefined);
</script>

<span class="logo" class:plate style="width:{width}rem;height:{height}rem">
  {#if src && failed !== src}
    <img {src} alt={row.name} onerror={() => (failed = src)} />
  {:else if fallback}
    <span class="name" style="font-size:{Math.max(11, height * 0.38)}rem">{row.name}</span>
  {/if}
</span>

<style>
  .logo {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    overflow: hidden;
  }
  .plate {
    padding: 4rem 8rem;
    border-radius: var(--r-xs);
    background: #1c1c1f;
    box-sizing: content-box;
  }
  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .name {
    font-weight: 700;
    line-height: 1.1;
    text-align: center;
    color: var(--label-2);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
</style>
