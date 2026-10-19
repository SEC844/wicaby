<script lang="ts">
  // Android TV SheetButton (Chrome.kt): a full-width row of a sheet, white when focused. With an icon the text sits
  // at the start.
  import { focusable } from '../lib/focus';
  import Icon from './Icon.svelte';

  let {
    text,
    icon,
    centered = icon === undefined,
    autofocus = false,
    onclick,
  }: { text: string; icon?: string; centered?: boolean; autofocus?: boolean; onclick: () => void } = $props();
</script>

<button class="button t-headline" class:centered use:focusable={autofocus} {onclick}>
  {#if icon}<span class="icon"><Icon name={icon} size={20} /></span>{/if}
  <span class="text ellipsis">{text}</span>
</button>

<style>
  .button {
    display: flex;
    align-items: center;
    width: 100%;
    margin-top: 6rem;
    padding: 13rem 20rem;
    border-radius: var(--r-md);
    background: var(--fill-2);
    color: var(--label);
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .button:first-child {
    margin-top: 0;
  }
  .icon {
    display: flex;
    margin-right: 12rem;
    color: var(--label-2);
  }
  .text {
    flex: 1;
    min-width: 0;
    text-align: left;
  }
  .centered .text {
    text-align: center;
  }
  .button:global(.focused) {
    background: #fff;
    color: #000;
    transform: scale(1.04);
  }
  .button:global(.focused) .icon {
    color: #000;
  }
</style>
