<script lang="ts">
  // Android TV ReaderActivity (tv/reader/ReaderActivity.kt): a comic full screen for the remote. Double-page spreads on
  // a 16:9 screen (Komga's pairing), manga order from ComicInfo or the reader's choice, the whole page or the width
  // (Up / Down then scroll the page), a ×2 zoom that pans with the D-pad before turning the page, and a vertical
  // strip for webtoons (Up / Down scroll, Left / Right jump a page). CH+/CH-, Next/Previous and FF/RW turn pages.
  // OK opens the bar: title, page, a slider (Left / Right step through spreads, mirrored in manga order) and the
  // options. The page read goes back to the server as it changes and on leaving.
  import { getContext, onMount, tick } from 'svelte';
  import type { BaseItem } from '$shared/models';
  import Pill from '../components/Pill.svelte';
  import Spinner from '../components/Spinner.svelte';
  import { ComicBook, ComicError, looksWebtoon, saveProgress, spreads, startPage, type ComicFailure, type PageSize } from '../lib/comic';
  import { focusable, focusFirst, focused, setFocus } from '../lib/focus';
  import { t } from '../lib/i18n.svelte';
  import { changed } from '../lib/load.svelte';
  import { nav, onBack, SCREEN } from '../lib/nav.svelte';
  import { overlay } from '../lib/overlay.svelte';
  import { apiOf } from '../lib/session.svelte';
  import { load, save } from '../lib/storage';
  import { keyOf } from '../platform/keys';

  let { id, fromStart = false, serverId }: { id: string; fromStart?: boolean; serverId?: string } = $props();
  // svelte-ignore state_referenced_locally
  const client = apiOf(serverId)!;

  const FAILURE: Record<ComicFailure, string> = {
    unsupported: 'reader_unsupported',
    encrypted: 'reader_encrypted',
    'text-book': 'reader_text_book',
    'too-large': 'reader_too_large',
    'no-pages': 'reader_no_pages',
    forbidden: 'reader_forbidden',
    load: 'reader_load_error',
  };

  let item = $state<BaseItem | null>(null);
  let book = $state.raw<ComicBook | null>(null);
  let error = $state<string | null>(null);
  let count = $state(0);
  let index = $state(0);
  let sizes = $state<(PageSize | undefined)[]>([]);
  let urls = $state<Record<number, string>>({});
  let rtl = $state(false);
  let webtoon = $state(false);
  let fit = $state<'page' | 'width'>('page');
  let zoom = $state(1);
  let pan = $state({ x: 0, y: 0 });
  let bar = $state(false);
  let viewW = $state(1920);
  let viewH = $state(1080);

  // svelte-ignore state_referenced_locally
  const prefKey = `reader.${id}`;
  const double = $derived(viewW > viewH * 1.15 && !webtoon);
  const spreadList = $derived(spreads(sizes, count, double));
  const spreadIndex = $derived(Math.max(0, spreadList.findIndex((s) => s.includes(index))));
  const spread = $derived(spreadList[spreadIndex] ?? [index]);
  const shown = $derived(rtl ? spread.slice().reverse() : spread);

  // --- Loading ---
  onMount(() => {
    void (async () => {
      try {
        const it = await client.get<BaseItem>(`/Users/${client.userId}/Items/${id}`, { Fields: 'Path,MediaSources' });
        item = it;
        const b = await ComicBook.open(client, it);
        book = b;
        count = b.pages.length;
        sizes = b.pages.map((_, i) => (b.doubles.has(i) ? { width: 2, height: 1 } : undefined));
        const pref = load<{ rtl?: boolean; webtoon?: boolean }>(prefKey, {});
        rtl = pref.rtl ?? b.rtl;
        webtoon = pref.webtoon ?? b.webtoon;
        index = fromStart ? 0 : startPage(it, count);
      } catch (e) {
        const kind: ComicFailure = e instanceof ComicError ? e.kind : 'load';
        error = t(FAILURE[kind]);
      }
    })();
  });

  // The pages shown and the next ones, decoded ahead; their sizes feed the pairing.
  function want(i: number): void {
    if (!book || i < 0 || i >= count || urls[i]) return;
    void book.page(i).then(
      (u) => {
        urls = { ...urls, [i]: u };
        const img = new Image();
        img.onload = () => {
          if (!sizes[i] || sizes[i]!.width === 2) {
            const s = sizes.slice();
            s[i] = { width: img.naturalWidth, height: img.naturalHeight };
            sizes = s;
            if (!webtoon && !load<{ webtoon?: boolean }>(prefKey, {}).webtoon && looksWebtoon(s)) webtoon = true;
          }
        };
        img.src = u;
      },
      () => {},
    );
  }
  $effect(() => {
    if (!book) return;
    if (webtoon) for (let i = index - 1; i <= index + 3; i++) want(i);
    else {
      for (const i of spread) want(i);
      for (const s of spreadList.slice(spreadIndex + 1, spreadIndex + 3)) s.forEach(want);
      spreadList[spreadIndex - 1]?.forEach(want);
    }
  });

  // --- Progress: back to the server once the page rests, and on leaving ---
  let saveTimer = 0;
  let savedPage = -1;
  function persist(): void {
    if (!item || !count || savedPage === index) return;
    savedPage = index;
    // The last spread shown counts as the last page read.
    const page = spread.includes(count - 1) ? count - 1 : index;
    void saveProgress(client, item.Id, page, count).then(() => changed(), () => {});
  }
  $effect(() => {
    void index;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(persist, 2000);
  });

  // --- Turning pages ---
  function go(spreadTo: number): void {
    const s = spreadList[Math.max(0, Math.min(spreadList.length - 1, spreadTo))];
    if (!s) return;
    index = s[0];
    zoom = zoom > 1 ? zoom : 1;
    pan = { x: 0, y: 0 };
  }
  // Left / Right: pan first while there is more of the page that way, else the page on that side.
  function side(right: boolean): void {
    if (zoom > 1) {
      const maxX = (viewW * (zoom - 1)) / 2;
      const x = pan.x + (right ? -1 : 1) * viewW * 0.3;
      if (Math.abs(x) <= maxX + 1) return void (pan = { ...pan, x: Math.max(-maxX, Math.min(maxX, x)) });
    }
    go(spreadIndex + ((right ? 1 : -1) * (rtl ? -1 : 1)));
  }
  let pageEl = $state<HTMLDivElement>();
  function vertical(down: boolean): void {
    const h = pageEl?.offsetHeight ?? viewH;
    const maxY = Math.max(0, (h * zoom - viewH) / 2);
    if (maxY > 1) pan = { ...pan, y: Math.max(-maxY, Math.min(maxY, pan.y + (down ? -1 : 1) * viewH * 0.6)) };
  }

  // --- Webtoon strip ---
  const colW = $derived(Math.min(viewW, viewH * 0.85));
  const tops = $derived.by(() => {
    const out: number[] = [];
    let y = 0;
    for (let i = 0; i < count; i++) {
      out.push(y);
      const s = sizes[i];
      y += s && s.width > 2 ? (colW * s.height) / s.width : colW * 1.5;
    }
    out.push(y);
    return out;
  });
  let stripY = $state(0);
  function scrollStrip(dy: number): void {
    stripY = Math.max(0, Math.min(tops[count] - viewH, stripY + dy));
    let i = 0;
    while (i < count - 1 && tops[i + 1] <= stripY + viewH / 3) i++;
    index = i;
  }
  function jumpStrip(d: number): void {
    const i = Math.max(0, Math.min(count - 1, index + d));
    index = i;
    stripY = Math.max(0, Math.min(Math.max(0, tops[count] - viewH), tops[i]));
  }
  $effect(() => {
    // Entering the strip: the page read at the top.
    if (webtoon && count) stripY = Math.max(0, Math.min(Math.max(0, tops[count] - viewH), tops[index] ?? 0));
  });

  // --- The bar ---
  async function openBar(): Promise<void> {
    bar = true;
    await tick();
    const slider = document.querySelector<HTMLElement>('[data-screen-top] .reader .slider');
    if (slider) setFocus(slider);
    else {
      const b = document.querySelector('[data-screen-top] .reader .bar');
      if (b) focusFirst(b);
    }
  }
  let sink: HTMLButtonElement;
  function closeBar(): void {
    bar = false;
    setFocus(sink);
  }
  function setPref(next: { rtl?: boolean; webtoon?: boolean }): void {
    save(prefKey, { rtl, webtoon, ...next });
    if (next.rtl !== undefined) rtl = next.rtl;
    if (next.webtoon !== undefined) webtoon = next.webtoon;
    pan = { x: 0, y: 0 };
    zoom = 1;
  }
  function onSliderMove(e: CustomEvent<'up' | 'down' | 'left' | 'right'>): void {
    if (e.detail !== 'left' && e.detail !== 'right') return;
    e.preventDefault();
    const step = (e.detail === 'right' ? 1 : -1) * (rtl ? -1 : 1);
    if (webtoon) jumpStrip(step);
    else go(spreadIndex + step);
  }

  // --- The remote ---
  function onKey(e: KeyboardEvent): void {
    if (overlay.alert || !document.querySelector('[data-screen-top] .reader') || error || !book) return;
    const key = keyOf(e);
    if (!key || key === 'back') return;
    const next = key === 'next' || key === 'ff' || key === 'channelDown' || e.keyCode === 34;
    const prev = key === 'prev' || key === 'rw' || key === 'channelUp' || e.keyCode === 33;
    if (bar && !next && !prev) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (webtoon) {
      if (key === 'up' || key === 'down') return scrollStrip((key === 'down' ? 1 : -1) * viewH * 0.6);
      if (key === 'left' || key === 'right' || next || prev) return jumpStrip(key === 'right' || next ? 1 : -1);
    } else {
      if (next || prev) return go(spreadIndex + (next ? 1 : -1));
      if (key === 'left' || key === 'right') return side(key === 'right');
      if (key === 'up' || key === 'down') return vertical(key === 'down');
    }
    if (key === 'ok' && !e.repeat) void openBar();
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
      if (bar) return closeBar(), true;
      if (zoom > 1) return (zoom = 1), (pan = { x: 0, y: 0 }), true;
      return false;
    });
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('keydown', onKey, true);
      clearTimeout(saveTimer);
      persist();
      book?.close();
      stop();
    };
  });
  $effect(() => {
    if (!bar) return;
    const check = () => {
      if (!focused()?.closest('.bar')) bar = false;
    };
    document.addEventListener('tvfocus', check);
    return () => document.removeEventListener('tvfocus', check);
  });

  const pageLabel = $derived(spread.length > 1 ? `${spread[0] + 1}–${spread[spread.length - 1] + 1}` : String(index + 1));
  const progress = $derived(count > 1 ? index / (count - 1) : 0);
