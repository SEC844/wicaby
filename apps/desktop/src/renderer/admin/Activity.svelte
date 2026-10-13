<script lang="ts">
  // Server activity log: GET /System/ActivityLog/Entries (Emby and Jellyfin).
  // The server filters by date (MinDate) and by "has a user" (HasUserId);
  // severity and a specific user are filtered here, over the loaded pages.
  import { onMount } from 'svelte';
  import type { ServerKind } from '../../shared/contract';
  import Icon from '../components/Icon.svelte';
  import Picker from '../components/Picker.svelte';
  import Segmented from '../components/Segmented.svelte';
  import { w } from '../lib/bridge';
  import { fmt, t } from '../lib/i18n.svelte';
  import { userImageUrl } from '../lib/images';
  import { errorMessage } from '../lib/stores.svelte';
  import { live } from './live';

  let { serverId }: { serverId: string; kind?: ServerKind } = $props();

  interface Entry {
    Id: number | string;
    Name: string;
    Overview?: string;
    ShortOverview?: string;
    Type?: string;
    ItemId?: string;
    Date: string;
    UserId?: string;
    UserPrimaryImageTag?: string;
    Severity?: string;
  }
  interface Page {
    Items: Entry[];
    TotalRecordCount: number;
  }
  interface UserLite {
    Id: string;
    Name: string;
    PrimaryImageTag?: string;
  }

  const PAGE = 100;
  type Level = 'all' | 'warn' | 'error';
  type Period = 'all' | 'day' | 'week' | 'month';

  let level = $state<Level>('all');
  let period = $state<Period>('week');
  let who = $state<string>('all'); // 'all' | 'system' | userId
  let entries = $state<Entry[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let more = $state(false);
  let error = $state('');
  let users = $state<UserLite[]>([]);
  let now = $state(Date.now());
  let expanded = $state<Record<string, boolean>>({});

  const userById = $derived(new Map(users.map((u) => [u.Id, u])));

  // Emby: Info/Warn/Error/Fatal. Jellyfin: Information/Warning/Error/Critical.
  function rank(sev?: string): 0 | 1 | 2 {
    const s = (sev ?? '').toLowerCase();
    if (s.startsWith('err') || s === 'fatal' || s === 'critical') return 2;
    if (s.startsWith('warn')) return 1;
    return 0;
  }

  const shown = $derived(
    entries.filter((e) => {
      if (level === 'warn' && rank(e.Severity) < 1) return false;
      if (level === 'error' && rank(e.Severity) < 2) return false;
      if (who === 'system' && e.UserId) return false;
      if (who !== 'all' && who !== 'system' && e.UserId !== who) return false;
      return true;
    }),
  );

  function query(start: number) {
    const q: Record<string, string | number | boolean> = { StartIndex: start, Limit: PAGE };
    const days = { all: 0, day: 1, week: 7, month: 30 }[period];
    if (days) q.MinDate = new Date(Date.now() - days * 86_400_000).toISOString();
    if (who === 'system') q.HasUserId = false;
    else if (who !== 'all') q.HasUserId = true;
    return q;
  }

  async function load(): Promise<void> {
    loading = true;
    try {
      const page = await w.api.get<Page>('/System/ActivityLog/Entries', query(0), serverId);
      entries = page.Items ?? [];
      total = page.TotalRecordCount ?? entries.length;
      error = '';
      now = Date.now();
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  // Background refresh: merges new entries at the top without losing loaded pages.
  async function refreshTop(): Promise<void> {
    if (loading || more) return;
    const page = await w.api.get<Page>('/System/ActivityLog/Entries', query(0), serverId);
    const known = new Set(entries.map((e) => String(e.Id)));
    const fresh = (page.Items ?? []).filter((e) => !known.has(String(e.Id)));
    if (fresh.length) entries = [...fresh, ...entries];
    total = page.TotalRecordCount ?? total;
    now = Date.now();
  }

  async function loadMore(): Promise<void> {
    more = true;
    try {
      const page = await w.api.get<Page>('/System/ActivityLog/Entries', query(entries.length), serverId);
      entries = [...entries, ...(page.Items ?? [])];
      total = page.TotalRecordCount ?? total;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      more = false;
    }
  }

  // Filters that the server applies reload from the first page.
  const serverFilter = $derived(`${period}|${who === 'all' || who === 'system' ? who : 'user'}`);
  let first = true;
  $effect(() => {
    void serverFilter;
    if (first) {
      first = false;
      return;
    }
    void load();
  });

  onMount(() => {
    void load();
    void w.api
      .get<UserLite[]>('/Users', undefined, serverId)
      .then((list) => (users = (Array.isArray(list) ? list : []).sort((a, b) => fmt.compare(a.Name, b.Name))))
      .catch(() => undefined);
    let started = false;
    return live(
      serverId,
      () => {
        if (!started) {
          started = true;
          return;
        }
        return refreshTop();
      },
      () => 30_000,
      ['ActivityLogEntry', 'ScheduledTaskEnded', 'PlaybackStart', 'PlaybackStopped', 'SessionEnded'],
    );
  });

  const userOptions = $derived([
    { value: 'all', label: t('admin.activity.userAll') },
    { value: 'system', label: t('admin.activity.userSystem') },
    ...users.map((u) => ({ value: u.Id, label: u.Name })),
  ]);
  const periodOptions = $derived<{ value: Period; label: string }[]>([
    { value: 'day', label: t('admin.activity.periodDay') },
    { value: 'week', label: t('admin.activity.periodWeek') },
    { value: 'month', label: t('admin.activity.periodMonth') },
    { value: 'all', label: t('admin.activity.periodAll') },
  ]);
  const levelOptions = $derived<{ value: Level; label: string }[]>([
    { value: 'all', label: t('admin.activity.levelAll') },
    { value: 'warn', label: t('admin.activity.levelWarn') },
    { value: 'error', label: t('admin.activity.levelError') },
  ]);

  // Day headings: "Aujourd’hui", "Hier", then the date.
  function day(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(today) - start(d)) / 86_400_000);
    if (diff === 0) return t('admin.activity.today');
    if (diff === 1) return t('admin.activity.yesterday');
    return fmt.date(d, { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
  }

  const groups = $derived.by(() => {
    const out: { day: string; items: Entry[] }[] = [];
    for (const e of shown) {
      const label = day(e.Date);
      const last = out[out.length - 1];
      if (last?.day === label) last.items.push(e);
      else out.push({ day: label, items: [e] });
    }
    return out;
  });
</script>

<div class="filters">
  <Segmented label={t('admin.activity.level')} value={level} options={levelOptions} onchange={(v) => (level = v)} />
  <span class="grow"></span>
  <Picker label={t('admin.activity.user')} value={who} options={userOptions} onchange={(v) => (who = v)} />
  <Picker label={t('admin.activity.period')} value={period} options={periodOptions} onchange={(v) => (period = v)} />
</div>

{#if loading && !entries.length}
  <div class="skeleton block"></div>
{:else if error && !entries.length}
  <div class="a-group"><p class="a-empty">{t('admin.activity.error')} <span class="caption">{error}</span></p></div>
{:else if !shown.length}
  <div class="a-group"><p class="a-empty">{t('admin.activity.empty')}</p></div>
{:else}
  {#each groups as g (g.day)}
    <h3 class="a-gh">{g.day}</h3>
    <div class="a-group">
      {#each g.items as e (e.Id)}
        {@const r = rank(e.Severity)}
        {@const u = e.UserId ? userById.get(e.UserId) : undefined}
        {@const detail = e.Overview && e.Overview !== e.ShortOverview ? e.Overview : ''}
        <div class="a-row entry">
          <span class="who" title={u?.Name ?? (e.UserId ? '' : t('admin.activity.userSystem'))}>
            {#if e.UserId && (e.UserPrimaryImageTag || u?.PrimaryImageTag)}
              <img src={userImageUrl(e.UserId, e.UserPrimaryImageTag ?? u?.PrimaryImageTag, 30, serverId)} alt="" />
            {:else if e.UserId}
              <span class="gram">{(u?.Name ?? '?').slice(0, 1).toUpperCase()}</span>
            {:else}
              <Icon name="server" size={15} />
            {/if}
          </span>
          <div class="a-txt">
            <div class="a-lbl name">
              {#if r > 0}<span class="a-status" class:warn={r === 1} class:bad={r === 2} title={t(r === 2 ? 'admin.activity.levelErrorOne' : 'admin.activity.levelWarnOne')}></span>{/if}
              <span class="text">{e.Name}</span>
            </div>
            {#if e.ShortOverview}<div class="a-desc">{e.ShortOverview}</div>{/if}
            {#if detail}
              {#if expanded[String(e.Id)]}
                <pre class="overview">{detail}</pre>
              {:else}
                <button type="button" class="disclose" onclick={() => (expanded[String(e.Id)] = true)}>{t('admin.activity.details')}</button>
              {/if}
            {/if}
          </div>
          <span class="a-val when" title={fmt.date(e.Date, { dateStyle: 'long', timeStyle: 'medium' })}>{fmt.relative(e.Date, now)}</span>
        </div>
      {/each}
    </div>
  {/each}

  <div class="pager">
    <span class="count">{t('admin.activity.count', { shown: fmt.number(entries.length), total: fmt.number(total) })}</span>
    {#if entries.length < total}
      <button type="button" class="a-push" disabled={more} onclick={loadMore}>{more ? t('common.status.loading') : t('admin.activity.loadMore')}</button>
    {/if}
  </div>
{/if}

<style>
  .filters {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 22px;
  }
  .grow {
    flex: 1;
  }
  .block {
    height: 300px;
    border-radius: var(--r-sm);
  }
  .entry {
    align-items: flex-start;
  }
  .who {
    flex: none;
    width: 30px;
    height: 30px;
    margin-top: 1px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    overflow: hidden;
    background: var(--fill-2);
    color: var(--label-2);
  }
  .who img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .gram {
    font-size: var(--fs-footnote);
    font-weight: 600;
    color: var(--label);
  }
  .name {
    align-items: center;
    gap: 8px;
  }
  .name .text {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .name .a-status::before {
    width: 7px;
    height: 7px;
  }
  .when {
    font-size: var(--fs-footnote);
    color: var(--label-3);
    padding-top: 2px;
  }
  .disclose {
    align-self: flex-start;
    margin-top: 4px;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .disclose:hover {
    color: var(--label);
  }
  .overview {
    margin: 6px 0 0;
    padding: 8px 10px;
    border-radius: var(--r-xs);
    background: var(--fill-1);
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    color: var(--label-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 220px;
    overflow: auto;
    user-select: text;
  }
  .pager {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 14px;
  }
  .count {
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
</style>
