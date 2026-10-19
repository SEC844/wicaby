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
  import Icon from '../components/Icon.svelte';
  import Pill from '../components/Pill.svelte';
  import Osd, { type OsdButton } from '../components/player/Osd.svelte';
  import SubtitleLayer from '../components/player/SubtitleLayer.svelte';
  import TrackPanel from '../components/player/TrackPanel.svelte';
  import Spinner from '../components/Spinner.svelte';
  import { focusable, focused, setFocus } from '../lib/focus';
  import { episodeLine } from '../lib/format';
  import { t } from '../lib/i18n.svelte';
  import { nav, onBack, SCREEN } from '../lib/nav.svelte';
  import { overlay } from '../lib/overlay.svelte';
  import { Playback } from '../lib/playback.svelte';
  import { skippableAt, STILL_WATCHING_AFTER, upNextAt, type SegmentKind } from '../lib/segments';
  import { api } from '../lib/session.svelte';
  import { SKIP_AUTO, SKIP_OFF, settings } from '../lib/settings.svelte';
  import { createPlayer, platform } from '../platform';
  import { keyOf } from '../platform/keys';
  import type { Aspect } from '../platform/player';

  let { id, fromStart = false, trailer = false, queue }: { id: string; fromStart?: boolean; trailer?: boolean; queue?: string[] } = $props();

  const client = api()!;
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
  let panel = $state(false);
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
    if (!pb || !pb.next || dismissedUpNext || stillWatching || pb.trailer) return null;
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
    if (!pb?.ended || stillWatching) return;
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

  const buttons = $derived<OsdButton[]>([
    { key: 'tracks', icon: 'Subtitles', text: t('tracks_hint_touch'), run: openPanel },
    { key: 'aspect', icon: 'Aspect', text: t(ASPECT_LABEL[aspect]), run: cycleAspect },
  ]);

  function openPanel(): void {
    panel = true;
    osd = true;
  }
  function closePanel(): void {
    panel = false;
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
    if (panel || stillWatching || pb?.error) return;
    if (inControls()) {
      poke();
      if (key === 'up') return consume(), setFocus(sink);
      if (key === 'down' && focused()?.getAttribute('data-osd-button') === 'tracks') return consume(), openPanel();
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
  const chapterStarts = $derived(
    (pb?.item?.Chapters ?? []).filter((c) => !c.MarkerType || c.MarkerType === 'Chapter').map((c) => c.StartPositionTicks / 10_000),
  );
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

    {#if panel}
      <TrackPanel
        audio={pb.audio()}
        subtitles={pb.subtitles()}
        audioIndex={pb.audioIndex}
        subtitleIndex={pb.subtitleIndex}
        onaudio={(i) => pb?.selectAudio(i)}
        onsubtitle={(i) => pb?.selectSubtitle(i)}
      />
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
