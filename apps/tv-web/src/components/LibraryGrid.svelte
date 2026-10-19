<script lang="ts">
  // Android TV LibraryGrid (Main.kt): a library tab or a pushed folder, sorted by name, 7 columns of posters under
  // the title and the count, with the A–Z rail on the left (AlphaRail.svelte) once the library has more than 28
  // titles.
  //
  // Built for libraries of thousands of titles on 2018 TVs:
  // - Sparse paging: the list is the library's full length once the first page is in, empty slots where a page is not
  //   loaded yet, so an A–Z jump lands far ahead without loading what lies before it. Pages of 120 are fetched for
  //   the rows on screen and 28 titles ahead.
  // - Virtualized: only the rows near the viewport exist in the DOM, positioned by transforms on a fixed pitch;
  //   the page scrolls with one GPU transform, by EdgeSpec (110 dp from the edges, as on Android).
  // - The items array is a plain array behind a revision counter: thousands of entries are never made reactive.
  import type { BaseItem, ItemsResult } from '$shared/models';
  import { getContext, onMount, tick, type Snippet } from 'svelte';
  import type { Api } from '../lib/api';
  import { focused, setFocus } from '../lib/focus';
  import { plural, t } from '../lib/i18n.svelte';
  import * as LetterIndex from '../lib/letter-index';
  import { itemRoute, nav, onBack, SCREEN } from '../lib/nav.svelte';
  import { dp } from '../lib/screen';
  import { clamp, edgeDelta } from '../lib/scroll';
  import AlphaRail from './AlphaRail.svelte';
  import Card from './Card.svelte';
  import Pill from './Pill.svelte';
  import Spinner from './Spinner.svelte';

  let {
    api,
    parentId,
    title,
    collectionType,
    top,
    defaultFocus = false,
    mode = 'albums',
    actions,
    onopen,
    onscrolled,
  }: {
    api: Api;
    parentId: string;
    title: string;
    collectionType?: string;
    top: number;
    defaultFocus?: boolean;
    // A music library: the grid it shows (Android MUSIC_ALBUMS, MUSIC_ARTISTS, MUSIC_SONGS).
    mode?: 'albums' | 'artists' | 'songs';
    // The header's pills, right of the title (music modes, Play, Shuffle); given the title count.
    actions?: Snippet<[number]>;
    // A card's OK, when the caller plays it (a track); false: the default (its page).
    onopen?: (item: BaseItem, index: number) => boolean;
    onscrolled?: (scrolled: boolean) => void;
  } = $props();

  const PAGE = 120;
  const COLS = 7;
  // Fewer titles than this: no A–Z rail (a screen or two of posters).
  const RAIL_MIN = 28;
  // Layout in dp (Main.kt: start/end padding 48, 20 between columns, 24 between rows, bottom 56).
  const SIDE = 48;
  const HGAP = 20;
  const VGAP = 24;
  const BOTTOM = 56;
  const HEADER = 61; // largeTitle line (40) + count footnote (17) + 4
  const TITLE = 29; // the card's title: 12 above + a 17 dp footnote line
  // Rows mounted beyond the viewport, above and below.
  const BUFFER = 2;

  // svelte-ignore state_referenced_locally
  const ct = collectionType;
  // svelte-ignore state_referenced_locally
  const artists = ct === 'music' && mode === 'artists';
  // Music cards are square (album and artist art).
  const ratio = ct === 'music' ? 1 : 1.5;
  // svelte-ignore state_referenced_locally
  const types =
    ct === 'movies' ? 'Movie' : ct === 'tvshows' ? 'Series' : ct === 'boxsets' ? 'BoxSet' : ct === 'music' ? (mode === 'songs' ? 'Audio' : 'MusicAlbum') : undefined;
  // Sorted by name, hence the A–Z rail (not Live TV's channel list).
  const byName = ct !== 'livetv';
  // svelte-ignore state_referenced_locally
  const filters = { ParentId: parentId, IncludeItemTypes: types, Recursive: types !== undefined };

  // --- Data: sparse pages ---
  let items: (BaseItem | null)[] = [];
  let rev = $state(0);
  let total = $state(-1);
  let failed = $state(false);
  let letters = $state<number[] | null>(null);
  const inFlight = new Set<number>();

  function page(start: number): Promise<ItemsResult> {
    if (ct === 'livetv') return api.liveChannelsPage(start, PAGE);
    if (artists) return api.albumArtists({ ParentId: parentId, SortBy: 'SortName', SortOrder: 'Ascending', StartIndex: start, Limit: PAGE });
    return api.items({ ...filters, SortBy: 'SortName', SortOrder: 'Ascending', StartIndex: start, Limit: PAGE, ...(mode === 'songs' ? { Fields: api.trackFields } : {}) });
  }

  // Page [n] into its slots; a new total (titles added or removed on the server) starts the list over.
  async function load(n: number): Promise<void> {
    if (inFlight.has(n)) return;
    inFlight.add(n);
    try {
      const r = await page(n * PAGE);
      if (r.TotalRecordCount !== total || items.length !== r.TotalRecordCount) {
        items = new Array(r.TotalRecordCount).fill(null);
        total = r.TotalRecordCount;
        letters = null;
      }
      r.Items.forEach((it, k) => {
        if (n * PAGE + k < items.length) items[n * PAGE + k] = it;
      });
      failed = false;
      rev++;
    } catch {
      failed = total < 0;
    } finally {
      inFlight.delete(n);
    }
  }
  const loaded = (n: number): boolean => items[n * PAGE] != null;

  // The rail's letter offsets, once the library is big enough.
  $effect(() => {
    if (!byName || total <= RAIL_MIN || letters) return;
    LetterIndex.load(async (b) =>
      artists ? (await api.albumArtists({ ParentId: parentId, ...LetterIndex.countOnly(b) })).TotalRecordCount : (await api.items({ ...filters, ...LetterIndex.countOnly(b) })).TotalRecordCount,
    )
      .then((l) => (letters = l))
      .catch(() => {});
  });
  const rail = $derived(byName && letters !== null && letters.filter((o) => o >= 0).length > 1);

  // --- Geometry (dp) ---
  let viewW = $state(960);
  let viewH = $state(540);
  function measure(): void {
    viewW = window.innerWidth / dp(1);
    viewH = window.innerHeight / dp(1);
  }
  const cardW = $derived((viewW - SIDE * 2 - HGAP * (COLS - 1)) / COLS);
  const artH = $derived(cardW * ratio);
  const pitch = $derived(artH + TITLE + VGAP);
  const firstTop = $derived(top + HEADER + VGAP);
  const rows = $derived(total > 0 ? Math.ceil(total / COLS) : 0);
  const height = $derived(firstTop + rows * pitch - VGAP + BOTTOM);

  // --- Scroll and the mounted window ---
  let y = $state(0);
  let jump = $state(false); // A–Z: move at once, no slide
  const maxY = $derived(Math.max(0, height - viewH));
  const firstRow = $derived(Math.max(0, Math.floor((y - firstTop) / pitch) - BUFFER));
  const lastRow = $derived(Math.min(rows - 1, Math.ceil((y + viewH - firstTop) / pitch) + BUFFER));
  const mounted = $derived.by(() => {
    void rev;
    const out: { row: number; slots: { index: number; item: BaseItem | null }[] }[] = [];
    for (let r = firstRow; r <= lastRow; r++) {
      const slots = [];
      for (let c = 0; c < COLS; c++) {
        const index = r * COLS + c;
        if (index < total) slots.push({ index, item: items[index] });
      }
      out.push({ row: r, slots });
    }
    return out;
  });

  // The pages on screen, and 28 titles ahead.
  $effect(() => {
    if (total <= 0) return;
    const a = Math.max(0, firstRow * COLS - 1);
    const b = Math.min(total - 1, (lastRow + 1) * COLS + 28);
    for (let n = Math.floor(a / PAGE); n <= Math.floor(b / PAGE); n++) if (!loaded(n)) void load(n);
  });

  $effect(() => {
    onscrolled?.(y > 30);
  });

  function rowTop(row: number): number {
    return firstTop + row * pitch;
  }

  // --- Focus ---
  let current = 0; // the grid item last focused (where the rail opens, where Back from it returns)
  let target = $state(-1); // an item to focus once its page is in (A–Z pick, Back from the rail)
  let railRef: AlphaRail | undefined = $state();
  let grid: HTMLDivElement;

  function indexOf(el: HTMLElement): number {
    return Number(el.closest('[data-index]')?.getAttribute('data-index') ?? -1);
  }

  function onfocus(e: CustomEvent): void {
    const el = e.target as HTMLElement;
    const i = indexOf(el);
    if (i < 0) return;
    current = i;
    jump = false;
    const offset = rowTop(Math.floor(i / COLS)) - y;
    y = clamp(y + edgeDelta(offset, artH, viewH, 110), 0, maxY);
  }

  function onmove(e: CustomEvent<'up' | 'down' | 'left' | 'right'>): void {
    const i = indexOf(e.target as HTMLElement);
    if (i < 0) return;
    const col = i % COLS;
    // Left from the first column: the rail, on the current title's letter (not the nearest one); else a dead end.
    if (e.detail === 'left' && col === 0) {
      e.preventDefault();
      if (rail && letters) railRef?.enter(LetterIndex.railLetter(letters, LetterIndex.entry(letters, i, items[i]?.Name)));
    } else if (e.detail === 'right' && (col === COLS - 1 || i === total - 1)) e.preventDefault();
  }

  // Scroll the row of [index] to the top, under the tab bar (scrollToItem).
  function showRow(index: number): void {
    jump = true;
    y = clamp(rowTop(Math.floor(index / COLS)) - top, 0, maxY);
  }

  // The rail browsed a letter: scroll there after a short pause (holding Up/Down skims letters).
  let browseTimer = 0;
  function browse(i: number): void {
    clearTimeout(browseTimer);
    const at = letters?.[i] ?? -1;
    if (at < 0) return;
    browseTimer = window.setTimeout(() => {
      showRow(at);
      if (!loaded(Math.floor(at / PAGE))) void load(Math.floor(at / PAGE));
    }, 120);
  }

  function pick(i: number): void {
    const at = letters?.[i] ?? -1;
    if (at >= 0) target = at;
  }

  // Focus [target] once its page is in and its row is mounted.
  $effect(() => {
    void rev;
    if (target < 0) return;
    const page_ = Math.floor(target / PAGE);
    if (!loaded(page_)) {
      void load(page_);
      return;
    }
    showRow(target);
    const want = target;
    void tick().then(() =>
      requestAnimationFrame(() => {
        const el = grid?.querySelector<HTMLElement>(`[data-index="${want}"] [data-focusable]`);
        if (el) {
          setFocus(el);
          target = -1;
        }
      }),
    );
  });

  // A pushed folder focuses its first title once loaded (Android defaultFocus); a tab waits for the user.
  let first = true;
  $effect(() => {
    if (!defaultFocus || !first || total <= 0) return;
    first = false;
    target = 0;
  });

  function open(item: BaseItem, index: number): void {
    if (onopen?.(item, index)) return;
    nav.push(itemRoute(item));
  }

  const screen = getContext<number>(SCREEN);
  onMount(() => {
    measure();
    window.addEventListener('resize', measure);
    void load(0);
    // Back from the rail: back to the title last focused in the grid.
    const stop = onBack(screen, () => {
      if (!railRef?.holdsFocus() || !grid?.isConnected || grid.offsetParent === null) return false;
      target = current;
      return true;
    });
    return () => {
      window.removeEventListener('resize', measure);
      clearTimeout(browseTimer);
      stop();
    };
  });

  const hasFocus = (): boolean => !!focused()?.closest('.grid-page');
