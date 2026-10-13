<script lang="ts" module>
  import { t } from '../../lib/i18n.svelte';

  type Dto = Record<string, unknown>;

  // "Toutes les chaînes · Inédits · 5 derniers épisodes · marges −2 / +30 min" (§9.4).
  export function ruleSummary(r: Dto): string {
    const keep = Number(r.KeepUpTo ?? 0);
    const pre = Math.round(Number(r.PrePaddingSeconds ?? 0) / 60);
    const post = Math.round(Number(r.PostPaddingSeconds ?? 0) / 60);
    return [
      r.RecordAnyChannel ? t('livetv.scheduled.allChannels') : typeof r.ChannelName === 'string' ? r.ChannelName : '',
      r.RecordNewOnly ? t('livetv.category.new') : '',
      keep > 0 ? t('livetv.record.keepUpToValue', { count: keep }) : '',
      pre || post ? t('livetv.scheduled.padding', { pre, post }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
</script>

<script lang="ts">
  import type { TimerLite } from '../../../shared/livetv/model';
  import { fmt } from '../../lib/i18n.svelte';
  import type { LiveTvStore } from '../../lib/livetv.svelte';
  import { toast } from '../../lib/stores.svelte';
  import Sheet from '../Sheet.svelte';
  import { dvrToast, dvrWritten } from './RecordOptionsSheet.svelte';

  // One series rule (§9.4): its summary, the episodes it has scheduled (from the timer overlay, no
  // extra request), skip an episode, edit the rule, delete it (the server cascades).
  let { store, ruleId, onclose, onedit }: { store: LiveTvStore; ruleId: string | null; onclose: () => void; onedit: (id: string) => void } = $props();

  let confirming = $state(false);
  let busy = $state(false);

  const rule = $derived(ruleId ? (store.dvr.rules.find((r) => r.Id === ruleId) ?? null) : null);
  const episodes = $derived(ruleId ? store.dvr.timers.filter((x: TimerLite) => x.seriesTimerId === ruleId && x.end > store.clock) : []);
  const name = $derived(typeof rule?.Name === 'string' ? rule.Name : '');

  $effect(() => {
    if (!ruleId) return;
    confirming = false;
    if (!store.dvr.rules.some((r) => r.Id === ruleId)) void store.dvr.loadRules().catch(() => undefined);
  });

  async function run(fn: () => Promise<void>, done: string, close = false): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await fn();
      dvrWritten(store);
      toast('success', done);
      if (close) onclose();
    } catch (err) {
      dvrToast(err);
    } finally {
      busy = false;
    }
  }
</script>

<Sheet open={ruleId !== null} {onclose} label={name || t('livetv.scheduled.viewRule')} width={520}>
  <div class="rule">
    <h2 class="title-3">{name}</h2>
    {#if rule}<p class="footnote">{ruleSummary(rule)}</p>{/if}
    <p class="headline">{t('livetv.scheduled.ruleEpisodes', { count: episodes.length })}</p>
    {#if episodes.length}
      <ul class="list">
        {#each episodes as ep (ep.id)}
          <li>
            <span class="when mono">{fmt.day(ep.start)} · {fmt.time(ep.start)}</span>
            <span class="name">{ep.name}</span>
            {#if store.dvr.canRecord}
              <button class="btn ghost" disabled={busy} onclick={() => run(() => store.dvr.cancelTimer(ep.id), t('livetv.toasts.recordingCanceled'))}>{t('livetv.scheduled.skipEpisode')}</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if store.dvr.canRecord && ruleId}
      {#if confirming}
        <div class="confirm" role="alertdialog" aria-label={t('livetv.scheduled.deleteRule')}>
          <p>{t('livetv.scheduled.deleteRuleConfirm', { name })}</p>
          <div class="actions">
            <button class="btn" data-autofocus onclick={() => (confirming = false)}>{t('common.actions.cancel')}</button>
            <button class="btn danger" disabled={busy} onclick={() => run(() => store.dvr.cancelSeriesTimer(ruleId), t('livetv.toasts.seriesCanceled'), true)}>{t('livetv.scheduled.deleteRule')}</button>
          </div>
        </div>
      {:else}
        <div class="actions">
          <button class="btn danger" onclick={() => (confirming = true)}>{t('livetv.scheduled.deleteRule')}</button>
          <button class="btn" data-autofocus onclick={() => onedit(ruleId)}>{t('livetv.scheduled.editRule')}</button>
        </div>
      {/if}
    {/if}
  </div>
</Sheet>

<style>
  .rule {
    display: grid;
    gap: 10px;
    padding: 24px 24px 20px;
  }
  h2,
  p {
    margin: 0;
  }
  h2 {
    padding-right: 32px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
    max-height: 40vh;
    overflow-y: auto;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    color: var(--label-2);
  }
  .when {
    flex: none;
    color: var(--label-3);
    font-size: var(--fs-footnote);
  }
  .name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .confirm {
    display: grid;
    gap: 10px;
    padding: 12px;
    border-radius: var(--r-md);
    background: var(--fill-1);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding-top: 6px;
  }
</style>
