<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../lib/i18n.svelte';

  // Settings > Système > "Compteur d'images par seconde": frames counted with rAF over 500 ms.
  let fps = $state(0);
  let worst = $state(0);

  onMount(() => {
    let raf = 0;
    let frames = 0;
    let longest = 0;
    let last = performance.now();
    let since = last;
    const tick = (now: number) => {
      frames++;
      longest = Math.max(longest, now - last);
      last = now;
      if (now - since >= 500) {
        fps = Math.round((frames * 1000) / (now - since));
        worst = Math.round(longest);
        frames = 0;
        longest = 0;
        since = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="fps mono" aria-hidden="true">{t('shell.fps.meter', { fps, worst })}</div>

<style>
  .fps {
    position: fixed;
    left: 12px;
    bottom: 12px;
    z-index: 300;
    padding: 4px 8px;
    border-radius: var(--r-xs);
    background: rgb(0 0 0 / 0.65);
    color: var(--label);
    font-size: var(--fs-caption);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
</style>
