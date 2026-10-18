<script lang="ts">
  // The Photos page (photos spec PH-02..PH-04): photo and home-video libraries open here instead of the poster
  // grid. Timeline, albums (folders) and favourites; the viewer and the slideshow are overlays, so the grid keeps
  // its scroll and focus underneath. An Immich source (immich: its id, spec PH-12) is its own library here: its
  // albums, its people, its memories above the timeline, and map markers from /api/map/markers. A photo source on
  // files (Settings > Photo sources) is a library of its own too, its memories above the timeline as well.
  import { tick } from 'svelte';
  import type { BaseItem } from '../../../shared/models';
  import Icon from '../../components/Icon.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { reducedMotion } from '../../lib/motion';
  import { immichError, immichMarkers, immichMemories, immichSkeleton, type ImmichPerson } from '../../lib/photos/immich.svelte';
  import { localDay } from '../../lib/photos/memories';
  import { mapEnabled, memoriesOf, setFavorite, skeleton, type GridAsset, type MemoryGroup, type Skeleton } from '../../lib/photos/source.svelte';
  import { errorMessage, isFileSource, toast } from '../../lib/stores.svelte';
  import Albums from './Albums.svelte';
  import MemoryCards from './MemoryCards.svelte';
  import People from './People.svelte';
  import PhotoGrid from './PhotoGrid.svelte';
  import PhotoViewer from './PhotoViewer.svelte';
  import Slideshow from './Slideshow.svelte';

  let { lib, server, immich }: { lib: BaseItem; server?: string; immich?: string } = $props();

  type Tab = 'timeline' | 'albums' | 'favorites' | 'people' | 'map';
  let tab = $state<Tab>('timeline');
  let album = $state<BaseItem | null>(null);
  let person = $state<ImmichPerson | null>(null);
  let memories = $state.raw<MemoryGroup[]>([]);
  // Immich's map: the timeline's assets placed by the markers (asset id -> position), or the caption of a failure.
  let markers = $state.raw<Map<string, { lat: number; lon: number }> | null>(null);
  let markerError = $state('');
  let view = $state.raw<Skeleton | null>(null);
  let viewing = $state<{ index: number; thumb?: string } | null>(null);
  let showing = $state<number | null>(null);
  let grid = $state<PhotoGrid>();

  // The Map tab exists only while the map is on (Settings > Privacy, spec PH-09).
  $effect(() => {
    if (tab === 'map' && !mapEnabled()) tab = 'timeline';
  });
  $effect(() => {
    if (immich)
      view =
        tab === 'albums' ? (album ? immichSkeleton(immich, { albumId: album.Id }) : null) : tab === 'people' ? (person ? immichSkeleton(immich, { personId: person.id }) : null) : immichSkeleton(immich, { favorites: tab === 'favorites' });
    else view = tab === 'albums' ? (album ? skeleton(server, album.Id) : null) : skeleton(server, lib.Id, tab === 'favorites');
  });
  const fileSource = $derived(isFileSource(server));
  $effect(() => {
    if (!immich && !fileSource) return;
    (immich ? immichMemories(immich, localDay()) : memoriesOf(server!, localDay()))
      .then((g) => (memories = g))
      .catch(() => (memories = []));
  });
  $effect(() => {
    if (!immich || tab !== 'map' || markers) return;
    immichMarkers(immich)
      .then((m) => (markers = m))
      .catch((err) => (markerError = immichError(err, 'map.read')));
  });
  const mapAssets = $derived.by((): GridAsset[] => {
    if (!view) return [];
    if (!immich) return view.assets;
    const pos = markers;
    return pos ? view.assets.flatMap((a) => (pos.has(a.id) ? [{ ...a, ...pos.get(a.id)! }] : [])) : [];
  });

  function pick(next: Tab): void {
    tab = next;
    album = null;
    person = null;
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
    <h1 class="large-title">{album?.Name ?? person?.name ?? lib.Name}</h1>
    {#if view && view.total > 0}<span class="count">{t('photos.count', { count: view.total })}</span>{/if}
  </header>

  <div class="toolbar">
    {#if album}
      <button class="btn" onclick={() => (album = null)}><Icon name="chevronLeft" size={15} /> {t('photos.albums.back')}</button>
    {:else if person}
      <button class="btn" onclick={() => (person = null)}><Icon name="chevronLeft" size={15} /> {t('photos.people.back')}</button>
    {/if}
    <Segmented
      value={tab}
      label={t('photos.tabs.label')}
      options={[
        { value: 'timeline', label: t('photos.tabs.timeline') },
        { value: 'albums', label: t('photos.tabs.albums') },
        { value: 'favorites', label: t('photos.tabs.favorites') },
        ...(immich ? [{ value: 'people' as Tab, label: t('photos.tabs.people') }] : []),
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
    <Albums {lib} {server} {immich} onopen={(a) => (album = a)} />
  {:else if tab === 'people' && immich && !person}
    <People source={immich} onopen={(p) => (person = p)} />
  {:else if tab === 'map' && immich && markerError}
    <div class="note"><Icon name="exclamation" size={16} /> {markerError}</div>
  {:else if tab === 'map' && view}
    <!-- Leaflet loads with the map tab, not at app start. -->
    {#await import('./PhotoMap.svelte') then { default: PhotoMap }}
      <PhotoMap assets={mapAssets} done={view.done && (!immich || markers !== null)} />
    {/await}
  {:else if view}
    {#if (immich || fileSource) && tab === 'timeline' && memories.length > 0}<MemoryCards groups={memories} />{/if}
    {#if view.error}
      <div class="note"><Icon name="exclamation" size={16} /> {immich ? view.error : `${t('photos.error.load')} ${view.error}`}</div>
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
