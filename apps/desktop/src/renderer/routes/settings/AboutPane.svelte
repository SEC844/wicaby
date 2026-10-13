<script lang="ts">
  import type { Component } from 'svelte';
  import { w } from '../../lib/bridge';
  import { t } from '../../lib/i18n.svelte';
  import { settings } from '../../lib/stores.svelte';
  import { copy, type SettingsData } from './shared.svelte';

  // Logo: optional, from the Settings shell's glob.
  let { data, Logo }: { data: SettingsData; Logo?: Component } = $props();

  const s = $derived(settings.value);
  const info = $derived(data.info);
</script>

{#if s}
  {#if Logo}
    <div class="brand"><Logo size={56} /></div>
  {/if}
  <div class="group">
    <div class="row compact">
      <div class="lbl soft">Wicaby</div>
      <span class="val tabular">{info ? (info.isPackaged ? info.version : t('settings.about.devBuild', { version: info.version })) : '…'}</span>
    </div>
    {#if info}
      {#each [['Electron', info.electron], ['Chromium', info.chromium], ['Node.js', info.node], [t('settings.about.system'), `${info.platform} ${info.osRelease}`], [t('settings.about.device'), info.deviceName]] as [k, v] (k)}
        <div class="row compact">
          <div class="lbl soft">{k}</div>
          <span class="val tabular">{v}</span>
        </div>
      {/each}
    {/if}
  </div>
  {#if info}
    <h3 class="gh">{t('settings.about.ids')}</h3>
    <div class="group">
      <div class="row compact">
        <div class="lbl soft">{t('settings.about.deviceId')}</div>
        <button type="button" class="val mono copy" title={t('common.actions.copy')} onclick={() => copy(info!.deviceId)}>{info.deviceId}</button>
      </div>
      <div class="row compact">
        <div class="lbl soft">{t('settings.about.data')}</div>
        <span class="val mono" title={info.userDataPath}>{info.userDataPath}</span>
      </div>
    </div>
  {/if}
  <h3 class="gh">{t('settings.about.support')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.about.logs.label')}</div>
        <div class="desc">{t('settings.about.logs.desc')}</div>
      </div>
      <button type="button" class="push" onclick={() => w.app.openPath('logs')}>{t('common.actions.open')}</button>
    </div>
  </div>
  <p class="desc legal">{t('settings.about.trademarks')}</p>
  <!-- plex-spec §1.2 / D-8: the unofficial-client line, whether or not a Plex server is added. -->
  <p class="desc legal">{t('plex.about.notAffiliated')}</p>
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
  .row.compact {
    min-height: 42px;
    padding-block: 9px;
    justify-content: space-between;
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
  .lbl.soft {
    font-weight: 400;
    color: var(--label-2);
  }
  .desc {
    display: block;
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.45;
  }
  .legal {
    margin: 14px 2px 0;
  }
  .legal + .legal {
    margin-top: 6px;
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
    transition: background-color var(--t-fast) var(--ease);
  }
  .push:hover,
  .push:focus-visible {
    background: var(--fill-3);
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
  .val.mono {
    font-size: var(--fs-caption);
    color: var(--label-2);
  }
  .copy:hover {
    color: var(--label);
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
  .brand {
    display: flex;
    justify-content: center;
    padding: 6px 0 22px;
  }

  /* Compact density tightens these rows as well. */
  :global(html[data-density='compact']) .row {
    min-height: 50px;
    padding-block: 9px;
  }
  :global(html[data-density='compact']) .row.compact {
    min-height: 38px;
    padding-block: 7px;
  }
</style>
