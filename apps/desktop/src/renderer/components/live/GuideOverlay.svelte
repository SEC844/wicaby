<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { resolveKey } from '../../../shared/livetv/keys';
  import type { ChannelRow, ProgramLite } from '../../../shared/livetv/model';
  import { w } from '../../lib/bridge';
  import type { LiveTvStore } from '../../lib/livetv.svelte';
  import { dur } from '../../lib/motion';
  import Guide from '../Guide.svelte';
  import DetailBand from '../livetv/DetailBand.svelte';

  // Picture-in-guide (livetv-spec-final.md §8.7, LT-17): the guide over the running channel, in the OSD
  // window. Main moves the video into a tile at the top right (GUIDE_TILE in mpv-player.ts: 3 % from the
  // top, 2 % from the right, 30 % × 30 %); nothing is painted there, so the video shows through. The
  // focused programme's details sit beside it. OK on an airing programme tunes in place (same player,
  // make-before-break). The guide fades; the margins change at once.
  let { store, current, onclose }: { store: LiveTvStore; current: string; onclose: () => void } = $props();

  let guide = $state<ReturnType<typeof Guide>>();
  let focused = $state<{ p: ProgramLite | null; c: ChannelRow | null }>({ p: null, c: null });
  // Opens on the current channel, now.
  const initial = untrack(() => ({ jump: { channelId: current, time: store.now() } }));

  const overlay = (open: boolean) => void w.playback.command({ type: 'guide-overlay', open }).catch(() => undefined);
  onMount(() => {
    overlay(true);
    requestAnimationFrame(() => guide?.focusGrid());
  });
  onDestroy(() => overlay(false));

  // LiveOverlay asks here first while open. The grid already handled its own keys; Escape (which it
  // leaves) and Shift+G close, and nothing else reaches the player.
  export function onKey(e: KeyboardEvent): boolean {
    if (!e.defaultPrevented && (e.key === 'Escape' || resolveKey(e, 'live')?.id === 'live.guideOverlay')) onclose();
    return true;
  }
</script>

<div class="pig" transition:fade={{ duration: dur('fast') }}>
  <div class="detail"><DetailBand {store} program={focused.p} channel={focused.c} /></div>
  <div class="grid">
    <Guide bind:this={guide} {store} mode="overlay" {initial} onfocus={(p, c) => (focused = { p, c })} />
  </div>
</div>

<style>
  .pig {
    position: absolute;
    inset: 0;
    z-index: 8;
  }
  .detail {
    position: absolute;
    top: 3%;
    left: 2%;
    width: 64%;
  }
  .grid {
    position: absolute;
    top: 36%;
    left: 2%;
    right: 2%;
    bottom: 3%;
  }
</style>
