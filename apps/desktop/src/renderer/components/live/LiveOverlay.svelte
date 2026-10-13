<script lang="ts" module>
  // The timeshift limit toast shows once per app session (§8.8).
  const warned = new Set<string>();
</script>

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { LiveNowNext, PlaybackCommand, PlaybackState, ReminderCountdown, ZapEntry } from '../../../shared/contract';
  import { resolveKey } from '../../../shared/livetv/keys';
  import { applyLens, sameLens } from '../../../shared/livetv/lens';
  import { zapEntry, type ChannelRow, type LensRef } from '../../../shared/livetv/model';
  import { DIGIT_TIMEOUT_MS, digitIndex, digitReduce, type DigitEvent, type DigitPreview, type DigitState } from '../../../shared/livetv/zap';
  import { w } from '../../lib/bridge';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { live as liveApi } from '../../lib/livetv.svelte';
  import { storeFor } from '../../lib/livetv/store.svelte';
  import { errorMessage } from '../../lib/stores.svelte';
  import DigitBuffer from './DigitBuffer.svelte';
  import GuideOverlay from './GuideOverlay.svelte';
  import LiveBanner from './LiveBanner.svelte';
  import MiniGuide from './MiniGuide.svelte';
  import TuneCard from './TuneCard.svelte';

  // Player live mode in the OSD (livetv-spec-final.md §8.3–§8.6, §10.1): the banner, number entry,
  // the mini-guide, the tune card and the radio screen. Osd.svelte mounts it while state.live is set
  // and asks onKey first. Main owns the zap list, merging and release; this keeps only UI state.
  let { state: pb, chrome }: { state: PlaybackState; chrome: boolean } = $props();

  const BANNER_MS = 4_000; // live.bannerSeconds default
  const SAY_MS = 2_000;
  const ARIA_MS = 1_000; // one banner announcement per second while zapping

  const lv = $derived(pb.live!);
  const sid = $derived(lv.channel.serverId);
  const store = $derived(storeFor(sid));
  const all: LensRef = { kind: 'all' };

  let clock = $state(Date.now());
  let banner = $state(false);
  let expanded = $state(false);
  let browse = $state(0);
  let overview = $state('');
  let digits = $state<DigitState | null>(null);
  let preview = $state<DigitPreview | null>(null);
  let mini = $state<{ filter: boolean } | null>(null);
  let miniRef = $state<MiniGuide>();
  // Picture-in-guide (Shift+G, §8.7) and a reminder's auto-tune countdown (§9.6).
  let pig = $state(false);
  let pigRef = $state<GuideOverlay>();
  let countdown = $state<ReminderCountdown | null>(null);
  let tick = $state(Date.now());
  let said = $state('');
  let aria = $state('');
  let bannerTimer: ReturnType<typeof setTimeout> | null = null;
  let sayTimer: ReturnType<typeof setTimeout> | null = null;
  let digitTimer: ReturnType<typeof setInterval> | null = null;
  let ariaAt = 0;
  let ariaTimer: ReturnType<typeof setTimeout> | null = null;
  let wheelAt = 0;

  function cmd(c: PlaybackCommand): void {
    void w.playback.command(c).catch(() => undefined);
  }

  // The OSD window's own guide cache (IndexedDB + BroadcastChannel), opened once per server.
  let opened: unknown = null;
  $effect(() => {
    const s = store;
    if (s && opened !== s) {
      opened = s;
      void s.open().catch(() => undefined);
    }
  });

  const hidden = $derived(new Set(store?.prefs.hidden ?? []));
  const byId = $derived(new Map((store?.channels ?? []).map((r) => [r.id, r] as const)));
  const ix = $derived(digitIndex((store?.channels ?? []).map((r) => ({ id: r.id, number: r.number, hidden: hidden.has(r.id) }))));
  const entryOf = (id: string): ZapEntry | undefined => (lv.pending?.id === id ? lv.pending : lv.channel.id === id ? lv.channel : byId.has(id) ? zapEntry(byId.get(id)!) : undefined);

  function rowsOf(lens: LensRef): ChannelRow[] {
    return store ? applyLens({ rows: store.channels, lens, prefs: store.lensPrefs, sort: store.sort, favFirst: store.favFirst }) : [];
  }

  function lensLabel(l: LensRef): string {
    switch (l.kind) {
      case 'tag':
        return l.tag;
      case 'group':
        return store?.prefs.groups.find((g) => g.id === l.id)?.name ?? '';
      default:
        return t(`player.live.lens.${l.kind}`);
    }
  }

  function sendLens(lens: LensRef, rows = rowsOf(lens)): void {
    // Plain data only: a $state proxy cannot cross IPC (structured clone).
    cmd({ type: 'live-lens', lens: $state.snapshot(lens), lensLabel: lensLabel(lens), entries: rows.map(zapEntry) });
  }

  // A channel started without a zap list (Home, search, a remote Play): the guide's current lens,
  // else Toutes when the channel is not in it (F7).
  let filledFor = '';
  $effect(() => {
    if (lv.count > 0 || !store?.channels.length || filledFor === lv.channel.id) return;
    filledFor = lv.channel.id;
    const rows = rowsOf(store.lens);
    if (rows.some((r) => r.id === lv.channel.id)) sendLens(store.lens, rows);
    else sendLens(all);
  });

  // Recents follow what is actually watched.
  let pushed = '';
  $effect(() => {
    if (lv.tuning || pushed === lv.channel.id) return;
    pushed = lv.channel.id;
    store?.pushRecent(lv.channel.id);
  });

  function say(text: string): void {
    said = text;
    if (sayTimer) clearTimeout(sayTimer);
    sayTimer = setTimeout(() => (said = ''), SAY_MS);
  }

  function showBanner(): void {
    banner = true;
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, BANNER_MS);
  }

  function hideBanner(): void {
    if (bannerTimer) clearTimeout(bannerTimer);
    banner = expanded = false;
    browse = 0;
  }

  // Shown the moment a zap or tune is accepted (before the first frame), and when a programme starts.
  const shown = $derived(lv.pending ?? lv.channel);
  let lastShown = '';
  $effect(() => {
    const key = `${shown.id}|${lv.now?.id ?? ''}`;
    if (key === lastShown) return;
    lastShown = key;
    browse = 0;
    expanded = false;
    showBanner();
  });

  // Programmes of the banner's channel: main's now/next for the current channel, else the cache.
  const programs = $derived.by((): LiveNowNext[] => {
    const id = shown.id;
    const cached = store ? store.programsIn(id, clock, clock + 12 * 3_600_000) : [];
    if (store && !cached.length) store.demandNow(id);
    if (cached.length) return cached;
    return id === lv.channel.id ? ([lv.now, lv.next].filter(Boolean) as LiveNowNext[]) : [];
  });

  const position = $derived(lv.pending || !lv.count ? '' : lv.index ? t('player.live.lensPosition', { lens: lv.lensLabel, index: lv.index, count: lv.count }) : lv.lensLabel);

  // Polite announcement, throttled while zapping (§8.5, §12).
  $effect(() => {
    const p = programs[0]?.title ?? '';
    const text = t('player.live.bannerAria', { number: shown.number, channel: shown.name, program: p });
    if (ariaTimer) clearTimeout(ariaTimer);
    const wait = Math.max(0, ariaAt + ARIA_MS - Date.now());
    ariaTimer = setTimeout(() => ((aria = text), (ariaAt = Date.now())), wait);
  });

  // The detail panel's overview, fetched when it opens.
  $effect(() => {
    const p = expanded ? programs[browse] : null;
    overview = '';
    if (!p) return;
    const id = p.id;
    void liveApi.program(id, sid).then(
      (d) => {
        if (expanded && programs[browse]?.id === id) overview = d.Overview ?? '';
      },
      () => undefined,
    );
  });

  // ---- Timeshift (§8.8): main clamps every seek to the window ----

  const ts = $derived(lv.timeshift);
  $effect(() => {
    const cur = ts;
    if (!cur?.limited || warned.has(cur.limited)) return;
    warned.add(cur.limited);
    say(t(cur.limited === 'space' ? 'player.live.timeshiftNoSpace' : 'player.live.timeshiftLimit', { time: fmt.duration(cur.windowMs) }));
  });

  function shift(deltaMs: number): void {
    if (!ts) return;
    if (ts.endWall - ts.startWall < 2_000 && deltaMs < 0) say(t('player.live.noTimeshift'));
    cmd({ type: 'seek-relative', deltaMs });
  }

  // ---- Number entry ----

  function digitStep(ev: DigitEvent): void {
    const step = digitReduce(ix, digits, ev, DIGIT_TIMEOUT_MS);
    digits = step.state;
    preview = step.state ? step.preview : null;
    if (digits && !digitTimer) digitTimer = setInterval(() => digitStep({ type: 'tick', at: Date.now() }), 100);
    if (!digits && digitTimer) [digitTimer] = [null, clearInterval(digitTimer)];
    const r = step.result;
    if (r?.type === 'commit') {
      aria = t('player.live.digits', { digits: entryOf(r.id)?.number ?? '' });
      tuneTo(r.id, 'digits');
      if (r.hidden) say(t('livetv.channel.hiddenToast')); // a hidden channel stays reachable by number
    } else if (r?.type === 'fail') say(t('player.live.noChannel', { number: r.number }));
    else if (r?.type === 'last-channel') cmd({ type: 'last-channel' });
  }

  // Outside the current lens, the zap list becomes Toutes (§8.4).
  function tuneTo(id: string, reason: 'digits' | 'miniguide'): void {
    const lens = lv.lens ?? all;
    if (lv.count && !sameLens(lens, all) && !rowsOf(lens).some((r) => r.id === id)) {
      sendLens(all);
      say(t('player.live.lensSwitched', { name: lensLabel(all) }));
    }
    cmd({ type: 'tune', channelId: id, reason });
  }

  // ---- Actions ----

  function record(programId: string): void {
    void liveApi.record(programId, false, sid).then(
      () => say(t('livetv.toasts.recordingScheduled')),
      (err) => say(errorMessage(err)),
    );
  }

  function favorite(id: string): void {
    const row = byId.get(id);
    if (!store || !row) return;
    const before = row.favorite;
    void store.toggleFavorite(id).then((fav) => {
      if (fav !== before) say(t(fav ? 'livetv.toasts.favoriteAdded' : 'livetv.toasts.favoriteRemoved', { channel: row.name }));
    });
  }

  function openMini(filter = false): void {
    if (!store) return;
    hideBanner();
    mini = { filter };
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const at = Date.now();
    if (at - wheelAt < 150 || !e.deltaY) return;
    wheelAt = at;
    cmd({ type: 'zap', delta: e.deltaY > 0 ? -1 : 1 });
  }

  // Osd.onKey asks here first (live context of keys.ts). True when the key was used.
  export function onKey(e: KeyboardEvent): boolean {
    if (e.key.startsWith('Media')) return false; // the media session zaps through main
    if (pig) return pigRef?.onKey(e) ?? true;
    if (mini) return miniRef?.onKey(e) ?? false;
    if (countdown && e.key === 'Escape') return void w.reminders.stay(), true;
    if (banner) showBanner(); // any key keeps it up
    const r = resolveKey(e, 'live');
    if (digits) {
      const at = Date.now();
      if (r?.id === 'live.digits') return digitStep({ type: 'digit', d: e.code.slice(-1), at }), true;
      if (r?.id === 'live.separator') return digitStep({ type: 'separator', at }), true;
      if (r?.id === 'live.lastChannel') return digitStep({ type: 'backspace', at }), true;
      if (r?.id === 'live.enter') return digitStep({ type: 'enter', at }), true;
      if (r?.id === 'live.close') return digitStep({ type: 'escape', at }), true;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return digitStep({ type: 'pick', delta: e.key === 'ArrowUp' ? -1 : 1, at }), true;
    }
    switch (r?.id) {
      case 'live.zapUp':
        cmd({ type: 'zap', delta: 1 });
        return true;
      case 'live.zapDown':
        cmd({ type: 'zap', delta: -1 });
        return true;
      case 'live.digits':
        digitStep({ type: 'digit', d: e.code.slice(-1), at: Date.now() });
        return true;
      case 'live.lastChannel':
        cmd({ type: 'last-channel' });
        return true;
      case 'live.enter':
        // The mini-guide opens with the controls hidden; with them shown, Enter stays with the OSD.
        if (chrome || (e.target as HTMLElement | null)?.tagName === 'BUTTON') return false;
        openMini();
        return true;
      case 'live.channelList':
        openMini();
        return true;
      case 'live.guideOverlay':
        if (!store) return false;
        hideBanner();
        pig = true;
        return true;
      case 'live.pip':
        cmd({ type: 'pip' });
        return true;
      case 'live.search':
        openMini(true);
        return true;
      case 'live.info':
        if (banner && !expanded) expanded = true;
        else if (expanded) hideBanner();
        else showBanner();
        return true;
      case 'live.record': {
        const p = programs[browse];
        if (p && p.end > clock) record(p.id);
        return true;
      }
      case 'live.favorite':
        favorite(lv.channel.id);
        return true;
      // ←/→ ±10 s in the timeshift window; without one they browse the banner now → next → later.
      case 'live.back':
      case 'live.forward': {
        if (ts) shift(r.id === 'live.back' ? -10_000 : 10_000);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          browse = Math.max(0, Math.min(programs.length - 1, browse + (e.key === 'ArrowRight' ? 1 : -1)));
          showBanner();
        }
        return true;
      }
      case 'live.backLong':
      case 'live.forwardLong':
        if (ts) shift(r.id === 'live.backLong' ? -30_000 : 30_000);
        return true;
      case 'live.bufferStart':
        if (ts) shift(ts.startWall - ts.posWall);
        return true;
      case 'live.liveEdge':
        cmd({ type: 'live-edge' });
        return true;
      case 'live.close':
        if (!banner) return false;
        hideBanner();
        return true;
    }
    return false;
  }

  onMount(() => {
    const timer = setInterval(() => (clock = Date.now()), 5_000);
    const off = w.reminders.onCountdown((c) => {
      tick = Date.now();
      countdown = c;
    });
    return () => (clearInterval(timer), off());
  });

  $effect(() => {
    if (!countdown) return;
    const timer = setInterval(() => (tick = Date.now()), 250);
    return () => clearInterval(timer);
  });

  onDestroy(() => {
    for (const tm of [bannerTimer, sayTimer, ariaTimer]) if (tm) clearTimeout(tm);
    if (digitTimer) clearInterval(digitTimer);
  });

  const nowTitle = $derived(lv.now?.title ?? (store?.nowNext(lv.channel.id, clock)[0]?.title || ''));
