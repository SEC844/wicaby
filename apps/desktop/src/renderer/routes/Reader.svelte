<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import type { ComicInfo } from '../../shared/contract';
  import Icon from '../components/Icon.svelte';
  import LogoLoader from '../components/LogoLoader.svelte';
  import Segmented from '../components/Segmented.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { invalidateApiCache } from '../lib/api';
  import { w } from '../lib/bridge';
  import { fmt, t } from '../lib/i18n.svelte';
  import { back, router } from '../lib/router.svelte';
  import { dataVersion, errorMessage } from '../lib/stores.svelte';
  import { ZoomPan } from '../lib/zoom.svelte';
  import { dur, reducedMotion } from '../lib/motion';

  // Comic reader (CBZ). Pages come from wicaby-media://comic/<id>/<n>, which
  // main serves out of the cached archive. Spreads, zoom and pan move with
  // transform/opacity only.
  // server: the book's server (absent: the primary one).
  let { id, server }: { id: string; server?: string } = $props();

  type Fit = 'width' | 'height' | 'original';
  type Layout = 'auto' | 'single' | 'double' | 'strip';
  interface Prefs {
    rtl: boolean;
    fit: Fit;
    layout: Layout;
  }
  const PREFS_KEY = 'wicaby.reader.prefs';
  const DEFAULTS: Prefs = { rtl: false, fit: 'height', layout: 'auto' };

  // null when this book has no saved choice yet, so ComicInfo and the page shapes decide.
  function loadPrefs(): Prefs | null {
    try {
      const all = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, Partial<Prefs>>;
      return all[id] ? { ...DEFAULTS, ...all[id] } : null;
    } catch {
      return null;
    }
  }
  const saved = untrack(loadPrefs);

  function setPrefs(patch: Partial<Prefs>): void {
    prefs = { ...prefs, ...patch };
    try {
      const all = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, Prefs>;
      all[id] = prefs;
      localStorage.setItem(PREFS_KEY, JSON.stringify(all));
    } catch {
      // Per-book preferences are best effort.
    }
    resetView();
  }

  let info = $state<ComicInfo | null>(null);
  let error = $state('');
  let prefs = $state<Prefs>(saved ?? { ...DEFAULTS });
  let current = $state(0);
  let dir = 1;
  let sizes = $state<Record<number, [number, number]>>({});
  let vw = $state(window.innerWidth);
  let vh = $state(window.innerHeight);
  let glide = $state(false);
  let chrome = $state(true);
  let panel = $state(false);
  let fullscreen = $state(false);
  let strip = $state<HTMLDivElement>();
  let scroller = $state<HTMLDivElement>();

  const pageCount = $derived(info?.pageCount ?? 0);
  const book = untrack(() => `${server ? `${encodeURIComponent(server)}/` : ''}${encodeURIComponent(id)}`);
  const src = (i: number, thumb = false) => `wicaby-media://comic/${book}/${i}${thumb ? '?thumb=1' : ''}`;
  const aspect = (i: number) => (sizes[i] ? sizes[i][0] / sizes[i][1] : 0.68);
  const scrolling = $derived(prefs.layout === 'strip');
  const double = $derived(prefs.layout === 'double' || (prefs.layout === 'auto' && vw > vh * 1.15));
  const alone = (i: number) => aspect(i) > 1 || Boolean(info?.pages[i]?.double);

  // Komga's pairing: the cover, the last page and landscape pages stand alone.
  const spreads = $derived.by(() => {
    const out: number[][] = [];
    for (let i = 0; i < pageCount; ) {
      if (!double || i === 0 || i + 1 >= pageCount - 1 || alone(i) || alone(i + 1)) out.push([i++]);
      else {
        out.push([i, i + 1]);
        i += 2;
      }
    }
    return out;
  });
  const spreadIndex = $derived(Math.max(0, spreads.findIndex((s) => s.includes(current))));
  const spread = $derived(spreads[spreadIndex] ?? [current]);

  // Pages share one height; the fit decides that height.
  const layer = $derived.by(() => {
    const ratios = spread.map(aspect);
    const sum = ratios.reduce((a, b) => a + b, 0);
    let h: number;
    if (prefs.fit === 'width') h = vw / sum;
    else if (prefs.fit === 'height') h = Math.min(vh, vw / sum);
    else h = Math.max(...spread.map((i) => sizes[i]?.[1] ?? vh)) / (window.devicePixelRatio || 1);
    return { key: spread.join('-'), pages: spread, widths: ratios.map((r) => r * h), h, w: sum * h };
  });
  // Zoom ×1–×6 and pan (lib/zoom.svelte.ts, shared with the photo viewer).
  const z = new ZoomPan(() => ({ vw, vh, w: layer.w, h: layer.h }));
  const maxX = $derived(z.maxX);
  const maxY = $derived(z.maxY);
  const overflows = $derived(z.overflows);
  // ComicInfo series line, unless the item title already says it.
  const seriesLine = $derived.by(() => {
    const m = info?.meta;
    if (!m?.series || info?.title.toLowerCase().startsWith(m.series.toLowerCase())) return '';
    return m.number ? t('reader.seriesNumber', { series: m.series, number: m.number }) : m.series;
  });
  const folio = $derived(spread.length > 1 ? `${spread[0] + 1}–${spread[1] + 1}` : `${spread[0] + 1}`);

  // Vertical scroll (webtoons): one column, heights reserved from the known page sizes.
  const column = $derived(Math.min(vw, 900));
  const tops = $derived.by(() => {
    const out = [0];
    for (let i = 0; i < pageCount; i++) out.push(out[i] + column / aspect(i));
    return out;
  });

  function onScroll(): void {
    if (!scroller) return;
    const y = scroller.scrollTop + vh / 3;
    let i = 0;
    while (i < pageCount - 1 && tops[i + 1] <= y) i++;
    if (i !== current) {
      current = aim = i;
      scheduleSave();
    }
  }

  function scrollBy(dy: number): void {
    scroller?.scrollBy({ top: dy, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  // Entering the mode (or opening a webtoon) lands on the current page.
  $effect(() => {
    const el = scroller;
    if (el) untrack(() => (el.scrollTop = tops[current]));
  });

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  // New spread: no zoom, top of the page, reading-side edge first.
  function resetView(): void {
    z.zoom = 1;
    glide = false;
    z.panY = maxY;
    z.panX = prefs.rtl ? -maxX : maxX;
  }

  $effect(() => {
    void vw;
    void vh;
    void layer;
    untrack(() => z.clampPan());
  });

  // ---- Decoding and preloading ----
  // About ±3 pages stay decoded; a page is shown only once img.decode() resolved.
  const decoded = new Map<number, { img: HTMLImageElement; ready: Promise<void> }>();

  function decode(i: number): Promise<void> {
    let d = decoded.get(i);
    if (!d) {
      const img = new Image();
      img.decoding = 'async';
      img.src = src(i);
      const ready = img.decode().then(
        () => {
          sizes[i] = [img.naturalWidth, img.naturalHeight];
        },
        () => {
          decoded.delete(i);
        },
      );
      d = { img, ready };
      decoded.set(i, d);
    }
    return d.ready;
  }

  function preload(): void {
    if (scrolling) return;
    const first = spread[0];
    const last = spread[spread.length - 1];
    // Reading direction first, then one page back.
    for (const i of [last + 1, last + 2, last + 3, first - 1]) if (i >= 0 && i < pageCount) void decode(i);
    for (const [i, d] of decoded) {
      if (i >= first - 3 && i <= last + 3) continue;
      d.img.src = '';
      decoded.delete(i);
    }
  }

  let aim = 0;
  let navSeq = 0;
  async function go(page: number): Promise<void> {
    if (!pageCount) return;
    page = clamp(Math.round(page), 0, pageCount - 1);
    if (scrolling) {
      scroller?.scrollTo({ top: tops[page] });
      return;
    }
    const target = spreads.find((s) => s.includes(page)) ?? [page];
    if (target.includes(current)) return;
    aim = target[0];
    const seq = ++navSeq;
    await Promise.race([Promise.all(target.map(decode)), new Promise((r) => setTimeout(r, 1500))]);
    if (seq !== navSeq) return;
    dir = target[0] > current ? 1 : -1;
    current = target[0];
    resetView();
    preload();
    scheduleSave();
  }

  function step(delta: 1 | -1): void {
    const idx = spreads.findIndex((s) => s.includes(aim)) + delta;
    if (idx >= 0 && idx < spreads.length) void go(spreads[idx][0]);
  }

  // Screen sides map to reading order: in manga mode the left side is "next".
  function side(s: 'left' | 'right'): void {
    step((s === 'right') !== prefs.rtl ? 1 : -1);
  }

  // Space reads down a tall page before turning it, like scrolling a book.
  function advance(delta: 1 | -1): void {
    const edge = delta > 0 ? -maxY : maxY;
    if (Math.abs(z.panY - edge) > 1) {
      glide = true;
      z.panY = clamp(z.panY - delta * vh * 0.85, -maxY, maxY);
    } else step(delta);
  }

  function nudge(dy: number): void {
    glide = true;
    z.panY = clamp(z.panY + dy, -maxY, maxY);
  }

  // ---- Progress ----
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let savedPage = -1;
  // Plain copies: save() also runs from onDestroy, when deriveds are gone.
  let readPage = -1;
  let total = 0;

  function save(): Promise<void> {
    clearTimeout(saveTimer);
    if (readPage < 0 || readPage === savedPage) return Promise.resolve();
    savedPage = readPage;
    return w.comics.saveProgress(id, readPage, total, server).catch(() => undefined);
  }

  function scheduleSave(): void {
    // Reaching the last spread marks the book as read.
    readPage = spread.includes(pageCount - 1) ? pageCount - 1 : spread[0];
    total = pageCount;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), 1500);
  }

  // ---- Chrome ----
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let overChrome = false;

  function poke(): void {
    chrome = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!overChrome && !panel) chrome = false;
    }, 2600);
  }

  // Mouse clicks on the chrome must not leave focus on a button, or Space would press it again instead of turning the page.
  function keepFocus(e: MouseEvent): void {
    e.preventDefault();
  }

  function toggleChrome(): void {
    if (chrome) {
      chrome = false;
      panel = false;
    } else poke();
  }

  // ---- Pointer: tap halves, drag pans, swipe turns, pinch zooms ----
  let lastMouse = { x: -1, y: -1 };

  function onDown(e: PointerEvent): void {
    if (z.down(e)) glide = false;
  }

  function onMove(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && Math.hypot(e.clientX - lastMouse.x, e.clientY - lastMouse.y) > 3) {
      lastMouse = { x: e.clientX, y: e.clientY };
      if (!z.pointerCount) poke();
    }
    z.move(e);
  }

  function onUp(e: PointerEvent): void {
    const d = z.up(e);
    if (!d) return;
    if (!d.moved) {
      // Touch keeps a centre band for the controls, like Apple Books; a mouse already has hover.
      if (e.pointerType === 'touch' && Math.abs(e.clientX - vw / 2) < vw / 6) toggleChrome();
      else side(e.clientX < vw / 2 ? 'left' : 'right');
    } else if (maxX <= 1 && Math.abs(d.dx) > 60) side(d.dx < 0 ? 'right' : 'left');
  }

  let wheelAcc = 0;
  let wheelLock = 0;
  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    glide = false;
    if (z.wheel(e)) return;
    const now = performance.now();
    if (now < wheelLock) return;
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) > 80) {
      step(wheelAcc > 0 ? 1 : -1);
      wheelAcc = 0;
      wheelLock = now + 350;
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || e.metaKey) return;
    if (e.ctrlKey && !['+', '=', '-', '0'].includes(e.key)) return;
    const onControl = (e.target as HTMLElement | null)?.closest?.('button, [role="radiogroup"]');
    if (scrolling && !(onControl && (e.key === ' ' || panel))) {
      const page = vh * 0.9;
      const dy = ({ ' ': e.shiftKey ? -page : page, PageDown: page, PageUp: -page, ArrowDown: vh * 0.2, ArrowUp: -vh * 0.2 } as Record<string, number>)[e.key];
      if (dy) {
        e.preventDefault();
        scrollBy(dy);
        return;
      }
    }
    let handled = true;
    switch (e.key) {
      case 'ArrowRight':
        if (panel && onControl) return;
        side('right');
        break;
      case 'ArrowLeft':
        if (panel && onControl) return;
        side('left');
        break;
      case 'PageDown':
        step(1);
        break;
      case 'PageUp':
        step(-1);
        break;
      case ' ':
        if (onControl) return;
        advance(e.shiftKey ? -1 : 1);
        break;
      case 'ArrowDown':
        if (maxY > 1) nudge(-vh * 0.2);
        else poke();
        break;
      case 'ArrowUp':
        if (maxY > 1) nudge(vh * 0.2);
        else poke();
        break;
      case 'Home':
        void go(0);
        break;
      case 'End':
        void go(pageCount - 1);
        break;
      case 'Enter':
        if (onControl) return;
        toggleChrome();
        break;
      case '+':
      case '=':
        z.zoomAt(1.25);
        break;
      case '-':
        z.zoomAt(0.8);
        break;
      case '0':
        resetView();
        break;
      case 'f':
      case 'F':
        void w.window.toggleFullscreen();
        break;
      case 'Escape':
        if (panel) panel = false;
        else back();
        break;
      case 'Backspace':
      case 'BrowserBack':
        back();
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  // Page turn: the new spread slides in from the reading side while the old one fades out.
  function turn(_node: Element, { out }: { out: boolean }) {
    const d = dir * (prefs.rtl ? -1 : 1) * Math.min(72, vw * 0.06);
    return {
      duration: dur('med'),
      easing: cubicOut,
      css: (t: number, u: number) => `opacity: ${t}; transform: translate3d(${(out ? -d : d) * u}px, 0, 0)`,
    };
  }

  // Keep the current page centred in the strip.
  $effect(() => {
    void spreadIndex;
    if (!chrome || !strip) return;
    const el = strip.querySelector<HTMLElement>('.thumb.on');
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  });

  function stripWheel(e: WheelEvent): void {
    if (!strip || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    strip.scrollLeft += prefs.rtl ? -e.deltaY : e.deltaY;
  }

  onMount(() => {
    const offWin = w.window.onState((s) => {
      fullscreen = s.fullscreen;
    });
    void w.window.getState().then((s) => (fullscreen = s.fullscreen));
    poke();
    void (async () => {
      try {
        const opened = await w.comics.open(id, server);
        opened.pages.forEach((p, i) => {
          if (p.width > 0 && p.height > 0) sizes[i] = [p.width, p.height];
        });
        if (!saved) {
          // Very tall pages are a webtoon: median height over width above 2.5, as Mihon does.
          const ratios = opened.pages.filter((p) => p.width > 0).map((p) => p.height / p.width).sort((a, b) => a - b);
          const tall = opened.meta.webtoon || (ratios.length > 0 && ratios[Math.floor(ratios.length / 2)] > 2.5);
          prefs = { ...prefs, rtl: Boolean(opened.meta.manga), layout: tall ? 'strip' : 'auto', fit: tall ? 'width' : prefs.fit };
        }
        const asked = router.route.query.get('page');
        const start = clamp(asked !== null ? Number(asked) || 0 : opened.startPage, 0, opened.pageCount - 1);
        // Neighbours too: the pairing of the first spread depends on their shapes.
        const first = [start - 1, start, start + 1].filter((i) => i >= 0 && i < opened.pageCount);
        if (prefs.layout !== 'strip') await Promise.race([Promise.all(first.map(decode)), new Promise((r) => setTimeout(r, 2500))]);
        info = opened;
        current = aim = start;
        savedPage = start;
        await tick();
        resetView();
        preload();
        poke();
      } catch (err) {
        error = errorMessage(err);
      }
    })();
    return offWin;
  });

  onDestroy(() => {
    clearTimeout(hideTimer);
    // Item and Home re-read the server once the position is stored.
    void save().finally(() => {
      invalidateApiCache();
      dataVersion.userData++;
    });
  });
</script>

<svelte:window onkeydown={onKey} />

<div class="reader on-media" class:hidden={!chrome} bind:clientWidth={vw} bind:clientHeight={vh}>
  {#if error}
    <div class="state">
      <Icon name="book" size={40} stroke={1.5} />
      <h1 class="title-2">{t('reader.error.title')}</h1>
      <p class="footnote">{error}</p>
      <button class="btn" onclick={() => back()}><Icon name="arrowLeft" size={16} /> {t('reader.back')}</button>
    </div>
  {:else if !info}
    <div class="state" aria-busy="true">
      <LogoLoader size={56} />
      <p class="footnote">{t('reader.opening')}</p>
    </div>
  {:else}
    {#if scrolling}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="scroll"
      role="presentation"
      bind:this={scroller}
      onscroll={onScroll}
      onclick={toggleChrome}
      onpointermove={(e) => e.pointerType === 'mouse' && poke()}
      onwheel={(e) => e.ctrlKey && e.preventDefault()}
    >
      <div class="column" style:width="{column}px">
        {#each { length: pageCount } as _, i (i)}
          <img src={src(i)} alt={t('reader.page', { page: i + 1 })} loading="lazy" decoding="async" draggable="false" style:height="{tops[i + 1] - tops[i]}px" />
        {/each}
      </div>
    </div>
    {:else}
    <div
      class="stage"
      role="presentation"
      onpointerdown={onDown}
      onpointermove={onMove}
      onpointerup={onUp}
      onpointercancel={onUp}
      onwheel={onWheel}
      class:grab={overflows}
    >
      {#each [layer] as v (v.key)}
        <div class="layer" in:turn={{ out: false }} out:turn={{ out: true }}>
          <div
            class="spread"
            class:glide
            class:rtl={prefs.rtl}
            style:width="{v.w}px"
            style:height="{v.h}px"
            style:transform={v.key === layer.key ? `translate3d(-50%, -50%, 0) translate3d(${z.panX}px, ${z.panY}px, 0) scale(${z.zoom})` : undefined}
          >
            {#each v.pages as p, k (p)}
              <img
                src={src(p)}
                alt={t('reader.page', { page: p + 1 })}
                draggable="false"
                decoding="async"
                style:width="{v.widths[k]}px"
                style:height="{v.h}px"
                onload={(e) => {
                  const img = e.currentTarget as HTMLImageElement;
                  if (!sizes[p]) sizes[p] = [img.naturalWidth, img.naturalHeight];
                }}
              />
            {/each}
          </div>
        </div>
      {/each}
    </div>
    {/if}

    <div class="folio mono" aria-hidden="true">{folio} / {pageCount}</div>

    <div class="scrim top-scrim" aria-hidden="true"></div>
    <header
      class="top"
      class:caption-gap={!fullscreen}
      role="presentation"
      onpointerenter={() => (overChrome = true)}
      onpointerleave={() => (overChrome = false)}
      onmousedown={keepFocus}
    >
      <button class="round glass no-drag" title={t('reader.backHint')} aria-label={t('reader.back')} onclick={() => back()}>
        <Icon name="chevronLeft" size={20} stroke={2.2} />
      </button>
      <div class="title">
        <div class="t1">{info.title}</div>
        <div class="t2">{[seriesLine, t('reader.pageOf', { page: folio, count: pageCount }), z.zoom > 1.01 ? fmt.number(z.zoom, { style: 'percent', maximumFractionDigits: 0 }) : ''].filter(Boolean).join(' · ')}</div>
      </div>
      <button
        class="round glass no-drag"
        class:on={panel}
        title={t('reader.display')}
        aria-label={t('reader.display')}
        aria-expanded={panel}
        onclick={() => {
          panel = !panel;
          poke();
        }}
      >
        <Icon name={double ? 'spread' : 'singlePage'} size={18} />
      </button>
    </header>

    {#if panel}
      <div class="panel glass no-drag" role="dialog" aria-label={t('reader.display')} tabindex="-1" onpointerenter={() => (overChrome = true)} onpointerleave={() => (overChrome = false)} onmousedown={keepFocus}>
        <div class="row">
          <span class="label">{t('reader.layout.label')}</span>
          <Segmented
            label={t('reader.layout.label')}
            value={prefs.layout}
            options={[
              { value: 'auto', label: t('reader.layout.auto') },
              { value: 'single', label: t('reader.layout.single') },
              { value: 'double', label: t('reader.layout.double') },
              { value: 'strip', label: t('reader.layout.strip') },
            ]}
            onchange={(v) => setPrefs({ layout: v })}
          />
        </div>
        <div class="row" class:off={scrolling}>
          <span class="label">{t('reader.fit.label')}</span>
          <Segmented
            label={t('reader.fit.label')}
            value={prefs.fit}
            options={[
              { value: 'height', label: t('reader.fit.height') },
              { value: 'width', label: t('reader.fit.width') },
              { value: 'original', label: t('reader.fit.original') },
            ]}
            onchange={(v) => setPrefs({ fit: v })}
          />
        </div>
        <div class="row">
          <span class="label">{t('reader.manga.label')}<span class="caption">{t('reader.manga.caption')}</span></span>
          <Toggle label={t('reader.manga.aria')} checked={prefs.rtl} onchange={(v) => setPrefs({ rtl: v })} />
        </div>
        <p class="caption hint">{t('reader.hint')}</p>
      </div>
    {/if}

    <div class="scrim bottom-scrim" aria-hidden="true"></div>
    <footer class="dock glass" role="presentation" onpointerenter={() => (overChrome = true)} onpointerleave={() => (overChrome = false)} onmousedown={keepFocus}>
      <div class="strip" class:rtl={prefs.rtl} bind:this={strip} onwheel={stripWheel}>
        {#each { length: pageCount } as _, i (i)}
          <button class="thumb" class:on={spread.includes(i)} onclick={() => go(i)} aria-label={t('reader.page', { page: i + 1 })} aria-current={spread.includes(i) ? 'page' : undefined}>
            <img src={src(i, true)} alt="" loading="lazy" decoding="async" draggable="false" />
          </button>
        {/each}
      </div>
      <div class="dock-row">
        <span class="count mono">{folio} / {pageCount}</span>
        <span class="caption">{prefs.rtl ? t('reader.manga.label') : ''}</span>
      </div>
    </footer>
  {/if}
</div>

<style>
  .reader {
    position: fixed;
    inset: 0;
    z-index: 50;
    overflow: hidden;
    background: #000;
    color: var(--label);
    user-select: none;
  }
  .reader.hidden {
    cursor: none;
  }

  .state {
    height: 100%;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    text-align: center;
    padding: 0 24px;
    -webkit-app-region: drag;
  }
  .state .footnote {
    max-width: 440px;
    margin: 0 0 8px;
  }
  .state .btn {
    -webkit-app-region: no-drag;
  }
  /* ---- Pages ---- */
  .scroll {
    position: absolute;
    inset: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }
  .column {
    margin: 0 auto;
  }
  .column img {
    width: 100%;
    background: var(--fill-1);
  }
  .row.off {
    opacity: 0.35;
    pointer-events: none;
  }
  .stage {
    position: absolute;
    inset: 0;
    touch-action: none;
  }
  .stage.grab {
    cursor: grab;
  }
  .stage.grab:active {
    cursor: grabbing;
  }
  .layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .spread {
    position: absolute;
    left: 50%;
    top: 50%;
    display: flex;
    transform: translate3d(-50%, -50%, 0);
    /* No will-change: a promoted layer would keep its base raster and blur when zoomed. */
    transform-origin: 50% 50%;
  }
  .spread.rtl {
    flex-direction: row-reverse;
  }
  .spread.glide {
    transition: transform var(--t-med) var(--ease);
  }
  .spread img {
    flex: none;
    background: var(--fill-1);
    box-shadow: 0 0 40px rgb(0 0 0 / 0.5);
  }

  .folio {
    position: absolute;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    font-size: var(--fs-caption);
    color: var(--label-2);
    text-shadow: 0 0 8px rgb(0 0 0 / 0.8);
    pointer-events: none;
    transition: opacity var(--t-med) var(--ease);
  }
  .reader:not(.hidden) .folio {
    opacity: 0;
  }

  /* ---- Chrome ---- */
  .glass {
    background: var(--material);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    box-shadow:
      inset 0 0 0 0.5px var(--hairline),
      var(--shadow-2);
  }
  .scrim,
  .top,
  .dock,
  .panel {
    transition:
      opacity var(--t-med) var(--ease),
      transform var(--t-slow) var(--ease);
  }
  .hidden .scrim,
  .hidden .top,
  .hidden .dock,
  .hidden .panel {
    opacity: 0;
    pointer-events: none;
    transition-duration: var(--t-slow);
  }
  .hidden .top {
    transform: translate3d(0, -10px, 0);
    -webkit-app-region: no-drag;
  }
  .hidden .dock {
    transform: translate3d(-50%, 16px, 0);
  }
  .scrim {
    position: absolute;
    left: 0;
    right: 0;
    pointer-events: none;
  }
  .top-scrim {
    top: 0;
    height: 140px;
    background: linear-gradient(to bottom, rgb(0 0 0 / 0.6), transparent);
  }
  .bottom-scrim {
    bottom: 0;
    height: 200px;
    background: linear-gradient(to top, rgb(0 0 0 / 0.6), transparent);
  }

  .top {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px 24px 32px;
    -webkit-app-region: drag;
  }
  .top.caption-gap {
    padding-right: calc(var(--caption-buttons) + 12px);
  }
  .round {
    width: 40px;
    height: 40px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 999px;
    transition:
      transform var(--t-med) var(--spring);
  }
  .round:is(:hover, :focus-visible) {
    transform: scale(1.06);
    background: var(--fill-4);
  }
  .round:active {
    transform: scale(0.92);
  }
  .round.on {
    background: var(--label);
    color: #000;
  }
  .no-drag {
    -webkit-app-region: no-drag;
  }
  .title {
    min-width: 0;
    flex: 1;
    text-shadow: 0 1px 12px rgb(0 0 0 / 0.45);
  }
  .t1 {
    font-size: var(--fs-title-3);
    font-weight: 650;
    letter-spacing: -0.014em;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t2 {
    margin-top: 1px;
    font-size: var(--fs-callout);
    color: var(--label-2);
    font-variant-numeric: tabular-nums;
  }

  .panel {
    position: absolute;
    top: 76px;
    right: calc(var(--caption-buttons) + 12px);
    z-index: 3;
    width: 420px;
    padding: 14px 16px 12px;
    border-radius: var(--r-lg);
    display: grid;
    gap: 12px;
    transform-origin: top right;
    animation: pop var(--t-med) var(--spring) both;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.94);
    }
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .label {
    font-size: var(--fs-callout);
    font-weight: 560;
    display: grid;
  }
  .label .caption {
    font-weight: 400;
  }
  .hint {
    margin: 2px 0 0;
  }

  .dock {
    position: absolute;
    left: 50%;
    bottom: 18px;
    width: min(960px, calc(100% - 32px));
    transform: translate3d(-50%, 0, 0);
    padding: 10px 10px 8px;
    border-radius: var(--r-lg);
  }
  .strip {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 6px 4px 8px;
    scrollbar-width: none;
  }
  .strip.rtl {
    direction: rtl;
  }
  .thumb {
    flex: none;
    height: 72px;
    aspect-ratio: 2 / 3;
    border-radius: var(--r-xs);
    overflow: hidden;
    background: var(--fill-2);
    opacity: 0.55;
    transition:
      transform var(--t-med) var(--spring),
      opacity var(--t-fast) var(--ease);
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .thumb:is(:hover, :focus-visible) {
    opacity: 0.9;
    transform: translateY(-2px) scale(1.05);
  }
  .thumb.on {
    opacity: 1;
    transform: translateY(-3px) scale(1.08);
  }
  .dock-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 2px 6px 0;
  }
  .count {
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
</style>