</script>

<div class="reader">
  <button class="sink" bind:this={sink} use:focusable aria-label={item?.Name ?? ''}></button>
  {#if error}
    <div class="center message">
      <p class="t-title3">{error}</p>
      <Pill text={t('reader_back')} autofocus onclick={() => nav.back()} />
    </div>
  {:else if !book}
    <div class="center message">
      <Spinner size={44} />
      {#if item}<p class="t-callout label-2 loading">{item.Name}</p>{/if}
    </div>
  {:else if webtoon}
    <div class="strip" style="width:{colW}px;transform:translate3d(-50%,{-stripY}px,0)">
      {#each Array.from({ length: count }, (_, i) => i) as i (i)}
        {#if tops[i + 1] >= stripY - viewH && tops[i] <= stripY + viewH * 2}
          <div class="strip-page" style="top:{tops[i]}px;height:{tops[i + 1] - tops[i]}px">
            {#if urls[i]}<img src={urls[i]} alt="" />{:else}<Spinner size={32} />{/if}
          </div>
        {/if}
      {/each}
    </div>
  {:else}
    <div class="pages" class:width={fit === 'width'} bind:this={pageEl} style="transform:translate3d({pan.x}px,{pan.y}px,0) scale({zoom})">
      {#each shown as i (i)}
        <div class="page" class:pair={shown.length > 1} class:left={shown.length > 1 && i === shown[0]}>
          {#if urls[i]}<img src={urls[i]} alt="" />{:else}<Spinner size={36} />{/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if bar && book && item}
    <div class="bar">
      <div class="bar-head">
        <span class="t-headline ellipsis">{item.Name}</span>
        <span class="t-footnote label-2">{t('reader_page_of', pageLabel, count)}</span>
      </div>
      <button class="slider" use:focusable ontvmove={onSliderMove} onclick={closeBar} aria-label={t('reader_page_of', pageLabel, count)}>
        <span class="track"><span class="fill" style="transform:scaleX({rtl ? 1 - progress : progress})"></span></span>
        <span class="knob" style="left:{(rtl ? 1 - progress : progress) * 100}%"></span>
      </button>
      <div class="options" data-focus-group>
        {#if !webtoon}
          <Pill text={t('reader_fit_page')} selected={fit === 'page'} onclick={() => ((fit = 'page'), (pan = { x: 0, y: 0 }))} />
          <Pill text={t('reader_fit_width')} selected={fit === 'width'} onclick={() => ((fit = 'width'), (pan = { x: 0, y: 0 }))} />
          <Pill text={t('reader_zoom')} selected={zoom > 1} onclick={() => ((zoom = zoom > 1 ? 1 : 2), (pan = { x: 0, y: 0 }), closeBar())} />
        {/if}
        <Pill text={t('reader_rtl')} selected={rtl} onclick={() => setPref({ rtl: !rtl })} />
        <Pill text={t('reader_webtoon')} selected={webtoon} onclick={() => setPref({ webtoon: !webtoon })} />
        <Pill text={t('reader_back')} onclick={() => nav.back()} />
      </div>
    </div>
  {/if}
</div>

<style>
  .reader {
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
  p {
    margin: 0;
  }
  .center {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }
  .message {
    display: flex;
    flex-direction: column;
    align-items: center;
    max-width: 720rem;
    text-align: center;
  }
  .message > :global(* + *) {
    margin-top: 20rem;
  }
  .pages {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  .page {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
  }
  .page img {
    max-width: 100vw;
    max-height: 100vh;
    object-fit: contain;
  }
  .page.pair img {
    max-width: 50vw;
  }
  .page.pair.left {
    justify-content: flex-end;
  }
  /* Fit width: the spread fills the width, Up / Down scroll it. */
  .pages.width {
    bottom: auto;
    min-height: 100%;
  }
  .pages.width .page {
    height: auto;
  }
  .pages.width .page img {
    width: 100vw;
    max-height: none;
  }
  .pages.width .page.pair img {
    width: 50vw;
  }
  .strip {
    position: absolute;
    top: 0;
    left: 50%;
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  .strip-page {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .strip-page img {
    width: 100%;
    height: 100%;
  }
  .bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 20rem 56rem 28rem;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.92), rgba(0, 0, 0, 0.7) 70%, transparent);
  }
  .bar-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .bar-head > :global(* + *) {
    margin-left: 24rem;
  }
  .slider {
    position: relative;
    display: block;
    width: 100%;
    height: 28rem;
    margin: 12rem 0 16rem;
  }
  .track {
    position: absolute;
    top: 50%;
    left: 0;
    right: 0;
    height: 4rem;
    margin-top: -2rem;
    overflow: hidden;
    border-radius: 2rem;
    background: rgba(255, 255, 255, 0.22);
  }
  .fill {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
  }
  .knob {
    position: absolute;
    top: 50%;
    width: 14rem;
    height: 14rem;
    margin: -7rem 0 0 -7rem;
    border-radius: 50%;
    background: #fff;
    transition: transform var(--t-fast) var(--ease-out);
  }
  .slider:global(.focused) .knob {
    transform: scale(1.5);
  }
  .slider:global(.focused) .track {
    background: rgba(255, 255, 255, 0.35);
  }
  .options {
    display: flex;
    flex-wrap: wrap;
  }
  .options > :global(*) {
    margin: 0 10rem 8rem 0;
  }
  /* The options on: filled and full white; the others dimmed. */
  .options > :global(.pill:not(.selected):not(.focused)) {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.7);
  }
  .options > :global(.pill.selected:not(.focused)) {
    background: rgba(255, 255, 255, 0.28);
    color: #fff;
  }
</style>
