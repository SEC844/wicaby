<script lang="ts">
  // Android TV PhotoViewer (ui/photos/PhotoViewer.kt, spec §4.4): a loaded timeline full screen. Left / Right:
  // previous / next; Up: the info panel (the date and the EXIF lines the server has), Down closes it; OK: the
  // controls (Diaporama, Favori, Infos, Zoom, the interval, Ken Burns); Play/Pause: the slideshow, a fade every few
  // seconds round the stills, Ken Burns as an option. Zoom ×2 pans with the D-pad. Back closes what is open, then
  // the viewer. A clip opens the player. Two image layers cross-fade; the next photo is fetched ahead.
  import { getContext, onMount } from 'svelte';
  import { exifOf, formatExif } from '$desktop/photos/exif';
  import { rotation } from '$desktop/photos/asset';
  import Icon from '../components/Icon.svelte';
  import Pill from '../components/Pill.svelte';
  import { focusable, focusFirst, focused, setFocus } from '../lib/focus';
  import { locale, t } from '../lib/i18n.svelte';
  import { nav, onBack, SCREEN } from '../lib/nav.svelte';
  import { overlay } from '../lib/overlay.svelte';
  import { photoDate, photoUrl, timelineByKey, VIEWER_PX, type Photo } from '../lib/photos.svelte';
  import { play } from '../lib/playback';
  import { api } from '../lib/session.svelte';
  import { load, save } from '../lib/storage';
  import { keyOf } from '../platform/keys';

  let { key, index: start }: { key: string; index: number } = $props();
  const client = api()!;
  // svelte-ignore state_referenced_locally
  const tl = timelineByKey(key);
  const photos = $derived(tl?.photos ?? []);

  const INTERVALS = [3, 5, 10, 20];
  // svelte-ignore state_referenced_locally
  let index = $state(Math.max(0, Math.min(start, (tl?.photos.length ?? 1) - 1)));
  let chrome = $state(false);
  let info = $state(false);
  let slideshow = $state(false);
  let zoomed = $state(false);
  let pan = $state({ x: 0, y: 0 });
  let seconds = $state(load<number>('photos.interval', 5));
  let kenBurns = $state(load<boolean>('photos.kenBurns', true));
  $effect(() => save('photos.interval', seconds));
  $effect(() => save('photos.kenBurns', kenBurns));

  const p = $derived<Photo | undefined>(photos[index]);

  // --- Two layers: the shown one fades in over the other ---
  let layers = $state<{ id: string; src?: string; turn: number; p: Photo }[]>([]);
  let front = $state(0);
  $effect(() => {
    const q = p;
    if (!q) return;
    zoomed = false;
    pan = { x: 0, y: 0 };
    const src = photoUrl(client, q.asset, VIEWER_PX);
    if (layers[front]?.id === q.asset.id) return;
    const next = layers.length < 2 ? layers.length : 1 - front;
    const l = layers.slice();
    l[next] = { id: q.asset.id, src, turn: 0, p: q };
    layers = l;
    front = next;
    // The next still, ahead.
    const after = photos[index + 1];
    if (after?.asset.kind === 'photo') {
      const pre = new Image();
      pre.src = photoUrl(client, after.asset, VIEWER_PX) ?? '';
    }
  });
  function decoded(k: number, e: Event): void {
    if (client.isEmby) return;
    const img = e.currentTarget as HTMLImageElement;
    const q = layers[k]?.p;
    if (!q) return;
    const r = rotation(q.item.ImageOrientation, q.item.Width ?? 0, q.item.Height ?? 0, img.naturalWidth, img.naturalHeight);
    if (r) layers = layers.map((l, j) => (j === k ? { ...l, turn: r } : l));
  }

  // --- Slideshow: the next still every few seconds, round the list ---
  let slideTimer = 0;
  $effect(() => {
    void index;
    clearTimeout(slideTimer);
    if (!slideshow || !photos.length) return;
    slideTimer = window.setTimeout(() => {
      for (let k = 1; k <= photos.length; k++) {
        const n = (index + k) % photos.length;
        if (photos[n].asset.kind === 'photo') return void (index = n);
      }
    }, seconds * 1000);
    return () => clearTimeout(slideTimer);
  });

  // --- Info: the full item (EXIF), held in memory only ---
  let detail = $state<Record<string, unknown> | null>(null);
  $effect(() => {
    const id = p?.asset.id;
    detail = null;
    if (!info || !id) return;
    void client.item(id).then((d) => {
      if (p?.asset.id === id) detail = d as never;
    }, () => {});
  });
  const exifLines = $derived.by(() => {
    if (!p) return [];
    const tpl = {
      aperture: t('photos_exif_aperture_value'),
      exposure: t('photos_exif_exposure_value'),
      focal: t('photos_exif_focal_value'),
      iso: t('photos_exif_iso_value'),
      dimensions: t('photos_exif_dimensions_value'),
      altitude: t('photos_exif_altitude_value'),
      location: t('photos_exif_location_value'),
    };
    const lang = locale.current.startsWith('fr') ? 'fr' : 'en';
    const LABEL: Record<string, string> = {
      camera: t('photos_exif_camera'),
      exposure: t('photos_exif_exposure'),
      aperture: t('photos_exif_aperture'),
      focal: t('photos_exif_focal'),
      iso: t('photos_exif_iso'),
      dimensions: t('photos_exif_dimensions'),
      altitude: t('photos_exif_altitude'),
      location: t('photos_exif_location'),
      software: t('photos_exif_software'),
    };
    return [
      [t('photos_exif_taken'), photoDate(p.asset.takenAt, locale.current)],
      ...formatExif(exifOf((detail ?? p.item) as never), lang, tpl, 'hidden').map(([k, v]) => [LABEL[k] ?? k, v]),
    ];
  });

  async function toggleFavorite(): Promise<void> {
    if (!p) return;
    const on = !p.asset.favorite;
    await client.setFavorite(p.asset.id, on).then(() => tl?.setFavorite(p!.asset.id, on), () => {});
  }

  // --- The remote ---
  let viewW = $state(960);
  let viewH = $state(540);
  function move(d: 'left' | 'right' | 'up' | 'down'): void {
    if (zoomed) {
      // A sixth of the screen a press, half of it at most each way: at ×2 that reaches the edges.
      const sx = viewW / 6;
      const sy = viewH / 6;
      const x = pan.x + (d === 'left' ? sx : d === 'right' ? -sx : 0);
      const y = pan.y + (d === 'up' ? sy : d === 'down' ? -sy : 0);
      pan = { x: Math.max(-viewW / 2, Math.min(viewW / 2, x)), y: Math.max(-viewH / 2, Math.min(viewH / 2, y)) };
      return;
    }
    if (d === 'left' && index > 0) index--;
    else if (d === 'right' && index < photos.length - 1) index++;
    else if (d === 'up') info = true;
    else if (d === 'down') info = false;
  }
  function onKey(e: KeyboardEvent): void {
    if (overlay.alert || !document.querySelector('[data-screen-top] .viewer')) return;
    const key = keyOf(e);
    if (!key || key === 'back') return;
    if (key === 'playPause' || key === 'play' || key === 'pause') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) slideshow = key === 'pause' ? false : !slideshow;
      return;
    }
    if (chrome) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (key === 'up' || key === 'down' || key === 'left' || key === 'right') return move(key);
    if (key === 'ok' && !e.repeat && p) {
      if (p.asset.kind === 'video') return play(p.item);
      info = false;
      chrome = true;
      requestAnimationFrame(() => {
        const bar = document.querySelector('[data-screen-top] .viewer .chrome');
        if (bar) focusFirst(bar);
      });
    }
  }

  let sink: HTMLButtonElement;
  function closeChrome(): void {
    chrome = false;
    setFocus(sink);
  }
  const screen = getContext<number>(SCREEN);
  onMount(() => {
    const measure = () => {
      viewW = window.innerWidth;
      viewH = window.innerHeight;
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('keydown', onKey, true);
    setFocus(sink);
    const stop = onBack(screen, () => {
      if (chrome) return closeChrome(), true;
      if (info) return (info = false), true;
      if (zoomed) return (zoomed = false), (pan = { x: 0, y: 0 }), true;
      if (slideshow) return (slideshow = false), true;
      return false;
    });
    // Leaving with the focus elsewhere (a pill): the grid gets it back.
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('keydown', onKey, true);
      clearTimeout(slideTimer);
      stop();
    };
  });
  // Any key while the chrome shows and the focus left it closes it (Up from the pills).
  $effect(() => {
    if (!chrome) return;
    const check = () => {
      if (!focused()?.closest('.chrome')) chrome = false;
    };
    document.addEventListener('tvfocus', check);
    return () => document.removeEventListener('tvfocus', check);
  });
