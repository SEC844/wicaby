<script lang="ts">
  // One entry of the screen stack. Hidden while not on top (display: none removes it from the focus search), and
  // tells its children their stack key for Back handlers (lib/nav.svelte.ts onBack).
  import { setContext, type Snippet } from 'svelte';
  import { SCREEN } from '../lib/nav.svelte';

  let { key, top, children }: { key: number; top: boolean; children: Snippet } = $props();
  // svelte-ignore state_referenced_locally
  setContext(SCREEN, key);
</script>

<div class="screen" class:hidden={!top} data-screen-top={top ? '' : undefined}>
  {@render children()}
</div>

<style>
  .screen {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
  }
  .hidden {
    display: none;
  }
</style>