</script>

{#if lv.radio}
  <TuneCard entry={lv.channel} serverId={sid} now={nowTitle} next={lv.next?.title ?? ''} radio />
{:else if lv.tuning && pb.buffering && !pb.error}
  <TuneCard entry={lv.channel} serverId={sid} now={nowTitle} />
{/if}

{#if banner && !mini}
  <LiveBanner
    entry={shown}
    serverId={sid}
    {position}
    tuning={lv.tuning}
    {clock}
    {programs}
    {browse}
    recording={Boolean(lv.recording) && shown.id === lv.channel.id}
    {expanded}
    {overview}
    lifted={chrome}
    onwheel={onWheel}
    onrecord={record}
  />
{/if}

{#if digits}
  <DigitBuffer buf={digits.buf} {preview} entry={entryOf} serverId={sid} />
{/if}

{#if mini && store}
  <MiniGuide
    bind:this={miniRef}
    {store}
    current={lv.channel.id}
    lens={lv.lens ?? all}
    {clock}
    filterOnOpen={mini.filter}
    {lensLabel}
    onTune={(id, lens, rows) => {
      if (!lv.count || !sameLens(lens, lv.lens ?? all)) sendLens(lens, rows);
      cmd({ type: 'tune', channelId: id, reason: 'miniguide' });
    }}
    onRecord={record}
    onFavorite={favorite}
    onClose={() => (mini = null)}
  />
{/if}

{#if pig && store}
  <GuideOverlay bind:this={pigRef} {store} current={lv.channel.id} onclose={() => (pig = false)} />
{/if}

{#if countdown}
  <div class="remind" role="status">
    <span>{t('player.live.reminderCountdown', { title: countdown.title, channel: countdown.channelName, seconds: Math.max(0, Math.ceil((countdown.at - tick) / 1000)) })}</span>
    <button class="btn" onclick={() => void w.reminders.stay()}>{t('player.live.stayHere')}</button>
  </div>
{/if}

{#if said}
  <div class="say" role="status">{said}</div>
{/if}

<div class="sr" role="status" aria-live="polite">{aria}</div>

<style>
  .say {
    position: absolute;
    top: 132px;
    left: 50%;
    z-index: 6;
    translate: -50% 0;
    display: flex;
    align-items: center;
    height: 34px;
    padding: 0 16px;
    border-radius: 999px;
    background: var(--material-thick);
    box-shadow:
      inset 0 0 0 0.5px var(--hairline),
      var(--shadow-2);
    color: var(--label);
    font-size: var(--fs-callout);
    font-weight: 560;
    white-space: nowrap;
    pointer-events: none;
  }
  .remind {
    position: absolute;
    top: 132px;
    left: 50%;
    z-index: 9;
    translate: -50% 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 8px 8px 18px;
    border-radius: 999px;
    background: var(--material-thick);
    box-shadow:
      inset 0 0 0 0.5px var(--hairline),
      var(--shadow-2);
    color: var(--label);
    font-size: var(--fs-callout);
    font-weight: 560;
    white-space: nowrap;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
