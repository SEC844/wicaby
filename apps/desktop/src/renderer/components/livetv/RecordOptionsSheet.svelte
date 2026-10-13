<script lang="ts" module>
  import type { Req } from '../../../shared/livetv/dialect';
  import type { DvrOp } from '../../../shared/livetv/timers';
  import { invalidateApiCache } from '../../lib/api';
  import { DvrFailure } from '../../lib/livetv/dvr.svelte';
  import { broadcastTimers } from '../../lib/livetv/store.svelte';
  import type { LiveTvStore } from '../../lib/livetv.svelte';
  import { errorMessage, toast } from '../../lib/stores.svelte';

  // What the sheet edits: a new recording from the server defaults, an existing timer's padding,
  // or a series rule (GET, merge, POST, re-GET).
  export type RecordTarget = { kind: 'new'; programId: string; series: boolean; isSeries: boolean } | { kind: 'timer'; id: string } | { kind: 'rule'; id: string };

  type Dto = Record<string, unknown>;

  const policyRead = new WeakSet<LiveTvStore>();

  // Policy.EnableLiveTvManagement, read once per store: false hides every record action (§3.1, §9.7).
  // Unknown stays "allowed" until a 403 downgrades it.
  export function checkRecordPolicy(store: LiveTvStore): void {
    if (policyRead.has(store)) return;
    policyRead.add(store);
    store.api.run<{ Policy?: { EnableLiveTvManagement?: boolean } }>({ method: 'GET', path: `/Users/${encodeURIComponent(store.userId)}`, query: {} }).then(
      (r) => {
        if (r.data?.Policy?.EnableLiveTvManagement === false) store.dvr.canRecord = false;
      },
      () => policyRead.delete(store),
    );
  }

  // After a timer write: the recordings list may change, and the other windows refetch their overlay.
  export function dvrWritten(store: LiveTvStore): void {
    invalidateApiCache();
    broadcastTimers(store.serverId);
  }

  // "Already scheduled" is information (the mark stays); the rest are errors (§9.1).
  export function dvrToast(err: unknown): void {
    toast(err instanceof DvrFailure && err.code === 'already-scheduled' ? 'info' : 'error', errorMessage(err));
  }

  // shortcut: DvrStore.write is private (dvr.svelte.ts belongs to D-3), so the create-with-options
  // POST reaches it by name; make it public the next time that file changes.
  function dvrWrite(store: LiveTvStore, op: DvrOp, req: Req): Promise<unknown> {
    return (store.dvr as unknown as { write: (op: DvrOp, req: Req) => Promise<unknown> }).write(op, req);
  }
</script>

