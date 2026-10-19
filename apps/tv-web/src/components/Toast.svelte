<script lang="ts">
  // The toast layer (lib/toast.svelte.ts), above the screens, never focusable.
  import { toast } from '../lib/toast.svelte';
</script>

{#if toast.text}
  {#key toast.key}
    <div class="toast t-callout" role="status">{toast.text}</div>
  {/key}
{/if}

<style>
  .toast {
    position: fixed;
    left: 50%;
    bottom: 48rem;
    z-index: 200;
    max-width: 640rem;
    padding: 12rem 22rem;
    border-radius: 999rem;
    background: var(--raised);
    color: var(--label);
    transform: translateX(-50%);
    animation: in var(--t-fast) var(--ease-out) both;
  }
  @keyframes in {
    from {
      opacity: 0;
    }
  }
</style>
