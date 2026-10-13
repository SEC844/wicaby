<script lang="ts">
  import { onMount } from 'svelte';
  import { atParam, dayKey, dayStart } from '../../../shared/livetv/anchor';
  import type { TimerLite, TimerStatus } from '../../../shared/livetv/model';
  import Icon from '../../components/Icon.svelte';
  import RecordOptionsSheet, { checkRecordPolicy, dvrToast, dvrWritten } from '../../components/livetv/RecordOptionsSheet.svelte';
  import type { RecordTarget } from '../../components/livetv/RecordOptionsSheet.svelte';
  import ReorderSheet from '../../components/livetv/ReorderSheet.svelte';
  import SeriesRuleSheet, { ruleSummary } from '../../components/livetv/SeriesRuleSheet.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import Sheet from '../../components/Sheet.svelte';
  import { fmt, t } from '../../lib/i18n.svelte';
  import type { LiveTvStore } from '../../lib/livetv.svelte';
  import { navigate } from '../../lib/router.svelte';
  import { toast } from '../../lib/stores.svelte';

  // "Programmés" (§9.3, §9.4): À venir (recording now, today, tomorrow, then dates; status pills; the
  // conflict banner from server statuses only) and the series rules (priority order, edit, reorder,
  // delete). Read-only without Policy.EnableLiveTvManagement or after a 403.
  let { store }: { store: LiveTvStore } = $props();

  type View = 'upcoming' | 'rules';
  type Dto = Record<string, unknown>;
  let view = $state<View>('upcoming');
  let onlyConflicts = $state(false);
  let options = $state<RecordTarget | null>(null);
  let ruleOpen = $state<string | null>(null);
  let reorder = $state(false);
  let deleting = $state<Dto | null>(null);
  let busy = $state(false);

  const views = $derived([
    { value: 'upcoming' as View, label: t('livetv.scheduled.upcoming') },
    { value: 'rules' as View, label: t('livetv.scheduled.rules') },
  ]);

  const dvr = $derived(store.dvr);
  const byId = $derived(new Map(store.channels.map((r) => [r.id, r])));
  const groups = $derived.by(() => {
    const now = store.clock;
    const today = dayKey(now);
    const tomorrow = dayKey(dayStart(now) + 36 * 3_600_000);
    const out: { key: string; label: string; items: TimerLite[] }[] = [];
    for (const tm of dvr.timers) {
      if (tm.end <= now || (onlyConflicts && tm.status !== 'conflict-wont')) continue;
      const day = dayKey(tm.start);
      const key = tm.status === 'recording' ? 'rec' : day;
      let g = out.find((x) => x.key === key);
      if (!g) {
        const label = key === 'rec' ? t('livetv.scheduled.recordingNow') : day === today ? t('livetv.guide.today') : day === tomorrow ? t('livetv.guide.tomorrow') : fmt.date(tm.start, { weekday: 'long', day: 'numeric', month: 'long' });
        out.push((g = { key, label, items: [] }));
      }
      g.items.push(tm);
    }
    return out.sort((a, b) => (a.key === 'rec' ? -1 : b.key === 'rec' ? 1 : 0));
  });
  // Rules by priority, highest first; the episode count comes from the timer overlay.
  const rules = $derived([...dvr.rules].sort((a, b) => Number(b.Priority ?? 0) - Number(a.Priority ?? 0)));
  const episodes = $derived.by(() => {
    const m = new Map<string, number>();
    for (const x of dvr.timers) if (x.seriesTimerId && x.end > store.clock) m.set(x.seriesTimerId, (m.get(x.seriesTimerId) ?? 0) + 1);
    return m;
  });
  const recordingNow = $derived(dvr.timers.filter((x) => x.status === 'recording').length);

  const STATUS: Record<TimerStatus, string> = {
    scheduled: 'scheduled',
    recording: 'recording',
    'conflict-ok': 'conflictOk',
    'conflict-wont': 'wont',
    error: 'error',
  };

  onMount(() => {
    checkRecordPolicy(store);
    void dvr.refresh();
    void dvr.loadRules().catch(() => undefined);
  });

  async function run(fn: () => Promise<void>, done: string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await fn();
      dvrWritten(store);
      toast('success', done);
    } catch (err) {
      dvrToast(err);
    } finally {
      busy = false;
    }
  }

  function showInGuide(tm: TimerLite): void {
    const q = new URLSearchParams({ tab: 'guide', day: dayKey(tm.start), at: atParam(tm.start - 30 * 60_000) });
    if (tm.channelId) q.set('ch', tm.channelId);
    if (tm.programId) q.set('prog', tm.programId);
    navigate(`/livetv?${q}`);
  }

  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const pad = (tm: TimerLite): string => (tm.prePaddingS || tm.postPaddingS ? t('livetv.scheduled.padding', { pre: Math.round(tm.prePaddingS / 60), post: Math.round(tm.postPaddingS / 60) }) : '');
