<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { applyLens, sameLens, stepLens } from '../../../shared/livetv/lens';
  import { nameKey } from '../../../shared/livetv/channel-order';
  import { resolveKey } from '../../../shared/livetv/keys';
  import type { ChannelRow, LensRef, ProgramLite } from '../../../shared/livetv/model';
  import { JUMP_TIMEOUT_MS } from '../../../shared/livetv/zap';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { imageUrl } from '../../lib/images';
  import { timersVersion } from '../../lib/livetv.svelte';
  import type { LiveTvStore } from '../../lib/livetv/store.svelte';
  import Icon from '../Icon.svelte';

  // Mini-guide over the video (livetv-spec-final.md §8.6): ↑/↓ move without tuning, PgUp/PgDn a page,
  // ←/→ the lenses, Enter tunes and keeps the list 1.5 s, digits jump, F favourite, R record, / filter,
  // Esc closes, 10 s idle closes. Fixed 64 px rows, ±5 mounted around the viewport.
  let {
    store,
    current,
    lens: startLens,
    clock,
    filterOnOpen = false,
    lensLabel,
    onTune,
    onRecord,
    onFavorite,
    onClose,
  }: {
    store: LiveTvStore;
    current: string;
    lens: LensRef;
    clock: number;
    filterOnOpen?: boolean;
    lensLabel: (l: LensRef) => string;
    onTune: (id: string, lens: LensRef, rows: ChannelRow[]) => void;
    onRecord: (programId: string) => void;
    onFavorite: (id: string) => void;
    onClose: () => void;
  } = $props();

  const ROW = 64;
  const OVERSCAN = 5;
  const IDLE_MS = 10_000;
  const TUNED_CLOSE_MS = 1_500;
  const HELD_MS = 1000 / 12; // held ↑/↓: 12 rows/s
  const DEBOUNCE_MS = 150;

  // svelte-ignore state_referenced_locally
  let lens = $state.raw<LensRef>(startLens);
  // svelte-ignore state_referenced_locally
  let filter = $state<string | null>(filterOnOpen ? '' : null);
  let focus = $state(0);
  let listH = $state(0);
  let input = $state<HTMLInputElement>();
  let paneId = $state('');
  let lastMove = 0;
  let jump = '';
  let jumpAt = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let paneTimer: ReturnType<typeof setTimeout> | null = null;

  const lensRows = $derived(applyLens({ rows: store.channels, lens, prefs: store.lensPrefs, sort: store.sort, favFirst: store.favFirst }));
  const rows = $derived.by(() => {
    if (!filter) return lensRows;
    const q = nameKey(filter);
    return lensRows.filter((r) => r.number.startsWith(filter!) || nameKey(r.name).includes(q));
  });
  const visible = $derived(Math.max(1, Math.ceil(listH / ROW)));
  const top = $derived(Math.max(0, Math.min(focus - Math.floor(visible / 2), rows.length - visible)));
  const mounted = $derived(rows.slice(Math.max(0, top - OVERSCAN), Math.min(rows.length, top + visible + OVERSCAN)).map((r, i) => ({ r, at: Math.max(0, top - OVERSCAN) + i })));
  const focused = $derived(rows[focus]);

  function place(id: string | undefined): void {
    const i = id ? rows.findIndex((r) => r.id === id) : -1;
    const c = rows.findIndex((r) => r.id === current);
    focus = i >= 0 ? i : c >= 0 ? c : 0;
  }

  // Opens centred on the current channel (once the lineup is there); a lens change finds the focused
  // channel again by id; typing a filter goes to the first match.
  let hadRows = false;
  $effect(() => {
    const has = rows.length > 0;
    if (has && !hadRows) untrack(() => place(undefined));
    hadRows = has;
  });
  $effect(() => {
    if (focus >= rows.length && rows.length) focus = rows.length - 1;
  });

  // Missing slabs for the mounted batch only; the right pane after a short debounce.
  $effect(() => {
    const ids = mounted.map((m) => m.r.id);
    const id = focused?.id ?? '';
    if (paneTimer) clearTimeout(paneTimer);
    paneTimer = setTimeout(() => {
      paneId = id;
      if (ids.length) void store.ensure(ids, store.now(), store.now() + 3 * 3_600_000, 0).catch(() => undefined);
    }, DEBOUNCE_MS);
  });

  const pane = $derived.by((): ProgramLite[] => (paneId ? store.programsIn(paneId, clock, clock + 12 * 3_600_000).slice(0, 4) : []));
  const paneRow = $derived(store.channels.find((r) => r.id === paneId));

  function nowOf(id: string): ProgramLite | null {
    return store.nowNext(id, clock)[0];
  }
  function recorded(p: ProgramLite | null): boolean {
    void timersVersion.value;
    return Boolean(p && (store.dvr.overlay ? store.dvr.overlay.get(p.id) : p.timerId));
  }

  function poke(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(onClose, IDLE_MS);
  }

  function move(delta: number, repeat = false): void {
    const at = performance.now();
    if (repeat && at - lastMove < HELD_MS) return;
    lastMove = at;
    if (rows.length) focus = Math.max(0, Math.min(rows.length - 1, focus + delta));
  }

  function tune(): void {
    const r = rows[focus];
    if (!r) return;
    onTune(r.id, lens, lensRows);
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(onClose, TUNED_CLOSE_MS);
  }

  function setLens(delta: 1 | -1): void {
    const next = stepLens(store.lenses, lens, delta);
    if (sameLens(next, lens)) return;
    const keep = focused?.id;
    lens = next;
    place(keep);
  }

  function digit(d: string): void {
    const at = performance.now();
    jump = at - jumpAt > JUMP_TIMEOUT_MS ? d : jump + d;
    jumpAt = at;
    const exact = rows.findIndex((r) => r.number === jump);
    const i = exact >= 0 ? exact : rows.findIndex((r) => r.number.startsWith(jump));
    if (i >= 0) focus = i;
  }

  async function openFilter(): Promise<void> {
    filter ??= '';
    await tick();
    input?.focus();
  }

  // The OSD asks first while the mini-guide is open (miniguide context of keys.ts). True when used.
  export function onKey(e: KeyboardEvent): boolean {
    poke();
    const r = resolveKey(e, 'miniguide');
    switch (r?.id) {
      case 'miniguide.up':
        move(-1, e.repeat);
        return true;
      case 'miniguide.down':
        move(1, e.repeat);
        return true;
      case 'miniguide.pageUp':
        move(-visible);
        return true;
      case 'miniguide.pageDown':
        move(visible);
        return true;
      case 'miniguide.prevLens':
        setLens(-1);
        return true;
      case 'miniguide.nextLens':
        setLens(1);
        return true;
      case 'miniguide.tune':
        if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') return false;
        tune();
        return true;
      case 'miniguide.digits':
        digit(e.code.slice(-1));
        return true;
      case 'miniguide.favorite':
        if (focused) onFavorite(focused.id);
        return true;
      case 'miniguide.record': {
        const p = focused ? nowOf(focused.id) : null;
        if (p) onRecord(p.id);
        return true;
      }
      case 'miniguide.filter':
        void openFilter();
        return true;
      case 'miniguide.close':
        if (filter !== null) filter = null;
        else onClose();
        return true;
    }
    return false;
  }

  // The filter field keeps its own typing; the OSD ignores keys aimed at an input.
  function onInputKey(e: KeyboardEvent): void {
    poke();
    const keys: Record<string, () => void> = {
      ArrowUp: () => move(-1, e.repeat),
      ArrowDown: () => move(1, e.repeat),
      PageUp: () => move(-visible),
      PageDown: () => move(visible),
      Enter: tune,
      Escape: () => {
        filter = null;
      },
    };
    const fn = keys[e.key];
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  }

  onMount(() => {
    poke();
    if (filterOnOpen) void openFilter();
  });
  onDestroy(() => {
    for (const tm of [idleTimer, closeTimer, paneTimer]) if (tm) clearTimeout(tm);
  });

  const progress = (p: ProgramLite | null): number => (p && p.end > p.start ? Math.min(1, Math.max(0, (clock - p.start) / (p.end - p.start))) : 0);
  const logo = (r: ChannelRow): string => (r.logoTag ? imageUrl(r.id, 'Primary', { tag: r.logoTag, maxHeight: 28, server: store.serverId }) : '');
