<script lang="ts">
  // "Ce jour-là" (photos spec F7, PH-08): the Home row, one card per earlier year, nearest first. A card plays that
  // year's photos as a story: the slideshow, opened on a title card.
  import Row from '../../components/Row.svelte';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { photoUrl } from '../../lib/images';
  import { reveal } from '../../lib/motion';
  import type { MemoryGroup } from '../../lib/photos/source.svelte';
  import Slideshow from './Slideshow.svelte';

  let { groups }: { groups: MemoryGroup[] } = $props();
  let playing = $state<MemoryGroup | null>(null);

  // A cover the server already shows upright: quarter-turned photos need the decode test (spec §3.1) first.
  const cover = (g: MemoryGroup) => g.assets.find((a) => !a.orient) ?? g.assets[0];
  const day = (g: MemoryGroup) => fmt.date(new Date(g.assets[0].takenAt.slice(0, 19)), { day: 'numeric', month: 'long', year: 'numeric' });
  const title = (g: MemoryGroup) => t('photos.memories.yearsAgo', { n: g.yearsAgo });
</script>

{#if groups.length > 0}
  <Row title={t('photos.memories.title')} variant="thumb">
    {#each groups as g (g.yearsAgo)}
      <button class="memory" aria-label={t('photos.memories.play', { title: title(g), count: g.assets.length })} onclick={() => (playing = g)}>
        <span class="media">
          <img class="reveal" use:reveal src={photoUrl(cover(g), { maxWidth: 480 })} alt="" loading="lazy" decoding="async" />
          <span class="scrim"></span>
          <span class="label">
            <span class="name">{title(g)}</span>
            <span class="meta">{day(g)} · {t('photos.count', { count: g.assets.length })}</span>
          </span>
        </span>
      </button>
    {/each}
  </Row>
{/if}

{#if playing}
  <Slideshow assets={playing.assets} start={0} title={title(playing)} subtitle={day(playing)} onclose={() => (playing = null)} />
{/if}

<style>
  .memory {
    position: relative;
    display: block;
    width: var(--card-w);
    aspect-ratio: 16 / 9;
    padding: 0;
    border-radius: var(--r-md);
    text-align: left;
    transition: transform var(--t-slow) var(--spring);
  }
  .media {
    position: absolute;
    inset: 0;
    overflow: hidden;
    border-radius: inherit;
    background: var(--fill-1);
  }
  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, rgb(0 0 0 / 0.7), transparent 60%);
  }
  .label {
    position: absolute;
    left: 16px;
    right: 16px;
    bottom: 12px;
    display: grid;
    gap: 2px;
  }
  .name {
    font-size: var(--fs-title-3);
    font-weight: 650;
    letter-spacing: -0.014em;
    color: #fff;
  }
  .meta {
    font-size: var(--fs-footnote);
    color: rgb(255 255 255 / 0.75);
  }
  .memory:hover,
  .memory:focus-visible {
    z-index: 1;
    transform: scale(1.05);
    box-shadow: var(--shadow-3);
  }
</style>
