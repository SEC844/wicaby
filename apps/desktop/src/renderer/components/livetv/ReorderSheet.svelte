<script lang="ts">
  import { t } from '../../lib/i18n.svelte';
  import type { LiveTvStore } from '../../lib/livetv.svelte';
  import { toast } from '../../lib/stores.svelte';
  import Icon from '../Icon.svelte';
  import Sheet from '../Sheet.svelte';
  import { dvrToast, dvrWritten } from './RecordOptionsSheet.svelte';

  // "Réorganiser les priorités…" (§9.4): drag, or Alt+↑/↓, or the arrows. Saving rewrites Priority as
  // n…1 (first = highest), and only for the rules whose value changes, one after the other.
  let { store, open, onclose }: { store: LiveTvStore; open: boolean; onclose: () => void } = $props();

  type Dto = Record<string, unknown>;
  let order = $state.raw<Dto[]>([]);
  let busy = $state(false);
  let dragId: string | null = null;

  const id = (r: Dto): string => String(r.Id ?? '');
  const prio = (r: Dto): number => Number(r.Priority ?? 0);

  $effect(() => {
    if (open) order = [...store.dvr.rules].sort((a, b) => prio(b) - prio(a));
  });

  function move(rid: string, to: number): void {
    const r = order.find((x) => id(x) === rid);
    if (!r) return;
    const rest = order.filter((x) => x !== r);
    rest.splice(Math.max(0, Math.min(rest.length, to)), 0, r);
    order = rest;
  }

  function key(e: KeyboardEvent, rid: string, i: number): void {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    move(rid, i + (e.key === 'ArrowUp' ? -1 : 1));
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-rule="${CSS.escape(rid)}"]`)?.focus());
  }

  async function save(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const n = order.length;
      for (const [i, r] of order.entries()) if (prio(r) !== n - i) await store.dvr.updateSeriesTimer(id(r), { Priority: n - i });
      dvrWritten(store);
      toast('success', t('livetv.toasts.prioritiesUpdated'));
      onclose();
    } catch (err) {
      dvrToast(err);
    } finally {
      busy = false;
    }
  }
</script>

<Sheet {open} {onclose} label={t('livetv.scheduled.reorder')} width={480}>
  <div class="reorder">
    <h2 class="title-3">{t('livetv.scheduled.reorder')}</h2>
    <p class="footnote">{t('livetv.scheduled.reorderHint')}</p>
    <ol class="list">
      {#each order as r, i (id(r))}
        <li ondragstart={() => (dragId = id(r))} ondragover={(e) => e.preventDefault()} ondrop={(e) => (e.preventDefault(), dragId && dragId !== id(r) && move(dragId, i), (dragId = null))} draggable="true">
          <button class="item" data-rule={id(r)} onkeydown={(e) => key(e, id(r), i)}>
            <Icon name="grip" size={14} />
            <span class="num mono">{i + 1}</span>
            <span class="name">{String(r.Name ?? '')}</span>
          </button>
          <button class="btn icon ghost" onclick={() => move(id(r), i - 1)} disabled={i === 0} aria-label={t('livetv.manage.moveUp')}><Icon name="arrowUp" size={14} /></button>
          <button class="btn icon ghost" onclick={() => move(id(r), i + 1)} disabled={i === order.length - 1} aria-label={t('livetv.manage.moveDown')}><Icon name="arrowDown" size={14} /></button>
        </li>
      {/each}
    </ol>
    <div class="actions">
      <button class="btn" onclick={onclose}>{t('common.actions.cancel')}</button>
      <button class="btn primary" disabled={busy} onclick={save}>{t('livetv.record.apply')}</button>
    </div>
  </div>
</Sheet>

<style>
  .reorder {
    display: grid;
    gap: 10px;
    padding: 24px 24px 20px;
  }
  h2,
  p {
    margin: 0;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
    max-height: 50vh;
    overflow-y: auto;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .item {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--label-2);
    cursor: grab;
  }
  .item:is(:hover, :focus-visible) {
    background: var(--fill-4);
    color: var(--label);
  }
  .num {
    width: 24px;
    flex: none;
    color: var(--label-3);
  }
  .name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding-top: 6px;
  }
</style>