</script>

<div class="grid-page" bind:this={grid}>
  {#if failed}
    <div class="center">
      <p class="t-title3 label-2">{t('load_error')}</p>
      <Pill text={t('retry')} icon="Refresh" autofocus={!hasFocus()} onclick={() => load(0)} />
    </div>
  {:else if total < 0}
    <div class="center"><Spinner size={40} /></div>
  {/if}
  <div class="content" class:jump style="height:{height}rem;transform:translate3d(0,{-y}rem,0)" data-focus-group ontvfocus={onfocus} ontvmove={onmove}>
    <header style="top:{top}rem">
      <div class="titles">
        <h1 class="t-large-title ellipsis">{title}</h1>
        {#if total >= 0}<p class="t-footnote label-3">{plural('items_count', total, total)}</p>{/if}
      </div>
      {#if actions}<div class="actions">{@render actions(Math.max(0, total))}</div>{/if}
    </header>
    {#each mounted as r (r.row)}
      <div class="row" style="transform:translate3d(0,{rowTop(r.row)}rem,0)">
        {#each r.slots as s (s.index)}
          <div class="slot" data-index={s.index} style="width:{cardW}rem">
            {#if s.item}
              <Card item={s.item} {api} variant={ratio === 1 ? 'square' : 'poster'} width={cardW} onclick={() => open(s.item!, s.index)} />
            {:else}
              <div class="placeholder" style="height:{artH}rem"></div>
            {/if}
          </div>
        {/each}
      </div>
    {/each}
  </div>
  {#if rail && letters}
    <AlphaRail bind:this={railRef} offsets={letters} onbrowse={browse} onpick={pick} />
  {/if}
</div>

<style>
  .grid-page {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
  }
  .content {
    position: relative;
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  .content.jump {
    transition: none;
  }
  header {
    position: absolute;
    left: 48rem;
    right: 48rem;
    display: flex;
    align-items: center;
  }
  .titles {
    flex: 1;
    min-width: 0;
  }
  .actions {
    display: flex;
    margin-right: 16rem;
  }
  .actions > :global(* + *) {
    margin-left: 10rem;
  }
  h1,
  p {
    margin: 0;
  }
  .row {
    position: absolute;
    top: 0;
    left: 48rem;
    right: 48rem;
    display: flex;
  }
  .slot {
    margin-right: 20rem;
  }
  .slot:last-child {
    margin-right: 0;
  }
  .placeholder {
    border-radius: var(--r-md);
    background: var(--fill-2);
  }
  .center {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .center p {
    margin-bottom: 16rem;
  }
</style>