</script>

<div class="mini" role="dialog" tabindex="-1" aria-label={t('player.live.channelList')} onmousemove={poke} onwheel={(e) => (poke(), move(e.deltaY > 0 ? 1 : -1))}>
  <div class="list">
    <header class="hd">
      <span class="lens-nav">
        <button class="ic" aria-label={t('livetv.keys.prevLens')} onclick={() => setLens(-1)}><Icon name="chevronLeft" size={16} /></button>
        <span class="headline">{lensLabel(lens)}</span>
        <button class="ic" aria-label={t('livetv.keys.nextLens')} onclick={() => setLens(1)}><Icon name="chevronRight" size={16} /></button>
      </span>
      <span class="mono clock">{fmt.time(clock)}</span>
    </header>
    {#if filter !== null}
      <input class="filter" bind:this={input} bind:value={filter} placeholder={t('player.live.filter')} aria-label={t('player.live.filter')} onkeydown={onInputKey} oninput={() => (focus = 0)} />
    {/if}
    <div class="rows" bind:clientHeight={listH} role="listbox" aria-label={lensLabel(lens)}>
      {#each mounted as { r, at } (r.id)}
        {@const p = nowOf(r.id)}
        <div
          class="row"
          class:focus={at === focus}
          class:current={r.id === current}
          style:transform="translate3d(0, {(at - top) * ROW}px, 0)"
          role="option"
          aria-selected={at === focus}
          tabindex="-1"
          onclick={() => ((focus = at), tune())}
          onkeydown={() => undefined}
        >
          <span class="num mono">{r.number}</span>
          <span class="logo">{#if logo(r)}<img src={logo(r)} alt="" decoding="async" loading="lazy" />{/if}</span>
          <span class="txt">
            <span class="nm">{r.name}</span>
            <span class="pg">{p?.title ?? ''}</span>
          </span>
          <span class="meta">
            {#if p}
              <span class="bar" aria-hidden="true"><span style:transform="scaleX({progress(p)})"></span></span>
              <span class="end mono">{fmt.time(p.end)}</span>
            {/if}
            {#if recorded(p)}<span class="rec" aria-label={t('player.live.recording')}></span>{/if}
            {#if r.favorite}<Icon name="star" size={13} />{/if}
          </span>
        </div>
      {/each}
      {#if !rows.length}<div class="empty">{t('player.live.noMatch')}</div>{/if}
    </div>
  </div>
  <div class="sr" role="status" aria-live="polite">{focused ? t('player.live.bannerAria', { number: focused.number, channel: focused.name, program: nowOf(focused.id)?.title ?? '' }) : ''}</div>
  <aside class="pane">
    {#if paneRow}
      <div class="headline">{paneRow.name} · <span class="mono">{paneRow.number}</span></div>
      {#each pane as p (p.id)}
        <div class="pp"><span class="mono">{fmt.time(p.start)}</span><span>{p.title}</span></div>
      {:else}
        <div class="pp dim">{t('livetv.guide.noInfo')}</div>
      {/each}
    {/if}
  </aside>
</div>

<style>
  .mini {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 5;
    display: flex;
    width: 60%;
    min-width: 640px;
    pointer-events: none;
    animation: mini-in var(--t-med) var(--ease-out) both;
  }
  @keyframes mini-in {
    from {
      opacity: 0;
      transform: translate3d(-24px, 0, 0);
    }
  }
  .list,
  .pane {
    pointer-events: auto;
    background: var(--material-thick);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    color: var(--label);
  }
  .list {
    display: flex;
    flex-direction: column;
    width: 57%;
    min-width: 420px;
    box-shadow: inset -0.5px 0 0 var(--hairline);
  }
  .pane {
    flex: 1;
    padding: 72px 20px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: rgb(0 0 0 / 0.55);
  }
  .hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 64px 16px 10px;
  }
  .lens-nav {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ic {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    color: var(--label-2);
  }
  .ic:hover {
    background: var(--fill-2);
    color: var(--label);
  }
  .clock {
    color: var(--label-2);
  }
  .filter {
    margin: 0 16px 10px;
    height: 32px;
    padding: 0 12px;
    border-radius: 999px;
    background: var(--fill-2);
    color: var(--label);
    border: none;
    outline: none;
  }
  .rows {
    position: relative;
    flex: 1;
    overflow: hidden;
  }
  .row {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 64px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 16px;
    cursor: pointer;
    outline: none;
  }
  .row.current::before {
    content: '';
    position: absolute;
    left: 0;
    top: 10px;
    bottom: 10px;
    width: 3px;
    border-radius: 2px;
    background: var(--label);
  }
  .row:hover {
    background: var(--fill-3);
  }
  /* Inverted focus, no ring (§11). */
  .row.focus {
    background: var(--label);
    color: var(--bg);
  }
  .row.focus .pg,
  .row.focus .num,
  .row.focus .end {
    color: var(--bg);
    opacity: 0.7;
  }
  .row.focus .bar span {
    background: var(--bg);
  }
  .row.focus.current::before {
    background: var(--bg);
  }
  .num {
    width: 44px;
    flex: none;
    text-align: right;
    color: var(--label-2);
    font-variant-numeric: tabular-nums;
  }
  .logo {
    display: grid;
    place-items: center;
    width: 48px;
    height: 28px;
    flex: none;
  }
  .logo img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .txt {
    display: grid;
    min-width: 0;
    flex: 1;
  }
  .nm {
    font-weight: 600;
    font-size: var(--fs-headline);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pg {
    color: var(--label-2);
    font-size: var(--fs-callout);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
  }
  .bar {
    position: relative;
    width: 56px;
    height: 3px;
    border-radius: 2px;
    background: var(--fill-3);
    overflow: hidden;
  }
  .bar span {
    position: absolute;
    inset: 0;
    background: var(--label);
    opacity: 0.6;
    transform-origin: left;
  }
  .end {
    font-size: var(--fs-caption);
    color: var(--label-2);
  }
  .rec {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--red);
  }
  .empty,
  .dim {
    padding: 16px;
    color: var(--label-3);
  }
  .pp {
    display: flex;
    gap: 12px;
    font-size: var(--fs-callout);
  }
  .pp .mono {
    color: var(--label-2);
    flex: none;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (forced-colors: active) {
    .row.focus {
      outline: 3px solid Highlight;
      outline-offset: -3px;
    }
  }
</style>
