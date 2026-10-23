<script lang="ts">
  // The text subtitles over the picture, in the Settings look (size, style, colour, position), scaled to the
  // video's height so they read the same in portrait and landscape, raised over the controls while they show.
  // `contained`: in a small frame (the Settings preview), without the screen's safe areas.
  import { settings } from '$tv/settings.svelte';
  import type { Cue } from '$tv/subtitles';

  let { cues, raised = false, contained = false }: { cues: Cue[]; raised?: boolean; contained?: boolean } = $props();

  const SIZES = [0.75, 1, 1.25, 1.5];
  const COLORS = ['#fff', '#ffe14d', '#d1d1d6'];
  const POSITIONS = [4, 9, 16];
  const FONTS = ['inherit', '-apple-system, system-ui, sans-serif', 'ui-serif, "New York", Georgia, serif'];
  const at = <T,>(list: T[], i: number): T => list[Math.max(0, Math.min(list.length - 1, i))];
  const style = $derived(settings.subtitleStyle.value);
</script>

{#if cues.length}
  <div class="layer" class:raised class:contained style:font-family={at(FONTS, settings.subtitleFont.value)} style:--size={at(SIZES, settings.subtitleSize.value)} style:--pos="{at(POSITIONS, settings.subtitlePosition.value)}%">
    {#each cues as cue (cue.startMs + cue.html)}
      <span class="cue" class:outline={style === 0} class:shadow={style === 1} class:box={style === 2} style:color={at(COLORS, settings.subtitleColor.value)}>{@html cue.html}</span>
    {/each}
  </div>
{/if}

<style>
  .layer {
    position: absolute;
    left: max(16px, var(--safe-left));
    right: max(16px, var(--safe-right));
    bottom: calc(var(--pos) + var(--safe-bottom));
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    pointer-events: none;
    text-align: center;
    transition: transform var(--t-med) var(--ease);
  }
  .layer.raised {
    transform: translateY(-110px);
  }
  .contained {
    left: 12px;
    right: 12px;
    bottom: var(--pos);
  }
  .contained .cue {
    font-size: calc(var(--size) * 15px);
  }
  .cue {
    font-size: calc(var(--size) * clamp(16px, 4.6vmin, 34px));
    font-weight: 600;
    line-height: 1.25;
    max-width: 92%;
  }
  .outline {
    -webkit-text-stroke: 0;
    text-shadow:
      0 0 3px #000,
      0 0 3px #000,
      1px 1px 2px #000,
      -1px -1px 2px #000;
  }
  .shadow {
    text-shadow: 2px 2px 6px rgb(0 0 0 / 0.9);
  }
  .box {
    background: rgb(0 0 0 / 0.72);
    padding: 2px 10px;
    border-radius: 6px;
  }
</style>
