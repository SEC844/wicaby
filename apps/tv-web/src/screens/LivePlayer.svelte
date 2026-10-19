<script lang="ts">
  // Android TV LiveOverlay (player/LiveOverlay.kt, spec §8.3–§8.6): a channel full screen. CH+/CH- (and Up / Down)
  // zap with the merged presses of the shared reducer, a held key previewing in the banner; digits type a channel
  // number (top right, with what it points at); Left / Right page through the channel's programmes in the banner;
  // OK opens the mini-guide (the lineup at 34 %, the focused channel's next programmes beside it, the video full size);
  // INFO shows the banner, then its details. Red records the airing programme, green toggles the favourite, Back closes
  // the overlay on top, then leaves. Nothing here takes focus: one sink holds it and the keys are read here.
  import { getContext, onMount } from 'svelte';
  import type { ChannelRow, ProgramLite } from '$shared/livetv/model';
  import ChannelLogo from '../components/livetv/ChannelLogo.svelte';
  import Icon from '../components/Icon.svelte';
  import Pill from '../components/Pill.svelte';
  import Spinner from '../components/Spinner.svelte';
  import { focusable, setFocus } from '../lib/focus';
  import { locale, plural, t } from '../lib/i18n.svelte';
  import { LiveSession } from '../lib/live.svelte';
  import { DvrFailure, liveTv, progressOf, timeText } from '../lib/livetv.svelte';
  import { stopMusic } from '../lib/music.svelte';
  import { nav, onBack, SCREEN } from '../lib/nav.svelte';
  import { overlay } from '../lib/overlay.svelte';
  import { api } from '../lib/session.svelte';
  import { showToast } from '../lib/toast.svelte';
  import { createPlayer, platform } from '../platform';
  import { keyOf } from '../platform/keys';

  let { id, list: listIds }: { id: string; list?: string[] } = $props();
  const client = api()!;
  const repo = liveTv(client);

  const BANNER_MS = 5000;
  const GUIDE_ROWS = 7;
  const avplay = platform === 'tizen';

  let video: HTMLVideoElement;
  let sink: HTMLButtonElement;
  let live = $state<LiveSession | null>(null);
  let now = $state(Date.now());

  // --- Banner ---
  let banner = $state(true);
  let detail = $state(false);
  // Which programme of the channel the banner shows: 0 the airing one, then the next ones (Left / Right).
  let browse = $state(0);
  let bannerTimer = 0;
  function showBanner(): void {
    banner = true;
    clearTimeout(bannerTimer);
    if (!detail) bannerTimer = window.setTimeout(() => (banner = false), BANNER_MS);
  }

  const shownId = $derived(live?.bannerId || id);
  const shown = $derived(live ? (repo.channel(shownId) ?? live.list.find((c) => c.id === shownId)) : undefined);
  // The channel's programmes from the airing one on.
  function upcoming(chId: string, n: number): ProgramLite[] {
    void repo.rev;
    const l = repo.programsOf(chId) ?? [];
    const i = l.findIndex((p) => p.end > now);
    return i < 0 ? [] : l.slice(i, i + n);
  }
  const progs = $derived(shownId ? upcoming(shownId, 12) : []);
  const cur = $derived(progs[browse] ?? null);
  const after = $derived(progs[browse + 1] ?? null);
  $effect(() => {
    void shownId;
    browse = 0;
    if (shownId) void repo.ensure([shownId], now, now + 6 * 3_600_000);
  });

  // --- Mini-guide ---
  let guide = $state(false);
  let guideIndex = $state(0);
  const guideRows = $derived(live?.list ?? []);
  const guideFirst = $derived(Math.max(0, Math.min(guideIndex - 3, guideRows.length - GUIDE_ROWS)));
  const guideVisible = $derived(guideRows.slice(guideFirst, guideFirst + GUIDE_ROWS));
  const guideFocus = $derived(guideRows[guideIndex]);
  function openGuide(): void {
    if (!live) return;
    guideIndex = Math.max(0, guideRows.findIndex((c) => c.id === live!.channelId));
    guide = true;
    banner = false;
    detail = false;
  }
  $effect(() => {
    if (guide) void repo.ensure(guideVisible.map((c) => c.id), now, now + 3 * 3_600_000);
  });
  function guideMove(d: number): void {
    guideIndex = Math.max(0, Math.min(guideRows.length - 1, guideIndex + d));
  }

  // --- Actions ---
  const marked = $derived(repo.overlay);
  async function record(p: ProgramLite | null): Promise<void> {
    if (!p || !repo.canRecord) return;
    const timer = marked.get(p.id);
    try {
      if (timer) {
        await repo.cancelTimer(timer.id);
        showToast(t('livetv_toasts_recording_canceled'));
      } else {
        await repo.record(p.id, false);
        showToast(t('player_live_recording_scheduled'));
      }
    } catch (e) {
      const k = e instanceof DvrFailure ? e.kind : 'server';
      showToast(k === 'forbidden' ? t('player_live_record_forbidden') : k === 'premiere' ? t('player_live_record_premiere') : k === 'already-scheduled' ? t('player_live_already_scheduled') : t('player_live_record_failed'));
    }
  }
  async function favorite(row: ChannelRow | undefined): Promise<void> {
    if (!row) return;
    const on = !row.favorite;
    await repo.setFavorite(row.id, on).then(
      () => showToast(on ? t('player_live_favorite_added') : t('player_live_favorite_removed')),
      () => showToast(t('livetv_toasts_favorites_unavailable')),
    );
  }

  // --- The remote ---
  const DIGITS: Record<number, string> = {};
  for (let d = 0; d <= 9; d++) DIGITS[48 + d] = DIGITS[96 + d] = String(d);
  const SEPARATORS = new Set([110, 189, 190, 109]);
  const ZAP_KEYS = new Set(['channelUp', 'channelDown', 'next', 'prev', 'up', 'down']);
  let zapKey: string | null = null;

  function onKey(e: KeyboardEvent): void {
    if (overlay.alert || !document.querySelector('[data-screen-top] .live') || !live) return;
    const key = keyOf(e);
    const digit = DIGITS[e.keyCode];
    const consume = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const at = Date.now();
    if (digit !== undefined) return consume(), void live.digit({ type: 'digit', d: digit, at });
    if (SEPARATORS.has(e.keyCode) && live.typing) return consume(), void live.digit({ type: 'separator', at });
    if (!key || key === 'back') return;
    consume();
    if (live.typing) {
      if (key === 'ok') return void live.digit({ type: 'enter', at });
      if (key === 'up' || key === 'down') return void live.digit({ type: 'pick', delta: key === 'up' ? -1 : 1, at });
      return;
    }
    if (key === 'playPause' || key === 'play' || key === 'pause') return void (!e.repeat && live.togglePause());
    if (key === 'stop') return void nav.back();
    if (guide) {
      if (key === 'up' || key === 'down') return guideMove(key === 'up' ? -1 : 1);
      if (key === 'channelUp' || key === 'channelDown') return guideMove(key === 'channelUp' ? -GUIDE_ROWS : GUIDE_ROWS);
      if (key === 'ok' && !e.repeat && guideFocus) {
        guide = false;
        live.tuneTo(guideFocus.id);
        return showBanner();
      }
      if (key === 'green') return void favorite(guideFocus);
      return;
    }
    if (ZAP_KEYS.has(key)) {
      zapKey = key;
      live.press(key === 'channelUp' || key === 'next' || key === 'up' ? 1 : -1, e.repeat);
      detail = false;
      return showBanner();
    }
    if (key === 'left' || key === 'right') {
      browse = Math.max(0, Math.min(progs.length - 1, browse + (key === 'right' ? 1 : -1)));
      return showBanner();
    }
    if (key === 'ok') return void (!e.repeat && (live.error ? live.retry() : openGuide()));
    if (key === 'info') {
      if (banner && !detail) {
        detail = true;
        clearTimeout(bannerTimer);
      } else showBanner();
      return;
    }
    if (key === 'red') return void record(cur);
    if (key === 'green') return void favorite(live.channel);
    showBanner();
  }
  function onKeyUp(e: KeyboardEvent): void {
    const key = keyOf(e);
    if (live && zapKey && key === zapKey) {
      zapKey = null;
      live.keyUp();
    }
  }

  const screen = getContext<number>(SCREEN);
  onMount(() => {
    stopMusic();
    document.documentElement.classList.toggle('avplay', avplay);
    const player = createPlayer(video);
    let rows = repo.channels;
    if (listIds?.length) {
      const byId = new Map(rows.map((r) => [r.id, r] as const));
      rows = listIds.map((x) => byId.get(x)).filter((r): r is ChannelRow => !!r);
    }
    const s = new LiveSession(repo, player, rows, id);
    live = s;
    s.start();
    showBanner();
    setFocus(sink);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    const clock = setInterval(() => (now = Date.now()), 15_000);
    if (!repo.loaded) void repo.loadChannels();
    void repo.loadTimers();
    const stopBack = onBack(screen, () => {
      if (live?.typing) return live.digit({ type: 'escape', at: Date.now() }), true;
      if (guide) return (guide = false), true;
      if (detail) return (detail = false), showBanner(), true;
      if (banner && !live?.error) return (banner = false), true;
      return false;
    });
    return () => {
      stopBack();
      clearInterval(clock);
      clearTimeout(bannerTimer);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
      s.stop();
      document.documentElement.classList.remove('avplay');
    };
  });

  const position = $derived(live && shown ? live.position(shown.id) : 0);
  const digitRow = $derived.by(() => {
    const p = live?.digits?.preview;
    const pid = p?.kind === 'exact' ? p.ids[p.pick] : p?.kind === 'prefix' || p?.kind === 'alias' ? p.id : undefined;
    return pid ? repo.channel(pid) : undefined;
  });
  const range = (p: ProgramLite) => `${timeText(p.start, locale.current)} – ${timeText(p.end, locale.current)}`;
