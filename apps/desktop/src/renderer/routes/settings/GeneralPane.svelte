<script lang="ts">
  import type { Component } from 'svelte';
  import { UI_LANGUAGES } from '../../../shared/i18n-core';
  import Icon from '../../components/Icon.svelte';
  import Picker from '../../components/Picker.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { linux, web } from '../../lib/platform';
  import { navigate } from '../../lib/router.svelte';
  import { session, settings } from '../../lib/stores.svelte';
  import { set } from './shared.svelte';

  // WindowsSettings: optional, from the Settings shell's glob; hasTorrents adds the torrent notification to its group.
  let { open, WindowsSettings, hasTorrents }: { open: (pane: 'server') => void; WindowsSettings?: Component<{ torrents?: boolean }>; hasTorrents: boolean } = $props();

  const s = $derived(settings.value);
</script>

{#if s}
  {#if session.value.user}
    {@const u = session.value.user}
    <div class="group">
      <button type="button" class="row link-row" onclick={() => open('server')}>
        <span class="avatar">{u.name.slice(0, 1).toUpperCase()}</span>
        <span class="txt">
          <span class="lbl">{u.name}</span>
          <span class="desc">{u.isAdmin ? t('settings.general.account.admin') : t('settings.general.account.user')}{session.value.server ? ` · ${session.value.server.name}` : ''}</span>
        </span>
        <span class="chev"><Icon name="chevronRight" size={16} /></span>
      </button>
    </div>
  {/if}

  <h3 class="gh">{t('settings.general.language.title')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.general.language.label')}</div>
        <div class="desc">{t(linux ? 'settings.general.language.descLinux' : 'settings.general.language.desc')}</div>
      </div>
      <Picker
        label={t('settings.general.language.label')}
        value={s.ui.language}
        options={UI_LANGUAGES.map((l) => ({ value: l, label: t(`settings.general.language.${l}`) }))}
        onchange={(v) => set({ ui: { language: v } })}
      />
    </div>
  </div>

  <!-- The web TV app (lib/platform.ts): no desktop window, notifications or setup wizard. -->
  {#if !web}
    {#if WindowsSettings}<WindowsSettings torrents={hasTorrents} />{/if}

    <h3 class="gh">{t('settings.general.setup.title')}</h3>
    <div class="group">
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.general.setup.label')}</div>
          <div class="desc">{t('settings.general.setup.desc')}</div>
        </div>
        <button type="button" class="push" data-action="rerun-setup" onclick={() => navigate('/welcome?rerun=1')}>{t('settings.general.setup.button')}</button>
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

  /* Neutral monogram, no gradient. */
  .avatar {
    flex: none;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: var(--fs-body);
    font-weight: 600;
    color: var(--label);
    background: var(--fill-3);
  }
  /* Compact density tightens these rows as well. */
  :global(html[data-density='compact']) .row {
    min-height: 50px;
    padding-block: 9px;
  }
  /* Push button: small, neutral (as in ServerPane). */
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
</style>
