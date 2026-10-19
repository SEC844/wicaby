<script module lang="ts">
  // The stats panel stays on for the next videos of the session (Android PlaybackStats.visible).
  const session = $state({ stats: false });
</script>

<script lang="ts">
  // Android TV PlayerScreen (player/PlayerActivity.kt): the picture, the subtitles the app draws, the OSD, the skip
  // chip, the up-next card with its countdown, "Still watching?", the track panel and the error state, driven by the
  // remote as on Android:
  // - picture: OK plays or pauses (or skips, or plays next when its chip or card shows), Left/Right and FF/REW seek
  //   by steps that add up and accelerate while held (stepped seek), Down goes to the control buttons, Up shows the
  //   OSD; the media keys work everywhere;
  // - buttons: Left/Right between them, Up back to the picture, Down on "Audio and subtitles" opens the panel;
  // - Back closes the panel, leaves the buttons, closes the card, hides the OSD, then stops.
  import type { BaseItem } from '$shared/models';
  import { MERGE_MS, press, type PendingSeek } from '$shared/stepped-seek';
  import { getContext, onMount } from 'svelte';
  import HScroll from '../components/HScroll.svelte';
  import Icon from '../components/Icon.svelte';
  import Pill from '../components/Pill.svelte';
  import ColumnsPanel, { type PanelColumn } from '../components/player/ColumnsPanel.svelte';
  import Osd, { type OsdButton } from '../components/player/Osd.svelte';
  import StatsOverlay from '../components/player/StatsOverlay.svelte';
  import SubtitleLayer from '../components/player/SubtitleLayer.svelte';
  import Spinner from '../components/Spinner.svelte';
  import { focusable, focused, focusFirst, setFocus } from '../lib/focus';
  import { clock, episodeLine } from '../lib/format';
  import { locale, t } from '../lib/i18n.svelte';
  import { showToast } from '../lib/toast.svelte';
  import * as Versions from '../lib/versions';
  import { nav, onBack, SCREEN } from '../lib/nav.svelte';
  import { overlay } from '../lib/overlay.svelte';
  import { stopMusic } from '../lib/music.svelte';
  import { Playback } from '../lib/playback.svelte';
  import { cancelSleep, checkSleep, endOfVideo, extendSleep, restartSleep, sleep, sleepAtEnd, SLEEP_MINUTES, startSleep } from '../lib/sleep.svelte';
  import { ORIGINAL_BITRATE } from '$shared/quality-presets';
  import { skippableAt, STILL_WATCHING_AFTER, upNextAt, type SegmentKind } from '../lib/segments';
  import { apiOf } from '../lib/session.svelte';
  import { SKIP_AUTO, SKIP_OFF, settings } from '../lib/settings.svelte';
  import { createPlayer, platform } from '../platform';
  import { keyOf } from '../platform/keys';
  import type { Aspect } from '../platform/player';

  let {
    id,
    fromStart = false,
    trailer = false,
    queue,
    serverId,
  }: { id: string; fromStart?: boolean; trailer?: boolean; queue?: string[]; serverId?: string } = $props();

  // Android's own glyph for the chapters button (PlayerActivity.kt ChaptersIcon).
  const CHAPTERS_ICON = 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z';
  // And its moon (sleep timer) and speedometer (speed).
  const MOON_ICON = 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z';
  const SPEED_ICON =
    'M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z';

  // svelte-ignore state_referenced_locally
  const client = apiOf(serverId)!;
  const screen = getContext<number>(SCREEN);
  let video: HTMLVideoElement;
  let sink: HTMLButtonElement;
  let pb = $state<Playback | null>(null);
  // AVPlay draws on a plane behind the page: everything but the OSD must be see-through while it plays.
  const avplay = platform === 'tizen';

  // --- OSD visibility: shown on any input, hidden after 4.5 s of playing (9 s on the buttons) ---
  let osd = $state(true);
  let nonce = $state(0);
  let controlsFocused = $state(false);
  type Panel = 'tracks' | 'quality' | 'chapters' | 'speed' | 'sleep';
  let panel = $state<Panel | null>(null);
  let now = $state(Date.now());
  function poke(): void {
    osd = true;
    nonce++;
  }
  $effect(() => {
    void nonce;
    if (!osd || panel || !pb?.playing || scrub !== null) return;
    const timer = setTimeout(() => (osd = false), controlsFocused ? 9000 : 4500);
    return () => clearTimeout(timer);
  });

  // --- Seeking: steps add up into one target (shown on the bar), the player seeks once they stop ---
  let pending: PendingSeek | null = null;
  let held = false;
  let scrub = $state<number | null>(null);
  let scrubTimer = 0;
  function commitPending(): void {
    const p = pending;
    pending = null;
    held = false;
    if (p && pb) pb.seek(p.target);
    scrub = null;
  }
  function stepSeek(forward: boolean, repeat: boolean): void {
    if (!pb || pb.durationMs <= 0) return poke();
    pending = press(pending, scrub ?? pb.positionMs, pb.durationMs, forward ? 10_000 : -10_000, repeat);
    if (repeat) held = true;
    scrub = pending.target;
    poke();
    clearTimeout(scrubTimer);
    scrubTimer = window.setTimeout(commitPending, MERGE_MS);
  }

  // --- Play / pause, with the centred disc when the OSD is hidden ---
  let disc = $state(0);
  let discShown = $state(false);
  function togglePlay(play?: boolean): void {
    if (!pb) return;
    pb.togglePlay(play ?? !pb.playing);
    if (osd) poke();
    else disc++;
  }
  $effect(() => {
    if (!disc) return;
    discShown = true;
    const timer = setTimeout(() => (discShown = false), 600);
    return () => clearTimeout(timer);
  });

  // --- Skippable segments: a chip for 8 s (Ask), a jump once (Auto), nothing (Off) ---
  const SKIP_SETTING: Record<SegmentKind, keyof typeof settings> = { Intro: 'skipIntro', Recap: 'skipRecap', Preview: 'skipPreview', Commercial: 'skipCommercial' };
  const SKIP_LABEL: Record<SegmentKind, string> = { Intro: 'skip_intro', Recap: 'skip_recap', Preview: 'skip_preview', Commercial: 'skip_commercial' };
  const skippable = $derived.by(() => {
    if (!pb || pb.trailer) return undefined;
    const r = skippableAt(pb.segments, pb.positionMs);
    const mode = r ? (settings[SKIP_SETTING[r.kind]] as { value: number }).value : SKIP_OFF;
    return r && mode !== SKIP_OFF ? { ...r, mode } : undefined;
  });
  let skipVisible = $state(false);
  const autoSkipped = new Set<number>();
  $effect(() => {
    const s = skippable;
    if (!s) return void (skipVisible = false);
    if (s.mode === SKIP_AUTO) {
      if (!autoSkipped.has(s.startMs)) {
        autoSkipped.add(s.startMs);
        pb?.seek(s.endMs);
      }
      return;
    }
    skipVisible = true;
    const timer = setTimeout(() => (skipVisible = false), 8000);
    return () => clearTimeout(timer);
  });
  function skip(): void {
    if (skippable) pb?.seek(skippable.endMs);
    skipVisible = false;
  }

  // --- Up next: the card at the credits (or 30 s before the end), a countdown when autoplay is on ---
  let dismissedUpNext = $state(false);
  let stillWatching = $state(false);
  let countdown = $state<number | null>(null);
  const upNext = $derived.by<BaseItem | null>(() => {
    // "End of this video" on the sleep timer: no up next.
    if (!pb || !pb.next || dismissedUpNext || stillWatching || pb.trailer || endOfVideo()) return null;
    const at = upNextAt(pb.durationMs, pb.segments.credits);
    return at !== undefined && pb.positionMs >= at && pb.positionMs > 0 ? pb.next : null;
  });
  function autoAdvance(): void {
    if (!pb) return;
    if (pb.autoCount >= STILL_WATCHING_AFTER) {
      pb.togglePlay(false);
      stillWatching = true;
    } else advance(true);
  }
  function advance(auto: boolean): void {
    dismissedUpNext = false;
    countdown = null;
    autoSkipped.clear();
    pb?.advance(auto);
  }
  $effect(() => {
    if (!upNext || !settings.autoplayNext.value) return void (countdown = null);
    let left = settings.countdown.value;
    countdown = left;
    const timer = setInterval(() => {
      // The countdown waits while the viewer has paused the credits.
      if (pb?.playing) left--;
      countdown = left;
      if (left <= 0) {
        clearInterval(timer);
        autoAdvance();
      }
    }, 1000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    if (!pb?.ended || stillWatching || sleep.state?.promptUntil) return;
    // The sleep timer's "end of this video": stay at the end and ask.
    if (sleepAtEnd()) return;
    if (pb.next && !dismissedUpNext && settings.autoplayNext.value) autoAdvance();
    else exit();
  });

  // --- Picture format ---
  let aspect = $state<Aspect>('fit');
  const ASPECT_LABEL: Record<Aspect, string> = { fit: 'aspect_fit', fill: 'aspect_fill', stretch: 'aspect_stretch', zoom: 'aspect_zoom' };
  function cycleAspect(): void {
    if (!pb) return;
    const list = pb.player.aspects;
    aspect = list[(list.indexOf(aspect) + 1) % list.length];
    pb.player.setAspect(aspect);
    poke();
  }

  // --- Audio and subtitles: the tracks, then the quick subtitle look (the Settings values) ---
  const trackName = (s: { DisplayTitle?: string; Title?: string; Language?: string; Index: number }) =>
    s.DisplayTitle || s.Title || s.Language || t('track_unknown', s.Index);
  const trackColumns = $derived.by<PanelColumn[]>(() => {
    if (!pb) return [];
    const p = pb;
    const audio = p.audio();
    return [
      { key: 'a', title: t('audio'), weight: 1.3, rows: audio.map((s) => ({ id: s.Index, text: trackName(s) })), selected: p.audioIndex ?? audio.find((s) => s.IsDefault)?.Index, pick: (i) => p.selectAudio(i) },
      {
        key: 's', title: t('subtitles'), weight: 1.3, selected: p.subtitleIndex, pick: (i) => p.selectSubtitle(i),
        rows: [{ id: -1, text: t('subtitles_off') }, ...p.subtitles().map((s) => ({ id: s.Index, text: trackName(s) }))],
      },
      {
        key: 'z', title: t('subtitle_size'), weight: 1, selected: settings.subtitleSize.value, pick: (i) => (settings.subtitleSize.value = i),
        rows: ['size_small', 'size_normal', 'size_large', 'size_xlarge'].map((k, i) => ({ id: i, text: t(k) })),
      },
      {
        key: 'p', title: t('subtitle_position'), weight: 1, selected: settings.subtitlePosition.value, pick: (i) => (settings.subtitlePosition.value = i),
        rows: ['sub_pos_bottom', 'sub_pos_slightly_raised', 'sub_pos_raised'].map((k, i) => ({ id: i, text: t(k) })),
      },
    ];
  });

  // --- X-02 quality: "Quality · Original" / "Quality · 720p" on the button, presets with their bitrate in the sheet ---
  const mbps = (b: number) => (b / 1_000_000).toLocaleString(locale.current, { maximumFractionDigits: 2 });
  const presetLabel = (b: number, height?: number) => t('quality_preset', height ?? 0, mbps(b));
  const capped = $derived(pb && pb.qualityCap !== null && pb.qualityCap < ORIGINAL_BITRATE ? pb.qualityCap : null);
  const qualityShort = $derived.by(() => {
    const row = capped ? pb?.qualityRows().find((r) => r.maxBitrate === capped) : undefined;
    return row?.height ? `${row.height}p` : t('quality_original');
  });
  // "1,4 Go" / "1.4 GB" (Android formatShortFileSize).
  function size(bytes?: number): string | undefined {
    if (!bytes) return undefined;
    const units = locale.current.startsWith('fr') ? ['o', 'ko', 'Mo', 'Go', 'To'] : ['B', 'kB', 'MB', 'GB', 'TB'];
    let v = bytes;
    let u = 0;
    while (v >= 1000 && u < units.length - 1) {
      v /= 1000;
      u++;
    }
    return `${v.toLocaleString(locale.current, { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[u]}`;
  }
  let busy = $state<{ col: 'v' | 'q'; i: number } | null>(null);
  const qualityColumns = $derived.by<PanelColumn[]>(() => {
    if (!pb) return [];
    const p = pb;
    const tag = p.playMethod === 'Transcode' ? t('play_method_transcode') : t('play_method_direct');
    const versions = p.versions;
    const labels = p.item ? Versions.labels(p.item) : [];
    const vSel = versions.findIndex((v) => v.Id === p.currentSourceId);
    const rows = p.qualityRows();
    const rSel = rows.findIndex((r) => r.maxBitrate === capped);
    const cols: PanelColumn[] = [];
    if (versions.length > 1)
      cols.push({
        key: 'v', title: t('quality_version'), weight: 1, selected: vSel, busy: busy?.col === 'v' ? busy.i : null,
        rows: versions.map((v, i) => ({ id: i, text: [labels[i] ?? v.Id, i === vSel && !p.switching ? tag : undefined, size(v.Size)].filter(Boolean).join(' · ') })),
        pick: (i) => void (i !== vSel && switchQuality('v', i, versions[i].Id, capped)),
      });
    cols.push({
      key: 'q', title: t('quality'), weight: 1.3, selected: rSel, busy: busy?.col === 'q' ? busy.i : null,
      rows: rows.map((r, i) => {
        const name = r.maxBitrate === null ? [t('quality_original'), r.height ? `${r.height}p` : undefined].filter(Boolean).join(' · ') : presetLabel(r.maxBitrate, r.height);
        const sz = size(r.size);
        return { id: i, text: [name, i === rSel && !p.switching ? tag : undefined, sz && r.percent !== undefined ? t('quality_size', sz, r.percent) : sz].filter(Boolean).join(' · ') };
      }),
      pick: (i) => void (i !== rSel && switchQuality('q', i, null, rows[i].maxBitrate)),
    });
    return cols;
  });
  // The sheet closes once the switch took and stays open on a failure (its toast says so).
  async function switchQuality(col: 'v' | 'q', i: number, sourceId: string | null, maxBitrate: number | null): Promise<void> {
    if (!pb || pb.switching) return;
    busy = { col, i };
    const ok = await pb.switchQuality(sourceId, maxBitrate);
    busy = null;
    if (!ok) return showToast(t('quality_failed'));
    const item = pb.item;
    const label =
      sourceId && item
        ? (Versions.labels(item)[pb.versions.findIndex((v) => v.Id === sourceId)] ?? sourceId)
        : maxBitrate
          ? presetLabel(maxBitrate, pb.qualityRows().find((r) => r.maxBitrate === maxBitrate)?.height)
          : t('quality_original');
    showToast(t('quality_switched', label));
    closePanel();
  }

  // --- Chapters: the real ones (Emby's intro and credits markers left out), with their index for the stills ---
  const chapters = $derived(
    (pb?.item?.Chapters ?? [])
      .map((c, index) => ({ c, index, ms: c.StartPositionTicks / 10_000 }))
      .filter(({ c }) => !c.MarkerType || c.MarkerType === 'Chapter')
      .sort((a, b) => a.ms - b.ms),
  );
  const chapterStarts = $derived(chapters.map((c) => c.ms));

  // --- X-03 speed ---
  const speedText = (r: number) => t('speed_value', r.toLocaleString(locale.current, { maximumFractionDigits: 2 }));
  const speedColumns = $derived.by<PanelColumn[]>(() => {
    if (!pb) return [];
    const p = pb;
    const list = p.player.speeds;
    return [{ key: 'r', title: t('speed'), weight: 1, rows: list.map((r, i) => ({ id: i, text: speedText(r) })), selected: list.indexOf(p.rate), pick: (i) => (p.setSpeed(list[i]), closePanel()) }];
  });

  // --- X-04 sleep timer: +15 min and Cancel while one runs, then end of this video and the durations ---
  const SLEEP_EXTEND = -2;
  const SLEEP_CANCEL = -3;
  const SLEEP_END = -1;
  const sleepColumns = $derived.by<PanelColumn[]>(() => {
    const st = sleep.state;
    const rows = [
      ...(st?.endsAt ? [{ id: SLEEP_EXTEND, text: t('sleep_extend') }] : []),
      ...(st ? [{ id: SLEEP_CANCEL, text: t('sleep_cancel') }] : []),
      { id: SLEEP_END, text: t('sleep_end_of_video') },
      ...SLEEP_MINUTES.map((m) => ({ id: m, text: t('sleep_minutes', m) })),
    ];
    return [
      {
        key: 's', title: t('sleep_timer'), weight: 1, rows, selected: st ? (st.minutes ?? SLEEP_END) : null,
        pick: (i) => {
          if (i === SLEEP_EXTEND) extendSleep();
          else if (i === SLEEP_CANCEL) cancelSleep();
          else startSleep(i === SLEEP_END ? null : i);
          closePanel();
        },
      },
    ];
  });
  const sleepLeft = $derived(sleep.state?.endsAt ? Math.max(0, sleep.state.endsAt - now) : null);
  // Once a second (the clock): the prompt, then the pause.
  $effect(() => {
    void now;
    if (!pb || pb.trailer) return;
    if (checkSleep(now) === 'expire') pb.togglePlay(false);
  });
  const sleepPrompt = $derived(sleep.state?.promptUntil ? Math.max(0, Math.ceil((sleep.state.promptUntil - now) / 1000)) : null);
  // Continue (or Back): the same timer again; at the end of the video it goes on.
  function sleepContinue(): void {
    const atEnd = !!pb?.ended;
    restartSleep();
    if (atEnd) {
      if (pb?.next) advance(false);
      else exit();
    } else if (pb && !pb.playing) pb.togglePlay(true);
    setFocus(sink);
  }
  function sleepStop(): void {
    cancelSleep();
    pb?.togglePlay(false);
    setFocus(sink);
  }

  const buttons = $derived<OsdButton[]>([
    { key: 'tracks', icon: 'Subtitles', text: t('tracks_hint_touch'), run: () => openPanel('tracks') },
    ...(chapters.length > 1 ? [{ key: 'chapters', icon: '', path: CHAPTERS_ICON, text: t('chip_chapters'), run: () => openPanel('chapters') }] : []),
    ...(pb && !pb.trailer ? [{ key: 'quality', icon: 'Gear', text: t('quality'), value: qualityShort, run: () => openPanel('quality') }] : []),
    ...(pb && pb.player.speeds.length > 1 ? [{ key: 'speed', icon: '', path: SPEED_ICON, text: t('speed'), value: pb.rate === 1 ? undefined : speedText(pb.rate), run: () => openPanel('speed') }] : []),
    ...(pb && !pb.trailer
      ? [{ key: 'sleep', icon: '', path: MOON_ICON, text: t('sleep_timer'), value: sleepLeft !== null ? clock(sleepLeft) : sleep.state ? t('sleep_end_of_video') : undefined, run: () => openPanel('sleep') }]
      : []),
    { key: 'aspect', icon: 'Aspect', text: t(ASPECT_LABEL[aspect]), run: cycleAspect },
    { key: 'stats', icon: 'Info', text: t('stats_title'), value: session.stats ? '✓' : undefined, run: () => (session.stats = !session.stats) },
  ]);

  function openPanel(kind: Panel): void {
    panel = kind;
    osd = true;
    // The panel takes the focus at once (its selected row, the current chapter), off the button behind it.
    requestAnimationFrame(() => {
      const trap = document.querySelector('[data-screen-top] .player [data-focus-trap]');
      if (trap) focusFirst(trap);
    });
  }
  function closePanel(): void {
    panel = null;
    setFocus(sink);
  }

  function exit(): void {
    nav.back();
  }

  // --- The remote ---
  function inControls(): boolean {
    return !!focused()?.closest('.controls');
  }

  function onKey(e: KeyboardEvent): void {
    if (overlay.alert || !document.querySelector('[data-screen-top] .player')) return;
    const key = keyOf(e);
    if (!key || key === 'back') return;
    const consume = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    if (pb) pb.autoCount = 0;
    // Media keys work from anywhere, the panel included.
    if (key === 'playPause') return consume(), void (!e.repeat && togglePlay());
    if (key === 'play') return consume(), void (!e.repeat && togglePlay(true));
    if (key === 'pause') return consume(), void (!e.repeat && togglePlay(false));
    if (key === 'stop') return consume(), exit();
    if (key === 'ff' || key === 'rw') return consume(), stepSeek(key === 'ff', e.repeat);
    if (key === 'next') return consume(), void (pb?.next && advance(false));
    if (key === 'prev') return consume(), void (!e.repeat && pb?.previous());
    if (panel || stillWatching || sleepPrompt !== null || pb?.error) return;
    if (inControls()) {
      poke();
      if (key === 'up') return consume(), setFocus(sink);
      if (key === 'down' && focused()?.getAttribute('data-osd-button') === 'tracks') return consume(), openPanel('tracks');
      return;
    }
    consume();
    if (key === 'ok') {
      if (e.repeat) return;
      if (upNext) return advance(false);
      if (skipVisible) return skip();
      return togglePlay();
    }
    if (key === 'left' || key === 'right') return stepSeek(key === 'right', e.repeat);
    if (key === 'down') {
      poke();
      requestAnimationFrame(() => {
        const first = document.querySelector<HTMLElement>('[data-screen-top] .controls [data-focusable]');
        if (first) setFocus(first);
      });
      return;
    }
    poke();
  }

  function onKeyUp(e: KeyboardEvent): void {
    const key = keyOf(e);
    if (held && (key === 'left' || key === 'right' || key === 'ff' || key === 'rw')) {
      clearTimeout(scrubTimer);
      commitPending();
    }
  }

  onMount(() => {
    // A video ends the music session, as on Android (one audio output, one session).
    stopMusic();
    document.documentElement.classList.toggle('avplay', avplay);
    const player = createPlayer(video);
    const p = new Playback(client, player, id, { fromStart, trailer, queue: queue ? { ids: queue, index: Math.max(0, queue.indexOf(id)), fromStart: true } : undefined });
    pb = p;
    p.start();
    setFocus(sink);
    const track = () => (controlsFocused = inControls());
    document.addEventListener('tvfocus', track);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    const clockTimer = setInterval(() => (now = Date.now()), 1000);
    const stopBack = onBack(screen, () => {
      if (panel) return closePanel(), true;
      // Back on the sleep prompt counts as Continue.
      if (sleepPrompt !== null) return sleepContinue(), true;
      if (stillWatching) return false;
      if (inControls()) return setFocus(sink), true;
      if (upNext) return (dismissedUpNext = true), true;
      if (osd && pb?.playing && !pb.error) return (osd = false), true;
      return false;
    });
    return () => {
      stopBack();
      clearInterval(clockTimer);
      clearTimeout(scrubTimer);
      document.removeEventListener('tvfocus', track);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
      p.stop();
      document.documentElement.classList.remove('avplay');
    };
  });

  const position = $derived(scrub ?? pb?.positionMs ?? 0);
  // The skip chip and the up-next card sit just above the OSD's title row.
  const OSD_TOP = 176;
</script>

<div class="player" class:avplay>
  <!-- svelte-ignore a11y_media_has_caption: the app draws the captions (SubtitleLayer) -->
  <video bind:this={video} class="video" class:hidden={avplay} playsinline></video>
  <button class="sink" bind:this={sink} use:focusable aria-label={pb?.item?.Name ?? ''}></button>

  {#if pb}
    <SubtitleLayer cues={pb.activeCues} raised={osd && !panel} />

    {#if pb.error}
      <div class="center message">
        <p class="t-title2">{pb.error}</p>
        <p class="t-callout label-2 hint">{t('back_to_exit')}</p>
        <Pill text={t('retry')} icon="Refresh" autofocus onclick={() => pb?.retry()} />
      </div>
    {:else if pb.buffering || !pb.item}
      <div class="center"><Spinner size={48} color="#fff" /></div>
    {/if}

    {#if discShown && !osd}
      <div class="center disc"><Icon name={pb.playing ? 'Play' : 'Pause'} size={40} /></div>
    {/if}

    {#if pb.item && (osd || scrub !== null || panel) && !pb.error}
      <Osd
        item={pb.item}
        {position}
        duration={pb.durationMs}
        scrubbing={scrub !== null}
        playing={pb.playing}
        {chapterStarts}
        {buttons}
        {now}
        thumb={scrub !== null ? (pb.preview?.at(scrub) ?? null) : null}
      />
    {/if}

    {#if skipVisible && !upNext && !panel && scrub === null}
      <div class="chip t-headline" style="bottom:{osd ? OSD_TOP : 56}rem"><Icon name="Next" size={20} /><span>{t(SKIP_LABEL[skippable?.kind ?? 'Intro'])}</span></div>
    {/if}

    {#if upNext && !panel}
      {@const thumb = client.thumb(upNext, 800)}
      <div class="upnext" style="bottom:{osd ? OSD_TOP : 56}rem">
        <div class="art">
          {#if thumb}<img src={thumb} alt="" />{/if}
          {#if countdown !== null}
            <span class="bar"><span style="transform:scaleX({1 - countdown / settings.countdown.value})"></span></span>
          {/if}
        </div>
        <div class="text">
          <p class="t-eyebrow label-3">{(pb.queue ? t('queue_up_next') : t('up_next')).toUpperCase()}</p>
          <p class="t-headline name">{episodeLine(upNext) ?? upNext.Name}</p>
          <div class="row">
            <span class="chip inline t-headline"><Icon name="Next" size={20} /><span>{t('play_now')}</span></span>
            {#if countdown !== null}<span class="t-callout label-2 in">{t('up_next_in', countdown)}</span>{/if}
          </div>
        </div>
      </div>
    {/if}

    {#if panel === 'tracks'}
      <ColumnsPanel columns={trackColumns} />
    {:else if panel === 'quality'}
      <ColumnsPanel columns={qualityColumns} height={320} />
    {:else if panel === 'speed'}
      <ColumnsPanel columns={speedColumns} height={300} />
    {:else if panel === 'sleep'}
      <ColumnsPanel columns={sleepColumns} height={320} />
    {:else if panel === 'chapters' && pb.item}
      {@const item = pb.item}
      {@const current = Math.max(0, chapterStarts.filter((s) => s <= (pb?.positionMs ?? 0)).length - 1)}
      <div class="scrim" data-focus-trap>
        <div class="chapters">
          <p class="t-title3 sheet-title">{t('chapters')}</p>
          <HScroll spacing={16} padding={[8, 12, 8, 12]}>
            {#each chapters as ch, i (ch.index)}
              {@const still = client.image(item.Id, `Chapter/${ch.index}`, ch.c.ImageTag, { maxWidth: 480 })}
              {@const where = t('chapter_position', i + 1, chapters.length, clock(ch.ms))}
              <div data-row-item>
                <button
                  class="chapter"
                  use:focusable={i === current}
                  aria-label={where}
                  onclick={() => {
                    pb?.seek(ch.ms);
                    closePanel();
                  }}
                >
                  <span class="still-image">{#if still}<img src={still} alt="" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')} />{/if}</span>
                  <span class="name t-callout ellipsis">{ch.c.Name?.trim() || where}</span>
                  <span class="time">{clock(ch.ms)}</span>
                </button>
              </div>
            {/each}
          </HScroll>
        </div>
      </div>
    {/if}

    {#if session.stats && pb.item}
      <StatsOverlay {pb} />
    {/if}

    {#if sleepPrompt !== null && !stillWatching}
      <div class="still" data-focus-trap>
        <div class="card">
          <p class="t-title2">{t('still_watching')}</p>
          <p class="t-callout label-2 sub">{t('still_watching_pausing_in', sleepPrompt)}</p>
          <div class="row">
            <Pill text={t('keep_watching')} primary autofocus onclick={sleepContinue} />
            <span class="gap"></span>
            <Pill text={t('sleep_pause')} onclick={sleepStop} />
          </div>
        </div>
      </div>
    {/if}

    {#if stillWatching}
      <div class="still" data-focus-trap>
        <div class="card">
          <p class="t-title2">{t('still_watching')}</p>
          <p class="t-callout label-2 sub">{t('still_watching_sub')}</p>
          <div class="row">
            <Pill text={t('keep_watching')} primary autofocus onclick={() => {
              stillWatching = false;
              if (pb) pb.autoCount = 0;
              advance(false);
            }} />
            <span class="gap"></span>
            <Pill text={t('stop_watching')} onclick={exit} />
          </div>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .player {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
    background: #000;
    color: #fff;
  }
  .player.avplay {
    background: transparent;
  }
  :global(html.avplay),
  :global(html.avplay body) {
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
  /* The picture's focus target: it holds the focus while no button does, so the remote reaches the player. */
  .sink {
    position: absolute;
    top: 0;
    left: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
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
  .message p {
    margin: 0;
  }
  .message .hint {
    margin: 8rem 0 24rem;
  }
  .row {
    display: flex;
    align-items: center;
  }
  .gap {
    width: 12rem;
  }
  .disc {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 96rem;
    height: 96rem;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.55);
    animation: pop 600ms var(--ease-out) both;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translate(-50%, -50%) scale(0.85);
    }
    40% {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
    to {
      opacity: 0;
    }
  }
  .chip {
    position: absolute;
    right: 56rem;
    display: flex;
    align-items: center;
    padding: 12rem 22rem;
    border-radius: 999rem;
    background: #fff;
    color: #000;
    animation: fade 220ms var(--ease-out) both;
    transition: bottom var(--t-med) var(--ease);
  }
  .chip > :global(* + *) {
    margin-left: 8rem;
  }
  .chip.inline {
    position: static;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .upnext {
    position: absolute;
    right: 56rem;
    width: 400rem;
    overflow: hidden;
    border-radius: var(--r-lg);
    background: rgba(21, 21, 23, 0.94);
    animation: fade 300ms var(--ease-out) both;
    transition: bottom var(--t-med) var(--ease);
  }
  .art {
    position: relative;
    padding-top: 56.25%;
    background: var(--elevated-2);
  }
  .art img {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4rem;
    background: rgba(255, 255, 255, 0.22);
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
    transition: transform 1s linear;
  }
  .text {
    padding: 16rem 20rem 18rem;
  }
  .text p {
    margin: 0;
  }
  .name {
    margin: 4rem 0 14rem !important;
  }
  .in {
    margin-left: 14rem;
  }
  .scrim {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.35);
  }
  .chapters {
    position: absolute;
    left: 32rem;
    right: 32rem;
    bottom: 32rem;
    padding: 20rem 12rem 12rem;
    border-radius: var(--r-xl);
    background: var(--elevated);
    animation: fade 220ms var(--ease-out) both;
  }
  .sheet-title {
    margin: 0 0 8rem 20rem;
  }
  .chapter {
    display: block;
    width: 240rem;
    padding: 8rem;
    border-radius: var(--r-md);
    color: var(--label);
    text-align: left;
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .chapter:global(.focused) {
    background: #fff;
    color: #000;
    transform: scale(1.05);
  }
  .still-image {
    position: relative;
    display: block;
    padding-top: 56.25%;
    overflow: hidden;
    border-radius: var(--r-sm);
    background: var(--elevated-2);
  }
  .still-image img {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .chapter .name {
    display: block;
    margin-top: 8rem;
  }
  .chapter .time {
    font-family: 'Geist Mono', monospace;
    font-size: 15rem;
    color: var(--label-2);
  }
  .chapter:global(.focused) .time {
    color: rgba(0, 0, 0, 0.62);
  }
  .still {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.6);
  }
  .still .card {
    width: 520rem;
    padding: 32rem;
    border-radius: var(--r-xl);
    background: rgba(21, 21, 23, 0.96);
    text-align: center;
  }
  .still p {
    margin: 0;
  }
  .still .sub {
    margin: 8rem 0 24rem;
  }
  .still .row {
    justify-content: center;
  }
</style>
