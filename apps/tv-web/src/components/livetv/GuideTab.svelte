<script lang="ts">
  // Android TV GuideGrid (livetv/GuideGrid.kt, spec §6, TV-2): the focused programme's band on top, the time ruler,
  // then a row per channel: its number and logo in a 200 dp column, its programmes on a lane of 4.4 dp a minute with
  // the now line. The D-pad moves on the data model ($shared/livetv/nav navMove, the same moves as Android and the
  // desktop: focusT kept by vertical moves, gap fillers, 30 min scroll back); one element holds the focus and the grid
  // draws it. The lane and the rows slide with GPU transforms; only the rows around the view are mounted and their
  // 3 h slabs fetched. OK on what airs tunes; on anything else, or INFO, the programme's sheet (record, the series,
  // watch the channel). CH+/CH- page the rows, FF/RW two hours. Up from the first row leaves for the tabs.
  import type { ChannelRow, ProgramLite } from '$shared/livetv/model';
  import { dayStart, HOUR, leftForNow, MINUTE, TV_PAGE_MS } from '$shared/livetv/anchor';
  import { navMove, rowCells, type GuideFocus, type NavModel, type NavMove } from '$shared/livetv/nav';
  import { markFor } from '$shared/livetv/timers';
  import { focusable, focused } from '../../lib/focus';
  import { locale, t } from '../../lib/i18n.svelte';
  import { dp } from '../../lib/screen';
  import { DvrFailure, progressOf, timeText, type LiveTv, type Program } from '../../lib/livetv.svelte';
  import { closeAlert, showAlert } from '../../lib/overlay.svelte';
  import { showToast } from '../../lib/toast.svelte';
  import { keyOf } from '../../platform/keys';
  import ChannelLogo from './ChannelLogo.svelte';

  let { repo, now, height, tune }: { repo: LiveTv; now: number; height: number; tune: (id: string, list?: ChannelRow[]) => void } = $props();

  const DP_PER_MIN = 4.4;
  const CHANNEL = 200;
  const SIDE = 48;
  const BAND = 132;
  const RULER = 32;
  const ROW = 62;
  const RANGE_DAYS = 14;
  const k = DP_PER_MIN / MINUTE; // dp per ms

  let viewW = $state(960);
  const laneW = $derived(viewW - SIDE * 2 - CHANNEL);
  const laneMs = $derived(laneW / k);
  const visibleRows = $derived(Math.max(1, Math.floor((height - BAND - RULER - 8) / ROW)));

  const rows = $derived(repo.channels);
  const ids = $derived(rows.map((r) => r.id));
  // The canvas: today from midnight (local) to two weeks on.
  const base = $derived(dayStart(now));
  let left = $state(0);
  let rowFirst = $state(0);
  let f = $state<GuideFocus | null>(null);
  let held = $state(false);
  let grip = $state<HTMLButtonElement>();
  // The focus is virtual (lib/focus.ts): the grid's button never blurs, so the grid lets go when the focus lands
  // anywhere else.
  $effect(() => {
    const away = (e: Event) => {
      if (e.target !== grip) held = false;
    };
    document.addEventListener('tvfocus', away);
    return () => document.removeEventListener('tvfocus', away);
  });
  $effect.pre(() => {
    if (!left) left = leftForNow(Date.now(), laneMs);
  });

  const model = (): NavModel => ({
    rows: ids,
    programs: (id) => repo.programsOf(id),
    rangeStart: base,
    rangeEnd: base + RANGE_DAYS * 24 * HOUR,
    left,
    right: left + laneMs,
    now,
  });

  // --- Data: the mounted rows' slabs over the view and an hour around it ---
  const mountedFrom = $derived(Math.max(0, rowFirst - 2));
  const mounted = $derived(rows.slice(mountedFrom, rowFirst + visibleRows + 2));
  $effect(() => {
    const want = mounted.map((r) => r.id);
    if (want.length) void repo.ensure(want, left - HOUR, left + laneMs + HOUR);
  });

  // --- Focus ---
  function show(rowIndex: number | undefined): void {
    if (rowIndex === undefined) return;
    if (rowIndex < rowFirst) rowFirst = rowIndex;
    else if (rowIndex > rowFirst + visibleRows - 1) rowFirst = rowIndex - visibleRows + 1;
  }
  function apply(move: NavMove, pageRows = 1): boolean {
    if (!f) return false;
    const r = navMove(model(), f, move, pageRows);
    if (!r.focus) return false;
    f = r.focus;
    if (r.scrollLeft !== undefined) left = r.scrollLeft;
    show(r.rowIndex);
    return true;
  }
  // Entering the grid: the programme airing on the first visible row (else the channel).
  function onEnter(): void {
    held = true;
    if (f || !ids.length) return;
    f = { kind: 'channel', channelId: ids[Math.min(rowFirst, ids.length - 1)], focusT: now };
    apply('right');
  }
  // A row still loading becomes its programme once its slab lands.
  $effect(() => {
    void repo.rev;
    if (f?.kind === 'loading') {
      const at = f;
      f = { kind: 'channel', channelId: at.channelId, focusT: at.focusT };
      const r = navMove(model(), f, 'right');
      if (r.focus) f = { ...r.focus, focusT: at.focusT };
    }
  });
  function onmove(e: CustomEvent<'up' | 'down' | 'left' | 'right'>): void {
    if (!f) return;
    const r = navMove(model(), f, e.detail);
    // Up from the first row: the focus engine takes it to the tabs.
    if (!r.focus && r.exit === 'up') return;
    e.preventDefault();
    if (!r.focus) return;
    f = r.focus;
    if (r.scrollLeft !== undefined) left = r.scrollLeft;
    show(r.rowIndex);
  }
  function onKey(e: KeyboardEvent): void {
    if (!focused()?.classList.contains('guide-focus') || !f) return;
    const key = keyOf(e);
    const page = (fn: () => void) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      fn();
    };
    if (key === 'channelUp') return page(() => apply('page-up', visibleRows));
    if (key === 'channelDown') return page(() => apply('page-down', visibleRows));
    if (key === 'ff' || key === 'rw')
      return page(() => {
        left = Math.max(base, left + (key === 'ff' ? TV_PAGE_MS : -TV_PAGE_MS));
        f = f && { kind: 'channel', channelId: f.channelId, focusT: left + MINUTE };
        apply('right');
      });
    if (key === 'info') return page(() => void openSheet());
    if (key === 'red') return page(() => void quickRecord());
  }

  // --- Actions ---
  const focusedRow = $derived(f ? repo.channel(f.channelId) : undefined);
  const focusedProgram = $derived.by((): ProgramLite | null => {
    void repo.rev;
    if (!f || f.kind !== 'program') return null;
    return repo.programsOf(f.channelId)?.find((p) => p.id === f!.programId) ?? null;
  });
  function ok(): void {
    if (!f) return;
    const p = focusedProgram;
    // What airs or already aired (no catch-up) tunes the channel; what is to come opens its sheet.
    if (f.kind !== 'program' || (p && p.start <= now)) return tune(f.channelId, rows);
    if (p) void openSheet();
  }

  async function quickRecord(series = false): Promise<void> {
    const p = focusedProgram;
    if (!p || !repo.canRecord || p.end <= now) return;
    const timer = repo.overlay.get(p.id);
    try {
      if (timer && !series) {
        await repo.cancelTimer(timer.id);
        showToast(t('livetv_toasts_recording_canceled'));
      } else {
        await repo.record(p.id, series);
        showToast(series ? t('livetv_toasts_series_scheduled') : t('livetv_toasts_recording_scheduled'));
      }
    } catch (e) {
      const kind = e instanceof DvrFailure ? e.kind : 'server';
      showToast(
        kind === 'forbidden'
          ? t('livetv_toasts_forbidden')
          : kind === 'premiere'
            ? t('livetv_toasts_premiere')
            : kind === 'already-scheduled'
              ? t('livetv_toasts_already_scheduled')
              : kind === 'not-series'
                ? t('livetv_toasts_not_series')
                : t('player_live_record_failed'),
      );
    }
  }

  async function openSheet(): Promise<void> {
    const p = focusedProgram;
    const row = focusedRow;
    if (!p || !row) return;
    const airing = p.start <= now && p.end > now;
    const timer = repo.overlay.get(p.id);
    const actions: { label: string; destructive?: boolean; run: () => void }[] = [];
    if (airing) actions.push({ label: t('livetv_sheet_watch_channel'), run: () => tune(row.id, rows) });
    if (repo.canRecord && p.end > now) {
      if (timer) actions.push({ label: t('livetv_actions_cancel_recording'), destructive: true, run: () => void quickRecord() });
      else actions.push({ label: t('livetv_actions_record'), run: () => void quickRecord() });
      if (p.seriesId || p.flags & 512) actions.push({ label: t('livetv_record_whole_series'), run: () => void quickRecord(true) });
    }
    actions.push({ label: t('cancel'), run: closeAlert });
    showAlert({ title: p.title, message: `${row.name} · ${range(p)}${p.episodeTitle ? ` · ${p.episodeTitle}` : ''}`, actions, focusIndex: 0 });
  }

  // --- The band: the focused programme, its overview fetched once the focus rests ---
  let detail = $state<Program | null>(null);
  let detailTimer = 0;
  $effect(() => {
    const id = focusedProgram?.id;
    clearTimeout(detailTimer);
    if (!id) return void (detail = null);
    if (detail?.Id === id) return;
    detailTimer = window.setTimeout(() => {
      void repo.programItem(id).then((d) => {
        if (focusedProgram?.id === id) detail = d;
      }, () => {});
    }, 350);
  });

  // --- Drawing ---
  const lane = $derived(-(left - base) * k);
  const winFrom = $derived(left - HOUR);
  const winTo = $derived(left + laneMs + HOUR);
  const cellsOf = (id: string) => {
    void repo.rev;
    return rowCells(model(), id, winFrom, winTo);
  };
  const ticks = $derived.by(() => {
    const out: number[] = [];
    const step = 30 * MINUTE;
    for (let t0 = Math.ceil(winFrom / step) * step; t0 < winTo; t0 += step) out.push(t0);
    return out;
  });
  const nowX = $derived((now - base) * k);
  const range = (p: { start: number; end: number }) => `${timeText(p.start, locale.current)} – ${timeText(p.end, locale.current)}`;
  const isFocused = (c: { kind: string; programId?: string; start: number; channelId: string }) =>
    !!f && held && f.channelId === c.channelId && (c.kind === 'program' ? f.programId === c.programId : f.kind === 'filler' && f.start === c.start);
  const dayLabel = $derived(dayStart(left + laneMs * 0.34) === dayStart(now) ? t('livetv_guide_today') : new Date(left + laneMs * 0.34).toLocaleDateString(locale.current, { weekday: 'long', day: 'numeric', month: 'long' }));

  $effect(() => {
    const measure = () => (viewW = window.innerWidth / dp(1));
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('keydown', onKey, true);
    };
  });
