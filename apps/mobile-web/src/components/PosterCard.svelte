<script lang="ts">
  // A poster (2:3) or a thumbnail (16:9) with its title, as the Android mobile rows draw them. The image is asked for
  // at the device's pixel size (the server resizes once), fades in over the BlurHash's average colour, and decodes
  // off the main thread.
  import type { BaseItem } from '$shared/models';
  import type { Api } from '$tv/api';
  import { placeholder } from '$tv/images';

  let { item, api, thumb = false, width, subtitle, onclick }: { item: BaseItem; api: Api; thumb?: boolean; width: number; subtitle?: string; onclick?: () => void } = $props();

  const dpr = Math.min(3, window.devicePixelRatio || 2);
  const height = $derived(thumb ? (width * 9) / 16 : (width * 3) / 2);
  const src = $derived(thumb ? api.thumb(item, Math.ceil(width * dpr)) : api.poster(item, Math.ceil(height * dpr)));
  const tint = $derived(placeholder(item, thumb ? 'Thumb' : 'Primary'));
  const progress = $derived(item.UserData?.PlayedPercentage);
  let loaded = $state(false);
</script>

<button class="card pressable" style:width="{width}px" {onclick}>
  <span class="art" style:height="{height}px" style:background-color={tint}>
    {#if src}<img {src} alt="" loading="lazy" decoding="async" class:loaded onload={() => (loaded = true)} />{/if}
    {#if progress}<span class="bar"><span style:transform="scaleX({progress / 100})"></span></span>{/if}
  </span>
  <span class="subhead name">{item.SeriesName ?? item.Name}</span>
  {#if subtitle}<span class="footnote label-2 name">{subtitle}</span>{/if}
</button>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    text-align: left;
    flex: none;
  }
  .art {
    position: relative;
    display: block;
    border-radius: var(--r-sm);
    overflow: hidden;
    background: var(--fill-2);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity var(--t-med) var(--ease-out);
  }
  img.loaded {
    opacity: 1;
  }
  .bar {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 8px;
    height: 4px;
    border-radius: 2px;
    background: rgb(255 255 255 / 0.3);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
