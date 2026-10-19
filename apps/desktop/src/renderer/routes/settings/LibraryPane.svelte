<script lang="ts">
  import { LIBRARY_SORTS } from '../../../shared/contract';
  import Icon from '../../components/Icon.svelte';
  import Picker from '../../components/Picker.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { libraryRef } from '../../lib/api';
  import { t } from '../../lib/i18n.svelte';
  import { navigate } from '../../lib/router.svelte';
  import { libraries, multiServer, serverName, settings } from '../../lib/stores.svelte';
  import { set } from './shared.svelte';

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
  <h3 class="gh">{t('settings.library.home')}</h3>
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
        <div class="lbl">{t('settings.appearance.hero.label')}</div>
        <div class="desc">{t('settings.appearance.hero.desc')}</div>
      </div>
      <Toggle label={t('settings.appearance.hero.label')} checked={s.ui.heroEnabled} onchange={(v) => set({ ui: { heroEnabled: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.appearance.heroAutoplay.label')}</div>
        <div class="desc">{t('settings.appearance.heroAutoplay.desc')}</div>
      </div>
      <Toggle label={t('settings.appearance.heroAutoplay.label')} checked={s.ui.heroAutoplay} disabled={!s.ui.heroEnabled} onchange={(v) => set({ ui: { heroAutoplay: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('files.home.label')}</div>
        <div class="desc">{t('files.home.desc')}</div>
      </div>
      <Toggle label={t('files.home.label')} checked={s.ui.filesOnHome === true} onchange={(v) => set({ ui: { filesOnHome: v } })} />
    </div>
    <button type="button" class="row link-row" onclick={() => navigate('/home?customize=1')}>
      <div class="txt">
        <div class="lbl">{t('settings.library.customizeHome.label')}</div>
        <div class="desc">{t('settings.library.customizeHome.desc')}</div>
      </div>
      <span class="chev"><Icon name="chevronRight" size={16} /></span>
    </button>
  </div>

  <h3 class="gh">{t('settings.library.libraries')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.library.sort.label')}</div>
        <div class="desc">{t('settings.library.sort.desc')}</div>
      </div>
      <Picker
        label={t('settings.library.sort.label')}
        value={s.ui.librarySort}
        options={LIBRARY_SORTS.map((k) => ({ value: k, label: t(`settings.library.sorts.${k}`) }))} onchange={(v) => set({ ui: { librarySort: v } })} />
    </div>
    <div class="row">
      <div class="txt"><div class="lbl">{t('settings.library.order.label')}</div></div>
      <Segmented
        label={t('settings.library.order.label')}
        value={s.ui.librarySortDesc ? 'desc' : 'asc'}
        options={[
          { value: 'asc', label: t('settings.library.order.asc') },
          { value: 'desc', label: t('settings.library.order.desc') },
        ]}
        onchange={(v) => set({ ui: { librarySortDesc: v === 'desc' } })}
      />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.library.view.label')}</div>
        <div class="desc">{t('settings.library.view.desc')}</div>
      </div>
      <Segmented
        label={t('settings.library.view.label')}
        value={s.ui.libraryView}
        options={[
          { value: 'poster', label: t('settings.library.view.poster') },
          { value: 'thumb', label: t('settings.library.view.thumb') },
        ]}
        onchange={(v) => set({ ui: { libraryView: v } })}
      />
    </div>
  </div>
  <p class="foot">{t('settings.library.foot')}</p>
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

  /* Compact density tightens these rows as well. */
  :global(html[data-density='compact']) .row {
    min-height: 50px;
    padding-block: 9px;
  }
</style>
