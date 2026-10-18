<script lang="ts">
  // Android TV Backdrop (Components.kt): full-bleed art that crossfades (520 ms) when the URL changes, under the
  // Android gradients (left for the text, bottom into the page), with an animated dim. Two layers swap roles, so a
  // change never shows an empty frame; the new image fades in only once decoded.
  let { url, dim = 0 }: { url?: string; dim?: number } = $props();

  let layers = $state<[string | undefined, string | undefined]>([undefined, undefined]);
  let front = $state(0);
  let ready = $state<[boolean, boolean]>([false, false]);

  $effect(() => {
    if (!url || url === layers[front]) return;
    const back = 1 - front;
    ready[back] = false;
    layers[back] = url;
  });

  function loaded(i: number): void {
    ready[i] = true;
    front = i;
  }
</script>

<div class="backdrop" aria-hidden="true">
  {#each layers as src, i (i)}
    {#if src}<img {src} alt="" decoding="async" class:shown={ready[i] && front === i} onload={() => loaded(i)} />{/if}
  {/each}
  <div class="side"></div>
  <div class="bottom"></div>
  <div class="dim" style="opacity:{dim}"></div>
</div>

<style>
  .backdrop {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
    background: var(--bg);
  }
  img {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity 520ms var(--ease-out);
  }
  img.shown {
    opacity: 1;
  }
  .side,
  .bottom,
  .dim {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
  }
  .side {
    background: linear-gradient(90deg, rgba(11, 11, 13, 0.94), rgba(11, 11, 13, 0.62) 38%, rgba(11, 11, 13, 0.08) 72%, transparent);
  }
  .bottom {
    background: linear-gradient(transparent 40%, var(--bg));
  }
  .dim {
    background: var(--bg);
    transition: opacity var(--t-med);
  }
</style>
