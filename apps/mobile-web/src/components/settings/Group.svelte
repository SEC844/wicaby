<script lang="ts">
  // A settings group as iOS draws it: a small caps title, rounded rows on the elevated fill, a hint under them.
  import type { Snippet } from 'svelte';

  let { title, hint, children }: { title?: string; hint?: string; children: Snippet } = $props();
</script>

<section class="group">
  {#if title}<h2 class="footnote label-2 title">{title}</h2>{/if}
  <div class="rows">{@render children()}</div>
  {#if hint}<p class="footnote label-2 hint">{hint}</p>{/if}
</section>

<style>
  .group {
    margin: 26px max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
  }
  .title {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 0 0 7px 16px;
  }
  .rows {
    border-radius: var(--r-md);
    background: var(--bg-elevated);
    overflow: hidden;
  }
  .rows > :global(* + *) {
    border-top: 0.5px solid var(--separator);
  }
  .hint {
    margin: 7px 16px 0;
    line-height: 1.35;
  }
</style>
