<script lang="ts">
  // Sticky bar at the foot of a settings form while it has unsaved changes.
  import { t } from '../../lib/i18n.svelte';

  let {
    dirty,
    busy = false,
    invalid = false,
    onsave,
    onrevert,
  }: { dirty: boolean; busy?: boolean; invalid?: boolean; onsave: () => void; onrevert: () => void } = $props();
</script>

{#if dirty}
  <div class="bar material">
    <span class="msg">{invalid ? t('adminServer.common.invalid') : t('adminServer.common.unsaved')}</span>
    <button type="button" class="a-push ghost" disabled={busy} onclick={onrevert}>{t('adminServer.common.revert')}</button>
    <button type="button" class="a-push primary" disabled={busy || invalid} onclick={onsave}>{t('common.actions.save')}</button>
  </div>
{/if}

<style>
  .bar {
    position: sticky;
    bottom: 16px;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 22px;
    padding: 10px 10px 10px 18px;
    border-radius: var(--r-md);
    box-shadow:
      inset 0 0 0 1px var(--hairline),
      var(--shadow-2);
    animation: bar-in var(--t-med) var(--ease-out) both;
  }
  @keyframes bar-in {
    from {
      opacity: 0;
      transform: translate3d(0, 8px, 0);
    }
  }
  .msg {
    flex: 1;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
</style>