</script>

<div class="live" class:avplay>
  <video bind:this={video} class="video" class:hidden={avplay} playsinline></video>
  <button class="sink" bind:this={sink} use:focusable aria-label={shown?.name ?? ''}></button>

  {#if live}
    {#if live.tuning && !live.error && shown}
      <!-- While the next channel loads, its logo on black with the airing title (§8.1). -->
      <div class="tune">
        <ChannelLogo {repo} row={shown} height={72} />
        <div class="tune-line">
          <Spinner size={22} />
          <span class="t-callout label-2">{cur?.title ?? t('player_live_tuning')}</span>
        </div>
      </div>
    {:else if live.buffering && !live.error}
      <div class="center"><Spinner size={44} /></div>
    {/if}

    {#if live.error}
      <div class="center message">
        <p class="t-title2">{live.error}</p>
        <p class="t-callout label-2 hint">{t('back_to_exit')}</p>
        <Pill text={t('retry')} icon="Refresh" onclick={() => live?.retry()} />
      </div>
    {/if}

    {#if live.digits}
      <div class="digits panel">
        <p class="buf mono">{live.digits.buf.split('').join(' ')}{live.digits.buf.length < 6 ? ' _' : ''}</p>
        {#if live.digits.preview?.kind === 'exact' && live.digits.preview.ids.length > 1}
          <p class="t-caption label-2">{plural('player_live_duplicates', live.digits.preview.ids.length, live.digits.preview.ids.length)}</p>
        {/if}
        {#if digitRow}
          <div class="digit-row">
            <ChannelLogo {repo} row={digitRow} height={24} fallback={false} />
            <span class="t-headline ellipsis" class:dim={live.digits.preview?.kind === 'prefix'}>{digitRow.name}</span>
          </div>
        {:else if live.digits.preview}
          <p class="t-callout label-3">{t('player_live_no_match')}</p>
        {/if}
      </div>
    {:else if live.noMatch}
      <div class="digits panel"><p class="t-headline">{t('player_live_no_channel', live.noMatch)}</p></div>
    {/if}

    {#if guide}
      <div class="mini">
        <div class="mini-list panel">
          {#each guideVisible as row, k (row.id)}
            {@const a = upcoming(row.id, 1)[0]}
            <div class="mini-row" class:focused={guideFirst + k === guideIndex} class:current={row.id === live.channelId}>
              <span class="mono num">{row.number}</span>
              <ChannelLogo {repo} {row} height={26} width={56} plate />
              <span class="mini-text">
                <span class="t-headline ellipsis">{row.name}</span>
                {#if a && a.start <= now}
                  <span class="t-caption ellipsis sub">{a.title}</span>
                  <span class="bar"><span style="transform:scaleX({progressOf(a, now)})"></span></span>
                {/if}
              </span>
              {#if a && marked.has(a.id)}<span class="rec"></span>{/if}
              {#if row.favorite}<Icon name="Heart" size={16} />{/if}
            </div>
          {/each}
        </div>
        {#if guideFocus}
          <div class="mini-pane panel">
            {#each upcoming(guideFocus.id, 5) as p, k (p.id)}
              <div class="pane-row">
                {#if k === 0 && p.start <= now}<span class="t-eyebrow time">{t('player_live_now')}</span>{:else}<span class="mono time">{timeText(p.start, locale.current)}</span>{/if}
                <span class="t-callout ellipsis" class:label-2={k > 0}>{p.title}</span>
              </div>
            {:else}
              <p class="t-callout label-3">{t('livetv_guide_no_info')}</p>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if banner && shown && !guide}
      <div class="banner panel">
        <div class="head">
          {#if shown.number}<span class="mono chnum">{shown.number}</span>{/if}
          <ChannelLogo {repo} row={shown} height={40} />
          <span class="t-title3 ellipsis chname">{shown.name}</span>
          {#if shown.favorite}<Icon name="Heart" size={18} />{/if}
          <span class="t-footnote label-3 pos">{t('player_live_lens_position', t('livetv_lens_all'), position, live.list.length)}</span>
          <span class="mono clock">{timeText(now, locale.current)}</span>
        </div>
        {#if cur}
          <div class="prog">
            <span class="t-eyebrow label-3 tag">{browse === 0 && cur.start <= now ? t('player_live_now') : timeText(cur.start, locale.current)}</span>
            <span class="t-headline ellipsis">{cur.title}{cur.episodeTitle ? ` · ${cur.episodeTitle}` : ''}</span>
            {#if marked.has(cur.id)}<span class="rec"></span>{/if}
            <span class="mono label-2 range">{range(cur)}</span>
          </div>
          {#if browse === 0 && cur.start <= now}
            <span class="bar wide"><span style="transform:scaleX({progressOf(cur, now)})"></span></span>
          {/if}
          {#if after}
            <div class="prog next">
              <span class="t-eyebrow label-3 tag">{t('player_live_next')}</span>
              <span class="t-callout ellipsis label-2">{after.title}</span>
              <span class="mono label-3 range">{timeText(after.start, locale.current)}</span>
            </div>
          {/if}
        {:else}
          <p class="t-callout label-3 prog">{t('livetv_guide_no_info')}</p>
        {/if}
        {#if detail && cur}
          {#await repo.programItem(cur.id) then full}
            {#if full.Overview}<p class="t-callout label-2 overview">{full.Overview}</p>{/if}
          {:catch}{/await}
          <p class="t-caption label-3 keys">
            {#if repo.canRecord}<span class="key red"></span>{marked.has(cur.id) ? t('livetv_actions_cancel_recording') : t('player_live_record')}{/if}
            <span class="key green"></span>{shown.favorite ? t('livetv_channel_favorite_remove') : t('livetv_channel_favorite_add')}
          </p>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .live {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
    background: #000;
    color: #fff;
  }
  .live.avplay {
    background: transparent;
  }
  .video {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
  }
  .hidden {
    display: none;
  }
  .sink {
    position: absolute;
    top: 0;
    left: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  p {
    margin: 0;
  }
  .panel {
    background: rgba(18, 18, 22, 0.88);
    border-radius: var(--r-xl);
  }
  .mono {
    font-family: 'Geist Mono', monospace;
  }
  .center {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }
  .message {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .message .hint {
    margin: 8rem 0 24rem;
  }
  .tune {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #000;
  }
  .tune-line {
    display: flex;
    align-items: center;
    margin-top: 20rem;
  }
  .tune-line > :global(* + *) {
    margin-left: 12rem;
  }
  /* Bottom, inside the 48 / 27 dp safe area. */
  .banner {
    position: absolute;
    left: 48rem;
    right: 48rem;
    bottom: 27rem;
    padding: 18rem 24rem;
  }
  .head {
    display: flex;
    align-items: center;
  }
  .head > :global(* + *) {
    margin-left: 14rem;
  }
  .chnum {
    font-size: 26rem;
    font-weight: 600;
  }
  .chname {
    min-width: 0;
  }
  .pos {
    flex: 1;
    text-align: right;
    white-space: nowrap;
  }
  .clock {
    font-size: 17rem;
  }
  .prog {
    display: flex;
    align-items: baseline;
    margin-top: 12rem;
  }
  .prog > :global(* + *) {
    margin-left: 12rem;
  }
  .prog.next {
    margin-top: 8rem;
  }
  .tag {
    width: 92rem;
    flex-shrink: 0;
  }
  .range {
    margin-left: auto !important;
    padding-left: 16rem;
    white-space: nowrap;
    font-size: 15rem;
  }
  .bar {
    position: relative;
    display: block;
    height: 4rem;
    margin-top: 6rem;
    border-radius: 2rem;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.18);
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
  .bar.wide {
    margin: 10rem 0 0 104rem;
  }
  .rec {
    width: 10rem;
    height: 10rem;
    flex-shrink: 0;
    border-radius: 50%;
    background: #ff453a;
  }
  .overview {
    margin-top: 12rem;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .keys {
    display: flex;
    align-items: center;
    margin-top: 12rem;
  }
  .key {
    width: 12rem;
    height: 12rem;
    margin: 0 6rem 0 16rem;
    border-radius: 3rem;
  }
  .key:first-child {
    margin-left: 0;
  }
  .key.red {
    background: #ff453a;
  }
  .key.green {
    background: #30d158;
  }
  /* Number entry: top right. */
  .digits {
    position: absolute;
    top: 27rem;
    right: 48rem;
    width: 300rem;
    padding: 20rem;
    text-align: right;
  }
  .buf {
    font-size: 40rem;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .digit-row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    margin-top: 8rem;
  }
  .digit-row > :global(* + *) {
    margin-left: 10rem;
  }
  .dim {
    color: var(--label-2);
  }
  /* The mini-guide: the list at 34 % (min 360 dp), the focused channel's next programmes at 26 %. */
  .mini {
    position: absolute;
    top: 27rem;
    bottom: 27rem;
    left: 48rem;
    display: flex;
    align-items: flex-start;
  }
  .mini-list {
    width: 34vw;
    min-width: 360rem;
    padding: 8rem;
  }
  .mini-row {
    display: flex;
    align-items: center;
    height: 64rem;
    padding: 0 12rem;
    border-radius: var(--r-md);
  }
  .mini-row > :global(* + *) {
    margin-left: 12rem;
  }
  .mini-row.current .num {
    color: var(--accent);
  }
  .mini-row.focused {
    background: #fff;
    color: #000;
  }
  .num {
    width: 36rem;
    font-size: 15rem;
    color: var(--label-2);
  }
  .mini-row.focused .num,
  .mini-row.focused .sub {
    color: rgba(0, 0, 0, 0.6);
  }
  .mini-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .sub {
    color: var(--label-2);
  }
  .mini-text .bar {
    margin-top: 4rem;
    height: 3rem;
  }
  .mini-row.focused .bar {
    background: rgba(0, 0, 0, 0.15);
  }
  .mini-pane {
    width: 26vw;
    margin-left: 12rem;
    padding: 16rem 20rem;
  }
  .pane-row {
    display: flex;
    align-items: baseline;
    padding: 6rem 0;
  }
  .pane-row .time {
    width: 116rem;
    flex-shrink: 0;
    font-size: 14rem;
    color: var(--label-3);
  }
</style>
