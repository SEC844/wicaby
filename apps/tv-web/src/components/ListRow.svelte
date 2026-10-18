<script lang="ts">
  // Android TV ListRow: a full-width row with an optional leading icon, a title, a subtitle and a trailing label.
  import { focusable } from '../lib/focus';
  import Icon from './Icon.svelte';

  let {
    title,
    subtitle,
    icon,
    trailing,
    autofocus = false,
    onclick,
  }: { title: string; subtitle?: string; icon?: string; trailing?: string; autofocus?: boolean; onclick: () => void } = $props();
</script>

<button class="row" use:focusable={autofocus} {onclick}>
  {#if icon}<span class="lead"><Icon name={icon} size={22} /></span>{/if}
  <span class="text">
    <span class="t-headline ellipsis">{title}</span>
    {#if subtitle}<span class="t-footnote sub ellipsis">{subtitle}</span>{/if}
  </span>
  {#if trailing}<span class="t-callout trailing">{trailing}</span>{/if}
</button>

<style>
  .row {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 12rem 18rem;
    border-radius: var(--r-md);
    background: var(--fill-1);
    text-align: left;
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .lead {
    margin-right: 14rem;
    color: var(--label-2);
  }
  .text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .sub,
  .trailing {
    color: var(--label-2);
  }
  .trailing {
    margin-left: 12rem;
  }
  .row:global(.focused) {
    background: #fff;
    color: #000;
    transform: scale(1.02);
  }
  .row:global(.focused) .sub,
  .row:global(.focused) .trailing,
  .row:global(.focused) .lead {
    color: rgba(0, 0, 0, 0.6);
  }
</style>
