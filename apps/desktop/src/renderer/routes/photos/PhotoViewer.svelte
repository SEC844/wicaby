<script lang="ts">
  // Full-screen photo viewer (photos spec PH-03), an overlay over the page that opened it, so the grid keeps its
  // scroll. Zoom ×1–×8 and pan come from lib/zoom.svelte.ts (shared with the comic reader). An asset shows once
  // img.decode() resolved; the previous and next ones stay decoded. Past ×2 the current one is fetched larger.
  import { onDestroy, onMount, untrack } from 'svelte';
  import type { BaseItem } from '../../../shared/models';
  import Icon from '../../components/Icon.svelte';
  import { apiFor } from '../../lib/api';
  import { w } from '../../lib/bridge';
  import { clock } from '../../lib/format';
  import { fmt, locale, t } from '../../lib/i18n.svelte';
  import { immichUrl, photoUrl } from '../../lib/images';
  import { immichDetail } from '../../lib/photos/immich.svelte';
  import { rotation } from '../../lib/photos/asset';
  import { exifOf, formatExif, type ApertureUnit } from '../../lib/photos/exif';
  import { setFavorite, type GridAsset } from '../../lib/photos/source.svelte';
  import { errorMessage, isFileSource, toast } from '../../lib/stores.svelte';
  import { ZoomPan } from '../../lib/zoom.svelte';

  let {
    assets,
    start,
    thumb,
    onclose,
    onslideshow,
  }: {
    assets: GridAsset[];
    start: number;
    // The opened tile's thumbnail, shown (and morphed) until the full image is decoded.
    thumb?: string;
    onclose: (index: number) => void;
    onslideshow?: (index: number) => void;
  } = $props();

  // Gate G2 (spec §3.1): Aperture may be an APEX value; hidden until a test server confirms the unit.
  const APERTURE: ApertureUnit = 'hidden';

  let index = $state(untrack(() => start));
  const a = $derived(assets[index]);
  let vw = $state(window.innerWidth);
  let vh = $state(window.innerHeight);
  let hi = $state(false);
  let shown = $state<{ id: string; url: string; w: number; h: number; turn: number } | null>(null);
  let chrome = $state(true);
  let info = $state(false);
  let menu = $state(false);
  let fav = $state(untrack(() => Boolean(assets[start]?.favorite)));
  let morph = $state(true);
  let detail = $state<BaseItem | null>(null);
  // The URL of an Immich clip playing in place, through wicaby-media://immich: the key never reaches the page.
  let clip = $state('');
  const immichOf = (x?: GridAsset) => (x?.serverId.startsWith('immich:') ? x.serverId.slice(7) : '');

  // The layer fills the screen at zoom 1 (contain), in the shown picture's upright shape.
  const box = $derived.by(() => {
    const r = shown ? (shown.turn % 180 ? shown.h / shown.w : shown.w / shown.h) : (a?.aspect ?? 1.5);
    const bw = Math.min(vw, vh * r);
    return { w: bw, h: bw / r };
  });
  const z = new ZoomPan(() => ({ vw, vh, w: box.w, h: box.h }), 8);

  // Viewport-sized, capped at 3840 × 2160 device pixels; past ×2 zoom, the largest the server gives (≤ 8192).
  const url = (i: number, large = false) => {
    const dpr = window.devicePixelRatio || 1;
    return photoUrl(assets[i], large ? { maxWidth: 4096 } : { maxWidth: Math.min(vw, 3840 / dpr), maxHeight: Math.min(vh, 2160 / dpr) });
  };

  const decoded = new Map<string, { img: HTMLImageElement; ready: Promise<boolean> }>();
  function decode(src: string) {
    let d = decoded.get(src);
    if (!d) {
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
      d = { img, ready: img.decode().then(() => true, () => false) };
      decoded.set(src, d);
    }
    return d;
  }

  async function show(i: number, src: string): Promise<void> {
    const d = decode(src);
    const ok = await d.ready;
    if (i !== index || !ok) return;
    const asset = assets[i];
    const o = asset.orient;
    const turn = o ? rotation(o.o, o.w, o.h, d.img.naturalWidth, d.img.naturalHeight) : 0;
    shown = { id: asset.id, url: src, w: d.img.naturalWidth, h: d.img.naturalHeight, turn };
    // Keep the current picture (both sizes) and the neighbours decoded; let the rest go.
    const keep = new Set([src, url(i), ...[i - 1, i + 1].filter((j) => j >= 0 && j < assets.length).map((j) => url(j))]);
    for (const k of keep) if (k !== src) decode(k);
    for (const [k, v] of decoded) if (!keep.has(k)) ((v.img.src = ''), decoded.delete(k));
  }

  $effect(() => {
    const i = index;
    const src = url(i, hi);
    untrack(() => void show(i, src));
  });
  $effect(() => {
    if (z.zoom > 2) hi = true;
  });

  function go(i: number): void {
    if (i < 0 || i >= assets.length || i === index) return;
    index = i;
    hi = false;
    z.reset();
    fav = Boolean(assets[i].favorite);
    detail = null;
    clip = '';
  }

  // Info panel: the item itself carries the EXIF fields (list answers may not, gate G3).
  $effect(() => {
    if (!info || !a) return;
    const id = a.id;
    const source = immichOf(a);
    void (source ? immichDetail(source, id) : apiFor(a.serverId || undefined).item(id))
      .then((it) => {
        if (assets[index]?.id === id) detail = it;
      })
      .catch(() => undefined);
  });

  const rows = $derived.by(() => {
    if (!detail) return [];
    const tpl = (k: string, ...names: string[]) => t(`photos.exif.${k}Value`, Object.fromEntries(names.map((n) => [n, `{${n}}`])));
    return formatExif(
      exifOf(detail),
      locale.current,
      {
        aperture: tpl('aperture', 'value'),
        exposure: tpl('exposure', 'value'),
        focal: tpl('focal', 'value'),
        iso: tpl('iso', 'value'),
        dimensions: tpl('dimensions', 'w', 'h'),
        altitude: tpl('altitude', 'value'),
        location: tpl('location', 'lat', 'lon'),
      },
      // Immich and the index of a photo source (EXIF FNumber) report the f-number itself.
      immichOf(a) || isFileSource(a?.serverId) ? 'fnumber' : APERTURE,
    );
  });

  const taken = $derived(a ? new Date(a.takenAt.slice(0, 19)) : null);
  const title = $derived(taken ? fmt.date(taken) : '');

  async function toggleFavorite(): Promise<void> {
    if (!a) return;
    const next = !fav;
    fav = next;
    try {
      await setFavorite(a, next);
    } catch (err) {
      fav = !next;
      toast('error', errorMessage(err));
    }
  }

  // "Enregistrer l'original" (F15): the downloads queue, through /Items/{id}/Download (permission-gated on both
  // servers; never /Items/{id}/File, which skips that permission).
  async function saveOriginal(): Promise<void> {
    menu = false;
    if (!a) return;
    const { id, serverId } = a;
    const source = immichOf(a);
    if (source) {
      try {
        toast('info', t('photos.save.queued'));
        await w.photos.immich.saveOriginal(source, id);
        toast('success', t('photos.save.done'), { label: t('photos.save.reveal'), run: () => void w.app.openPath('downloads') });
      } catch (err) {
        toast('error', /immich:403/.test(errorMessage(err)) ? t('photos.sources.scopeMissing', { scope: 'asset.download' }) : errorMessage(err));
      }
      return;
    }
    try {
      const off = w.downloads.onChange((list) => {
        const e = list.find((x) => x.itemId === id && (!serverId || x.serverId === serverId));
        if (e?.status === 'done') toast('success', t('photos.save.done'), { label: t('photos.save.reveal'), run: () => void w.downloads.reveal(e.id) });
        else if (e?.status === 'error') toast('error', t('photos.save.denied'));
        else return;
        off();
      });
      setTimeout(off, 120_000);
      await w.downloads.add([id], serverId || undefined);
      toast('info', t('photos.save.queued'));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  function play(): void {
    if (!a) return;
    if (immichOf(a)) return void (clip = immichUrl(immichOf(a), `assets/${a.id}/video/playback`));
    w.playback.play({ itemIds: [a.id], startIndex: 0, serverId: a.serverId || undefined }).catch((err) => toast('error', errorMessage(err)));
  }

  // ---- Chrome: hides after 2.5 s without pointer movement ----
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let overChrome = false;
  function poke(): void {
    chrome = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!overChrome && !menu) chrome = false;
    }, 2500);
  }

  // ---- Pointer: drag pans, swipe turns, pinch zooms, double-click toggles fit / ×2 ----
  let lastMouse = { x: -1, y: -1 };
  function onMove(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && Math.hypot(e.clientX - lastMouse.x, e.clientY - lastMouse.y) > 3) {
      lastMouse = { x: e.clientX, y: e.clientY };
      poke();
    }
    z.move(e);
  }
  function onUp(e: PointerEvent): void {
    const d = z.up(e);
    if (!d) return;
    if (!d.moved) {
      if (e.pointerType === 'touch' && chrome) chrome = false;
      else if (e.pointerType === 'touch') poke();
    } else if (!z.overflows && Math.abs(d.dx) > 60 && Math.abs(d.dx) > Math.abs(d.dy)) go(index + (d.dx < 0 ? 1 : -1));
  }
  function onDouble(e: MouseEvent): void {
    if (z.zoom > 1.01) z.reset();
    else z.zoomAt(2, e.clientX, e.clientY);
  }
  let wheelAcc = 0;
  let wheelLock = 0;
  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (z.wheel(e)) return;
    const now = performance.now();
    if (now < wheelLock) return;
    wheelAcc += e.deltaY + e.deltaX;
    if (Math.abs(wheelAcc) > 80) {
      go(index + (wheelAcc > 0 ? 1 : -1));
      wheelAcc = 0;
      wheelLock = now + 300;
    }
  }

  // Capture phase: the viewer's keys win over spatial navigation and the page underneath.
  function onKey(e: KeyboardEvent): void {
    if (e.altKey || e.metaKey || (e.ctrlKey && !['+', '=', '-', '0'].includes(e.key))) return;
    const onControl = (e.target as HTMLElement | null)?.closest?.('button, [role="menu"]');
    let handled = true;
    switch (e.key) {
      case 'ArrowRight':
        go(index + 1);
        break;
      case 'ArrowLeft':
        go(index - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(assets.length - 1);
        break;
      case '+':
      case '=':
        z.zoomAt(1.25);
        break;
      case '-':
        z.zoomAt(0.8);
        break;
      case '0':
        z.reset();
        break;
      case 'i':
      case 'I':
        info = !info;
        break;
      case 'f':
      case 'F':
        void toggleFavorite();
        break;
      case 's':
      case 'S':
        if (onslideshow) onslideshow(index);
        break;
      case 'Enter':
      case ' ':
        if (onControl) handled = false;
        else if (a?.kind === 'video') play();
        break;
      case 'Escape':
        if (menu) menu = false;
        else onclose(index);
        break;
      case 'Backspace':
      case 'BrowserBack':
        onclose(index);
        break;
      case 'ArrowUp':
      case 'ArrowDown':
      case 'Tab':
        handled = false;
        poke();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      poke();
    }
  }

  let root = $state<HTMLDivElement>();
  // Out of the page's stacking context, over the title bar.
  const toBody = (node: HTMLElement) => void document.body.appendChild(node);
  onMount(() => {
    poke();
    root?.focus({ preventScroll: true });
    // The open morph (view-transition-name) is only needed for the first frame's snapshot.
    const t = setTimeout(() => (morph = false), 700);
    return () => clearTimeout(t);
  });
  onDestroy(() => {
    clearTimeout(hideTimer);
    for (const v of decoded.values()) v.img.src = '';
    decoded.clear();
  });
</script>

<svelte:window onkeydowncapture={onKey} onresize={() => ((vw = window.innerWidth), (vh = window.innerHeight), z.clampPan())} />

<div class="viewer" class:idle={!chrome} role="dialog" aria-modal="true" aria-label={title} tabindex="-1" bind:this={root} use:toBody>
  <div
    class="stage"
    class:grab={z.overflows}
    role="presentation"
    onpointerdown={(e) => z.down(e)}
    onpointermove={onMove}
    onpointerup={onUp}
    onpointercancel={onUp}
    ondblclick={onDouble}
    onwheel={onWheel}
  >
    <div
      class="layer"
      style:width="{box.w}px"
      style:height="{box.h}px"
      style:transform="translate3d(-50%, -50%, 0) translate3d({z.panX}px, {z.panY}px, 0) scale({z.zoom})"
      style:view-transition-name={morph ? 'photo-morph' : undefined}
      style:view-transition-class={morph ? 'morph' : undefined}
    >
      {#if shown}
        <img
          class="pic"
          data-id={shown.id}
          data-turn={shown.turn}
          class:turned={shown.turn !== 0}
          style:width={shown.turn ? `${box.h}px` : undefined}
          style:height={shown.turn ? `${box.w}px` : undefined}
          style:--turn="{shown.turn}deg"
          src={shown.url}
          alt=""
          draggable="false"
        />
      {:else if thumb}
        <img class="pic" src={thumb} alt="" draggable="false" />
      {/if}
    </div>
    {#if clip}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video class="clip" src={clip} controls autoplay onpointerdown={(e) => e.stopPropagation()}></video>
    {:else if a?.kind === 'video'}
      <button class="play" aria-label={t('photos.viewer.play')} onclick={play} onpointerdown={(e) => e.stopPropagation()}>
        <Icon name="play" size={34} fill stroke={0} />
        {#if a.durationMs}<span class="mono">{clock(a.durationMs)}</span>{/if}
      </button>
    {/if}
  </div>

  <header class="bar" role="presentation" onpointerenter={() => (overChrome = true)} onpointerleave={() => (overChrome = false)}>
    <button class="round material-thin" aria-label={t('photos.viewer.close')} onclick={() => onclose(index)}><Icon name="arrowLeft" size={18} /></button>
    <div class="title">
      <div class="headline">{title}</div>
      {#if taken}<div class="footnote mono">{fmt.time(taken)} · {index + 1} / {assets.length}</div>{/if}
    </div>
    <button class="round material-thin" class:on={fav} aria-pressed={fav} aria-label={t(fav ? 'photos.viewer.unfavorite' : 'photos.viewer.favorite')} onclick={toggleFavorite}>
      <Icon name="heart" size={18} fill={fav} stroke={fav ? 0 : undefined} />
    </button>
    <button class="round material-thin" class:on={info} aria-pressed={info} aria-label={t('photos.viewer.info')} onclick={() => (info = !info)}><Icon name="info" size={18} /></button>
    {#if onslideshow}
      <button class="round material-thin" aria-label={t('photos.viewer.slideshow')} onclick={() => onslideshow(index)}><Icon name="presentation" size={18} /></button>
    {/if}
    <!-- A photo source's file is already the original: nothing to save. -->
    {#if !isFileSource(a?.serverId)}<div class="more">
      <button class="round material-thin" aria-label={t('photos.viewer.more')} aria-haspopup="menu" aria-expanded={menu} onclick={() => (menu = !menu)}><Icon name="ellipsis" size={18} /></button>
      {#if menu}
        <div class="menu material" role="menu">
          <button role="menuitem" onclick={saveOriginal}><Icon name="download" size={16} /> {t('photos.viewer.saveOriginal')}</button>
        </div>
      {/if}
    </div>{/if}
  </header>

  {#if index > 0}<button class="nav prev round material-thin" aria-label={t('photos.viewer.previous')} onclick={() => go(index - 1)}><Icon name="chevronLeft" size={22} /></button>{/if}
  {#if index < assets.length - 1}<button class="nav next round material-thin" aria-label={t('photos.viewer.next')} onclick={() => go(index + 1)}><Icon name="chevronRight" size={22} /></button>{/if}

  {#if info}
    <aside class="info material" aria-label={t('photos.info.title')}>
      <h2 class="title-3">{t('photos.info.title')}</h2>
      {#if taken}
        <dl>
          <dt class="footnote">{t('photos.exif.taken')}</dt>
          <dd>{fmt.date(taken, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, {fmt.time(taken)}</dd>
          {#if detail?.Name}<dt class="footnote">{t('photos.info.name')}</dt><dd>{detail.Name}</dd>{/if}
          {#each rows as [k, v] (k)}<dt class="footnote">{t(`photos.exif.${k}`)}</dt><dd class:mono={k !== 'camera' && k !== 'software'}>{v}</dd>{/each}
        </dl>
        {#if detail && rows.length === 0}<p class="footnote">{t('photos.info.noExif')}</p>{/if}
      {/if}
    </aside>
  {/if}
</div>

<style>
  .viewer {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: #000;
    color: #fff;
    outline: none;
    -webkit-app-region: no-drag;
    animation: fade var(--t-med) var(--ease) both;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .viewer.idle {
    cursor: none;
  }
  .stage {
    position: absolute;
    inset: 0;
    overflow: hidden;
    touch-action: none;
  }
  .stage.grab {
    cursor: grab;
  }
  .layer {
    position: absolute;
    left: 50%;
    top: 50%;
    transform-origin: center;
  }
  .pic {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    user-select: none;
  }
  .pic.turned {
    inset: auto;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%) rotate(var(--turn));
  }
  .clip {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    background: #000;
    object-fit: contain;
  }
  .play {
    position: absolute;
    left: 50%;
    top: 50%;
    translate: -50% -50%;
    display: grid;
    place-items: center;
    gap: 4px;
    width: 96px;
    height: 96px;
    border-radius: 50%;
    background: var(--material-thin);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    color: #fff;
  }
  .bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 18px;
    background: linear-gradient(rgb(0 0 0 / 0.55), transparent);
    transition: opacity var(--t-med) var(--ease);
  }
  .title {
    flex: 1;
    min-width: 0;
  }
  .title .footnote {
    color: rgb(255 255 255 / 0.7);
  }
  .round {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    color: #fff;
  }
  .round.on {
    color: var(--accent);
  }
  .nav {
    position: absolute;
    top: 50%;
    translate: 0 -50%;
    transition: opacity var(--t-med) var(--ease);
  }
  .prev {
    left: 16px;
  }
  .next {
    right: 16px;
  }
  .idle .bar,
  .idle .nav {
    opacity: 0;
    pointer-events: none;
  }
  .more {
    position: relative;
  }
  .menu {
    position: absolute;
    right: 0;
    top: 46px;
    min-width: 220px;
    padding: 6px;
    border-radius: var(--r-md);
    box-shadow: var(--shadow-3);
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 12px;
    border-radius: var(--r-sm);
    color: var(--label);
    text-align: left;
  }
  .menu button:is(:hover, :focus-visible) {
    background: var(--fill-3);
  }
  .info {
    position: absolute;
    top: 72px;
    right: 16px;
    bottom: 16px;
    width: min(340px, calc(100vw - 32px));
    overflow: auto;
    padding: 20px 22px;
    border-radius: var(--r-xl);
    color: var(--label);
    box-shadow: var(--shadow-3);
    animation: slide var(--t-med) var(--ease) both;
  }
  @keyframes slide {
    from {
      opacity: 0;
      transform: translate3d(24px, 0, 0);
    }
  }
  .info h2 {
    margin: 0 0 14px;
  }
  dl {
    display: grid;
    gap: 2px;
    margin: 0;
  }
  dt {
    margin-top: 10px;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