<script lang="ts">
  import { createSeriesTimer, createTimer, seriesTimer, timerDefaults } from '../../../shared/livetv/dialect';
  import { applyOptions, KEEP_UP_TO_CHOICES, PADDING_CHOICES_MIN, visibleOptions } from '../../../shared/livetv/timers';
  import type { RecordMode } from '../../../shared/livetv/timers';
  import { fmt, t } from '../../lib/i18n.svelte';
  import Segmented from '../Segmented.svelte';
  import Sheet from '../Sheet.svelte';
  import Toggle from '../Toggle.svelte';

  // Recording options (§9.1, §9.2). Capability by presence: a field absent from the object the server
  // sent (defaults, timer or rule) is not shown, and only the changed fields are applied to it.
  let { store, target, onclose }: { store: LiveTvStore; target: RecordTarget | null; onclose: () => void } = $props();

  let dto = $state.raw<Dto | null>(null);
  let changes = $state<Dto>({});
  let mode = $state<RecordMode>('single');
  let saveDefault = $state(false);
  let busy = $state(false);

  $effect(() => {
    const tg = target;
    dto = null;
    changes = {};
    saveDefault = false;
    if (!tg) return;
    mode = tg.kind === 'rule' || (tg.kind === 'new' && tg.series) ? 'series' : 'single';
    const kind = store.api.kind;
    const req: Req = tg.kind === 'new' ? timerDefaults(kind, { programId: tg.programId }) : tg.kind === 'rule' ? seriesTimer(kind, { id: tg.id }) : { method: 'GET', path: `/LiveTv/Timers/${encodeURIComponent(tg.id)}`, query: {} };
    store.api.run<Dto>(req).then(
      (r) => {
        if (target !== tg) return;
        dto = r.data ?? {};
        // A new recording starts from the synced padding, as the quick record does.
        const pad = store.prefs.dvrPadding;
        if (tg.kind === 'new' && pad) changes = { PrePaddingSeconds: pad.pre, PostPaddingSeconds: pad.post };
      },
      (err: unknown) => {
        if (target !== tg) return;
        toast('error', errorMessage(err));
        onclose();
      },
    );
  });

  const shown = $derived(visibleOptions(dto, mode));
  const val = (field: string): unknown => (field in changes ? changes[field] : dto?.[field]);
  const set = (field: string, v: unknown): void => {
    changes[field] = v;
  };
  const isNew = $derived(target?.kind === 'new');
  const modes = $derived([
    { value: 'single' as RecordMode, label: t('livetv.record.thisEpisode') },
    { value: 'series' as RecordMode, label: t('livetv.record.wholeSeries') },
  ]);

  // Chips: the fixed choices plus the current value when the server uses another one.
  const withCurrent = (choices: readonly number[], cur: number): number[] => [...new Set([...choices, cur])].sort((a, b) => a - b);
  const padMin = (field: string): number => Math.round(Number(val(field) ?? 0) / 60);

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
  const PRESETS = [
    { id: 'everyDay', pattern: 'Daily', days: [...DAYS] },
    { id: 'weekdays', pattern: 'Weekdays', days: DAYS.slice(1, 6) },
    { id: 'weekends', pattern: 'Weekends', days: [DAYS[6], DAYS[0]] },
  ];
  // 2024-01-07 is a Sunday: the weekday names come from the UI locale.
  const dayLabel = (i: number): string => fmt.date(new Date(2024, 0, 7 + i), { weekday: 'short' });
  const days = $derived(new Set(Array.isArray(val('Days')) ? (val('Days') as string[]) : []));
  const sameDays = (a: readonly string[]): boolean => a.length === days.size && a.every((d) => days.has(d));
  function setDays(list: readonly string[]): void {
    const ordered = DAYS.filter((d) => list.includes(d));
    set('Days', ordered);
    // Jellyfin also carries the pattern; null means a custom set.
    if (dto && 'DayPattern' in dto) set('DayPattern', PRESETS.find((p) => p.days.length === ordered.length && p.days.every((d) => ordered.includes(d)))?.pattern ?? null);
  }
  const toggleDay = (d: string): void => setDays(days.has(d) ? [...days].filter((x) => x !== d) : [...days, d]);

  const KEEP_UNTIL = [
    { value: 'UntilDeleted', key: 'keepUntilDeleted' },
    { value: 'UntilSpaceNeeded', key: 'keepUntilSpace' },
    { value: 'UntilWatched', key: 'keepUntilWatched' },
  ];
  const TOGGLES = [
    { id: 'newOnly', field: 'RecordNewOnly' },
    { id: 'anyChannel', field: 'RecordAnyChannel' },
    { id: 'anyTime', field: 'RecordAnyTime' },
    { id: 'skipInLibrary', field: 'SkipEpisodesInLibrary' },
  ];

  async function submit(): Promise<void> {
    const tg = target;
    if (!tg || !dto || busy) return;
    busy = true;
    try {
      const kind = store.api.kind;
      // Plain values: the bodies cross IPC, which cannot clone the state proxies.
      const edits = $state.snapshot(changes) as Dto;
      if (tg.kind === 'new') {
        const series = mode === 'series';
        const body: Dto = { ...applyOptions(dto, edits), ProgramId: tg.programId };
        await dvrWrite(store, series ? 'createSeriesTimer' : 'createTimer', series ? createSeriesTimer(kind, { body }) : createTimer(kind, { body }));
        // 200/204 with an empty body: the new timer id comes from the refetch.
        await store.dvr.refresh();
        toast('success', t(series ? 'livetv.toasts.seriesScheduled' : 'livetv.toasts.recordingScheduled'));
      } else if (tg.kind === 'timer') {
        await store.dvr.updateTimer(tg.id, applyOptions(dto, edits));
        toast('success', t('livetv.toasts.paddingUpdated'));
      } else {
        await store.dvr.updateSeriesTimer(tg.id, edits);
        toast('success', t('livetv.toasts.ruleUpdated'));
      }
      if (saveDefault) store.prefsSync.set({ dvrPadding: { pre: Number(val('PrePaddingSeconds') ?? 0), post: Number(val('PostPaddingSeconds') ?? 0) } });
      dvrWritten(store);
      onclose();
    } catch (err) {
      dvrToast(err);
    } finally {
      busy = false;
    }
  }
</script>

