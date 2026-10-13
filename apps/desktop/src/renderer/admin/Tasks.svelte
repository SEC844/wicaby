<script lang="ts">
  // Scheduled tasks, grouped by category. Emby and Jellyfin share the routes:
  // GET /ScheduledTasks, POST|DELETE /ScheduledTasks/Running/{id},
  // POST /ScheduledTasks/{id}/Triggers (the full trigger list).
  import { onMount } from 'svelte';
  import type { ServerKind } from '../../shared/contract';
  import Icon from '../components/Icon.svelte';
  import Picker from '../components/Picker.svelte';
  import Sheet from '../components/Sheet.svelte';
  import { w } from '../lib/bridge';
  import { fmt, has, t } from '../lib/i18n.svelte';
  import { errorMessage, toast } from '../lib/stores.svelte';
  import { live, ticksToMs } from './live';

  let { serverId }: { serverId: string; kind?: ServerKind } = $props();

  type TriggerType = 'DailyTrigger' | 'WeeklyTrigger' | 'IntervalTrigger' | 'StartupTrigger' | 'SystemEventTrigger';
  interface Trigger {
    Type: TriggerType | string;
    TimeOfDayTicks?: number;
    IntervalTicks?: number;
    DayOfWeek?: string;
    SystemEvent?: string;
    MaxRuntimeTicks?: number;
    [k: string]: unknown;
  }
  interface Task {
    Id: string;
    Name: string;
    Description?: string;
    Category?: string;
    State: 'Idle' | 'Running' | 'Cancelling' | string;
    CurrentProgressPercentage?: number;
    IsHidden?: boolean;
    Key?: string;
    Triggers?: Trigger[];
    LastExecutionResult?: { StartTimeUtc?: string; EndTimeUtc?: string; Status?: string; ErrorMessage?: string; LongErrorMessage?: string };
  }

  const TICKS_PER_MIN = 600_000_000;
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  let tasks = $state<Task[] | null>(null);
  let error = $state('');
  let now = $state(Date.now());
  let busy = $state<Record<string, boolean>>({});

  const anyRunning = $derived((tasks ?? []).some((x) => x.State !== 'Idle'));
  const groups = $derived.by(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks ?? []) {
      const cat = task.Category || t('admin.tasks.otherCategory');
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(task);
    }
    return [...map.entries()].sort((a, b) => fmt.compare(a[0], b[0])).map(([name, list]) => ({ name, list: list.sort((a, b) => fmt.compare(a.Name, b.Name)) }));
  });

  async function load(): Promise<void> {
    try {
      const list = await w.api.get<Task[]>('/ScheduledTasks', { IsHidden: false }, serverId);
      tasks = (Array.isArray(list) ? list : []).filter((x) => !x.IsHidden);
      error = '';
      now = Date.now();
    } catch (err) {
      error = errorMessage(err);
    }
  }

  onMount(() => live(serverId, load, () => (anyRunning ? 1500 : 15_000), ['ScheduledTaskEnded', 'ScheduledTasksInfo']));

  async function run(task: Task): Promise<void> {
    busy[task.Id] = true;
    try {
      await w.api.post(`/ScheduledTasks/Running/${encodeURIComponent(task.Id)}`, undefined, undefined, serverId);
      task.State = 'Running';
      task.CurrentProgressPercentage = 0;
      setTimeout(() => void load(), 500);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy[task.Id] = false;
    }
  }

  async function stop(task: Task): Promise<void> {
    busy[task.Id] = true;
    try {
      await w.api.del(`/ScheduledTasks/Running/${encodeURIComponent(task.Id)}`, undefined, serverId);
      task.State = 'Cancelling';
      setTimeout(() => void load(), 500);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy[task.Id] = false;
    }
  }

  // ---- Formatting ----

  function timeOfDay(ticks = 0): string {
    const min = Math.round(ticks / TICKS_PER_MIN);
    return fmt.time(new Date(2000, 0, 1, Math.floor(min / 60), min % 60));
  }
  function weekday(day?: string): string {
    const i = Math.max(0, DAYS.indexOf(day ?? 'Sunday'));
    // 2024-01-07 is a Sunday.
    return fmt.date(new Date(2024, 0, 7 + i), { weekday: 'long' });
  }
  function interval(ticks = 0): string {
    const min = Math.round(ticks / TICKS_PER_MIN);
    if (min % 1440 === 0) return t('admin.tasks.everyDays', { count: min / 1440 });
    if (min % 60 === 0) return t('admin.tasks.everyHours', { count: min / 60 });
    return t('admin.tasks.everyMinutes', { count: min });
  }
  function describe(tr: Trigger): string {
    switch (tr.Type) {
      case 'DailyTrigger':
        return t('admin.tasks.trigger.daily', { time: timeOfDay(tr.TimeOfDayTicks) });
      case 'WeeklyTrigger':
        return t('admin.tasks.trigger.weekly', { day: weekday(tr.DayOfWeek), time: timeOfDay(tr.TimeOfDayTicks) });
      case 'IntervalTrigger':
        return interval(tr.IntervalTicks);
      case 'StartupTrigger':
        return t('admin.tasks.trigger.startup');
      case 'SystemEventTrigger':
        return t('admin.tasks.trigger.systemEvent');
      default:
        return tr.Type;
    }
  }
  function schedule(task: Task): string {
    const list = task.Triggers ?? [];
    return list.length ? fmt.list(list.map(describe)) : t('admin.tasks.trigger.none');
  }

  function took(ms: number): string {
    if (ms < 1000) return t('admin.tasks.lessThanSecond');
    if (ms < 60_000) return t('admin.tasks.seconds', { n: Math.round(ms / 1000) });
    return fmt.duration(ms);
  }
  function statusLabel(s?: string): string {
    const key = `admin.tasks.status.${s}`;
    return s && has(key) ? t(key) : (s ?? '');
  }
  const failed = (s?: string) => s === 'Failed' || s === 'Aborted';

  // ---- Trigger editor ----

  type NewType = 'DailyTrigger' | 'WeeklyTrigger' | 'IntervalTrigger' | 'StartupTrigger';
  let editing = $state<Task | null>(null);
  let draft = $state<Trigger[]>([]);
  let addType = $state<NewType>('DailyTrigger');
  let addTime = $state(String(3 * 60)); // minutes after midnight
  let addDay = $state('Sunday');
  let addInterval = $state(String(12 * 60));
  let saving = $state(false);

  function edit(task: Task): void {
    editing = task;
    draft = (task.Triggers ?? []).map((x) => ({ ...x }));
    addType = 'DailyTrigger';
  }

  function addTrigger(): void {
    const tod = Number(addTime) * TICKS_PER_MIN;
    if (addType === 'DailyTrigger') draft.push({ Type: addType, TimeOfDayTicks: tod });
    else if (addType === 'WeeklyTrigger') draft.push({ Type: addType, TimeOfDayTicks: tod, DayOfWeek: addDay });
    else if (addType === 'IntervalTrigger') draft.push({ Type: addType, IntervalTicks: Number(addInterval) * TICKS_PER_MIN });
    else if (!draft.some((x) => x.Type === 'StartupTrigger')) draft.push({ Type: addType });
  }

  async function saveTriggers(): Promise<void> {
    const task = editing;
    if (!task) return;
    saving = true;
    try {
      const body = $state.snapshot(draft);
      await w.api.post(`/ScheduledTasks/${encodeURIComponent(task.Id)}/Triggers`, undefined, body, serverId);
      task.Triggers = body;
      toast('success', t('admin.tasks.saved'));
      editing = null;
      void load();
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      saving = false;
    }
  }

  const typeOptions = $derived<{ value: NewType; label: string }[]>([
    { value: 'DailyTrigger', label: t('admin.tasks.type.daily') },
    { value: 'WeeklyTrigger', label: t('admin.tasks.type.weekly') },
    { value: 'IntervalTrigger', label: t('admin.tasks.type.interval') },
    { value: 'StartupTrigger', label: t('admin.tasks.type.startup') },
  ]);
  // Every half hour of the day.
  const timeOptions = $derived(Array.from({ length: 48 }, (_, i) => ({ value: String(i * 30), label: timeOfDay(i * 30 * TICKS_PER_MIN) })));
  const dayOptions = $derived(DAYS.map((d) => ({ value: d, label: weekday(d) })));
  const intervalOptions = $derived([15, 30, 60, 120, 180, 360, 720, 1440].map((m) => ({ value: String(m), label: interval(m * TICKS_PER_MIN) })));
