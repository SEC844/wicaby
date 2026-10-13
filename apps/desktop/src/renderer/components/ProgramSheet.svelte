<script lang="ts">
  import { nameKey } from '../../shared/livetv/channel-order';
  import { otherAirings } from '../../shared/livetv/dialect';
  import { markFor } from '../../shared/livetv/timers';
  import type { Mark } from '../../shared/livetv/timers';
  import { w } from '../lib/bridge';
  import { fmt, t } from '../lib/i18n.svelte';
  import { imageUrl } from '../lib/images';
  import { airing, currentLiveServer, live, openProgram, playChannel, programSheet, span, storeFor, type Program } from '../lib/livetv.svelte';
  import { toggleReminder } from '../lib/livetv/reminders';
  import { reveal } from '../lib/motion';
  import { errorMessage, toast } from '../lib/stores.svelte';
  import Icon from './Icon.svelte';
  import RecordOptionsSheet, { checkRecordPolicy, dvrToast } from './livetv/RecordOptionsSheet.svelte';
  import type { RecordTarget } from './livetv/RecordOptionsSheet.svelte';
  import SeriesRuleSheet from './livetv/SeriesRuleSheet.svelte';
  import Sheet from './Sheet.svelte';

  type Dto = Record<string, unknown>;

  const p = $derived(programSheet.program);
  const channel = $derived(programSheet.channel);
  let busy = $state(false);
  let fetched = '';

  // DVR (§9.1, §6.7): the timer overlay gives the mark and the timer; the record actions hide without
  // Policy.EnableLiveTvManagement or after a 403. The child sheets replace this one while open.
  const store = $derived(p ? storeFor(p.ServerId ?? currentLiveServer()) : null);
  const dvr = $derived(store?.dvr ?? null);
  const canRecord = $derived(dvr?.canRecord ?? false);
  const overlay = $derived(dvr?.overlay ?? null);
  const timer = $derived(p?.Id && overlay ? (overlay.get(p.Id) ?? null) : null);
  const timerId = $derived(overlay ? timer?.id : p?.TimerId);
  const ruleId = $derived(timer?.seriesTimerId ?? p?.SeriesTimerId);
  const mark = $derived<Mark | null>(p?.Id ? markFor({ id: p.Id, timerId: p.TimerId, seriesTimerId: p.SeriesTimerId }, overlay) : null);
  const MARK_TEXT: Record<Mark, string> = {
    timer: 'marks.timer',
    series: 'marks.series',
    recording: 'marks.recording',
    'conflict-wont': 'marks.wontRecord',
    'conflict-ok': 'marks.conflictOk',
    error: 'marks.error',
    'rule-skip': 'marks.ruleSkips',
  };
  let options = $state<RecordTarget | null>(null);
  let ruleOpen = $state<string | null>(null);

  // Start over (LT-18): the airing programme has a timer and an in-progress recording matches it.
  let startOver = $state.raw<Dto | null>(null);
  // Watch-from-start prompt (F2): how long ago the recording started, while asked.
  let ask = $state<number | null>(null);
  let askTimer: ReturnType<typeof setTimeout> | undefined;
  // Other airings (LT-21), loaded on demand.
  let airings = $state.raw<Program[] | null>(null);
  let airingsBusy = $state(false);

  // The guide sends a light program; the detail call adds overview, IsSeries and timer ids.
  $effect(() => {
    const id = p?.Id;
    const server = p?.ServerId;
    if (!id || `${server}:${id}` === fetched) return;
    fetched = `${server}:${id}`;
    startOver = null;
    airings = null;
    if (store) checkRecordPolicy(store);
    live
      .program(id, server)
      .then((full) => {
        if (programSheet.program?.Id === id) programSheet.program = { ...programSheet.program, ...full };
      })
      .catch(() => undefined);
  });

  // Reminder (§9.6): read from main's list when the sheet shows an upcoming programme.
  let reminded = $state(false);
  $effect(() => {
    const id = p?.Id;
    const server = p?.ServerId ?? currentLiveServer();
    reminded = false;
    if (id && upcoming) void w.reminders.list().then((l) => (reminded = l.some((r) => r.programId === id && r.serverId === server)), () => undefined);
  });

  async function remind(): Promise<void> {
    const server = p?.ServerId ?? currentLiveServer();
    const channelId = channel?.Id ?? p?.ChannelId;
    if (!p?.Id || !p.StartDate || !server || !channelId) return;
    const on = await toggleReminder({ serverId: server, programId: p.Id, channelId, start: Date.parse(p.StartDate), title: p.Name ?? '', channelName: channel?.Name ?? p.ChannelName ?? '' });
    if (on !== null) reminded = on;
  }

  const art = $derived.by(() => {
    if (!p) return null;
    if (p.Id && p.ImageTags?.Thumb) return imageUrl(p.Id, 'Thumb', { tag: p.ImageTags.Thumb, maxWidth: 560, server: p.ServerId });
    if (p.Id && p.ImageTags?.Primary) return imageUrl(p.Id, 'Primary', { tag: p.ImageTags.Primary, maxWidth: 560, server: p.ServerId });
    return null;
  });
  const logoId = $derived(channel?.Id ?? p?.ChannelId);
  const logoTag = $derived(channel?.ImageTags?.Primary ?? (p as (Program & { ChannelPrimaryImageTag?: string }) | null)?.ChannelPrimaryImageTag);
  const pct = $derived(airing(p));
  const upcoming = $derived(p?.StartDate ? Date.parse(p.StartDate) > Date.now() : false);
  const ended = $derived(p?.EndDate ? Date.parse(p.EndDate) <= Date.now() : false);
  const day = $derived(
    p?.StartDate ? fmt.date(p.StartDate, { weekday: 'long', day: 'numeric', month: 'long' }) : '',
  );

  // The in-progress recording of the airing programme: by ProgramId, else same channel and overlap.
  $effect(() => {
    const id = p?.Id;
    const d = dvr;
    if (!id || !d || !timerId || upcoming || ended || startOver) return;
    const s = Date.parse(p?.StartDate ?? '');
    const e = Date.parse(p?.EndDate ?? '');
    const ch = p?.ChannelId;
    d.loadRecordings(true).then(
      (list) => {
        if (programSheet.program?.Id !== id) return;
        startOver = list.find((r) => r.ProgramId === id) ?? list.find((r) => r.ChannelId === ch && Date.parse(String(r.StartDate)) < e && Date.parse(String(r.EndDate)) > s) ?? null;
      },
      () => undefined,
    );
  });

  function close(): void {
    fetched = '';
    clearTimeout(askTimer);
    ask = null;
    programSheet.program = null;
    programSheet.channel = null;
  }

  async function act(fn: () => Promise<void>, done: string, action?: { label: string; run: () => void }): Promise<void> {
    if (!p?.Id || busy) return;
    busy = true;
    try {
      await fn();
      toast('success', done, action);
      const fresh = await live.program(p.Id, p.ServerId);
      openProgram({ ...p, ...fresh, TimerId: fresh.TimerId, SeriesTimerId: fresh.SeriesTimerId }, channel);
    } catch (err) {
      dvrToast(err);
    } finally {
      busy = false;
    }
  }

  // The quick-record toast's "Options…" edits the new timer while this sheet still shows its programme.
  function optionsAfterRecord(pid: string): { label: string; run: () => void } {
    return {
      label: t('livetv.record.options'),
      run: () => {
        const id = dvr?.overlay?.get(pid)?.id;
        if (programSheet.program?.Id === pid && id && !id.startsWith('pending-')) options = { kind: 'timer', id };
      },
    };
  }

  function watchLive(): void {
    const id = channel?.Id ?? p?.ChannelId;
    const server = channel?.ServerId ?? p?.ServerId;
    close();
    void playChannel(id, server);
  }

  // F2: a recording that started more than 60 s ago offers the start; live is the default after 8 s.
  function watch(): void {
    const began = Date.parse(String(startOver?.StartDate ?? ''));
    if (startOver && Date.now() - began > 60_000) {
      ask = Date.now() - began;
      askTimer = setTimeout(watchLive, 8_000);
      return;
    }
    watchLive();
  }

  function playFromStart(): void {
    clearTimeout(askTimer);
    const id = startOver?.Id;
    const server = p?.ServerId;
    if (typeof id !== 'string') return;
    close();
    w.playback.play({ itemIds: [id], serverId: server, startPositionTicks: 0 }).catch((err: unknown) => toast('error', errorMessage(err)));
  }

  // Emby: by name, keeping exact folded matches; Jellyfin: by series rule, else nothing (§5.1).
  async function loadAirings(): Promise<void> {
    const s = store;
    const prog = p;
    if (!s || !prog?.Name || airingsBusy) return;
    const req = otherAirings(s.kind, { userId: s.userId, name: prog.Name, now: s.now(), seriesTimerId: ruleId });
    if (!req) {
      airings = [];
      return;
    }
    airingsBusy = true;
    try {
      const r = await s.api.run<{ Items?: Program[] }>(req);
      const key = nameKey(prog.Name);
      if (programSheet.program?.Id === prog.Id) airings = (r.data?.Items ?? []).filter((x) => x.Id !== prog.Id && nameKey(x.Name) === key).map((x) => ({ ...x, ServerId: s.serverId }));
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      airingsBusy = false;
    }
  }
