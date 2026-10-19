<script lang="ts">
  import Picker from '../../components/Picker.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { invalidateApiCache } from '../../lib/api';
  import { w } from '../../lib/bridge';
  import { bytes } from '../../lib/format';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { dataVersion, errorMessage, settings, toast } from '../../lib/stores.svelte';
  import { set, type SettingsData } from './shared.svelte';

  let { data }: { data: SettingsData } = $props();

  const COMIC_CAPS = $derived([0.5, 1, 2, 5, 10].map((v) => ({ value: v, label: t('settings.units.gigabytes', { size: fmt.number(v) }) })));

  const s = $derived(settings.value);

  // ---- Storage ----
  const storage = $derived(data.storage);
  async function clearStorage(kind: 'http' | 'logs'): Promise<void> {
    try {
      data.storage = await w.app.clearStorage(kind);
      toast('success', kind === 'http' ? t('settings.privacy.imageCache.cleared') : t('settings.privacy.logs.cleared'));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  function clearApiCache(): void {
    invalidateApiCache();
    // Pages already open refetch on the next data version.
    dataVersion.library++;
    dataVersion.userData++;
    toast('success', t('settings.privacy.apiCache.cleared'));
  }
</script>

{#if s}
  <h3 class="gh">{t('settings.privacy.storage')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.privacy.imageCache.label')}</div>
        <div class="desc">{storage ? t('settings.privacy.imageCache.descSize', { size: bytes(storage.http) }) : t('settings.privacy.imageCache.desc')}</div>
      </div>
      <button type="button" class="push" onclick={() => clearStorage('http')}>{t('settings.privacy.clear')}</button>
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.privacy.apiCache.label')}</div>
        <div class="desc">{t('settings.privacy.apiCache.desc')}</div>
      </div>
      <button type="button" class="push" onclick={clearApiCache}>{t('settings.privacy.clear')}</button>
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.privacy.comicCache.label')}</div>
        <div class="desc">{storage ? t('settings.privacy.comicCache.descSize', { size: bytes(storage.comics) }) : t('settings.privacy.comicCache.desc')}</div>
      </div>
      <Picker label={t('settings.privacy.comicCache.aria')} value={s.system.comicCacheGb} options={COMIC_CAPS} onchange={(v) => set({ system: { comicCacheGb: v } })} />
    </div>
  </div>
  <p class="foot">{t('settings.privacy.foot')}</p>

  <h3 class="gh">{t('settings.privacy.logsData')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.privacy.logs.label')}</div>
        <div class="desc">{storage ? t('settings.privacy.logs.descSize', { size: bytes(storage.logs) }) : t('settings.privacy.logs.desc')}</div>
      </div>
      <div class="actions">
        <button type="button" class="push ghost" onclick={() => w.app.openPath('logs')}>{t('common.actions.open')}</button>
        <button type="button" class="push" onclick={() => clearStorage('logs')}>{t('common.actions.delete')}</button>
      </div>
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.privacy.dataFolder.label')}</div>
        <div class="desc">{t('settings.privacy.dataFolder.desc')}</div>
        {#if data.info}<div class="path mono" title={data.info.userDataPath}>{data.info.userDataPath}</div>{/if}
      </div>
      <button type="button" class="push" onclick={() => w.app.openPath('data')}>{t('common.actions.open')}</button>
    </div>
  </div>

  {#if data.info?.vaultPlainText}
    <h3 class="gh">{t('settings.privacy.security')}</h3>
    <div class="group">
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.privacy.plainTextVault.label')}</div>
          <div class="desc">{t('settings.privacy.plainTextVault.desc')}</div>
        </div>
        <Toggle label={t('settings.privacy.plainTextVault.label')} checked={s.system.plainTextVault} onchange={(v) => set({ system: { plainTextVault: v } })} />
      </div>
    </div>
  {/if}
{/if}

<style>
  .gh {
    margin: 30px 0 8px 2px;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
  }
  .foot {
    margin: 10px 2px 0;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.5;
  }
  .group {
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
    overflow: hidden;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 16px;
    min-height: 58px;
    padding: 12px 18px;
  }
  /* Hairline between rows, inset to the text edge. */
  .row + .row::before {
    content: '';
    position: absolute;
    top: 0;
    left: 18px;
    right: 0;
    height: 1px;
    background: var(--separator);
  }
  .txt {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .lbl {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--label);
  }
  .desc {
    display: block;
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.45;
  }
  .path {
    margin-top: 3px;
    font-size: var(--fs-caption);
    color: var(--label-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: text;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }

  /* Push button: small, neutral. */
  .push {
    flex: none;
    height: 28px;
    padding: 0 12px;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    font-size: var(--fs-callout);
    font-weight: 500;
    color: var(--label);
    white-space: nowrap;
  }
  .push:hover,
  .push:focus-visible {
    background: var(--fill-3);
  }
  .push.ghost {
    background: transparent;
    color: var(--label-2);
  }
  .push.ghost:hover,
  .push.ghost:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  :global(.searching) .foot {
    display: none;
  }
  /* Hairlines only between rows that are still shown. */
  :global(.searching) .row::before {
    display: none;
  }
  :global(.searching) .row:not([hidden]) ~ .row:not([hidden])::before {
    display: block;
  }
  .push:disabled {
    color: var(--label-4);
    pointer-events: none;
  }
  .actions .push.ghost:has(:global(svg)) {
    width: 28px;
    padding: 0;
    display: grid;
    place-items: center;
  }

  /* Compact density tightens these rows as well. */
  :global(html[data-density='compact']) .row {
    min-height: 50px;
    padding-block: 9px;
  }
</style>