</script>

<div class="viewer">
  <button class="sink" bind:this={sink} use:focusable aria-label={p ? photoDate(p.asset.takenAt, locale.current) : ''}></button>
  {#if !photos.length}
    <p class="center t-title3 label-2">{t('photos_empty')}</p>
  {/if}
  {#each layers as l, k (k)}
    {@const shown = k === front}
    {@const scale = (shown && slideshow && kenBurns ? 1.08 : 1) * (shown && zoomed ? 2 : 1)}
    <div
      class="layer"
      class:shown
      class:slow={slideshow}
      style="--kb:{slideshow && kenBurns ? seconds * 1000 + 1600 : 300}ms;transform:translate3d({shown ? pan.x : 0}px,{shown ? pan.y : 0}px,0) scale({scale})"
    >
      {#if l.src}
        <img src={l.src} alt="" onload={(e) => decoded(k, e)} style={l.turn ? `transform:rotate(${l.turn}deg)${l.turn % 180 ? ';max-width:100vh;max-height:100vw' : ''}` : ''} />
      {/if}
      {#if l.p.asset.kind === 'video'}
        <span class="play"><Icon name="Play" size={32} /></span>
      {/if}
    </div>
  {/each}

  {#if (chrome || slideshow) && p}
    <p class="date t-title3">{photoDate(p.asset.takenAt, locale.current)}</p>
  {/if}

  {#if chrome && p}
    <div class="chrome" data-focus-group>
      <Pill text={t('photos_slideshow')} icon={slideshow ? 'Pause' : 'Play'} onclick={() => ((slideshow = !slideshow), closeChrome())} />
      <Pill text={p.asset.favorite ? t('photos_viewer_unfavorite') : t('photos_viewer_favorite')} icon={p.asset.favorite ? 'Heart' : 'HeartOutline'} onclick={toggleFavorite} />
      <Pill text={t('photos_info')} icon="Info" onclick={() => ((info = true), closeChrome())} />
      <Pill text={`${t('photos_zoom')} ${zoomed ? '×1' : '×2'}`} onclick={() => ((zoomed = !zoomed), (pan = { x: 0, y: 0 }), closeChrome())} />
      <Pill text={t('photos_slideshow_seconds', seconds)} onclick={() => (seconds = INTERVALS[(INTERVALS.indexOf(seconds) + 1) % INTERVALS.length])} />
      <Pill text={t('photos_slideshow_ken_burns')} selected={kenBurns} onclick={() => (kenBurns = !kenBurns)} />
    </div>
  {/if}

  {#if info && p}
    <div class="info">
      <p class="t-title3">{t('photos_info')}</p>
      <div class="lines">
        {#each exifLines as [label, value] (label)}
          <div class="line"><span class="t-footnote label-2 k">{label}</span><span class="v ellipsis">{value}</span></div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .viewer {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
    background: #000;
    color: #fff;
  }
  .sink {
    position: absolute;
    top: 0;
    left: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  .layer {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition:
      opacity 300ms var(--ease-out),
      transform var(--kb) linear;
    will-change: opacity, transform;
  }
  .layer.slow {
    transition:
      opacity 1600ms var(--ease-out),
      transform var(--kb) linear;
  }
  .layer.shown {
    opacity: 1;
  }
  .layer img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .play {
    position: absolute;
    top: 50%;
    left: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 72rem;
    height: 72rem;
    margin: -36rem 0 0 -36rem;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.45);
  }
  .date {
    position: absolute;
    top: 36rem;
    left: 56rem;
    margin: 0;
    color: rgba(255, 255, 255, 0.78);
    text-shadow: 0 1rem 8rem rgba(0, 0, 0, 0.6);
  }
  .chrome {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 40rem;
    display: flex;
    justify-content: center;
  }
  .chrome > :global(* + *) {
    margin-left: 12rem;
  }
  .info {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 28rem 56rem;
    background: rgba(28, 28, 32, 0.94);
  }
  .info p {
    margin: 0 0 8rem;
  }
  /* Two columns: the panel keeps to the bottom third. */
  .lines {
    display: flex;
    flex-wrap: wrap;
  }
  .line {
    display: flex;
    align-items: baseline;
    width: 50%;
    padding: 4rem 16rem 4rem 0;
  }
  .k {
    width: 160rem;
    flex-shrink: 0;
  }
  .v {
    min-width: 0;
    font-family: 'Geist Mono', monospace;
    font-size: 15rem;
  }
  .center {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }
</style>
