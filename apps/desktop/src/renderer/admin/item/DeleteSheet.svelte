<script lang="ts">
  import { untrack } from 'svelte';
  import type { BaseItem } from '../../../shared/models';
  import { t } from '../../lib/i18n.svelte';
  import { back } from '../../lib/router.svelte';
  import { errorMessage, serverName, toast } from '../../lib/stores.svelte';
  import Icon from '../../components/Icon.svelte';
  import AdminSheet from './AdminSheet.svelte';
  import { deleteItem } from './metadata';

  // Deletes the item from the server, media files included. The name must be typed
  // (the id when the item has no name), and the button arms only after a short pause.
  let { open, item, onclose }: { open: boolean; item: BaseItem; onclose: () => void } = $props();

  const ARM_DELAY_MS = 600;

  let typed = $state('');
  let busy = $state(false);
  let error = $state('');
  let armed = $state(false);
  const expected = $derived((item.Name ?? '').trim() || item.Id);
  const ok = $derived(typed.trim() !== '' && typed.trim().toLowerCase() === expected.toLowerCase());
  const folder = $derived(item.IsFolder === true);

  // Keyed on the id: the page hands a new item object after every reload.
  const itemId = $derived(item.Id);

  $effect(() => {
    if (!open) return;
    void itemId;
    untrack(() => {
      typed = '';
      error = '';
    });
  });

  // A held or auto-repeated key cannot type the name and confirm in one go.
  $effect(() => {
    armed = false;
    if (!open || !ok) return;
    const timer = setTimeout(() => (armed = true), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  });

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && e.repeat) e.preventDefault();
  }

  async function run(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!ok || !armed || busy) return;
    busy = true;
    try {
      await deleteItem(item);
      toast('success', t('adminMetadata.delete.done', { name: item.Name }));
      onclose();
      back('/home');
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<AdminSheet {open} {onclose} title={t('adminMetadata.delete.title')} subtitle={item.Name} width={480}>
  <form id="am-delete" onsubmit={run} onkeydowncapture={onkeydown}>
    <div class="warn">
      <Icon name="exclamation" size={18} />
      <p class="callout">
        {folder ? t('adminMetadata.delete.warningFolder', { server: serverName(item.ServerId) }) : t('adminMetadata.delete.warning', { server: serverName(item.ServerId) })}
      </p>
    </div>
    <label class="am-f">
      <span class="am-l">{t('adminMetadata.delete.typeName', { name: expected })}</span>
      <input class="field" bind:value={typed} autocomplete="off" spellcheck="false" data-autofocus aria-label={t('adminMetadata.delete.typeName', { name: expected })} />
    </label>
    {#if error}<p class="am-error">{error}</p>{/if}
  </form>

  {#snippet footer()}
    <button type="button" class="btn ghost" onclick={onclose}>{t('adminMetadata.common.cancel')}</button>
    <button type="submit" form="am-delete" class="btn danger" disabled={!ok || !armed || busy} onkeydown={onkeydown}>
      <Icon name="trash" size={15} />
      {busy ? t('adminMetadata.delete.deleting') : t('adminMetadata.delete.confirm')}
    </button>
  {/snippet}
</AdminSheet>

<style>
  .warn {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin: 6px 0 18px;
    padding: 14px 16px;
    border-radius: var(--r-sm);
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
  }
  .warn p {
    margin: 0;
    color: var(--label);
    line-height: 1.5;
  }
  .warn :global(svg) {
    flex: none;
    margin-top: 1px;
  }
</style>
