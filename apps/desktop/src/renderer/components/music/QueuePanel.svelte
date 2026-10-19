<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { TICKS_PER_MS } from '../../../shared/contract';
  import { formatDuration } from '../../../shared/music';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { saveQueueAsPlaylist } from '../../lib/music';
  import { carriesTracks, command, droppedTracks, ensureItems, known, musicUi } from '../../lib/music-ui.svelte';
  import { queueIds } from '../../lib/queue.svelte';
  import { w } from '../../lib/bridge';
  import { errorMessage, playback, toast } from '../../lib/stores.svelte';
  import Icon from '../Icon.svelte';
  import MusicArt from './MusicArt.svelte';

  // The queue (music-spec §4.3): the current track, then what follows. Drag a row by its grip (pointer events),
  // Alt+↑/↓ moves the focused row, Delete removes it, a double click (or Enter) plays it. It follows the current
  // track unless the user scrolled it in the last 5 s. embedded: inside the full-screen player.
  let { embedded = false }: { embedded?: boolean } = $props();

  const ROW = 52;
  const s = $derived(playback.value);
  // The same array while the queue is unchanged: main publishes a fresh state on every position tick (4 a second),
  // and a new array would re-run every derived value and row below it.
  let lastIds: string[] = [];
  const published = $derived.by(() => {
    const next = s?.music?.queue.ids ?? [];
    if (next.length === lastIds.length && next.every((id, i) => id === lastIds[i])) return lastIds;
    return (lastIds = next);
  });
  // A dropped row is drawn in its new slot until main publishes the new order (or 1.5 s), not back at its origin.
  let moved = $state<string[] | null>(null);
  let movedTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    void published;
    untrack(() => (moved = null));
  });
  const ids = $derived(moved ?? published);
  const index = $derived(s?.music?.queue.index ?? 0);
  const serverId = $derived(s?.item?.serverId);
  // Keys: an id may be queued twice.
  const keys = $derived.by(() => {
    const seen = new Map<string, number>();
    return ids.map((id) => {
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      return `${id}:${n}`;
    });
  });
  const upcoming = $derived(ids.slice(index + 1).map((_, k) => index + 1 + k));
  const upcomingMs = $derived(upcoming.reduce((sum, i) => sum + (known[ids[i]]?.RunTimeTicks ?? 0) / TICKS_PER_MS, 0));

  $effect(() => {
    void ensureItems(ids, serverId);
  });

  let list = $state<HTMLDivElement>();
  let scroller = $state<HTMLDivElement>();
  let userScrolledAt = 0;
  // Follow the current track.
  $effect(() => {
    void index;
    if (!scroller || Date.now() - userScrolledAt < 5000) return;
    scroller.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  });

  // ---- Drag to reorder (upcoming rows only, as the current one plays) ----
  let drag = $state<{ from: number; startY: number; dy: number } | null>(null);
  const dropAt = $derived(drag ? Math.max(index + 1, Math.min(ids.length - 1, drag.from + Math.round(drag.dy / ROW))) : -1);

  function startDrag(e: PointerEvent, from: number): void {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { from, startY: e.clientY, dy: 0 };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // A synthetic pointer (tests) cannot be captured: the window listeners below still follow it.
    }
    const move = (ev: PointerEvent) => drag && (drag.dy = ev.clientY - drag.startY);
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    const up = () => {
      stop();
      const d = drag;
      const to = dropAt;
      drag = null;
      if (d && to !== d.from) {
        const next = [...ids];
        next.splice(to, 0, ...next.splice(d.from, 1));
        moved = next;
        if (movedTimer) clearTimeout(movedTimer);
        movedTimer = setTimeout(() => (moved = null), 1500);
        command({ type: 'queue-move', from: d.from, to });
      }
    };
    // A drag the system cancelled (an OS gesture, a pen out of range) moves nothing.
    const cancel = () => {
      stop();
      drag = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }

  async function focusRow(i: number): Promise<void> {
    await tick();
    list?.querySelector<HTMLElement>(`[data-index="${i}"] .main`)?.focus({ preventScroll: false });
  }

  function onRowKey(e: KeyboardEvent, i: number): void {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      e.stopPropagation();
      const to = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (i <= index || to <= index || to >= ids.length) return;
      command({ type: 'queue-move', from: i, to });
      // The row follows once main publishes the new order.
      void waitFor(() => ids[to] === ids[i] || ids.length === 0).then(() => focusRow(to));
    } else if (e.key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      remove(i);
    }
  }
  // Focus the row that takes its place once main has removed it: focusing earlier lands on the row being removed.
  function remove(i: number): void {
    const n = ids.length;
    command({ type: 'queue-remove', index: i });
    void waitFor(() => ids.length < n).then(() => focusRow(Math.min(i, ids.length - 1)));
  }
  const waitFor = (ok: () => boolean) =>
    new Promise<void>((resolve) => {
      const end = Date.now() + 1500;
      const poll = () => (ok() || Date.now() > end ? resolve() : setTimeout(poll, 50));
      setTimeout(poll, 50);
    });

  // ---- Save as playlist ----
  let naming = $state(false);
  let name = $state('');
  async function save(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    try {
      // A plain copy: the state's proxy cannot cross IPC.
      await saveQueueAsPlaylist(n, [...ids], serverId);
      toast('success', t('music.toast.savedPlaylist', { name: n }));
      naming = false;
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }
  // Tracks dragged from a list (music spec C3) land where they are dropped among the upcoming rows: before the row
  // under the pointer (after it in its lower half), at the end off the rows.
  let over = $state(false);
  let overAt = $state(-1);
  function dropIndex(e: DragEvent): number {
    const r = (e.target as Element | null)?.closest<HTMLElement>('.row[data-index]');
    if (!r) return ids.length;
    const b = r.getBoundingClientRect();
    return Math.max(index + 1, Number(r.dataset.index) + (e.clientY > b.top + b.height / 2 ? 1 : 0));
  }
  async function drop(e: DragEvent): Promise<void> {
    over = false;
    overAt = -1;
    const d = droppedTracks(e);
    if (!d) return;
    e.preventDefault();
    const at = dropIndex(e);
    const end = ids.length;
    if (!(await queueIds(d.ids, d.serverId, 'last', t('music.selection.count', { count: d.ids.length }))) || !end || at >= end) return;
    // shortcut: appended then moved one by one (main has no insert-at queue op); add one to MusicQueue if drops grow big.
    try {
      for (let k = 0; k < d.ids.length; k++) await w.playback.command({ type: 'queue-move', from: end + k, to: at + k });
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  function startNaming(): void {
    name = t('music.queue.defaultName', { date: fmt.date(new Date(), { dateStyle: 'medium' }) });
    naming = true;
  }
</script>

{#snippet row(i: number)}
  {@const it = known[ids[i]]}
  <div
    class="row"
    class:current={i === index}
    class:dragging={drag?.from === i}
    class:drop-before={(dropAt === i && drag && drag.from > i) || overAt === i}
    class:drop-after={dropAt === i && drag && drag.from < i}
    style:transform={drag?.from === i ? `translateY(${drag.dy}px)` : undefined}
    data-index={i}
    data-id={ids[i]}
    role="listitem"
  >
    {#if i > index}
      <span class="grip" role="presentation" onpointerdown={(e) => startDrag(e, i)}><Icon name="grip" size={14} /></span>
    {:else}
      <span class="grip now" aria-hidden="true"><Icon name="equalizer" size={14} stroke={2.2} /></span>
    {/if}
    <button
      class="main"
      title={i > index ? t('music.queue.reorderHint') : undefined}
      ondblclick={() => i !== index && command({ type: 'queue-jump', index: i })}
      onclick={(e) => e.detail === 0 && i !== index && command({ type: 'queue-jump', index: i })}
      onkeydown={(e) => onRowKey(e, i)}
    >
      <span class="art">{#if it}<MusicArt item={it} size={40} />{/if}</span>
      <span class="txt"><span class="t">{it?.Name ?? ''}</span><span class="a">{(it?.Artists ?? []).join(', ')}</span></span>
      <span class="rt mono">{it?.RunTimeTicks ? formatDuration(it.RunTimeTicks / TICKS_PER_MS) : ''}</span>
    </button>
    {#if i !== index}
      <button class="x" title={t('music.queue.remove')} aria-label={t('music.queue.removeNamed', { name: it?.Name ?? '' })} onclick={() => remove(i)}><Icon name="close" size={14} /></button>
    {/if}
  </div>
{/snippet}

<aside
  class="queue"
  class:panel={!embedded}
  class:material={!embedded}
  class:over
  aria-label={t('music.bar.queue')}
  data-queue-panel
  title={over ? t('music.drop.queue') : undefined}
  ondragover={(e) => carriesTracks(e) && (e.preventDefault(), (over = true), (overAt = dropIndex(e)))}
  ondragleave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && ((over = false), (overAt = -1))}
  ondrop={drop}
>
  {#if !embedded}
    <header class="top">
      <h2 class="title-3">{t('music.bar.queue')}</h2>
      <button class="btn ghost icon" title={t('common.actions.close')} aria-label={t('common.actions.close')} onclick={() => (musicUi.queue = false)}><Icon name="close" size={16} /></button>
    </header>
  {/if}
  <div class="scroll" bind:this={scroller} onwheel={() => (userScrolledAt = Date.now())}>
    {#if ids.length === 0}
      <p class="empty footnote">{t('music.queue.empty')}</p>
    {:else}
      <div class="list" role="list" bind:this={list}>
        <h3 class="sec caption">{t('music.queue.nowPlaying')}</h3>
        {@render row(index)}
        {#if upcoming.length}
          <h3 class="sec caption">
            {t('music.queue.upNext')}
            <span class="sum" data-upcoming={upcoming.length}>{t('music.queue.upNextSummary', { count: upcoming.length, duration: formatDuration(upcomingMs) })}</span>
          </h3>
          {#each upcoming as i (keys[i])}{@render row(i)}{/each}
        {/if}
        {#if s?.music?.radio}<p class="note caption">{t('music.queue.radioNote')}</p>{/if}
      </div>
    {/if}
  </div>
  <footer class="bottom">
    {#if naming}
      <form class="name" onsubmit={save}>
        <input class="field" bind:value={name} maxlength="120" aria-label={t('music.queue.playlistName')} />
        <button class="btn primary" type="submit" data-save-playlist disabled={!name.trim()}>{t('music.queue.save')}</button>
        <button class="btn ghost icon" type="button" aria-label={t('common.actions.cancel')} onclick={() => (naming = false)}><Icon name="close" size={14} /></button>
      </form>
    {:else}
      <button class="btn" data-clear-upcoming disabled={!upcoming.length} onclick={() => command({ type: 'queue-clear-upcoming' })}>{t('music.queue.clearUpcoming')}</button>
      <button class="btn" data-save-queue disabled={!ids.length} onclick={startNaming}>{t('music.queue.saveAsPlaylist')}</button>
      <button class="btn icon" data-radio class:on={s?.music?.radio} aria-pressed={Boolean(s?.music?.radio)} title={t(s?.music?.radio ? 'music.radio.on' : 'music.radio.off')} aria-label={t('music.radio.start')} onclick={() => command({ type: 'radio', value: !s?.music?.radio })}>
        <Icon name="live" size={16} />
      </button>
    {/if}
  </footer>
</aside>

<style>
  .queue {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }
  .panel {
    position: absolute;
    top: var(--titlebar, 0px);
    right: 0;
    bottom: 72px;
    z-index: 30;
    width: 360px;
    border-left: 1px solid var(--separator);
    box-shadow: var(--shadow-2);
    animation: slide var(--t-med) var(--ease) both;
  }
  @keyframes slide {
    from {
      transform: translateX(24px);
      opacity: 0;
    }
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 12px 6px 18px;
  }
  .top h2 {
    margin: 0;
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 8px;
  }
  .sec {
    display: flex;
    justify-content: space-between;
    margin: 12px 10px 6px;
    color: var(--label-3);
    font-weight: 600;
  }
  .sum {
    font-weight: 400;
  }
  .row {
    position: relative;
    display: grid;
    grid-template-columns: 22px 1fr auto;
    align-items: center;
    height: 52px;
    border-radius: var(--r-sm);
  }
  .row:hover,
  .row:focus-within {
    background: var(--fill-2);
  }
  .row.current .t {
    color: var(--accent);
  }
  .row.dragging {
    z-index: 2;
    background: var(--fill-3);
    box-shadow: var(--shadow-2);
  }
  .row.drop-before::before,
  .row.drop-after::after {
    content: '';
    position: absolute;
    left: 8px;
    right: 8px;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
  }
  .row.drop-before::before {
    top: -1px;
  }
  .row.drop-after::after {
    bottom: -1px;
  }
  .grip {
    display: grid;
    place-items: center;
    height: 100%;
    color: var(--label-3);
    cursor: grab;
    touch-action: none;
  }
  .grip.now {
    cursor: default;
    color: var(--accent);
  }
  .main {
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    height: 52px;
    padding-right: 6px;
    min-width: 0;
    text-align: left;
    border-radius: var(--r-sm);
  }
  .art {
    width: 40px;
    height: 40px;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    overflow: hidden;
  }
  .txt {
    display: grid;
    min-width: 0;
  }
  .t,
  .a {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t {
    font-weight: 500;
  }
  .a {
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .rt {
    font-size: var(--fs-caption);
    color: var(--label-3);
  }
  .x {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    margin-right: 4px;
    border-radius: var(--r-xs);
    color: var(--label-3);
    opacity: 0;
  }
  .row:hover .x,
  .row:focus-within .x,
  .x:focus-visible {
    opacity: 1;
  }
  .x:hover {
    background: var(--fill-3);
    color: var(--label);
  }
  .note,
  .empty {
    margin: 12px 10px;
    color: var(--label-3);
  }
  .bottom {
    display: flex;
    gap: 6px;
    padding: 10px 12px 12px;
    border-top: 1px solid var(--separator);
  }
  .bottom .btn {
    padding: 0 12px;
  }
  .bottom .btn.icon {
    margin-left: auto;
    padding: 0;
  }
  .bottom .btn.on {
    background: var(--fill-3);
  }
  .name {
    display: flex;
    gap: 6px;
    width: 100%;
  }
  .name .field {
    flex: 1;
    min-width: 0;
  }
  .queue.over {
    box-shadow: inset 0 0 0 2px var(--accent);
  }
</style>