</script>

{#if error && !tasks}
  <div class="a-group"><p class="a-empty">{t('admin.tasks.error')} <span class="caption">{error}</span></p></div>
{:else if !tasks}
  <div class="skeleton block"></div>
{:else if !tasks.length}
  <div class="a-group"><p class="a-empty">{t('admin.tasks.empty')}</p></div>
{:else}
  {#each groups as g (g.name)}
    <h3 class="a-gh">{g.name}</h3>
    <div class="a-group">
      {#each g.list as task (task.Id)}
        {@const last = task.LastExecutionResult}
        {@const running = task.State !== 'Idle'}
        {@const pct = task.CurrentProgressPercentage ?? 0}
        <div class="a-row task">
          <div class="a-txt">
            <div class="a-lbl">{task.Name}</div>
            {#if task.Description}<div class="a-desc">{task.Description}</div>{/if}
            {#if running}
              <div class="run">
                <div class="a-progress" style:--p={pct / 100}><span></span></div>
                <span class="tabular pct">{task.State === 'Cancelling' ? t('admin.tasks.cancelling') : fmt.number(pct / 100, { style: 'percent', maximumFractionDigits: 0 })}</span>
              </div>
            {:else}
              <div class="meta">
                {#if last?.EndTimeUtc}
                  {@const end = Date.parse(last.EndTimeUtc)}
                  {@const start = Date.parse(last.StartTimeUtc ?? last.EndTimeUtc)}
                  <span class="a-status" class:ok={last.Status === 'Completed'} class:bad={failed(last.Status)} class:warn={last.Status === 'Cancelled'} title={last.ErrorMessage ?? ''}>
                    {statusLabel(last.Status)}
                  </span>
                  <span title={fmt.date(end, { dateStyle: 'long', timeStyle: 'short' })}>{fmt.relative(end, now)}</span>
                  <span>·</span>
                  <span>{took(end - start)}</span>
                {:else}
                  <span>{t('admin.tasks.never')}</span>
                {/if}
                <span>·</span>
                <button type="button" class="sched" onclick={() => edit(task)} title={t('admin.tasks.editTriggers')}>
                  <Icon name="clock" size={12} />{schedule(task)}
                </button>
              </div>
              {#if last && failed(last.Status) && last.ErrorMessage}
                <div class="err">{last.ErrorMessage}</div>
              {/if}
            {/if}
          </div>
          {#if running}
            <button type="button" class="a-push" disabled={busy[task.Id] || task.State === 'Cancelling'} onclick={() => stop(task)}>{t('admin.tasks.stop')}</button>
          {:else}
            <button type="button" class="a-push" disabled={busy[task.Id]} onclick={() => run(task)}>{t('admin.tasks.run')}</button>
          {/if}
        </div>
      {/each}
    </div>
  {/each}
{/if}

<Sheet open={editing !== null} onclose={() => (editing = null)} label={t('admin.tasks.editTriggers')} width={500}>
  <div class="a-sheet">
    <h2>{editing?.Name}</h2>
    <p>{t('admin.tasks.editTriggersDesc')}</p>
    <div class="a-group">
      {#each draft as tr, i (i)}
        <div class="a-row compact">
          <div class="a-txt"><div class="a-lbl soft">{describe(tr)}</div></div>
          <button type="button" class="a-push icon" title={t('admin.tasks.removeTrigger')} aria-label={t('admin.tasks.removeTrigger')} onclick={() => draft.splice(i, 1)}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      {:else}
        <p class="a-empty">{t('admin.tasks.trigger.none')}</p>
      {/each}
    </div>
    <div class="add">
      <Picker label={t('admin.tasks.triggerType')} value={addType} options={typeOptions} onchange={(v) => (addType = v)} />
      {#if addType === 'WeeklyTrigger'}
        <Picker label={t('admin.tasks.day')} value={addDay} options={dayOptions} onchange={(v) => (addDay = v)} />
      {/if}
      {#if addType === 'DailyTrigger' || addType === 'WeeklyTrigger'}
        <Picker label={t('admin.tasks.time')} value={addTime} options={timeOptions} onchange={(v) => (addTime = v)} />
      {/if}
      {#if addType === 'IntervalTrigger'}
        <Picker label={t('admin.tasks.every')} value={addInterval} options={intervalOptions} onchange={(v) => (addInterval = v)} />
      {/if}
      <span class="grow"></span>
      <button type="button" class="a-push" onclick={addTrigger}><Icon name="plus" size={14} />{t('admin.tasks.addTrigger')}</button>
    </div>
    <div class="a-sheet-actions">
      <button type="button" class="a-push ghost" onclick={() => (editing = null)}>{t('common.actions.cancel')}</button>
      <button type="button" class="a-push primary" disabled={saving} onclick={saveTriggers}>{t('common.actions.save')}</button>
    </div>
  </div>
</Sheet>

<style>
  .block {
    height: 300px;
    border-radius: var(--r-sm);
  }
  .task {
    align-items: flex-start;
  }
  .task > .a-push {
    margin-top: 2px;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .meta .a-status {
    font-size: inherit;
  }
  .sched {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--label-3);
    text-align: left;
  }
  .sched:hover,
  .sched:focus-visible {
    color: var(--label);
  }
  .err {
    margin-top: 4px;
    font-size: var(--fs-footnote);
    color: var(--label-2);
    overflow-wrap: anywhere;
  }
  .run {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
    max-width: 420px;
  }
  .run .a-progress {
    flex: 1;
  }
  .pct {
    flex: none;
    min-width: 44px;
    font-size: var(--fs-footnote);
    color: var(--label-2);
    text-align: right;
  }
  .add {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
  }
</style>
