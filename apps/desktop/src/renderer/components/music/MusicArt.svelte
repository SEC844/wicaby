<script lang="ts">
  import type { BaseItem } from '../../../shared/models';
  import { initials, musicArtLater, musicArtNow, needsLookup, placeholderBg, whenVisible } from '../../lib/music-art';

  // A music item's cover in a row (list views, the queue): its art, a borrowed one (an album's first track, an
  // artist's first album, looked up once visible), else its initials on a colour from its name (music spec §4.A).
  // It fills its box: the caller sizes and rounds it.
  let { item, size }: { item: BaseItem; size: number } = $props();

  let box: HTMLElement | undefined = $state();
  let late = $state<{ id: string; src: string | null } | null>(null);
  const now = $derived(musicArtNow(item, size));
  const src = $derived(now ?? (late?.id === item.Id ? late.src : null));
  let failed = $state('');

  $effect(() => {
    const it = item;
    if (now || !box || !needsLookup(it)) return;
    return whenVisible(box, () => void musicArtLater(it, size).then((s) => (late = { id: it.Id, src: s })));
  });
</script>

<span class="music-art" bind:this={box} style:background={src && failed !== src ? undefined : placeholderBg(item.Name ?? '')}>
  {#if src && failed !== src}
    <img {src} alt="" loading="lazy" decoding="async" draggable="false" onerror={() => (failed = src)} />
  {:else}
    <span class="ph-initials" aria-hidden="true">{initials(item.Name ?? '')}</span>
  {/if}
</span>

<style>
  .music-art {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    border-radius: inherit;
    overflow: hidden;
    container-type: size;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .ph-initials {
    font-size: 38cqmin;
    font-weight: 650;
    letter-spacing: -0.02em;
    color: rgb(255 255 255 / 0.92);
    user-select: none;
  }
</style>
