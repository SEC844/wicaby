<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import { w } from '../../lib/bridge';
  import { bytes } from '../../lib/format';
  import { t } from '../../lib/i18n.svelte';
  import { navigate } from '../../lib/router.svelte';
  import { downloads, settings } from '../../lib/stores.svelte';
  import { set } from './shared.svelte';

  const s = $derived(settings.value);

  const offlineCount = $derived(downloads.list.filter((d) => d.status === 'done').length);
  const offlineBytes = $derived(downloads.list.reduce((n, d) => n + (d.status === 'done' ? d.totalBytes || d.receivedBytes : 0), 0));

  async function pickFolder(): Promise<void> {
    const folder = await w.settings.pickFolder();
    if (folder) await set({ downloads: { folder } });
  }
</script>

{#if s}
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.downloads.folder.label')}</div>
        <div class="path mono static" title={s.downloads.folder}>{s.downloads.folder}</div>
      </div>
      <div class="actions">
        <button type="button" class="push ghost" onclick={() => w.app.openPath('downloads')}>{t('common.actions.open')}</button>
        <button type="button" class="push" onclick={pickFolder}>{t('settings.downloads.folder.change')}</button>
      </div>
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.downloads.concurrent.label')}</div>
        <div class="desc">{t('settings.downloads.concurrent.desc')}</div>
      </div>
      <div class="stepper">
        <button type="button" aria-label={t('settings.downloads.concurrent.less')} disabled={s.downloads.maxConcurrent <= 1} onclick={() => set({ downloads: { maxConcurrent: s.downloads.maxConcurrent - 1 } })}>
          <Icon name="minimize" size={14} />
        </button>
        <span class="val tabular">{s.downloads.maxConcurrent}</span>
        <button type="button" aria-label={t('settings.downloads.concurrent.more')} disabled={s.downloads.maxConcurrent >= 6} onclick={() => set({ downloads: { maxConcurrent: s.downloads.maxConcurrent + 1 } })}>
          <Icon name="plus" size={14} />
        </button>
      </div>
    </div>
  </div>

  <h3 class="gh">{t('settings.downloads.storage')}</h3>
  <div class="group">
    <button type="button" class="row link-row" onclick={() => navigate('/downloads')}>
      <div class="txt">
        <div class="lbl">{t('settings.downloads.offline.label')}</div>
        <div class="desc">{t('settings.downloads.offline.desc', { count: offlineCount, size: bytes(offlineBytes) })}</div>
      </div>
      <span class="chev"><Icon name="chevronRight" size={16} /></span>
    </button>
  </div>
{/if}

<style>
  .gh {
    margin: 30px 0 8px 2px;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
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
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .link-row {
    width: 100%;
    text-align: left;
    color: var(--label);
  }
  .link-row:hover,
  .link-row:focus-visible {
    background: var(--fill-1);
  }
  .chev {
    flex: none;
    display: grid;
    color: var(--label-3);
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
  .path {
    display: block;
    max-width: 100%;
    margin-top: 3px;
    font-size: var(--fs-caption);
    color: var(--label-3);
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: text;
  }

  /* Stepper */
  .stepper {
    display: flex;
    align-items: center;
    flex: none;
    height: 28px;
    border-radius: var(--r-xs);
    box-shadow: inset 0 0 0 1px var(--separator);
  }
  .stepper .val {
    min-width: 28px;
    text-align: center;
    font-size: var(--fs-callout);
    font-weight: 500;
  }
  .stepper button {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    color: var(--label-2);
    border-radius: var(--r-xs);
  }
  .stepper button:hover:not(:disabled),
  .stepper button:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  .stepper button:disabled {
    color: var(--label-4);
  }

  /* About */
  .val {
    min-width: 0;
    max-width: 62%;
    font-size: var(--fs-footnote);
    color: var(--label);
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: text;
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
