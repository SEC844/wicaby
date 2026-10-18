<script lang="ts">
  // Android TV SettingRow (Settings.kt): label, an optional value on the right and a chevron. Focused: white with
  // black text. Left goes back to the section list (data-settings-row, handled by SettingsTab).
  import { focusable } from '../../lib/focus';
  import Icon from '../Icon.svelte';

  let {
    label,
    value,
    chevron = false,
    mono = false,
    onclick = () => {},
  }: { label: string; value?: string; chevron?: boolean; mono?: boolean; onclick?: () => void } = $props();
</script>

<button class="row" data-settings-row use:focusable {onclick}>
  <span class="label t-headline ellipsis">{label}</span>
  {#if value !== undefined}<span class="value" class:t-mono={mono} class:t-callout={!mono}>{value}</span>{/if}
  {#if chevron}<span class="chevron"><Icon name="Chevron" size={18} /></span>{/if}
</button>

<style>
  .row {
    display: flex;
    align-items: center;
    width: 100%;
    margin-top: 4rem;
    padding: 12rem 18rem;
    border-radius: var(--r-md);
    background: var(--fill-1);
    text-align: left;
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .label {
    flex: 1;
    min-width: 0;
  }
  .value {
    max-width: 340rem;
    margin-left: 16rem;
    color: var(--label-2);
    text-align: right;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .chevron {
    margin-left: 16rem;
    color: var(--label-3);
  }
  .row:global(.focused) {
    background: #fff;
    color: #000;
    transform: scale(1.025);
  }
  .row:global(.focused) .value {
    color: rgba(0, 0, 0, 0.62);
  }
  .row:global(.focused) .chevron {
    color: rgba(0, 0, 0, 0.5);
  }
</style>
