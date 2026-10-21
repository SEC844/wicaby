<script lang="ts">
  // One settings row: a label and, on the right, the chosen value with a chevron (a choice), a switch (a toggle,
  // Safari's native one: it gives the iOS haptic), or nothing (an action, red when destructive).
  import ChevronRight from '@lucide/svelte/icons/chevron-right';

  let {
    label,
    value,
    checked,
    destructive = false,
    accent = false,
    onclick,
    ontoggle,
  }: { label: string; value?: string; checked?: boolean; destructive?: boolean; accent?: boolean; onclick?: () => void; ontoggle?: (on: boolean) => void } = $props();
</script>

{#if ontoggle}
  <label class="row">
    <span class="label">{label}</span>
    <input class="switch" type="checkbox" switch checked={checked} onchange={(e) => ontoggle((e.currentTarget as HTMLInputElement).checked)} />
  </label>
{:else}
  <button class="row" class:destructive class:accent {onclick} disabled={!onclick}>
    <span class="label">{label}</span>
    {#if value !== undefined}<span class="value label-2">{value}</span>{/if}
    {#if value !== undefined && onclick}<ChevronRight size={18} strokeWidth={2.2} aria-hidden="true" />{/if}
  </button>
{/if}

<style>
  .row {
    width: 100%;
    min-height: 48px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px 10px 16px;
    text-align: left;
    color: var(--label);
  }
  button.row:active:not(:disabled) {
    background: var(--fill-2);
  }
  .label {
    flex: 1;
    min-width: 0;
  }
  .value {
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
  }
  .row :global(svg) {
    color: var(--label-3);
    flex: none;
  }
  .destructive {
    color: var(--red);
  }
  .accent {
    color: var(--accent);
  }
  /* Safari 17.4+ draws the native switch; the accent tints it on. */
  .switch {
    flex: none;
    margin: 0;
    accent-color: var(--green);
    width: 51px;
    height: 31px;
  }
</style>
