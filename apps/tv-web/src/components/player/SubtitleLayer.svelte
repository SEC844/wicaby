<script lang="ts">
  // The text subtitles over the picture (Android SubtitleView with styleSubtitles): the Settings size, font, colour,
  // style (outline, shadow, box) and position (core SubtitleLook), raised over the OSD while it shows.
  import { settings } from '../../lib/settings.svelte';
  import type { Cue } from '../../lib/subtitles';

  let { cues, raised = false }: { cues: Cue[]; raised?: boolean } = $props();

  // core SubtitleLook: sizes against Media3's default (5.33 % of the picture height), fonts, colours, positions.
  const SIZES = [0.75, 1, 1.25, 1.5];
  const FONTS = ['Geist, sans-serif', 'sans-serif', 'serif'];
  const COLORS = ['#fff', '#ffe14d', '#d1d1d6'];
  const POSITIONS = [100, 95, 88];
  const at = <T,>(list: T[], i: number): T => list[Math.max(0, Math.min(list.length - 1, i))];

  const size = $derived(28.8 * at(SIZES, settings.subtitleSize.value));
  const bottom = $derived(raised ? 150 : 540 * (0.08 + (100 - at(POSITIONS, settings.subtitlePosition.value)) / 100));
  const style = $derived(settings.subtitleStyle.value);
</script>

{#if cues.length}
  <div class="layer" style="bottom:{bottom}rem">
    {#each cues as cue (cue.startMs + cue.html)}
      <span
        class="cue"
        class:outline={style === 0}
        class:shadow={style === 1}
        class:box={style === 2}
        style="font-size:{size}rem;font-family:{at(FONTS, settings.subtitleFont.value)};color:{at(COLORS, settings.subtitleColor.value)}"
      >{@html cue.html}</span>
    {/each}
  </div>
{/if}

<style>
  .layer {
    position: absolute;
    left: 48rem;
    right: 48rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    pointer-events: none;
    transition: bottom var(--t-med) var(--ease);
  }
  .cue {
    line-height: 1.25;
    font-weight: 500;
  }
  .cue + .cue {
    margin-top: 4rem;
  }
  /* Chromium 53 has no paint-order: a ring of text shadows draws the outline. */
  .outline {
    text-shadow: -1.5rem -1.5rem 0 #000, 1.5rem -1.5rem 0 #000, -1.5rem 1.5rem 0 #000, 1.5rem 1.5rem 0 #000, 0 1.5rem 0 #000, 0 -1.5rem 0 #000, 1.5rem 0 0 #000, -1.5rem 0 0 #000;
  }
  .shadow {
    text-shadow: 2rem 2rem 4rem rgba(0, 0, 0, 0.9);
  }
  .box {
    padding: 2rem 10rem;
    background: rgba(0, 0, 0, 0.7);
    border-radius: 4rem;
  }
</style>
