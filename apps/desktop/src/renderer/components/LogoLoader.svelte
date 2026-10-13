<script lang="ts">
  // Loading state drawn with the Wicaby mark, "en mode pinceau": a brush runs
  // along the W's centreline from the top-left to the right arm and leaves ink
  // behind (stroke-dashoffset on the centreline at the W's stroke width, clipped
  // by the W outline so the ink takes its exact shape), the blue play triangle
  // stamps in (scale 0.6 to 1, spring), holds, then the ink lifts (fade and a
  // slight rise) and the loop restarts. 2.4 s per cycle, scaled by --tempo.
  // A narrower, slightly faster tip leads the full-width body, so the leading
  // edge tapers like a brush. Large sizes add a light ink-edge displacement.
  // Reduced motion: the static mark with a gentle opacity pulse.
  // Geometry: brand/wicaby-mark-path.json (brand/scripts/make-brand.mjs).
  import mark from '../../../../../brand/wicaby-mark-path.json';
  import { t } from '../lib/i18n.svelte';

  // delay (ms): fade in only after this long, so a wait that ends quickly shows nothing.
  let {
    size = 28,
    label,
    delay = 0,
    class: cls = '',
  }: { size?: number; label?: string; delay?: number; class?: string } = $props();

  const uid = $props.id();
  // The small cut (wider gap) keeps the gap open at inline sizes; the texture filter is for splash sizes only.
  const cut = $derived(size <= 28 ? mark.small : mark.regular);
  const textured = $derived(size >= 48);
</script>

<span class="ld {cls}" class:late={delay > 0} style:--delay="{delay}ms" role="progressbar" aria-label={label ?? t('common.status.loading')} aria-busy="true">
  <svg width={size} height={size} viewBox={mark.viewBox.join(' ')} aria-hidden="true">
    <defs>
      <clipPath id="{uid}-w"><path d={cut.w} /></clipPath>
      {#if textured}
        <!-- Region in user space: the default box is the centreline's, without its stroke width. -->
        <filter id="{uid}-ink" filterUnits="userSpaceOnUse" x={mark.viewBox[0]} y={mark.viewBox[1]} width={mark.viewBox[2]} height={mark.viewBox[3]}>
          <feTurbulence type="fractalNoise" baseFrequency="0.11 0.07" numOctaves="2" seed="7" />
          <feDisplacementMap in="SourceGraphic" scale="10" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      {/if}
    </defs>
    <g class="lift">
      <g clip-path="url(#{uid}-w)">
        <g filter={textured ? `url(#${uid}-ink)` : undefined}>
          <path class="ink body" d={cut.line} pathLength="1" stroke-width={cut.stroke + 6} />
          <path class="ink tip" d={cut.line} pathLength="1" stroke-width={cut.stroke * 0.5} />
        </g>
      </g>
      <path class="play" d={cut.play} />
    </g>
  </svg>
</span>

<style>
  .ld {
    --cycle: calc(2400ms * var(--tempo));
    display: inline-grid;
    place-items: center;
    flex: none;
    color: var(--label);
  }
  .late {
    animation: appear var(--t-med) var(--ease-out) calc(var(--delay) * var(--tempo)) both;
  }
  @keyframes appear {
    from {
      opacity: 0;
    }
  }
  svg {
    display: block;
    overflow: visible;
  }
  .ink {
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 1 2;
  }
  /* Fast then slow: the brush lands, sweeps, and settles into the right arm. */
  .body {
    animation: paint-body var(--cycle) linear infinite;
  }
  .tip {
    animation: paint-tip var(--cycle) linear infinite;
  }
  .play {
    fill: #0a84ff; /* brand blue, like Logo.svelte, independent of the accent */
    transform-box: fill-box;
    transform-origin: center;
    animation: stamp var(--cycle) linear infinite;
  }
  .lift {
    animation: lift var(--cycle) linear infinite;
  }
  /* Timeline (2.4 s): paint 0-1.05 s, the brush reaching the arm's visible end near 0.85 s;
     stamp 0.84-1.27 s; hold about 600 ms; lift 1.87-2.28 s. */
  @keyframes paint-body {
    0% {
      stroke-dashoffset: 1;
      animation-timing-function: cubic-bezier(0.42, 0.15, 0.35, 1);
    }
    44%,
    100% {
      stroke-dashoffset: 0;
    }
  }
  @keyframes paint-tip {
    0% {
      stroke-dashoffset: 1;
      animation-timing-function: cubic-bezier(0.42, 0.15, 0.35, 1);
    }
    41%,
    100% {
      stroke-dashoffset: 0;
    }
  }
  /* Stamp: 0.6 to 1 with a spring overshoot, opacity in over the first part. */
  @keyframes stamp {
    0%,
    35% {
      opacity: 0;
      transform: scale(0.6);
      animation-timing-function: cubic-bezier(0.2, 0.9, 0.3, 1);
    }
    38% {
      opacity: 1;
    }
    42% {
      transform: scale(1.09);
      animation-timing-function: ease-in-out;
    }
    47% {
      transform: scale(0.97);
      animation-timing-function: ease-in-out;
    }
    53%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
  }
  /* The ink lifts: fade and a slight rise. */
  @keyframes lift {
    0% {
      opacity: 0;
      translate: 0 0;
    }
    3%,
    78% {
      opacity: 1;
      translate: 0 0;
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    95%,
    100% {
      opacity: 0;
      translate: 0 -34px;
    }
  }

  /* Reduced motion: the finished mark, breathing gently. */
  @media (prefers-reduced-motion: reduce) {
    .ink,
    .play {
      animation: none;
      stroke-dashoffset: 0;
    }
    .lift {
      animation: breathe 2.4s ease-in-out infinite alternate;
    }
  }
  :global(html[data-reduce-motion]) .ink,
  :global(html[data-reduce-motion]) .play {
    animation: none;
    stroke-dashoffset: 0;
  }
  :global(html[data-reduce-motion]) .lift {
    animation: breathe 2.4s ease-in-out infinite alternate;
  }
  @keyframes breathe {
    from {
      opacity: 1;
    }
    to {
      opacity: 0.5;
    }
  }
</style>
