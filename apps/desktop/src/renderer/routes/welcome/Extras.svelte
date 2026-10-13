<script lang="ts">
  // Step 5: optional extras. Each row writes at once; qBittorrent and Trakt open their settings in a sheet.
  import type { Component } from 'svelte';
  import Icon from '../../components/Icon.svelte';
  import Sheet from '../../components/Sheet.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { linux } from '../../lib/platform';
  import { settings } from '../../lib/stores.svelte';
  import { set } from '../settings/shared.svelte';

  // Optional features, as in Settings: a row shows once its component exists.
  const optional = import.meta.glob<{ default: Component }>(['../../components/TorrentSettings.svelte', '../../components/TraktSettings.svelte'], { eager: true });
  const pick = (name: string): Component | undefined => optional[`../../components/${name}.svelte`]?.default;
  const TorrentSettings = pick('TorrentSettings');
  const TraktSettings = pick('TraktSettings');

  let sheet = $state<'torrents' | 'trakt' | null>(null);
  const startup = $derived(settings.value?.windows.launchAtStartup ?? false);
</script>

<h1>{t('welcome.extras.title')}</h1>

<div class="group">
  {#if !linux}
    <div class="row">
      <span class="lbl">{t('welcome.extras.startup')}</span>
      <Toggle label={t('welcome.extras.startup')} checked={startup} onchange={(v) => set({ windows: { launchAtStartup: v } })} />
    </div>
  {/if}
  {#if TorrentSettings}
    <button type="button" class="row" data-extra="torrents" onclick={() => (sheet = 'torrents')}>
      <span class="lbl">qBittorrent</span>
      <span class="val">{t('welcome.extras.torrents')}</span>
      <Icon name="chevronRight" size={15} />
    </button>
  {/if}
  {#if TraktSettings}
    <button type="button" class="row" data-extra="trakt" onclick={() => (sheet = 'trakt')}>
      <span class="lbl">Trakt</span>
      <span class="val">{t('welcome.extras.trakt')}</span>
      <Icon name="chevronRight" size={15} />
    </button>
  {/if}
</div>

{#if TorrentSettings}
  <Sheet open={sheet === 'torrents'} onclose={() => (sheet = null)} label="qBittorrent" width={640}>
    <div class="sheet-body"><TorrentSettings /></div>
  </Sheet>
{/if}
{#if TraktSettings}
  <Sheet open={sheet === 'trakt'} onclose={() => (sheet = null)} label="Trakt" width={600}>
    <div class="sheet-body"><TraktSettings /></div>
  </Sheet>
{/if}

<style>
  .group {
    border-radius: var(--r-md);
    background: var(--fill-1);
    box-shadow: inset 0 0 0 0.5px var(--separator);
    overflow: hidden;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 54px;
    padding: 10px 16px 10px 18px;
    text-align: left;
    color: var(--label);
  }
  .row + .row::before {
    content: '';
    position: absolute;
    top: 0;
    left: 18px;
    right: 0;
    height: 1px;
    background: var(--separator);
  }
  button.row:is(:hover, :focus-visible) {
    background: var(--fill-2);
  }
  .lbl {
    flex: 1;
    font-size: var(--fs-body);
    font-weight: 500;
  }
  .val {
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .row :global(.wi-icon) {
    color: var(--label-3);
  }
  .sheet-body {
    padding: 28px 28px 24px;
  }
</style>
