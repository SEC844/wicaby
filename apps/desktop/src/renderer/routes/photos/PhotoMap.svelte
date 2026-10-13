<script lang="ts">
  // The photo map (photos spec PH-09, opt-in, §6): Leaflet over the tiles main proxies (wicaby-media://tile, the one
  // host the user configured), markers grouped on a 60 px grid (lib/photos/cluster.ts). Clicking a group zooms in;
  // when it cannot split any further (zoom 17 and more, or one place), its photos open in the viewer.
  // Coordinates stay in memory: never logged, never stored.
  // shortcut: the deepest group opens the viewer over its photos, not a strip; add the strip if groups get large.
  import 'leaflet/dist/leaflet.css';
  import * as L from 'leaflet';
  import { onDestroy, onMount } from 'svelte';
  import { t } from '../../lib/i18n.svelte';
  import { photoUrl } from '../../lib/images';
  import { reducedMotion } from '../../lib/motion';
  import { cluster } from '../../lib/photos/cluster';
  import type { GridAsset } from '../../lib/photos/source.svelte';
  import { settings } from '../../lib/stores.svelte';
  import PhotoViewer from './PhotoViewer.svelte';

  let { assets, done }: { assets: GridAsset[]; done: boolean } = $props();

  const DEEPEST = 17;
  let el = $state<HTMLDivElement>();
  let map: L.Map | undefined;
  let layer: L.LayerGroup | undefined;
  let fitted = false;
  let picked = $state<GridAsset[] | null>(null);

  const geo = $derived(assets.filter((a) => a.lat != null && a.lon != null) as (GridAsset & { lat: number; lon: number })[]);
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  function draw(): void {
    if (!map || !layer) return;
    layer.clearLayers();
    const view = map.getBounds().pad(0.5);
    const z = map.getZoom();
    for (const c of cluster(geo, z)) {
      if (!view.contains([c.lat, c.lon])) continue;
      const cover = photoUrl(geo[c.newest], { maxWidth: 96, maxHeight: 96 });
      const icon = L.divIcon({
        className: 'pm-marker',
        html: `<img src="${esc(cover)}" alt="" decoding="async">${c.count > 1 ? `<span>${c.count}</span>` : ''}`,
        iconSize: [52, 52],
      });
      const m = L.marker([c.lat, c.lon], { icon, keyboard: true, title: t('photos.map.cluster', { count: c.count }) });
      m.on('click', () => {
        const members = c.indexes.map((i) => geo[i]);
        const onePlace = members.every((a) => a.lat === members[0].lat && a.lon === members[0].lon);
        if (c.count > 1 && z < DEEPEST && !onePlace) map!.fitBounds(L.latLngBounds(members.map((a) => [a.lat, a.lon])), { padding: [60, 60], maxZoom: Math.min(z + 4, 19) });
        else picked = members.sort((a, b) => (a.takenAt < b.takenAt ? 1 : -1));
      });
      layer.addLayer(m);
    }
  }

  function fit(): void {
    if (!map || fitted || geo.length === 0) return;
    map.fitBounds(L.latLngBounds(geo.map((a) => [a.lat, a.lon])), { padding: [40, 40], maxZoom: 12 });
    fitted = true;
  }

  onMount(() => {
    const cfg = settings.value?.photos.map;
    const still = reducedMotion();
    map = L.map(el!, { minZoom: 1, maxZoom: 19, worldCopyJump: false, attributionControl: false, zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still });
    L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(map);
    layer = L.layerGroup().addTo(map);
    map.on('moveend', draw);
    // The view first, then the tiles: no tile is asked for a view the user never sees.
    fit();
    if (!fitted) map.setView([30, 0], 2);
    // Only what the map shows is asked for (no prefetch): Leaflet's default keepBuffer around the view.
    L.tileLayer('wicaby-media://tile/{z}/{x}/{y}', { maxZoom: 19, attribution: esc(cfg?.attribution ?? '© OpenStreetMap contributors') }).addTo(map);
    draw();
  });
  onDestroy(() => map?.remove());

  // Pages still arriving: redraw, and frame the photos once the first positions are in.
  $effect(() => {
    void geo;
    fit();
    draw();
  });
</script>

<div class="wrap">
  <div class="map" bind:this={el} role="application" aria-label={t('photos.map.title')}></div>
  {#if geo.length === 0}
    <div class="note material">{done ? t('photos.map.noLocation') : t('photos.map.loading')}</div>
  {/if}
</div>

{#if picked}
  <PhotoViewer assets={picked} start={0} onclose={() => (picked = null)} />
{/if}

<style>
  .wrap {
    position: relative;
    margin: 0 var(--gutter);
  }
  .map {
    height: calc(100vh - 230px);
    min-height: 360px;
    border-radius: var(--r-lg);
    overflow: hidden;
    background: var(--bg-elevated);
  }
  /* Artwork is the colour: the base map is dimmed (GPU filter). */
  .map :global(.leaflet-tile-pane) {
    filter: brightness(0.62) saturate(0.55) contrast(1.05);
  }
  .map:global(.leaflet-container) {
    font: inherit;
    background: var(--bg-elevated);
  }
  .map :global(.leaflet-control-attribution) {
    padding: 2px 8px;
    border-radius: var(--r-xs) 0 0 0;
    background: rgb(0 0 0 / 0.55);
    color: rgb(255 255 255 / 0.85);
    font-size: var(--fs-caption);
  }
  .map :global(.leaflet-control-zoom a) {
    background: var(--bg-elevated-2);
    color: var(--label);
    border-color: var(--separator);
  }
  .map :global(.pm-marker) {
    border-radius: var(--r-sm);
    box-shadow: 0 0 0 2px #fff, var(--shadow-3);
    background: var(--bg-elevated);
  }
  .map :global(.pm-marker:focus-visible) {
    outline: none;
    box-shadow: 0 0 0 2px #fff, 0 0 0 5px var(--accent);
  }
  .map :global(.pm-marker img) {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
  }
  .map :global(.pm-marker span) {
    position: absolute;
    right: -8px;
    top: -8px;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    border-radius: 11px;
    background: var(--bg-elevated);
    color: #fff;
    font-size: var(--fs-caption);
    font-weight: 650;
    line-height: 22px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .note {
    position: absolute;
    left: 50%;
    top: 20px;
    translate: -50% 0;
    padding: 8px 14px;
    border-radius: 999px;
    color: var(--label-2);
    z-index: 500;
  }
</style>
