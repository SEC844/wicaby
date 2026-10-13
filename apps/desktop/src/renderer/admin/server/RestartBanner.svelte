<script lang="ts">
  // "Restart required" strip shown at the top of a section once a change needs
  // the server to restart. Restarting asks first: it stops every playback.
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../lib/i18n.svelte';
  import ConfirmSheet from './ConfirmSheet.svelte';
  import { restartServer, restartState } from './serverAdmin.svelte';

  let { serverId }: { serverId: string } = $props();
  let confirming = $state(false);
  let busy = $state(false);

  async function restart(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await restartServer(serverId);
    } finally {
      busy = false;
      confirming = false;
    }
  }

  // Opening the sheet with a held key must not run straight into it (ConfirmSheet starts on Cancel).
  function ask(e: MouseEvent): void {
    if (e.detail > 1) return;
    confirming = true;
  }
</script>

{#if restartState.needed[serverId]}
  <div class="banner" role="status">
    <span class="ic"><Icon name="power" size={16} /></span>
    <div class="a-txt">
      <span class="a-lbl">{t('adminServer.restart.title')}</span>
      <span class="a-desc">{t('adminServer.restart.desc')}</span>
    </div>
    <button type="button" class="a-push" onclick={ask} onkeydown={(e) => e.repeat && e.preventDefault()}>{t('adminServer.restart.action')}</button>
  </div>
{/if}

<ConfirmSheet
  open={confirming}
  title={t('adminServer.restart.confirmTitle')}
  message={t('adminServer.restart.confirmText')}
  confirmLabel={t('adminServer.restart.action')}
  {busy}
  onconfirm={restart}
  onclose={() => (confirming = false)}
/>

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 18px;
    padding: 12px 14px 12px 16px;
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
  }
  /* The first group heading after the banner needs no extra top margin. */
  .banner + :global(.a-gh) {
    margin-top: 0;
  }
  .ic {
    flex: none;
    display: grid;
    color: var(--label-2);
  }
</style>