</script>

<div class="guide" style="height:{height}rem">
  <div class="band" style="height:{BAND}rem">
    {#if focusedRow && held}
      <ChannelLogo {repo} row={focusedRow} height={44} />
      <div class="band-text">
        {#if focusedProgram}
          {@const mark = markFor(focusedProgram, repo.overlay)}
          <p class="t-title3 ellipsis">{focusedProgram.title}</p>
          <p class="t-footnote label-2 ellipsis">
            {range(focusedProgram)} · {focusedRow.name}{focusedProgram.episodeTitle ? ` · ${focusedProgram.episodeTitle}` : ''}
            {#if mark}<span class="rec"></span>{/if}
          </p>
          {#if detail?.Overview}<p class="t-footnote label-2 overview">{detail.Overview}</p>{/if}
          {#if focusedProgram.start <= now && focusedProgram.end > now}
            <span class="bar"><span style="transform:scaleX({progressOf(focusedProgram, now)})"></span></span>
          {/if}
        {:else if f?.kind === 'filler'}
          <p class="t-title3 ellipsis">{focusedRow.name}</p>
          <p class="t-footnote label-3">{t('livetv_guide_no_info')}</p>
        {:else}
          {@const [c, n] = repo.nowNext(focusedRow.id, now)}
          <p class="t-title3 ellipsis">{focusedRow.number} {focusedRow.name}</p>
          {#if c}<p class="t-footnote label-2 ellipsis">{c.title}</p>{/if}
          {#if n}<p class="t-footnote label-3 ellipsis">{timeText(n.start, locale.current)}  {n.title}</p>{/if}
        {/if}
      </div>
    {/if}
  </div>

  <div class="ruler" style="height:{RULER}rem">
    <span class="day t-footnote" style="width:{CHANNEL}rem">{dayLabel}</span>
    <div class="ruler-lane">
      <div class="slide" style="transform:translate3d({lane}rem,0,0)">
        {#each ticks as tk (tk)}
          <span class="tick t-footnote mono" style="left:{(tk - base) * k}rem">{timeText(tk, locale.current)}</span>
        {/each}
      </div>
    </div>
  </div>

  <button bind:this={grip} class="guide-focus" use:focusable aria-label={focusedProgram?.title ?? focusedRow?.name ?? ''} ontvfocus={onEnter} ontvmove={onmove} onclick={ok}></button>

  <div class="rows">
    <div class="rows-slide" style="transform:translate3d(0,{-rowFirst * ROW}rem,0)">
      {#each mounted as row, i (row.id)}
        {@const index = mountedFrom + i}
        <div class="row" style="top:{index * ROW}rem;height:{ROW}rem">
          <div class="channel" class:focused={held && f?.kind === 'channel' && f.channelId === row.id} style="width:{CHANNEL - 6}rem">
            <span class="mono num">{row.number}</span>
            <ChannelLogo {repo} {row} height={26} width={60} plate />
            <span class="t-footnote ellipsis cname">{row.name}</span>
          </div>
          <div class="lane">
            <div class="slide" style="transform:translate3d({lane}rem,0,0)">
              {#each cellsOf(row.id) ?? [] as c (c.programId ?? `f${c.start}`)}
                {@const p = c.programId ? repo.programsOf(row.id)?.find((x) => x.id === c.programId) : undefined}
                {@const x0 = (c.start - base) * k}
                {@const w = (c.end - c.start) * k}
                {@const inset = Math.max(0, (left - c.start) * k)}
                <div class="cell" class:filler={c.kind === 'filler'} class:airing={c.start <= now && c.end > now} class:focused={isFocused(c)} style="left:{x0}rem;width:{Math.max(0, w - 4)}rem">
                  <span class="cell-text" style="padding-left:{12 + Math.min(inset, Math.max(0, w - 80))}rem">
                    <span class="t-callout ellipsis">{p?.title ?? t('livetv_guide_no_info')}</span>
                    {#if p}<span class="t-caption ellipsis when">{timeText(p.start, locale.current)}{p.episodeTitle ? ` · ${p.episodeTitle}` : ''}</span>{/if}
                  </span>
                  {#if p && markFor(p, repo.overlay)}<span class="rec dot"></span>{/if}
                </div>
              {:else}
                <div class="cell loading" style="left:{(left - base) * k}rem;width:{laneW}rem"></div>
              {/each}
            </div>
          </div>
        </div>
      {/each}
      {#if nowX}
        <div class="now-line" style="left:{SIDE + CHANNEL}rem;top:{rowFirst * ROW}rem;height:{visibleRows * ROW + ROW}rem">
          <span style="transform:translate3d({lane + nowX}rem,0,0)"></span>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .guide {
    position: relative;
    overflow: hidden;
  }
  p {
    margin: 0;
  }
  .mono {
    font-family: 'Geist Mono', monospace;
  }
  .band {
    display: flex;
    align-items: flex-start;
    padding: 12rem 48rem 0;
  }
  .band-text {
    flex: 1;
    min-width: 0;
    margin-left: 18rem;
  }
  .band-text > p + p {
    margin-top: 3rem;
  }
  .overview {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    max-width: 640rem;
  }
  .bar {
    position: relative;
    display: block;
    width: 240rem;
    height: 4rem;
    margin-top: 8rem;
    border-radius: 2rem;
    overflow: hidden;
    background: var(--fill-2);
  }
  .bar > span {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
  }
  .rec {
    display: inline-block;
    width: 9rem;
    height: 9rem;
    margin-left: 8rem;
    border-radius: 50%;
    background: #ff453a;
    vertical-align: middle;
  }
  .ruler {
    display: flex;
    align-items: center;
    padding: 0 48rem;
  }
  .day {
    flex-shrink: 0;
    color: var(--label-2);
    text-transform: capitalize;
  }
  .ruler-lane,
  .lane {
    position: relative;
    flex: 1;
    height: 100%;
    overflow: hidden;
  }
  .slide {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  .tick {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    padding-left: 6rem;
    border-left: 1rem solid var(--separator);
    font-size: 13rem;
    color: var(--label-3);
    white-space: nowrap;
  }
  /* The grid's one focus target, over the rows: the focus engine reaches it from the tabs above. */
  .guide-focus {
    position: absolute;
    top: 164rem;
    left: 48rem;
    /* A button does not stretch between left and right. */
    width: calc(100% - 96rem);
    height: calc(100% - 164rem);
    opacity: 0;
  }
  .rows {
    position: relative;
    height: calc(100% - 164rem);
    margin-top: 0;
    overflow: hidden;
  }
  .rows-slide {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  .row {
    position: absolute;
    left: 48rem;
    right: 48rem;
    display: flex;
    padding: 3rem 0;
  }
  .channel {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    margin-right: 6rem;
    padding: 0 10rem;
    border-radius: var(--r-sm);
    background: var(--fill-1);
  }
  .channel > :global(* + *) {
    margin-left: 8rem;
  }
  .channel.focused {
    background: #fff;
    color: #000;
  }
  .num {
    width: 34rem;
    flex-shrink: 0;
    font-size: 14rem;
    color: var(--label-2);
  }
  .cname {
    min-width: 0;
    color: var(--label-2);
  }
  .channel.focused .num,
  .channel.focused .cname {
    color: rgba(0, 0, 0, 0.65);
  }
  .cell {
    position: absolute;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    overflow: hidden;
    border-radius: var(--r-sm);
    background: var(--fill-1);
    transition: background-color var(--t-fast), transform var(--t-fast) var(--ease-out);
  }
  .cell.airing {
    background: var(--fill-2);
  }
  .cell.filler {
    background: transparent;
    border: 1rem dashed var(--separator);
  }
  .cell.loading {
    background: var(--fill-1);
    opacity: 0.5;
  }
  .cell.focused {
    background: #fff;
    color: #000;
    z-index: 1;
  }
  .cell-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding-right: 10rem;
  }
  .when {
    color: var(--label-3);
  }
  .cell.focused .when {
    color: rgba(0, 0, 0, 0.6);
  }
  .rec.dot {
    position: absolute;
    top: 8rem;
    right: 8rem;
    margin: 0;
  }
  .now-line {
    position: absolute;
    right: 48rem;
    overflow: hidden;
    pointer-events: none;
  }
  .now-line span {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 2rem;
    background: var(--accent);
    transition: transform var(--t-med) var(--ease);
  }
</style>
