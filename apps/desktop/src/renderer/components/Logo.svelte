<script lang="ts">
  // The Wicaby mark (brand/wicaby-mark.svg): a rounded W whose right arm flicks
  // into a blue play triangle, separated by a small gap. The W takes
  // currentColor; the triangle is the brand blue unless `mono`, which draws the
  // whole mark in currentColor (sidebar, quiet contexts). At 24 px and below it
  // switches to the small cut (brand/wicaby-mark-small.svg: wider gap, bigger
  // triangle) so the gap survives. `size` is the square box; the mark is
  // centred in it. Pass `title` when the mark stands alone and must be
  // announced; otherwise it is decorative. Paths come from brand/scripts/make-brand.mjs.
  let {
    size = 24,
    mono = false,
    title,
    class: cls = '',
  }: { size?: number; mono?: boolean; title?: string; class?: string } = $props();
  const small = $derived(size <= 24);
</script>

<svg
  class="logo {cls}"
  width={size}
  height={size}
  viewBox="170 175 696 696"
  fill="currentColor"
  role={title ? 'img' : undefined}
  aria-label={title}
  aria-hidden={title ? undefined : 'true'}
>
  {#if small}
    <path d="M183.32 464.15A70 70 0 0 1 307.68 399.85L373.84 527.81L457.77 398.41A70 70 0 0 1 578.62 404.23L643.34 528.83L664.77 495.37A56 56 0 0 0 742.56 518.84L782.49 496.05A12 12 0 0 1 799.04 512.09L698.86 701.26A70 70 0 0 1 574.88 700.77L509.8 575.47L425.73 705.09A70 70 0 0 1 304.82 699.15Z" />
    <path class:play={!mono} d="M698.8 327.46A28 28 0 0 1 740.68 303.14L847.64 364.18A28 28 0 0 1 847.64 412.82L740.68 473.86A28 28 0 0 1 698.8 449.54Z" />
  {:else}
    <path d="M187.76 461.85A65 65 0 0 1 303.24 402.15L373.35 537.76L461.97 401.13A65 65 0 0 1 574.18 406.54L643.25 539.52L692 464.44A42.5 42.5 0 0 0 751.57 483.36L797.83 456.96A11 11 0 0 1 813.03 471.6L694.63 698.56A65 65 0 0 1 579.32 698.46L510.28 565.54L421.53 702.37A65 65 0 0 1 309.26 696.85Z" />
    <path class:play={!mono} d="M707.5 334A25 25 0 0 1 744.89 312.29L840.39 366.79A25 25 0 0 1 840.39 410.21L744.89 464.71A25 25 0 0 1 707.5 443Z" />
  {/if}
</svg>

<style>
  .logo {
    flex: none;
    display: block;
  }
  /* Brand blue, independent of the user's accent choice. */
  .play {
    fill: #0a84ff;
  }
</style>
