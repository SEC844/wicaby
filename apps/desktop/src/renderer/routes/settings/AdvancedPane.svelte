<script lang="ts">
  import Toggle from '../../components/Toggle.svelte';
  import { w } from '../../lib/bridge';
  import { t } from '../../lib/i18n.svelte';
  import { errorMessage, settings, toast } from '../../lib/stores.svelte';
  import { set } from './shared.svelte';

  // The end of Settings › System (after PrivacyPane): performance and the settings backup.
  // Hardware acceleration as this run started with it (Settings.svelte): it only changes at the next launch.
  let { hwStart }: { hwStart: boolean | null } = $props();

  const s = $derived(settings.value);

  // ---- Export, import, reset ----
  let confirmReset = $state(false);
  async function exportSettings(): Promise<void> {
    try {
      if (await w.settings.exportFile()) toast('success', t('settings.advanced.exportImport.exported'));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }
  async function importSettings(): Promise<void> {
    try {
      if (await w.settings.importFile()) toast('success', t('settings.advanced.exportImport.imported'));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }
  async function resetSettings(): Promise<void> {
    if (!confirmReset) {
      confirmReset = true;
      setTimeout(() => (confirmReset = false), 4000);
      return;
    }
    confirmReset = false;
    try {
      await w.settings.reset();
      toast('success', t('settings.advanced.reset.done'));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }
</script>

{#if s}
  <h3 class="gh">{t('settings.advanced.performance')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">
          {t('settings.advanced.hwAccel.label')}
          {#if hwStart !== null && hwStart !== s.system.hardwareAcceleration}<span class="tag">{t('settings.page.nextLaunch')}</span>{/if}
        </div>
        <div class="desc">{t('settings.advanced.hwAccel.desc')}</div>
      </div>
      <Toggle
        label={t('settings.advanced.hwAccel.label')}
        checked={s.system.hardwareAcceleration}
        onchange={(v) => set({ system: { hardwareAcceleration: v } })}
      />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.advanced.fps.label')}</div>
        <div class="desc">{t('settings.advanced.fps.desc')}</div>
      </div>
      <Toggle label={t('settings.advanced.fps.label')} checked={s.ui.fpsMeter} onchange={(v) => set({ ui: { fpsMeter: v } })} />
    </div>
  </div>

  <h3 class="gh">{t('settings.advanced.backup')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.advanced.exportImport.label')}</div>
        <div class="desc">{t('settings.advanced.exportImport.desc')}</div>
      </div>
      <div class="actions">
        <button type="button" class="push" onclick={importSettings}>{t('settings.advanced.exportImport.import')}</button>
        <button type="button" class="push" onclick={exportSettings}>{t('settings.advanced.exportImport.export')}</button>
      </div>
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.advanced.reset.label')}</div>
        <div class="desc">{t('settings.advanced.reset.desc')}</div>
      </div>
      <button type="button" class="push" class:danger={confirmReset} onclick={resetSettings}>{confirmReset ? t('common.actions.confirm') : t('settings.advanced.reset.button')}</button>
    </div>
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
  /* Hairlines only between rows that are still shown. */
  :global(.searching) .row::before {
    display: none;
  }
  :global(.searching) .row:not([hidden]) ~ .row:not([hidden])::before {
    display: block;
  }

  /* ---- New controls ---- */
  .tag {
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--fill-2);
    font-size: var(--fs-caption);
    font-weight: 500;
    color: var(--label-2);
  }
  .push:disabled {
    color: var(--label-4);
    pointer-events: none;
  }
  .push.danger {
    color: var(--red);
  }

  /* Compact density tightens these rows as well. */
  :global(html[data-density='compact']) .row {
    min-height: 50px;
    padding-block: 9px;
  }
</style>
