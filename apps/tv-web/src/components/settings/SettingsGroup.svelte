<script lang="ts">
  // Android TV settings Group: an optional title above the rows and a hint below.
  import type { Snippet } from 'svelte';

  let { title, hint, children }: { title?: string; hint?: string; children: Snippet } = $props();
</script>

<section class="group">
  {#if title}<h3 class="t-callout">{title}</h3>{/if}
  {@render children()}
  {#if hint}<p class="t-footnote">{hint}</p>{/if}
</section>

<style>
  .group {
    padding-bottom: 26rem;
  }
  h3 {
    margin: 0 0 4rem 18rem;
    font-weight: 500;
    color: var(--label-3);
  }
  p {
    margin: 10rem 18rem 0;
    color: var(--label-3);
  }
</style>
