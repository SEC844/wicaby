<script lang="ts">
  import { UI_LANGUAGES } from '../../../shared/i18n-core';
  import Icon from '../../components/Icon.svelte';
  import Picker from '../../components/Picker.svelte';
  import ShortcutEditor from '../../components/ShortcutEditor.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { libraryRef } from '../../lib/api';
  import { t } from '../../lib/i18n.svelte';
  import { linux, web } from '../../lib/platform';
  import { navigate } from '../../lib/router.svelte';
  import { libraries, multiServer, serverName, session, settings } from '../../lib/stores.svelte';
  import { set } from './shared.svelte';

  let { open }: { open: (pane: 'server') => void } = $props();

  const s = $derived(settings.value);

  const browsable = $derived(libraries.list.filter((l) => !['playlists', 'livetv', 'folders'].includes(l.CollectionType ?? '')));
  const startPages = $derived([
    { value: 'home', label: t('settings.general.startPage.home') },
    { value: 'favorites', label: t('settings.general.startPage.favorites') },
    ...browsable.map((l) => ({ value: `library:${libraryRef(l)}`, label: multiServer() ? `${l.Name} · ${serverName(l.ServerId)}` : l.Name })),
    // A library this account no longer sees keeps a readable entry until it is changed.
    ...(s && s.ui.startPage.startsWith('library:') && !browsable.some((l) => `library:${libraryRef(l)}` === s.ui.startPage)
      ? [{ value: s.ui.startPage, label: t('settings.general.startPage.missing') }]
      : []),
  ]);
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

  <h3 class="gh">{t('settings.general.startup')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.general.startPage.label')}</div>
        <div class="desc">{t('settings.general.startPage.desc')}</div>
      </div>
      <Picker label={t('settings.general.startPage.label')} value={s.ui.startPage} options={startPages} onchange={(v) => set({ ui: { startPage: v } })} />
    </div>
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
    <!-- The web TV app (lib/platform.ts): no setup wizard, no updater, no desktop player windows or shortcuts. -->
    {#if !web}
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.general.setup.label')}</div>
        <div class="desc">{t('settings.general.setup.desc')}</div>
      </div>
      <button type="button" class="push" data-action="rerun-setup" onclick={() => navigate('/welcome?rerun=1')}>{t('settings.general.setup.button')}</button>
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.about.updates.auto')}</div>
        <div class="desc">{t('settings.about.updates.autoDesc')}</div>
      </div>
      <Toggle label={t('settings.about.updates.auto')} checked={s.updates.autoCheck} onchange={(v) => set({ updates: { autoCheck: v } })} />
    </div>
    {/if}
  </div>

  {#if !web}

  <h3 class="gh">{t('settings.general.player')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.general.startFullscreen.label')}</div>
        <div class="desc">{t('settings.general.startFullscreen.desc')}</div>
      </div>
      <Toggle label={t('settings.general.startFullscreen.label')} checked={s.playback.startFullscreen} onchange={(v) => set({ playback: { startFullscreen: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.general.confirmQuit.label')}</div>
        <div class="desc">{t('settings.general.confirmQuit.desc')}</div>
      </div>
      <Toggle
        label={t('settings.general.confirmQuit.label')}
        checked={s.ui.confirmQuitDuringPlayback}
        onchange={(v) => set({ ui: { confirmQuitDuringPlayback: v } })}
      />
    </div>
  </div>

  <h3 class="gh">{t('settings.general.shortcuts.title')}</h3>
  <!-- X-04: the editor (VOD actions) and the read-only "TV en direct" list (shared/shortcuts.ts). -->
  <ShortcutEditor />
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
  /* Hairlines only between rows that are still shown. */
  :global(.searching) .row::before {
    display: none;
  }
  :global(.searching) .row:not([hidden]) ~ .row:not([hidden])::before {
    display: block;
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
