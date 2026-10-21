<script lang="ts">
  // A title's card, as the Apple TV app draws them: a poster (2:3) with no text under it (titled: its name in a
  // grid), or a 16:9 card with its
  // progress over the picture and two lines under it. The image is asked for at the device's pixel size (the
  // server resizes once), fades in over the BlurHash's average colour, and decodes off the main thread; without an
  // image the card shows the title on its tint.
  import type { BaseItem } from '$shared/models';
  import type { Api } from '$tv/api';
  import { episodeLine, progress } from '$tv/format';
  import { placeholder } from '$tv/images';

  let {
    item,
    api,
    wide = false,
    titled = false,
    width,
    subtitle,
    onclick,
  }: { item: BaseItem; api: Api; wide?: boolean; titled?: boolean; width: number; subtitle?: string; onclick?: () => void } = $props();

  const dpr = Math.min(3, window.devicePixelRatio || 2);
  const height = $derived(wide ? Math.round((width * 9) / 16) : Math.round((width * 3) / 2));
  const src = $derived(wide ? api.thumb(item, Math.ceil(width * dpr)) : api.poster(item, Math.ceil(height * dpr)));
  const tint = $derived(placeholder(item, wide ? 'Thumb' : 'Primary') ?? placeholder(item, 'Backdrop'));
  const done = $derived(progress(item));
  const title = $derived(item.Type === 'Episode' && item.SeriesName ? item.SeriesName : item.Name);
  const line = $derived(subtitle ?? (item.Type === 'Episode' ? episodeLine(item) : undefined));
  let loaded = $state(false);
  let failed = $state(false);
</script>

<button class="card pressable" class:wide style:width="{width}px" aria-label={title} {onclick}>
  <span class="art" style:height="{height}px" style:background-color={tint}>
    {#if src && !failed}
      <img {src} alt="" loading="lazy" decoding="async" class:loaded onload={() => (loaded = true)} onerror={() => (failed = true)} />
    {/if}
    {#if !src || failed}<span class="fallback subhead">{title}</span>{/if}
    {#if done}<span class="bar"><span style:transform="scaleX({done})"></span></span>{/if}
  </span>
  {#if wide}
    <span class="subhead strong text">{title}</span>
    {#if line}<span class="footnote label-2 text">{line}</span>{/if}
  {:else if titled}
    <span class="footnote label-2 text">{title}</span>
  {/if}
</button>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    flex: none;
  }
  .art {
    position: relative;
    display: block;
    border-radius: var(--r-md);
    overflow: hidden;
    background: var(--fill-2);
    margin-bottom: 6px;
  }
  /* A hairline inside the edge: dark artwork keeps its shape on the dark canvas. */
  .art::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.1);
    pointer-events: none;
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
  .fallback {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 12px;
    text-align: center;
    color: #fff;
    font-weight: 600;
  }
  .bar {
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 10px;
    height: 4px;
    border-radius: 2px;
    background: rgb(255 255 255 / 0.32);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: #fff;
    transform-origin: left;
  }
  .strong {
    font-weight: 600;
  }
  .text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