</script>

<Sheet open={Boolean(p) && !options && !ruleOpen} onclose={close} label={p?.Name ?? t('livetv.program.label')} width={560}>
  {#if p}
    <div class="art">
      {#if art}
        <img class="reveal" use:reveal src={art} alt="" decoding="async" />
      {:else if logoId && logoTag}
        <img class="logo reveal" use:reveal src={imageUrl(logoId, 'Primary', { tag: logoTag, maxWidth: 240, server: channel?.ServerId ?? p?.ServerId })} alt="" decoding="async" />
      {:else}
        <Icon name="live" size={40} />
      {/if}
      {#if pct > 0 && !ended}<span class="bar"><span style:transform="scaleX({pct})"></span></span>{/if}
    </div>
    <div class="body">
      <div class="eyebrow">{[channel?.Name ?? p.ChannelName, pct > 0 && !ended ? t('livetv.program.onNow') : day].filter(Boolean).join(' · ')}</div>
      <h2 class="title-2">{p.Name}</h2>
      {#if p.EpisodeTitle}<div class="ep">{p.EpisodeTitle}</div>{/if}
      <div class="meta">
        {#if span(p)}<span>{span(p)}</span>{/if}
        {#if p.IsNew}<span class="chip">{t('livetv.program.new')}</span>{/if}
        {#if p.IsLive}<span class="chip">{t('livetv.program.live')}</span>{/if}
        {#if p.OfficialRating}<span class="chip">{p.OfficialRating}</span>{/if}
        {#if mark}<span class="rec" data-mark={mark}><span class="dot" aria-hidden="true"></span>{t(`livetv.${MARK_TEXT[mark]}`)}</span>{/if}
      </div>
      {#if p.Overview}<p class="overview">{p.Overview}</p>{/if}

      {#if ask !== null}
        <div class="actions" role="group" aria-label={t('livetv.program.watch')}>
          <button class="btn lg" onclick={playFromStart}><Icon name="prev" size={16} /> {t('player.live.watchFromStart', { time: fmt.duration(ask) })}</button>
          <button class="btn light lg" onclick={() => (clearTimeout(askTimer), watchLive())} data-autofocus><Icon name="play" size={16} fill stroke={0} /> {t('player.live.watchLive')}</button>
        </div>
      {:else}
        <div class="actions">
          {#if !upcoming && !ended}
            <button class="btn light lg" onclick={watch} data-autofocus><Icon name="play" size={16} fill stroke={0} /> {t('livetv.program.watch')}</button>
            {#if startOver}
              <button class="btn lg" onclick={playFromStart}><Icon name="prev" size={16} /> {t('livetv.sheet.startOver')}</button>
            {/if}
          {/if}
          {#if p.Id && !ended && canRecord}
            {#if timerId}
              {@const tid = timerId}
              <button class="btn lg" disabled={busy} onclick={() => act(() => live.cancelTimer(tid, p.ServerId), t('livetv.toasts.recordingCanceled'))}>
                <Icon name="close" size={16} /> {t(ruleId ? 'livetv.scheduled.skipEpisode' : 'livetv.actions.cancelRecording')}
              </button>
              {#if !tid.startsWith('pending-')}
                <button class="btn lg" onclick={() => (options = { kind: 'timer', id: tid })}><Icon name="customize" size={16} /> {t('livetv.scheduled.editPadding')}</button>
              {/if}
            {:else}
              <span class="split">
                <button class="btn lg" disabled={busy} onclick={() => act(() => live.record(p.Id, false, p.ServerId), t('livetv.toasts.recordingScheduled'), optionsAfterRecord(p.Id))} data-autofocus={upcoming || undefined}>
                  <Icon name="record" size={16} /> {t('livetv.record.quick')}
                </button>
                <button class="btn lg icon" onclick={() => (options = { kind: 'new', programId: p.Id, series: false, isSeries: Boolean(p.IsSeries) })} aria-label={t('livetv.record.options')} title={t('livetv.record.options')}>
                  <Icon name="chevronDown" size={16} />
                </button>
              </span>
            {/if}
            {#if ruleId}
              {@const rid = ruleId}
              <button class="btn lg" onclick={() => (ruleOpen = rid)}><Icon name="recordSeries" size={16} /> {t('livetv.scheduled.viewRule')}</button>
            {:else if p.IsSeries}
              <button class="btn lg" disabled={busy} onclick={() => act(() => live.record(p.Id, true, p.ServerId), t('livetv.toasts.seriesScheduled'))}>
                <Icon name="recordSeries" size={16} /> {t('livetv.record.series')}
              </button>
            {/if}
          {/if}
          {#if upcoming && p.Id}
            <button class="btn lg" onclick={remind}><Icon name="bell" size={16} /> {t(reminded ? 'livetv.sheet.cancelReminder' : 'livetv.sheet.remindMe')}</button>
          {/if}
        </div>
      {/if}

      {#if p.Id && p.Name && store}
        <div class="airings">
          {#if airings === null}
            <button class="btn ghost" disabled={airingsBusy} onclick={loadAirings}><Icon name="list" size={15} /> {t('livetv.sheet.otherAirings')}</button>
          {:else}
            <h3 class="headline">{t('livetv.sheet.otherAirings')}</h3>
            {#if airings.length}
              <ul>
                {#each airings as a (a.Id)}
                  <li>
                    <button onclick={() => openProgram(a)}>
                      <span class="mono">{a.StartDate ? `${fmt.day(a.StartDate)} · ${span(a)}` : ''}</span>
                      <span class="ch">{a.ChannelName ?? ''}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="footnote">{t('livetv.sheet.otherAiringsEmpty')}</p>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</Sheet>

{#if store}
  <RecordOptionsSheet {store} target={options} onclose={() => (options = null)} />
  <SeriesRuleSheet {store} ruleId={options ? null : ruleOpen} onclose={() => (ruleOpen = null)} onedit={(id) => (options = { kind: 'rule', id })} />
{/if}

<style>
  .art {
    position: relative;
    aspect-ratio: 16 / 9;
    display: grid;
    place-items: center;
    overflow: hidden;
    color: var(--label-3);
    background: linear-gradient(160deg, var(--bg-elevated-2), var(--bg-elevated));
  }
  .art img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .art img.logo {
    position: static;
    width: 40%;
    height: 40%;
    object-fit: contain;
  }
  .bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgb(255 255 255 / 0.2);
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
  }
  .body {
    padding: 22px 28px 28px;
  }
  h2 {
    margin: 6px 0 0;
  }
  .ep {
    margin-top: 2px;
    font-size: var(--fs-headline);
    color: var(--label-2);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    font-size: var(--fs-footnote);
    color: var(--label-2);
    font-variant-numeric: tabular-nums;
  }
  .rec {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--label);
  }
  /* §6.7: red only for recording marks, static; the shape tells them apart too. */
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--red);
  }
  .rec[data-mark='series'] .dot {
    box-shadow:
      0 0 0 1.5px var(--bg-elevated),
      0 0 0 3px var(--red);
  }
  .rec[data-mark='conflict-wont'] .dot,
  .rec[data-mark='rule-skip'] .dot {
    background: var(--label-3);
  }
  .rec[data-mark='error'] .dot {
    background: var(--label-2);
    border-radius: 1px;
  }
  .overview {
    margin: 14px 0 0;
    font-size: var(--fs-body);
    line-height: 1.5;
    color: var(--label-2);
    display: -webkit-box;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 22px;
  }
  .actions .btn.lg {
    height: 42px;
    padding: 0 20px;
    font-size: var(--fs-callout);
  }
  .actions .btn:focus-visible {
    transform: scale(1.04);
  }
  .actions .btn.light:focus-visible {
    background: #fff;
  }
  .split {
    display: inline-flex;
    gap: 2px;
  }
  .split .btn:first-child {
    border-radius: 999px 4px 4px 999px;
  }
  .actions .split .btn.icon {
    width: 40px;
    padding: 0;
    border-radius: 4px 999px 999px 4px;
  }
  .airings {
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid var(--separator);
  }
  .airings h3,
  .airings p {
    margin: 0 0 6px;
  }
  .airings ul {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 200px;
    overflow-y: auto;
  }
  .airings li button {
    display: flex;
    gap: 12px;
    width: 100%;
    padding: 7px 10px;
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--label-2);
    font-size: var(--fs-footnote);
  }
  .airings li button:is(:hover, :focus-visible) {
    background: var(--fill-3);
    color: var(--label);
  }
  .airings .ch {
    color: var(--label-3);
  }
</style>
