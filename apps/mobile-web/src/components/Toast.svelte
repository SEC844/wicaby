<script lang="ts">
  // Short messages (lib/toast.svelte.ts, shared with the TV): one at a time, above the tab bar.
  import { fly } from 'svelte/transition';
  import { toast } from '$tv/toast.svelte';
</script>

{#key toast.key}
  {#if toast.text}
    <div class="toast material subhead" role="status" transition:fly={{ y: 24, duration: 240 }}>{toast.text}</div>
  {/if}
{/key}

<style>
  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(var(--tabbar) + 16px);
    translate: -50% 0;
    max-width: calc(100% - 40px);
    padding: 12px 18px;
    border-radius: 999px;
    background: var(--material-thick);
    box-shadow: var(--shadow-2);
    z-index: 60;
    text-align: center;
  }
</style>
