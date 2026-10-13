<script lang="ts">
  // The Photos page (photos spec PH-02..PH-04): photo and home-video libraries open here instead of the poster
  // grid. Timeline, albums (folders) and favourites; the viewer and the slideshow are overlays, so the grid keeps
  // its scroll and focus underneath.
  import { tick } from 'svelte';
  import type { BaseItem } from '../../../shared/models';
  import Icon from '../../components/Icon.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { reducedMotion } from '../../lib/motion';
  import { mapEnabled, setFavorite, skeleton, type Skeleton } from '../../lib/photos/source.svelte';
  import { errorMessage, toast } from '../../lib/stores.svelte';
  import Albums from './Albums.svelte';
  import PhotoGrid from './PhotoGrid.svelte';
  import PhotoMap from './PhotoMap.svelte';
  import PhotoViewer from './PhotoViewer.svelte';
  import Slideshow from './Slideshow.svelte';

  let { lib, server }: { lib: BaseItem; server?: string } = $props();

  type Tab = 'timeline' | 'albums' | 'favorites' | 'map';
  let tab = $state<Tab>('timeline');
  let album = $state<BaseItem | null>(null);
  let view = $state.raw<Skeleton | null>(null);
  let viewing = $state<{ index: number; thumb?: string } | null>(null);
  let showing = $state<number | null>(null);
  let grid = $state<PhotoGrid>();

  // The Map tab exists only while the map is on (Settings > Privacy, spec PH-09).
  $effect(() => {
    if (tab === 'map' && !mapEnabled()) tab = 'timeline';
  });
  $effect(() => {
    view = tab === 'albums' ? (album ? skeleton(server, album.Id) : null) : skeleton(server, lib.Id, tab === 'favorites');
  });

  function pick(next: Tab): void {
    tab = next;
    album = null;
    document.getElementById('main-scroller')?.scrollTo({ top: 0, behavior: 'instant' });
  }

  // Shared-element morph from the tile into the viewer (view-transition-name photo-morph), a fade under reduced motion.
  function open(index: number, el: HTMLElement): void {
    const thumb = el.querySelector('img')?.currentSrc || undefined;
    const go = async () => {
      el.style.removeProperty('view-transition-name');
      el.style.removeProperty('view-transition-class');
      viewing = { index, thumb };
      await tick();
    };
    if (!document.startViewTransition || reducedMotion()) return void go();
    el.style.setProperty('view-transition-name', 'photo-morph');
    el.style.setProperty('view-transition-class', 'morph');
    const vt = document.startViewTransition(go);
    vt.ready.catch(() => undefined);
    vt.finished.catch(() => undefined);
  }

  async function favorite(index: number): Promise<void> {
    const a = view?.assets[index];
    if (!a) return;
    try {
      await setFavorite(a, !a.favorite);
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  function closeViewer(index: number): void {
    viewing = null;
    void grid?.focusIndex(index);
  }

  function closeShow(index: number): void {
    showing = null;
    void grid?.focusIndex(index);
  }
</script>

<div class="photos">
  <header class="head">
    <h1 class="large-title">{album?.Name ?? lib.Name}</h1>
    {#if view && view.total > 0}<span class="count">{t('photos.count', { count: view.total })}</span>{/if}
  </header>

  <div class="toolbar">
    {#if album}
      <button class="btn" onclick={() => (album = null)}><Icon name="chevronLeft" size={15} /> {t('photos.albums.back')}</button>
    {/if}
    <Segmented
      value={tab}
      label={t('photos.tabs.label')}
      options={[
        { value: 'timeline', label: t('photos.tabs.timeline') },
        { value: 'albums', label: t('photos.tabs.albums') },
        { value: 'favorites', label: t('photos.tabs.favorites') },
        ...(mapEnabled() ? [{ value: 'map' as Tab, label: t('photos.tabs.map') }] : []),
      ]}
      onchange={pick}
    />
    <div class="spacer"></div>
    {#if view && view.assets.length > 0 && tab !== 'map'}
      <button class="btn" onclick={() => (showing = 0)}><Icon name="presentation" size={15} /> {t('photos.slideshow.start')}</button>
      <div class="sizes" role="group" aria-label={t('photos.density.label')}>
        <button class="btn icon" aria-label={t('photos.density.smaller')} title={t('photos.density.smaller')} onclick={() => grid?.zoomBy(-1)}><Icon name="minimize" size={15} /></button>
        <button class="btn icon" aria-label={t('photos.density.larger')} title={t('photos.density.larger')} onclick={() => grid?.zoomBy(1)}><Icon name="plus" size={15} /></button>
      </div>
    {/if}
  </div>

  {#if tab === 'albums' && !album}
    <Albums {lib} {server} onopen={(a) => (album = a)} />
  {:else if tab === 'map' && view}
    <PhotoMap assets={view.assets} done={view.done} />
  {:else if view}
    {#if view.error}
      <div class="note"><Icon name="exclamation" size={16} /> {t('photos.error.load')} {view.error}</div>
    {:else if view.done && view.assets.length === 0}
      <div class="note">{t(tab === 'favorites' ? 'photos.emptyFavorites' : 'photos.empty')}</div>
    {:else}
      {#key view}
        <PhotoGrid
          bind:this={grid}
          assets={view.assets}
          total={view.total}
          years={view.years}
          version={view.version}
          onopen={open}
          onfavorite={favorite}
          onslideshow={(i) => (showing = i)}
        />
      {/key}
    {/if}
  {/if}
</div>

{#if viewing && view}
  <PhotoViewer
    assets={view.assets}
    start={viewing.index}
    thumb={viewing.thumb}
    onclose={closeViewer}
    onslideshow={(i) => ((viewing = null), (showing = i))}
  />
{/if}
{#if showing !== null && view}
  <Slideshow assets={view.assets} start={showing} onclose={closeShow} />
{/if}

<style>
  .photos {
    padding: 28px 0 72px;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 14px;
    flex-wrap: wrap;
    padding: 0 var(--gutter);
  }
  .head .large-title {
    margin: 0;
  }
  .count {
    font-size: var(--fs-callout);
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
  }
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 56px;
    padding: 0 var(--gutter);
    margin: 6px 0 4px;
    background: var(--material);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
  }
  .spacer {
    flex: 1;
  }
  .btn {
    gap: 6px;
    padding: 0 14px;
  }
  .btn.icon {
    width: 34px;
    padding: 0;
  }
  .sizes {
    display: flex;
    gap: 4px;
  }
  .note {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 48px var(--gutter);
    color: var(--label-3);
  }
</style>
