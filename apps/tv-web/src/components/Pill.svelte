<script lang="ts">
  // Android TV Pill (Components.kt): text and/or icon in a capsule. Focused: white with black content and a lift;
  // `primary`: the accent; `selected`: a stronger fill. Icon-only pills need a `description` for screen readers.
  import { focusable } from '../lib/focus';
  import Icon from './Icon.svelte';

  let {
    text,
    icon,
    primary = false,
    selected = false,
    description,
    autofocus = false,
    onclick,
  }: {
    text?: string;
    icon?: string;
    primary?: boolean;
    selected?: boolean;
    description?: string;
    autofocus?: boolean;
    onclick: () => void;
  } = $props();
</script>

<button
  class="pill t-headline"
  class:primary
  class:selected
  class:icon-only={!text}
  aria-label={text ?? description}
  use:focusable={autofocus}
  {onclick}
>
  {#if icon}<Icon name={icon} size={20} />{/if}
  {#if text}<span class="ellipsis">{text}</span>{/if}
</button>

<style>
  .pill {
    display: flex;
    align-items: center;
    padding: 11rem 22rem;
    border-radius: 999rem;
    background: var(--fill-3);
    color: var(--label);
    white-space: nowrap;
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .pill > :global(svg + span) {
    margin-left: 8rem;
  }
  .icon-only {
    padding: 11rem 13rem;
  }
  .selected {
    background: var(--fill-4);
  }
  .primary {
    background: var(--accent);
    color: var(--on-accent);
  }
  .pill:global(.focused) {
    transform: scale(var(--focus-scale));
  }
  .pill:global(.focused):not(.primary) {
    background: #fff;
    color: #000;
  }
</style>