</script>

<div class="sched">
  <Segmented label={t('livetv.tabs.scheduled')} value={view} options={views} onchange={(v) => (view = v)} />

  {#if !dvr.canRecord}<p class="note footnote">{t('livetv.scheduled.readOnly')}</p>{/if}

  {#if view === 'upcoming'}
    {#if dvr.conflicts > 0}
      <div class="banner" role="status">
        <Icon name="exclamation" size={16} />
        <span>{t('livetv.scheduled.conflicts', { count: dvr.conflicts })}</span>
        <button class="btn" aria-pressed={onlyConflicts} onclick={() => (onlyConflicts = !onlyConflicts)}>{t('livetv.scheduled.show')}</button>
      </div>
    {/if}
    {#if store.caps.tunerCount}<p class="footnote">{t('livetv.scheduled.tuners', { used: recordingNow, total: store.caps.tunerCount })}</p>{/if}
    {#each groups as g (g.key)}
      <h2 class="sec">{g.label}</h2>
      <ul class="list">
        {#each g.items as tm (tm.id)}
          {@const ch = tm.channelId ? byId.get(tm.channelId) : undefined}
          <li>
            <span class="time mono">{fmt.time(tm.start)} – {fmt.time(tm.end)}</span>
            <span class="l-main">
              <span class="l-name">{tm.name}</span>
              <span class="l-sub">{[ch ? `${ch.number} ${ch.name}`.trim() : '', pad(tm)].filter(Boolean).join(' · ')}</span>
            </span>
            <span class="pill" data-status={tm.status}>{t(`livetv.scheduled.status.${STATUS[tm.status]}`)}</span>
            <span class="acts">
              {#if dvr.canRecord}
                <button class="btn icon ghost" title={t('livetv.scheduled.editPadding')} aria-label={t('livetv.scheduled.editPadding')} onclick={() => (options = { kind: 'timer', id: tm.id })}><Icon name="customize" size={15} /></button>
              {/if}
              {#if tm.seriesTimerId}
                {@const rid = tm.seriesTimerId}
                <button class="btn icon ghost" title={t('livetv.scheduled.viewRule')} aria-label={t('livetv.scheduled.viewRule')} onclick={() => (ruleOpen = rid)}><Icon name="recordSeries" size={15} /></button>
              {/if}
              {#if tm.channelId}
                <button class="btn icon ghost" title={t('livetv.sheet.showInGuide')} aria-label={t('livetv.sheet.showInGuide')} onclick={() => showInGuide(tm)}><Icon name="list" size={15} /></button>
              {/if}
              {#if dvr.canRecord}
                {@const label = t(tm.seriesTimerId ? 'livetv.scheduled.skipEpisode' : 'livetv.scheduled.cancel')}
                <button class="btn icon ghost" title={label} aria-label={label} disabled={busy} onclick={() => run(() => dvr.cancelTimer(tm.id), t('livetv.toasts.recordingCanceled'))}><Icon name="close" size={15} /></button>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty footnote">{t('livetv.scheduled.empty')}</p>
    {/each}
  {:else if rules.length}
    {#if dvr.canRecord && rules.length > 1}
      <button class="btn reorder" onclick={() => (reorder = true)}>{t('livetv.scheduled.reorder')}</button>
    {/if}
    <ul class="list">
      {#each rules as r (str(r.Id))}
        {@const rid = str(r.Id)}
        <li>
          <Icon name="recordSeries" size={16} />
          <button class="l-main link" onclick={() => (ruleOpen = rid)}>
            <span class="l-name">{str(r.Name)}</span>
            <span class="l-sub">{[ruleSummary(r), t('livetv.scheduled.ruleEpisodes', { count: episodes.get(rid) ?? 0 })].filter(Boolean).join(' · ')}</span>
          </button>
          {#if dvr.canRecord}
            <span class="acts">
              <button class="btn icon ghost" title={t('livetv.scheduled.editRule')} aria-label={t('livetv.scheduled.editRule')} onclick={() => (options = { kind: 'rule', id: rid })}><Icon name="customize" size={15} /></button>
              <button class="btn icon ghost" title={t('livetv.scheduled.deleteRule')} aria-label={t('livetv.scheduled.deleteRule')} onclick={() => (deleting = r)}><Icon name="trash" size={15} /></button>
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty footnote">{t('livetv.scheduled.rulesEmpty')}</p>
  {/if}
</div>

<Sheet open={deleting !== null} onclose={() => (deleting = null)} label={t('livetv.scheduled.deleteRule')} width={440}>
  <div class="confirm">
    <p>{t('livetv.scheduled.deleteRuleConfirm', { name: str(deleting?.Name) })}</p>
    <div class="c-acts">
      <button class="btn" data-autofocus onclick={() => (deleting = null)}>{t('common.actions.cancel')}</button>
      <button class="btn danger" disabled={busy} onclick={() => run(() => dvr.cancelSeriesTimer(str(deleting?.Id)), t('livetv.toasts.seriesCanceled')).then(() => (deleting = null))}>{t('livetv.scheduled.deleteRule')}</button>
    </div>
  </div>
</Sheet>
<RecordOptionsSheet {store} target={options} onclose={() => (options = null)} />
<SeriesRuleSheet {store} ruleId={options ? null : ruleOpen} onclose={() => (ruleOpen = null)} onedit={(id) => (options = { kind: 'rule', id })} />
<ReorderSheet {store} open={reorder} onclose={() => (reorder = false)} />

<style>
  .sched {
    display: grid;
    gap: 12px;
    justify-items: start;
  }
  .sched > :not(:first-child) {
    justify-self: stretch;
  }
  .sched > .reorder {
    justify-self: start;
  }
  .note,
  .empty {
    margin: 0;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 8px 8px 14px;
    border-radius: var(--r-md);
    background: var(--fill-2);
    color: var(--label);
  }
  .banner span {
    flex: 1;
  }
  .btn[aria-pressed='true'] {
    background: var(--fill-4);
  }
  .sec {
    margin: 12px 0 0;
    font-size: var(--fs-headline);
    font-weight: 600;
  }
  .sec::first-letter {
    text-transform: uppercase;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 6px;
    border-radius: var(--r-lg);
    background: var(--bg-elevated);
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 6px 8px 14px;
    color: var(--label-2);
  }
  .list li + li {
    box-shadow: 0 -1px 0 var(--separator);
  }
  .time {
    flex: none;
    min-width: 14ch;
    white-space: nowrap;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .l-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    text-align: left;
  }
  .link {
    padding: 4px 8px;
    margin: -4px -8px;
    border-radius: var(--r-sm);
  }
  .link:is(:hover, :focus-visible) {
    background: var(--fill-3);
  }
  .l-name {
    font-weight: 560;
    color: var(--label);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .l-sub {
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .acts {
    flex: none;
    display: flex;
    gap: 2px;
  }
  .pill {
    flex: none;
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--fill-2);
    font-size: var(--fs-caption);
    color: var(--label-2);
  }
  /* Static red dot for "En cours"; "Ne sera pas enregistré" is the only emphasised pill (§9.3). */
  .pill[data-status='recording']::before {
    content: '';
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 6px;
    border-radius: 50%;
    background: var(--red);
    vertical-align: 1px;
  }
  .pill[data-status='conflict-wont'] {
    background: var(--fill-4);
    color: var(--label);
  }
  .confirm {
    display: grid;
    gap: 14px;
    padding: 24px 24px 20px;
  }
  .confirm p {
    margin: 0;
  }
  .c-acts {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  @media (forced-colors: active) {
    .pill[data-status='conflict-wont'] {
      outline: 2px solid Highlight;
    }
  }
</style>
