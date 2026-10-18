<script lang="ts">
  // Android TV TextButton: a quiet secondary action (label and icon, no fill until focused).
  import { focusable } from '../lib/focus';
  import Icon from './Icon.svelte';

  let { text, icon, onclick }: { text: string; icon?: string; onclick: () => void } = $props();
</script>

<button class="text-button t-callout" use:focusable {onclick}>
  {#if icon}<Icon name={icon} size={18} />{/if}
  <span>{text}</span>
</button>

<style>
  .text-button {
    display: flex;
    align-items: center;
    padding: 9rem 16rem;
    border-radius: 999rem;
    color: var(--label-2);
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .text-button span {
    margin-left: 8rem;
  }
  .text-button:global(.focused) {
    background: #fff;
    color: #000;
    transform: scale(var(--focus-scale));
  }
</style>