<Sheet open={target !== null} {onclose} label={t('livetv.record.title')} width={560}>
  <div class="opts">
    <h2 class="title-3">{target?.kind === 'rule' ? String(dto?.Name ?? t('livetv.record.title')) : t('livetv.record.title')}</h2>
    {#if dto}
      {#if target?.kind === 'new' && target.isSeries}
        <Segmented label={t('livetv.record.title')} value={mode} options={modes} onchange={(v) => (mode = v)} />
      {/if}

      {#each [['startEarly', 'PrePaddingSeconds'], ['endLate', 'PostPaddingSeconds']] as [id, field] (id)}
        {#if shown.includes(id)}
          <fieldset>
            <legend class="headline">{t(`livetv.record.${id}`)}</legend>
            <div class="chips">
              {#each withCurrent(PADDING_CHOICES_MIN, padMin(field)) as m (m)}
                <button type="button" class="pick" aria-pressed={padMin(field) === m} onclick={() => set(field, m * 60)}>{t('livetv.record.minutes', { count: m })}</button>
              {/each}
            </div>
          </fieldset>
        {/if}
      {/each}

      {#each TOGGLES as o (o.id)}
        {#if shown.includes(o.id)}
          <div class="line">
            <span>{t(`livetv.record.${o.id}`)}</span>
            <Toggle checked={Boolean(val(o.field))} onchange={(v) => set(o.field, v)} label={t(`livetv.record.${o.id}`)} />
          </div>
        {/if}
      {/each}

      {#if shown.includes('days') && !val('RecordAnyTime')}
        <fieldset>
          <legend class="headline">{t('livetv.record.days')}</legend>
          <div class="chips">
            {#each PRESETS as p (p.id)}
              <button type="button" class="pick" aria-pressed={sameDays(p.days)} onclick={() => setDays(p.days)}>{t(`livetv.record.${p.id}`)}</button>
            {/each}
          </div>
          <div class="chips">
            {#each DAYS as d, i (d)}
              <button type="button" class="pick" aria-pressed={days.has(d)} onclick={() => toggleDay(d)}>{dayLabel(i)}</button>
            {/each}
          </div>
        </fieldset>
      {/if}

      {#if shown.includes('keepUpTo')}
        <fieldset>
          <legend class="headline">{t('livetv.record.keepUpTo')}</legend>
          <div class="chips">
            {#each withCurrent(KEEP_UP_TO_CHOICES, Number(val('KeepUpTo') ?? 0)) as n (n)}
              <button type="button" class="pick" aria-pressed={Number(val('KeepUpTo') ?? 0) === n} onclick={() => set('KeepUpTo', n)}>{t('livetv.record.keepUpToValue', { count: n })}</button>
            {/each}
          </div>
        </fieldset>
      {/if}

      {#if shown.includes('keepUntil')}
        <fieldset>
          <legend class="headline">{t('livetv.record.keepUntil')}</legend>
          <div class="chips">
            {#each KEEP_UNTIL as k (k.value)}
              <button type="button" class="pick" aria-pressed={val('KeepUntil') === k.value} onclick={() => set('KeepUntil', k.value)}>{t(`livetv.record.${k.key}`)}</button>
            {/each}
          </div>
        </fieldset>
      {/if}

      {#if shown.includes('startEarly') || shown.includes('endLate')}
        <div class="line">
          <span>{t('livetv.record.saveDefault')}</span>
          <Toggle checked={saveDefault} onchange={(v) => (saveDefault = v)} label={t('livetv.record.saveDefault')} />
        </div>
      {/if}

      <div class="actions">
        <button type="button" class="btn" onclick={onclose}>{t('common.actions.cancel')}</button>
        <button type="button" class="btn primary" disabled={busy} onclick={submit} data-autofocus>{t(isNew ? 'livetv.record.schedule' : 'livetv.record.apply')}</button>
      </div>
    {:else}
      <div class="wait" aria-busy="true"></div>
    {/if}
  </div>
</Sheet>

<style>
  .opts {
    display: grid;
    gap: 14px;
    padding: 24px 24px 20px;
  }
  h2 {
    margin: 0;
    padding-right: 32px;
  }
  fieldset {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    padding: 0 0 8px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pick {
    height: 30px;
    padding: 0 12px;
    border-radius: 999px;
    background: var(--fill-2);
    color: var(--label-2);
    font-size: var(--fs-footnote);
  }
  .pick:is(:hover, :focus-visible) {
    background: var(--fill-3);
    color: var(--label);
  }
  .pick[aria-pressed='true'] {
    background: var(--label);
    color: var(--bg);
  }
  .line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding-top: 6px;
  }
  .wait {
    height: 120px;
  }
  @media (forced-colors: active) {
    .pick[aria-pressed='true'] {
      outline: 2px solid Highlight;
    }
  }
</style>
