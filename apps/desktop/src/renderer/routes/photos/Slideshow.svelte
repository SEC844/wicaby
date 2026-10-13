<script lang="ts">
  // Slideshow (photos spec PH-04, F11): full screen, a fade between photos (a cut under reduced motion), Ken Burns
  // as an option. Interval 3/5/10/20 s, timeline order or shuffle. Each photo fits over a dimmed, blurred copy of
  // itself. The next one is decoded before it fades in; the display stays awake while it runs. Clips are skipped.
  import { onDestroy, onMount, untrack } from 'svelte';
  import Icon from '../../components/Icon.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { w } from '../../lib/bridge';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { photoUrl } from '../../lib/images';
  import { rotation } from '../../lib/photos/asset';
  import type { GridAsset } from '../../lib/photos/source.svelte';

  // title, subtitle: a memory's title card (PH-08), shown over the first photo for a few seconds.
  let { assets, start, onclose, title, subtitle }: { assets: GridAsset[]; start: number; onclose: (index: number) => void; title?: string; subtitle?: string } = $props();
  let intro = $state(untrack(() => !!title));

  type Order = 'date' | 'shuffle';
  const KEY = 'wicaby.photos.slideshow';
  const INTERVALS = [3, 5, 10, 20];
  const prefs = untrack(() => {
    try {
      const p = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { interval?: number; order?: Order; kenBurns?: boolean };
      return { interval: INTERVALS.includes(p.interval ?? 0) ? p.interval! : 5, order: p.order === 'shuffle' ? ('shuffle' as Order) : ('date' as Order), kenBurns: p.kenBurns === true };
    } catch {
      return { interval: 5, order: 'date' as Order, kenBurns: false };
    }
  });
  let interval = $state(prefs.interval);
  let order = $state<Order>(prefs.order);
  let kenBurns = $state(prefs.kenBurns);
  let paused = $state(false);
  let chrome = $state(true);

  // Positions in `assets` of the photos, in play order; the start photo first when shuffled.
  const photos = untrack(() => assets.flatMap((a, i) => (a.kind === 'photo' ? [i] : [])));
  function sequence(o: Order, from: number): number[] {
    if (o === 'date') return photos;
    const out = photos.filter((i) => i !== from);
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return photos.includes(from) ? [from, ...out] : out;
  }
  let list = $state(untrack(() => sequence(order, photos.find((i) => i >= start) ?? photos[0] ?? 0)));
  let pos = $state(untrack(() => Math.max(0, list.indexOf(photos.find((i) => i >= start) ?? -1))));
  let seq = 0;
  let slides = $state<{ key: number; index: number; url: string; turn: number; drift: number }[]>([]);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const url = (i: number) => {
    const dpr = window.devicePixelRatio || 1;
    return photoUrl(assets[i], { maxWidth: Math.min(window.innerWidth, 3840 / dpr), maxHeight: Math.min(window.innerHeight, 2160 / dpr) });
  };

  const decoded = new Map<string, { img: HTMLImageElement; ready: Promise<boolean> }>();
  function decode(src: string) {
    let d = decoded.get(src);
    if (!d) {
      const img = new Image();
      img.src = src;
      d = { img, ready: img.decode().then(() => true, () => false) };
      decoded.set(src, d);
    }
    return d;
  }

  // Shows list[p] once decoded, then arms the timer and decodes the one after.
  async function showAt(p: number): Promise<void> {
    clearTimeout(timer);
    if (!list.length) return;
    p = ((p % list.length) + list.length) % list.length;
    pos = p;
    const i = list[p];
    const src = url(i);
    const d = decode(src);
    await d.ready;
    if (pos !== p) return;
    const o = assets[i].orient;
    const turn = o ? rotation(o.o, o.w, o.h, d.img.naturalWidth, d.img.naturalHeight) : 0;
    slides = [...slides.slice(-1), { key: ++seq, index: i, url: src, turn, drift: seq % 4 }];
    const next = url(list[(p + 1) % list.length]);
    decode(next);
    for (const [k, v] of decoded) if (k !== src && k !== next && !slides.some((s) => s.url === k)) ((v.img.src = ''), decoded.delete(k));
    arm();
  }

  function arm(): void {
    clearTimeout(timer);
    if (!paused) timer = setTimeout(() => void showAt(pos + 1), interval * 1000);
  }

  function save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ interval, order, kenBurns }));
    } catch {
      // Remembered options are a convenience.
    }
  }

  function setOrder(o: Order): void {
    const current = list[pos];
    order = o;
    list = sequence(o, current);
    pos = list.indexOf(current);
    save();
  }

  function togglePause(): void {
    paused = !paused;
    arm();
  }

  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let overChrome = false;
  function poke(): void {
    chrome = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!overChrome) chrome = false;
    }, 2500);
  }

  const exit = () => onclose(list[pos] ?? start);

  function onKey(e: KeyboardEvent): void {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const onControl = (e.target as HTMLElement | null)?.closest?.('button');
    let handled = true;
    if (e.key === ' ' && !onControl) togglePause();
    else if (e.key === 'ArrowRight') void showAt(pos + 1);
    else if (e.key === 'ArrowLeft') void showAt(pos - 1);
    else if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack') exit();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  let root = $state<HTMLDivElement>();
  // Out of the page's stacking context, over the title bar.
  const toBody = (node: HTMLElement) => void document.body.appendChild(node);
  let enteredFullscreen = false;
  onMount(() => {
    root?.focus({ preventScroll: true });
    if (intro) setTimeout(() => (intro = false), 3500);
    poke();
    void w.photos.keepAwake(true);
    void w.window.getState().then((s) => {
      if (!s.fullscreen) {
        enteredFullscreen = true;
        void w.window.toggleFullscreen();
      }
    });
    void showAt(pos);
  });
  onDestroy(() => {
    clearTimeout(timer);
    clearTimeout(hideTimer);
    void w.photos.keepAwake(false);
    if (enteredFullscreen) void w.window.toggleFullscreen();
    for (const v of decoded.values()) v.img.src = '';
  });

  const current = $derived(slides.length ? assets[slides[slides.length - 1].index] : null);
</script>

<svelte:window onkeydowncapture={onKey} />

<div
  class="show"
  class:idle={!chrome}
  class:kb={kenBurns}
  style:--interval="{interval}s"
  role="dialog"
  aria-modal="true"
  aria-label={t('photos.slideshow.start')}
  tabindex="-1"
  data-index={slides.length ? slides[slides.length - 1].index : -1}
  bind:this={root}
  use:toBody
  onpointermove={poke}
>
  {#each slides as s (s.key)}
    <div class="slide" style:--turn="{s.turn}deg">
      <img class="fill" class:turned={s.turn !== 0} src={s.url} alt="" aria-hidden="true" />
      <div class="move drift-{s.drift}"><img class="fit" class:turned={s.turn !== 0} src={s.url} alt="" /></div>
    </div>
  {/each}

  {#if intro && slides.length}
    <div class="intro" aria-live="polite"><h2 class="large-title">{title}</h2>{#if subtitle}<p class="title-3">{subtitle}</p>{/if}</div>
  {/if}
  {#if current}<div class="caption-date footnote">{fmt.date(new Date(current.takenAt.slice(0, 19)))}</div>{/if}

  <div class="controls material" role="toolbar" tabindex="-1" onpointerenter={() => (overChrome = true)} onpointerleave={() => (overChrome = false)}>
    <button class="round" aria-label={t(paused ? 'photos.slideshow.resume' : 'photos.slideshow.pause')} onclick={togglePause}>
      <Icon name={paused ? 'play' : 'pause'} size={18} fill stroke={0} />
    </button>
    <span class="footnote">{t('photos.slideshow.interval')}</span>
    <Segmented
      value={String(interval)}
      label={t('photos.slideshow.interval')}
      options={INTERVALS.map((n) => ({ value: String(n), label: t('photos.slideshow.intervalValue', { n }) }))}
      onchange={(v) => ((interval = Number(v)), save(), arm())}
    />
    <Segmented
      value={order}
      label={t('photos.slideshow.order')}
      options={[
        { value: 'date', label: t('photos.slideshow.orderDate') },
        { value: 'shuffle', label: t('photos.slideshow.orderShuffle') },
      ]}
      onchange={setOrder}
    />
    <span class="footnote">{t('photos.slideshow.kenBurns')}</span>
    <Toggle checked={kenBurns} label={t('photos.slideshow.kenBurns')} onchange={(v) => ((kenBurns = v), save())} />
    <button class="round" aria-label={t('photos.slideshow.exit')} onclick={exit}><Icon name="close" size={18} /></button>
  </div>
</div>

<style>
  .show {
    position: fixed;
    inset: 0;
    z-index: 60;
    overflow: hidden;
    background: #000;
    outline: none;
    -webkit-app-region: no-drag;
  }
  .show.idle {
    cursor: none;
  }
  .slide {
    position: absolute;
    inset: 0;
    animation: fade-in var(--t-slow) var(--ease) both;
  }
  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }
  .move {
    position: absolute;
    inset: 0;
  }
  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    user-select: none;
  }
  .fill {
    object-fit: cover;
    filter: blur(40px) brightness(0.35);
    transform: scale(1.1);
  }
  .fit {
    object-fit: contain;
  }
  img.turned {
    inset: auto;
    left: 50%;
    top: 50%;
    width: 100vh;
    height: 100vw;
    transform: translate(-50%, -50%) rotate(var(--turn));
  }
  .fill.turned {
    transform: translate(-50%, -50%) rotate(var(--turn)) scale(1.1);
  }
  /* Ken Burns: a slow push-in, its direction varying per photo. Off under reduced motion. */
  .kb .move {
    animation: kb calc(var(--interval) + 1s) linear both;
  }
  .kb .drift-1 {
    --kx: -2%;
  }
  .kb .drift-2 {
    --ky: -2%;
  }
  .kb .drift-3 {
    --kx: 2%;
    --ky: 1.5%;
  }
  @keyframes kb {
    from {
      transform: scale(1);
    }
    to {
      transform: scale(1.08) translate3d(var(--kx, 1.5%), var(--ky, 1%), 0);
    }
  }
  :global(html[data-reduce-motion]) .kb .move {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .kb .move {
      animation: none;
    }
  }
  .intro {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    gap: 6px;
    text-align: center;
    color: #fff;
    background: rgb(0 0 0 / 0.35);
    text-shadow: 0 2px 16px rgb(0 0 0 / 0.6);
    animation: fade-in var(--t-slow) var(--ease) both;
    pointer-events: none;
  }
  .intro h2,
  .intro p {
    margin: 0;
  }
  .intro p {
    color: rgb(255 255 255 / 0.8);
    font-weight: 500;
  }
  .caption-date {
    position: absolute;
    left: 24px;
    bottom: 22px;
    color: rgb(255 255 255 / 0.8);
    text-shadow: 0 1px 8px rgb(0 0 0 / 0.7);
  }
  .controls {
    position: absolute;
    left: 50%;
    bottom: 24px;
    translate: -50% 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-radius: 999px;
    color: var(--label);
    box-shadow: var(--shadow-3);
    transition: opacity var(--t-med) var(--ease);
  }
  .idle .controls,
  .idle .caption-date {
    opacity: 0;
    pointer-events: none;
  }
  .round {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
  }
  .round:is(:hover, :focus-visible) {
    background: var(--fill-3);
  }
</style>
