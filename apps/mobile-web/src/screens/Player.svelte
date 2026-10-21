<script lang="ts">
  // The video player, full screen on black, driven by touch as the iOS player is: a tap shows or hides the controls,
  // a double tap on either side skips 10 s, the bar follows the finger with the trickplay still above it. Glass
  // controls over the picture: close, the title and how it plays (direct, remuxed on the iPhone, audio converted,
  // transcoded), PiP and AirPlay; play/pause between ±10 s; the bar and the times; audio, subtitles, speed, quality
  // and chapters in sheets. Skip intro, the next episode with its countdown and "Still watching?" are the TV web
  // app's rules (shared Playback session); the lock screen and Control Center drive it through Media Session.
  import type { BaseItem } from '$shared/models';
  import { ORIGINAL_BITRATE } from '$shared/quality-presets';
  import { clock, episodeLine } from '$tv/format';
  import { locale, t } from '$tv/i18n.svelte';
  import { stopMusic } from '$tv/music.svelte';
  import { Playback } from '$tv/playback.svelte';
  import { skippableAt, STILL_WATCHING_AFTER, upNextAt, type SegmentKind } from '$tv/segments';
  import { apiOf } from '$tv/session.svelte';
  import { SKIP_AUTO, SKIP_OFF, settings } from '$tv/settings.svelte';
  import { showToast } from '$tv/toast.svelte';
  import { trackName } from '$tv/track-memory';
  import * as Versions from '$tv/versions';
  import Airplay from '@lucide/svelte/icons/airplay';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Captions from '@lucide/svelte/icons/captions';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Pause from '@lucide/svelte/icons/pause';
  import PictureInPicture from '@lucide/svelte/icons/picture-in-picture-2';
  import Play from '@lucide/svelte/icons/play';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import SkipForward from '@lucide/svelte/icons/skip-forward';
  import { getContext, onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import Spinner from '../components/Spinner.svelte';
  import Subtitles from '../components/player/Subtitles.svelte';
  import { video as sharedVideo } from '../lib/media-element';
  import { handleBack, onBack, SCREEN } from '../lib/nav.svelte';
  import { showAlert } from '../lib/overlay.svelte';
  import { createPlayer, keepAwake } from '../platform';
  import type { RemuxPlayer } from '../platform/remux-player.svelte';

  let {
    id,
    fromStart = false,
    trailer = false,
    queue,
    serverId,
    startMs,
    tracks,
  }: { id: string; fromStart?: boolean; trailer?: boolean; queue?: string[]; serverId?: string; startMs?: number; tracks?: { audio?: number; subtitle?: number } } = $props();

  // svelte-ignore state_referenced_locally
  const client = apiOf(serverId)!;
  const screen = getContext<number>(SCREEN);
  // The app's one video element, unlocked for sound at the first touch (lib/media-element.ts), placed here.
  const video = sharedVideo;
  let host: HTMLDivElement;
  let pb = $state<Playback | null>(null);

  // ---- Controls: shown on a tap, hidden 3.5 s after the last one while playing ----
  let controls = $state(true);
  let nonce = $state(0);
  function poke(): void {
    controls = true;
    nonce++;
  }
  $effect(() => {
    void nonce;
    if (!controls || !pb?.playing || scrub !== null) return;
    const timer = setTimeout(() => (controls = false), 3500);
    return () => clearTimeout(timer);
  });

  // ---- Taps: one shows or hides the controls, two on a side skip 10 s (more taps add up) ----
  let lastTap = { t: 0, side: 0 };
  let tapTimer = 0;
  let ripple = $state<{ side: -1 | 1; secs: number; key: number } | null>(null);
  function onSurface(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const side = e.clientX < window.innerWidth / 2 ? -1 : 1;
    const now = performance.now();
    if (now - lastTap.t < 280 && lastTap.side === side) {
      clearTimeout(tapTimer);
      skipBy(side * 10_000, side as -1 | 1);
    } else {
      clearTimeout(tapTimer);
      tapTimer = window.setTimeout(() => (controls ? (controls = false) : poke()), 260);
    }
    lastTap = { t: now, side };
  }
  function skipBy(ms: number, side?: -1 | 1): void {
    if (!pb) return;
    pb.autoCount = 0;
    pb.seek(Math.max(0, (scrub ?? pb.positionMs) + ms));
    if (side) ripple = { side, secs: (ripple?.side === side ? ripple.secs : 0) + Math.abs(ms) / 1000, key: Date.now() };
  }
  $effect(() => {
    if (!ripple) return;
    const timer = setTimeout(() => (ripple = null), 700);
    return () => clearTimeout(timer);
  });

  function togglePlay(): void {
    if (!pb) return;
    pb.autoCount = 0;
    pb.togglePlay(!pb.playing);
    poke();
  }

  // ---- The bar: follows the finger, seeks on release ----
  let scrub = $state<number | null>(null);
  let bar = $state<HTMLElement>()!;
  function scrubAt(e: PointerEvent): number {
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (pb?.durationMs ?? 0);
  }
  function onBarDown(e: PointerEvent): void {
    if (!pb?.durationMs) return;
    bar.setPointerCapture(e.pointerId);
    scrub = scrubAt(e);
    poke();
  }
  function onBarMove(e: PointerEvent): void {
    if (scrub !== null) scrub = scrubAt(e);
  }
  function onBarUp(): void {
    if (scrub !== null && pb) pb.seek(scrub);
    scrub = null;
    poke();
  }
  const position = $derived(scrub ?? pb?.positionMs ?? 0);
  const duration = $derived(pb?.durationMs ?? 0);
  const thumb = $derived(scrub !== null && pb?.preview ? pb.preview.at(scrub) : null);

  // ---- How it plays ----
  const mode = $derived.by(() => {
    if (!pb?.item) return '';
    if (pb.playMethod === 'Transcode') return t('web_mode_transcode');
    if (pb.playMethod === 'DirectStream') return t('web_mode_audio');
    return (pb.player as RemuxPlayer).remuxed ? t('web_mode_remux') : t('web_mode_direct');
  });

  // ---- Skippable segments: a chip for 8 s (Ask), a jump once (Auto) ----
  const SKIP_SETTING: Record<SegmentKind, keyof typeof settings> = { Intro: 'skipIntro', Recap: 'skipRecap', Preview: 'skipPreview', Commercial: 'skipCommercial' };
  const SKIP_LABEL: Record<SegmentKind, string> = { Intro: 'skip_intro', Recap: 'skip_recap', Preview: 'skip_preview', Commercial: 'skip_commercial' };
  const skippable = $derived.by(() => {
    if (!pb || pb.trailer) return undefined;
    const r = skippableAt(pb.segments, pb.positionMs);
    const m = r ? (settings[SKIP_SETTING[r.kind]] as { value: number }).value : SKIP_OFF;
    return r && m !== SKIP_OFF ? { ...r, mode: m } : undefined;
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

  // ---- Up next, its countdown, "Still watching?" ----
  let dismissedUpNext = $state(false);
  let stillWatching = $state(false);
  let countdown = $state<number | null>(null);
  const upNext = $derived.by<BaseItem | null>(() => {
    if (!pb || !pb.next || dismissedUpNext || stillWatching || pb.trailer) return null;
    const at = upNextAt(pb.durationMs, pb.segments.credits);
    return at !== undefined && pb.positionMs >= at && pb.positionMs > 0 ? pb.next : null;
  });
  function advance(auto: boolean): void {
    dismissedUpNext = false;
    countdown = null;
    autoSkipped.clear();
    pb?.advance(auto);
  }
  function autoAdvance(): void {
    if (!pb) return;
    if (pb.autoCount >= STILL_WATCHING_AFTER) {
      pb.togglePlay(false);
      stillWatching = true;
    } else advance(true);
  }
  $effect(() => {
    if (!upNext || !settings.autoplayNext.value) return void (countdown = null);
    let left = settings.countdown.value;
    countdown = left;
    const timer = setInterval(() => {
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
    if (!pb?.ended || stillWatching) return;
    if (pb.next && !dismissedUpNext && settings.autoplayNext.value) autoAdvance();
    else exit();
  });

  // ---- Sheets ----
  function pick(title: string, labels: string[], selected: number, run: (i: number) => void): void {
    showAlert({ title, selected, actions: labels.map((label, i) => ({ label, run: () => run(i) })) });
  }
  function audioSheet(): void {
    if (!pb) return;
    const p = pb;
    const list = p.audio();
    pick(t('audio'), list.map(trackName), Math.max(0, list.findIndex((s) => s.Index === p.audioIndex)), (i) => p.selectAudio(list[i].Index));
  }
  function subtitleSheet(): void {
    if (!pb) return;
    const p = pb;
    const list = p.subtitles();
    pick(t('subtitles'), [t('subtitles_off'), ...list.map(trackName)], Math.max(0, list.findIndex((s) => s.Index === p.subtitleIndex) + 1), (i) => p.selectSubtitle(i === 0 ? -1 : list[i - 1].Index));
  }
  function speedSheet(): void {
    if (!pb) return;
    const p = pb;
    const list = p.player.speeds;
    pick(t('speed'), list.map((r) => t('speed_value', r.toLocaleString(locale.current, { maximumFractionDigits: 2 }))), list.indexOf(p.rate), (i) => p.setSpeed(list[i]));
  }
  function qualitySheet(): void {
    if (!pb) return;
    const p = pb;
    const capped = p.qualityCap !== null && p.qualityCap < ORIGINAL_BITRATE ? p.qualityCap : null;
    const rows = p.qualityRows();
    const labels = rows.map((r) => (r.maxBitrate === null ? t('quality_original') : `${r.height ? `${r.height}p · ` : ''}${(r.maxBitrate / 1_000_000).toLocaleString(locale.current, { maximumFractionDigits: 1 })} Mb/s`));
    pick(t('quality'), labels, Math.max(0, rows.findIndex((r) => r.maxBitrate === capped)), async (i) => {
      const ok = await p.switchQuality(null, rows[i].maxBitrate);
      showToast(ok ? labels[i] : t('quality_failed'));
    });
  }
  const chapters = $derived(
    (pb?.item?.Chapters ?? [])
      .map((c) => ({ name: c.Name, ms: c.StartPositionTicks / 10_000, marker: c.MarkerType }))
      .filter((c) => !c.marker || c.marker === 'Chapter')
      .sort((a, b) => a.ms - b.ms),
  );
  function chapterSheet(): void {
    if (!pb || !chapters.length) return;
    const p = pb;
    const current = chapters.findLastIndex((c) => c.ms <= p.positionMs);
    pick(t('chapters'), chapters.map((c, i) => `${clock(c.ms)} · ${c.name || i + 1}`), current, (i) => p.seek(chapters[i].ms));
  }
  function moreSheet(): void {
    if (!pb) return;
    showAlert({
      title: pb.item?.Name ?? '',
      message: mode,
      actions: [
        { label: t('audio'), run: audioSheet },
        { label: t('speed'), run: speedSheet },
        ...((pb.player as RemuxPlayer).remuxed || pb.playMethod !== 'DirectPlay' ? [{ label: t('quality'), run: qualitySheet }] : []),
        ...(chapters.length ? [{ label: t('chapters'), run: chapterSheet }] : []),
        { label: t('web_playback_info'), run: infoSheet },
      ],
    });
  }

  // What plays and how, for a report from the phone (codecs, buffer, the last error).
  function infoSheet(): void {
    if (!pb) return;
    const p = pb;
    const lines = [mode, ...((p.player as RemuxPlayer).diagnostics?.() ?? []), p.transcodeReasons.length ? p.transcodeReasons.join(', ') : ''].filter(Boolean);
    showAlert({ title: t('web_playback_info'), message: lines.join('\n'), actions: [{ label: t('close'), run: () => {} }] });
  }

  // ---- Picture in picture, AirPlay ----
  const pipOk = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;
  let airplayOk = $state(false);
  function pip(): void {
    if (document.pictureInPictureElement) void document.exitPictureInPicture();
    else void video.requestPictureInPicture().catch(() => {});
  }
  function airplay(): void {
    (video as HTMLVideoElement & { webkitShowPlaybackTargetPicker?(): void }).webkitShowPlaybackTargetPicker?.();
  }

  function exit(): void {
    handleBack();
  }

  // ---- The lock screen and Control Center ----
  $effect(() => {
    const it = pb?.item;
    if (!it || !('mediaSession' in navigator)) return;
    const art = client.thumb(it, 600) ?? client.poster(it, 600);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: it.Type === 'Episode' ? (episodeLine(it) ?? it.Name) : it.Name,
      artist: it.Type === 'Episode' ? (it.SeriesName ?? '') : (it.ProductionYear?.toString() ?? ''),
      artwork: art ? [{ src: art, sizes: '600x338', type: 'image/jpeg' }] : [],
    });
  });
  $effect(() => {
    if (!('mediaSession' in navigator) || !pb || !duration) return;
    try {
      navigator.mediaSession.setPositionState({ duration: duration / 1000, position: Math.min(duration, pb.positionMs) / 1000, playbackRate: pb.rate });
    } catch {
      // A position past the duration while it is not known yet.
    }
  });

  onMount(() => {
    // A video ends the music, as on Android (one audio output, one session).
    stopMusic();
    keepAwake(true);
    host.prepend(video);
    const player = createPlayer(video);
    const p = new Playback(client, player, id, { fromStart, trailer, startMs, tracks, queue: queue ? { ids: queue, index: Math.max(0, queue.indexOf(id)), fromStart: true } : undefined });
    pb = p;
    p.start();
    const w = window as unknown as { WebKitPlaybackTargetAvailabilityEvent?: unknown };
    const onTargets = (e: Event) => (airplayOk = (e as Event & { availability?: string }).availability === 'available');
    if (w.WebKitPlaybackTargetAvailabilityEvent) video.addEventListener('webkitplaybacktargetavailabilitychanged', onTargets);
    const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => p.togglePlay(true)],
      ['pause', () => p.togglePlay(false)],
      ['seekbackward', () => skipBy(-10_000)],
      ['seekforward', () => skipBy(10_000)],
      ['seekto', (d) => d.seekTime !== undefined && p.seek(d.seekTime * 1000)],
      ['nexttrack', () => void (p.next && advance(false))],
    ];
    for (const [a, h] of handlers) ms?.setActionHandler(a, h);
    const stopBack = onBack(screen, () => {
      if (upNext) return (dismissedUpNext = true), true;
      return false;
    });
    return () => {
      stopBack();
      for (const [a] of handlers) ms?.setActionHandler(a, null);
      if (ms) ms.metadata = null;
      video.removeEventListener('webkitplaybacktargetavailabilitychanged', onTargets);
      clearTimeout(tapTimer);
      p.stop();
      video.remove();
      keepAwake(false);
    };
  });

  const title = $derived(pb?.item ? (pb.item.Type === 'Episode' ? (pb.item.SeriesName ?? pb.item.Name) : pb.item.Name) : '');
  const subtitle = $derived(pb?.item?.Type === 'Episode' ? (episodeLine(pb.item) ?? '') : '');
  const remuxed = $derived(!!pb && (pb.player as RemuxPlayer).remuxed);
</script>

<div class="player" bind:this={host}>
  <!-- svelte-ignore a11y_no_static_element_interactions (taps on the picture; every action also has a button) -->
  <div class="surface" onpointerup={onSurface}></div>

  {#if pb}
    <Subtitles cues={pb.activeCues} raised={controls} />

    {#if ripple}
      {#key ripple.key}
        <div class="ripple" class:right={ripple.side > 0} out:fade={{ duration: 200 }}>
          {#if ripple.side < 0}<RotateCcw size={30} aria-hidden="true" />{:else}<RotateCw size={30} aria-hidden="true" />{/if}
          <span class="footnote">{ripple.secs} s</span>
        </div>
      {/key}
    {/if}

    {#if pb.error}
      <div class="center message">
        <p class="title-3">{pb.error}</p>
        <button class="btn-light pressable" onclick={() => pb?.retry()}>{t('retry')}</button>
      </div>
    {:else if pb.buffering || !pb.item}
      <div class="center"><Spinner size={44} /></div>
    {/if}

    {#if controls}
      <div class="chrome" transition:fade={{ duration: 160 }}>
        <div class="top">
          <button class="round glass-media" aria-label={t('close')} onclick={exit}><ChevronDown size={26} aria-hidden="true" /></button>
          <div class="heading">
            <p class="headline ellipsis">{title}</p>
            <p class="caption ellipsis dim">{[subtitle, mode].filter(Boolean).join(' · ')}</p>
          </div>
          {#if pipOk}<button class="round glass-media" aria-label={t('pip')} onclick={pip}><PictureInPicture size={21} aria-hidden="true" /></button>{/if}
          {#if airplayOk && !remuxed}<button class="round glass-media" aria-label={t('web_airplay')} onclick={airplay}><Airplay size={21} aria-hidden="true" /></button>{/if}
        </div>

        <div class="middle">
          <button class="round big glass-media" aria-label={t('web_back10')} onclick={() => skipBy(-10_000)}><RotateCcw size={30} aria-hidden="true" /></button>
          <button class="round huge glass-media" aria-label={pb.playing ? t('pause') : t('play')} onclick={togglePlay}>
            {#if pb.playing}<Pause size={38} fill="currentColor" strokeWidth={0} aria-hidden="true" />{:else}<Play size={38} fill="currentColor" strokeWidth={0} aria-hidden="true" />{/if}
          </button>
          <button class="round big glass-media" aria-label={t('web_fwd10')} onclick={() => skipBy(10_000)}><RotateCw size={30} aria-hidden="true" /></button>
        </div>

        <div class="bottom">
          {#if thumb}
            <div class="thumb" style:left="{(position / Math.max(1, duration)) * 100}%">
              {#if thumb.tile}
                <span class="tile" style:background-image="url({thumb.src})" style:background-size="{(thumb.tile.sheetWidth / thumb.width) * 100}% auto" style:background-position="{(thumb.tile.x / Math.max(1, thumb.tile.sheetWidth - thumb.width)) * 100}% {(thumb.tile.y / Math.max(1, thumb.tile.sheetHeight - thumb.height)) * 100}%"></span>
              {:else}
                <img src={thumb.src} alt="" />
              {/if}
              <span class="caption mono">{clock(position)}</span>
            </div>
          {/if}
          <div
            class="bar"
            class:active={scrub !== null}
            bind:this={bar}
            role="slider"
            tabindex="0"
            aria-label={title}
            aria-valuemin={0}
            aria-valuemax={Math.round(duration / 1000)}
            aria-valuenow={Math.round(position / 1000)}
            onpointerdown={onBarDown}
            onpointermove={onBarMove}
            onpointerup={onBarUp}
            onpointercancel={onBarUp}
          >
            <span class="track"><span class="done" style:transform="scaleX({duration ? position / duration : 0})"></span></span>
          </div>
          <div class="times caption mono">
            <span>{clock(position)}</span>
            <span>−{clock(Math.max(0, duration - position))}</span>
          </div>
          <div class="tools">
            <button class="tool" aria-label={t('subtitles')} onclick={subtitleSheet}><Captions size={22} aria-hidden="true" /></button>
            {#if pb.next}<button class="tool" aria-label={t('up_next')} onclick={() => advance(false)}><SkipForward size={22} aria-hidden="true" /></button>{/if}
            <button class="tool" aria-label={t('more')} onclick={moreSheet}><Ellipsis size={22} aria-hidden="true" /></button>
          </div>
        </div>
      </div>
    {/if}

    {#if skipVisible && skippable}
      <button class="chip glass-media headline" transition:fade={{ duration: 160 }} onclick={() => (pb?.seek(skippable!.endMs), (skipVisible = false))}>{t(SKIP_LABEL[skippable.kind])}</button>
    {/if}

    {#if upNext}
      <div class="next glass-media" transition:fade={{ duration: 200 }}>
        <p class="caption dim">{t('up_next')}{countdown !== null ? ` · ${t('up_next_in', countdown)}` : ''}</p>
        <p class="subhead ellipsis">{episodeLine(upNext) ?? upNext.Name}</p>
        <div class="next-actions">
          <button class="btn-light small" onclick={() => advance(false)}><Play size={16} fill="currentColor" strokeWidth={0} aria-hidden="true" />{t('play')}</button>
          <button class="subhead dim" onclick={() => (dismissedUpNext = true)}>{t('cancel')}</button>
        </div>
      </div>
    {/if}

    {#if stillWatching}
      <div class="center message">
        <p class="title-2">{t('still_watching')}</p>
        <p class="callout dim">{t('web_still_body')}</p>
        <button class="btn-light pressable" onclick={() => ((stillWatching = false), advance(false))}>{t('web_continue')}</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .player {
    position: absolute;
    inset: 0;
    background: #000;
    color: #fff;
    overflow: hidden;
    touch-action: manipulation;
  }
  .player > :global(.app-video) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .surface {
    position: absolute;
    inset: 0;
  }
  .center {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    pointer-events: none;
    color: #fff;
  }
  .message {
    pointer-events: auto;
    background: rgb(0 0 0 / 0.6);
    text-align: center;
    padding: 24px;
  }
  .dim {
    color: rgb(255 255 255 / 0.7);
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chrome {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(to bottom, rgb(0 0 0 / 0.55), rgb(0 0 0 / 0) 26%, rgb(0 0 0 / 0) 62%, rgb(0 0 0 / 0.65));
  }
  .chrome button,
  .chrome .bar {
    pointer-events: auto;
  }
  .top {
    position: absolute;
    top: calc(var(--safe-top) + 6px);
    left: max(14px, var(--safe-left));
    right: max(14px, var(--safe-right));
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .heading {
    flex: 1;
    min-width: 0;
    text-align: center;
  }
  .round {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    flex: none;
  }
  .round.big {
    width: 58px;
    height: 58px;
  }
  .round.huge {
    width: 78px;
    height: 78px;
  }
  .middle {
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    justify-content: center;
    align-items: center;
    gap: clamp(28px, 10vw, 64px);
  }
  .bottom {
    position: absolute;
    left: max(18px, var(--safe-left));
    right: max(18px, var(--safe-right));
    bottom: calc(var(--safe-bottom) + 10px);
  }
  .bar {
    height: 30px;
    display: flex;
    align-items: center;
    touch-action: none;
  }
  .track {
    flex: 1;
    height: 5px;
    border-radius: 3px;
    background: rgb(255 255 255 / 0.28);
    overflow: hidden;
    transition: transform var(--t-fast) var(--ease-out);
  }
  .bar.active .track {
    transform: scaleY(1.8);
  }
  .done {
    display: block;
    height: 100%;
    background: #fff;
    transform-origin: left;
  }
  .times {
    display: flex;
    justify-content: space-between;
    color: rgb(255 255 255 / 0.75);
    margin-top: -2px;
  }
  .tools {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 6px;
  }
  .tool {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    color: #fff;
  }
  .thumb {
    position: absolute;
    bottom: 76px;
    width: 160px;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    pointer-events: none;
  }
  .thumb .tile,
  .thumb img {
    display: block;
    width: 160px;
    aspect-ratio: 16 / 9;
    border-radius: 8px;
    background-repeat: no-repeat;
    object-fit: cover;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.5);
  }
  .ripple {
    position: absolute;
    top: 50%;
    left: 18%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    pointer-events: none;
  }
  .ripple.right {
    left: 82%;
  }
  .chip {
    position: absolute;
    right: max(18px, var(--safe-right));
    bottom: calc(var(--safe-bottom) + 130px);
    height: 44px;
    padding: 0 20px;
    border-radius: 22px;
  }
  .next {
    position: absolute;
    right: max(18px, var(--safe-right));
    bottom: calc(var(--safe-bottom) + 130px);
    width: min(300px, calc(100% - 36px));
    padding: 14px;
    border-radius: var(--r-lg);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .next-actions {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-top: 8px;
  }
  .btn-light.small {
    height: 38px;
    padding: 0 16px;
    font-size: var(--fs-subhead);
  }
</style>
