<script lang="ts">
  // Android TV ScheduledTab (livetv/ScheduledTab.kt, spec §9): the upcoming recordings by start, each with its
  // channel, time and status (recording now, scheduled, conflicts), then the series rules. OK on a recording offers to
  // cancel it; on a rule, to delete the rule (confirmed).
  import type { TimerLite, TimerStatus } from '$shared/livetv/model';
  import { focusable } from '../../lib/focus';
  import { locale, plural, t } from '../../lib/i18n.svelte';
  import { DvrFailure, timeText, type LiveTv } from '../../lib/livetv.svelte';
  import { closeAlert, showAlert } from '../../lib/overlay.svelte';
  import { showToast } from '../../lib/toast.svelte';

  let { repo, now }: { repo: LiveTv; now: number } = $props();

  const STATUS: Record<TimerStatus, string> = {
    recording: 'livetv_scheduled_status_recording',
    scheduled: 'livetv_scheduled_status_scheduled',
    'conflict-ok': 'livetv_scheduled_status_conflict_ok',
    'conflict-wont': 'livetv_scheduled_status_wont',
    error: 'livetv_scheduled_status_error',
  };
  const upcoming = $derived(repo.timers.filter((x) => x.end > now));
  const rules = $derived(repo.seriesTimers);
  const day = (ms: number) => new Date(ms).toLocaleDateString(locale.current, { weekday: 'short', day: 'numeric', month: 'short' });

  function failed(e: unknown): void {
    showToast(e instanceof DvrFailure && e.kind === 'forbidden' ? t('livetv_toasts_forbidden') : t('player_live_record_failed'));
  }

  function openTimer(x: TimerLite): void {
    showAlert({
      title: x.name,
      message: `${repo.channel(x.channelId ?? '')?.name ?? ''} · ${day(x.start)} ${timeText(x.start, locale.current)} – ${timeText(x.end, locale.current)}`,
      actions: [
        {
          label: t('livetv_scheduled_cancel'),
          destructive: true,
          run: () => void repo.cancelTimer(x.id).then(() => showToast(t('livetv_toasts_recording_canceled')), failed),
        },
        { label: t('cancel'), run: closeAlert },
      ],
      focusIndex: 1,
    });
  }

  function openRule(r: Record<string, unknown>): void {
    const id = String(r.Id ?? '');
    const name = String(r.Name ?? '');
    showAlert({
      title: t('livetv_scheduled_delete_rule_confirm', name),
      actions: [
        { label: t('livetv_scheduled_delete_rule'), destructive: true, run: () => void repo.cancelSeries(id).then(() => showToast(t('livetv_toasts_series_canceled')), failed) },
        { label: t('cancel'), run: closeAlert },
      ],
      focusIndex: 1,
    });
  }
</script>

<div class="scheduled">
  <h2 class="t-title3">{t('livetv_scheduled_upcoming')}</h2>
  {#if !upcoming.length}
    <p class="t-body label-3 empty">{t('livetv_scheduled_empty')}</p>
  {:else}
    <div class="list" data-focus-group>
      {#each upcoming as x (x.id)}
        <button class="row" use:focusable onclick={() => openTimer(x)}>
          <span class="when mono">{day(x.start)}<br />{timeText(x.start, locale.current)} – {timeText(x.end, locale.current)}</span>
          <span class="text">
            <span class="t-headline ellipsis">{x.name}</span>
            <span class="t-footnote ellipsis sub">{repo.channel(x.channelId ?? '')?.name ?? ''}</span>
          </span>
          <span class="status t-footnote" class:live={x.status === 'recording'} class:warn={x.status === 'conflict-wont' || x.status === 'error'}>
            {#if x.status === 'recording'}<span class="rec"></span>{/if}{t(STATUS[x.status])}
          </span>
        </button>
      {/each}
    </div>
  {/if}

  <h2 class="t-title3 rules-title">{t('livetv_scheduled_rules')}</h2>
  {#if !rules.length}
    <p class="t-body label-3 empty">{t('livetv_scheduled_rules_empty')}</p>
  {:else}
    <div class="list" data-focus-group>
      {#each rules as r (String(r.Id))}
        {@const n = repo.timers.filter((x) => x.seriesTimerId === r.Id).length}
        <button class="row" use:focusable onclick={() => openRule(r)}>
          <span class="text">
            <span class="t-headline ellipsis">{String(r.Name ?? '')}</span>
            <span class="t-footnote ellipsis sub">
              {r.RecordAnyChannel ? t('livetv_scheduled_all_channels') : String(r.ChannelName ?? '')}{n
                ? ` · ${plural('livetv_scheduled_rule_episodes', n, n)}`
                : ''}
            </span>
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .scheduled {
    padding: 14rem 48rem 56rem;
  }
  h2 {
    margin: 0 0 12rem;
  }
  .rules-title {
    margin-top: 28rem;
  }
  p {
    margin: 0;
  }
  .empty {
    max-width: 640rem;
  }
  .row {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 64rem;
    margin-bottom: 6rem;
    padding: 10rem 16rem;
    border-radius: var(--r-md);
    background: var(--fill-1);
    color: var(--label);
    text-align: left;
    transition: background-color var(--t-fast);
  }
  .row > :global(* + *) {
    margin-left: 18rem;
  }
  .row:global(.focused) {
    background: #fff;
    color: #000;
  }
  .when {
    width: 150rem;
    flex-shrink: 0;
    font-family: 'Geist Mono', monospace;
    font-size: 14rem;
    color: var(--label-2);
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .sub {
    color: var(--label-3);
  }
  .status {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--label-2);
  }
  .status.live {
    color: #ff453a;
  }
  .status.warn {
    color: #ff9f0a;
  }
  .row:global(.focused) .when,
  .row:global(.focused) .sub,
  .row:global(.focused) .status {
    color: rgba(0, 0, 0, 0.65);
  }
  .rec {
    width: 9rem;
    height: 9rem;
    margin-right: 8rem;
    border-radius: 50%;
    background: #ff453a;
  }
</style>
