<script lang="ts">
  import { untrack } from 'svelte';
  import type { BaseItem } from '../../../shared/models';
  import { t } from '../../lib/i18n.svelte';
  import { errorMessage, toast } from '../../lib/stores.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import AdminSheet from './AdminSheet.svelte';
  import { refreshItem } from './metadata';

  let { open, item, onclose }: { open: boolean; item: BaseItem; onclose: () => void } = $props();

  let mode = $state<'missing' | 'all'>('missing');
  let replaceImages = $state(false);
  let recursive = $state(true);
  let busy = $state(false);
  let error = $state('');
  const folder = $derived(item.IsFolder === true || ['Series', 'Season', 'BoxSet', 'MusicAlbum', 'MusicArtist'].includes(item.Type));

  // Keyed on the id: the page hands a new item object after every reload.
  const itemId = $derived(item.Id);

  $effect(() => {
    if (!open) return;
    void itemId;
    untrack(() => {
      mode = 'missing';
      replaceImages = false;
      recursive = true;
      error = '';
    });
  });

  async function run(): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await refreshItem(item, { mode, replaceImages, recursive: folder && recursive });
      toast('success', t('adminMetadata.refresh.started'));
      onclose();
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<AdminSheet {open} {onclose} title={t('adminMetadata.refresh.title')} subtitle={item.Name} width={500}>
  <div class="mode">
    <Segmented
      value={mode}
      label={t('adminMetadata.refresh.mode')}
      options={[
        { value: 'missing', label: t('adminMetadata.refresh.missing') },
        { value: 'all', label: t('adminMetadata.refresh.all') },
      ]}
      onchange={(v) => (mode = v)}
    />
    <p class="a-foot">{mode === 'all' ? t('adminMetadata.refresh.allHint') : t('adminMetadata.refresh.missingHint')}</p>
  </div>
  <div class="a-group">
    <div class="a-row">
      <div class="a-txt">
        <span class="a-lbl">{t('adminMetadata.refresh.replaceImages')}</span>
        <span class="a-desc">{t('adminMetadata.refresh.replaceImagesHint')}</span>
      </div>
      <Toggle checked={replaceImages} label={t('adminMetadata.refresh.replaceImages')} onchange={(v) => (replaceImages = v)} />
    </div>
    {#if folder}
      <div class="a-row">
        <div class="a-txt">
          <span class="a-lbl">{t('adminMetadata.refresh.recursive')}</span>
          <span class="a-desc">{t('adminMetadata.refresh.recursiveHint')}</span>
        </div>
        <Toggle checked={recursive} label={t('adminMetadata.refresh.recursive')} onchange={(v) => (recursive = v)} />
      </div>
    {/if}
  </div>
  {#if error}<p class="am-error">{error}</p>{/if}

  {#snippet footer()}
    <button type="button" class="btn ghost" onclick={onclose}>{t('adminMetadata.common.cancel')}</button>
    <button type="button" class="btn primary" disabled={busy} onclick={run} data-autofocus>{t('adminMetadata.refresh.run')}</button>
  {/snippet}
</AdminSheet>

<style>
  .mode {
    margin: 4px 0 18px;
  }
</style>
