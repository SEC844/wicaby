<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { ASPECT_MODES, ZOOM_STEPS, type AspectMode, type PlaybackCommand, type PlaybackState, type SkipSegmentType, type Track, type VideoAspect } from '../../shared/contract';
  import { activeSegment, SEGMENT_SETTING } from '../../shared/markers';
  import { w } from '../lib/bridge';
  import { cast, openCastPicker } from '../lib/cast.svelte';
  import { clock, episodeCode } from '../lib/format';
  import { fmt, t } from '../lib/i18n.svelte';
  import { imageUrl } from '../lib/images';
  import { linux } from '../lib/platform';
  import { sessionFor, settings } from '../lib/stores.svelte';
  import { caps } from '../../shared/server-caps';
  import { loadBif, thumbAt } from '../lib/trickplay';
  import { applyOverrides, resolve } from '../../shared/shortcuts';
  import { appliedSeconds, chapterTarget, MERGE_MS, press, type PendingSeek } from '../../shared/stepped-seek';
  import CastPicker from './CastPicker.svelte';
  import Icon from './Icon.svelte';
  import SleepTimerSheet from './SleepTimerSheet.svelte';
  import QualitySheet, { qualityLabel } from './QualitySheet.svelte';
  import SubtitleSearchSheet, { subtitleSearchable, subtitleSearchAllowed } from './SubtitleSearchSheet.svelte';
  import LiveOverlay from './live/LiveOverlay.svelte';
  import LiveTimeline from './live/LiveTimeline.svelte';
  import { dur } from '../lib/motion';

  // Shared by the mpv overlay window (transparent, over a separate video
  // window, so backdrop blur sees nothing) and the in-page <video> player.
  let {
    state: pb,
    mode,
    bufferedMs = 0,
  }: { state: PlaybackState | null; mode: 'mpv' | 'html'; bufferedMs?: number } = $props();

  type Panel = 'tracks' | 'speed' | 'chapters' | 'aspect' | null;
  type Flash = 'play' | 'pause' | 'back' | 'fwd';

  let visible = $state(true);
  let panel = $state<Panel>(null);
  let showStats = $state(false);
  let dragging = $state(false);
  let dragFraction = $state(0);
  // Seek target held after release until mpv reports it, so the knob does not snap back to the old position first.
  let landing = $state<number | null>(null);
  let landingTimer: ReturnType<typeof setTimeout> | null = null;
  // Volume shown while dragging or stepping: mpv echoes each step back late, which made the fill trail and bounce.
  let volDraft = $state<number | null>(null);
  let volDrag = $state(false);
  let volTimer: ReturnType<typeof setTimeout> | null = null;
  let hoverFraction = $state<number | null>(null);
  let bar = $state<HTMLDivElement>();
  let barW = $state(0);
  let flash = $state<{ kind: Flash; n: number; sec?: number } | null>(null);
  // Live TV player mode (live/LiveOverlay.svelte): asked first for every key while a channel plays.
  let overlay = $state<LiveOverlay>();
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let clickTimer: ReturnType<typeof setTimeout> | null = null;

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const SKIP_PILL_MS = 8000;
  const THUMB_W = 224;
  const THUMB_H = 126;

  const s = $derived(pb);
  const duration = $derived(s?.durationMs ?? 0);
  // X-04 merged seek: arrow presses move one pending target, committed MERGE_MS after the last one.
  let pending = $state<PendingSeek | null>(null);
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let held = false;
  let sleepOpen = $state(false);
  let qualityOpen = $state(false); // X-02
  // X-03 subtitle search: offered for server VOD unless the user's policy is known to forbid it.
  let subSearchOpen = $state(false);
  let subSearchAllowed = $state(true);
  const subSearchServer = $derived(s?.item?.serverId);
  $effect(() => void subtitleSearchAllowed(subSearchServer).then((v) => (subSearchAllowed = v)));
  const subSearch = $derived(subSearchAllowed && subtitleSearchable(s));
  const position = $derived(dragging ? dragFraction * duration : pending ? pending.target : (landing ?? s?.positionMs ?? 0));
  $effect(() => {
    if (landing !== null && Math.abs((s?.positionMs ?? 0) - landing) < 1500) landing = null;
  });
  // The draft is dropped once main reports it (or after a short timeout), so the fill never steps back.
  $effect(() => {
    if (volDraft !== null && !volDrag && !s?.muted && Math.round(s?.volume ?? -1) === volDraft) volDraft = null;
  });
  const fraction = $derived(duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0);
  const bufFraction = $derived(duration > 0 ? Math.min(1, Math.max(0, bufferedMs / duration)) : 0);
  // In live mode next / previous change channel (main maps them to zap).
  const hasNext = $derived(Boolean(s && (s.live || s.queueIndex + 1 < s.queueLength)));
  const hasPrev = $derived(Boolean(s && (s.live || s.queueIndex > 0 || s.positionMs > 5000)));
  const up = $derived(s?.active ? s.upNext : undefined);
  // Space with the controls hidden pauses under the disc alone (subtitles stay readable): the pause
  // does not bring the OSD back until the next input or the next resume.
  let quietPause = $state(false);
  let wasPaused = false;
  $effect(() => {
    const p = Boolean(s?.paused);
    if (wasPaused && !p) quietPause = false;
    wasPaused = p;
  });
  const uiShown = $derived(visible || !s?.active || (Boolean(s?.paused) && !quietPause) || panel !== null || dragging || sleepOpen || qualityOpen || subSearchOpen || Boolean(cast.picker));
  const volume = $derived(volDraft ?? (s?.muted ? 0 : (s?.volume ?? 100)));
  // mpv amplifies up to 150 % with the boost on; <video> stops at 100 %.
  const volMax = $derived(mode === 'mpv' && settings.value?.playback.volumeBoost ? 150 : 100);
  // X-04: the shortcut table with the user's rebindings (Settings > Général > Raccourcis).
  const table = $derived(applyOverrides(settings.value?.ui.shortcuts));
  // Settings > Lecture > "Sauts": arrow keys and the ±buttons (short), Shift + arrows (long).
  const stepShort = $derived((settings.value?.playback.seekShortS ?? 10) * 1000);
  const stepLong = $derived((settings.value?.playback.seekLongS ?? 60) * 1000);

  const item = $derived(s?.item);
  const chapters = $derived(duration > 0 ? (item?.chapters ?? []).filter((c) => c.startMs > 0 && c.startMs < duration) : []);
  const titleTop = $derived(item?.seriesName ?? item?.name ?? '');
  const titleSub = $derived(
    s?.trailer
      ? item?.type === 'Trailer' ? t('player.title.trailer') : t('player.title.bonus')
      : item?.seriesName
      ? [
          item.seasonNumber !== undefined && item.episodeNumber !== undefined
            ? t('player.title.episode', { season: item.seasonNumber, episode: item.episodeNumber })
            : episodeCode({ ParentIndexNumber: item.seasonNumber, IndexNumber: item.episodeNumber }),
          item.name,
        ]
          .filter(Boolean)
          .join(' · ')
      : item?.year
        ? String(item.year)
        : '',
  );
  const hoverChapter = $derived(
    hoverFraction === null ? undefined : (item?.chapters ?? []).filter((c) => c.startMs <= hoverFraction! * duration).at(-1),
  );

  const allChapters = $derived(item?.chapters ?? []);
  const currentChapter = $derived(allChapters.findLastIndex((c) => c.startMs <= position));
  // Chapter images load once the picker has been opened, and stay for its closing animation.
  let chaptersSeen = $state(false);
  $effect(() => {
    if (panel === 'chapters') chaptersSeen = true;
  });

  // "Passer l'intro" from IntroStart until 2 s before IntroEnd; "Passer le générique"
  // from CreditsStart when nothing follows (a series shows the next-episode card instead); a recap,
  // preview or commercial while its setting is not Off.
  const segment = $derived.by((): 'intro' | 'credits' | SkipSegmentType | null => {
    const m = s?.markers;
    if (!s?.active || !m || s.error) return null;
    const pos = s.positionMs;
    if (s.skipMode !== 'off' && m.introStartMs !== undefined && m.introEndMs !== undefined && pos >= m.introStartMs && pos < m.introEndMs - 2000) return 'intro';
    if ((s.creditsSkipMode ?? s.skipMode) !== 'off' && m.creditsStartMs !== undefined && pos >= m.creditsStartMs && !hasNext && duration - pos > 1500) return 'credits';
    const pb = settings.value?.playback;
    return activeSegment(m, pos, (g) => (pb?.[SEGMENT_SETTING[g.type]] ?? 'ask') !== 'off')?.type ?? null;
  });
  // Fresh for 8 s after it appears, then only alongside the rest of the OSD.
  let pillFresh = $state(false);
  let pillTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSegment: string | null = null;
  $effect(() => {
    const seg = segment;
    if (seg === lastSegment) return;
    lastSegment = seg;
    if (pillTimer) clearTimeout(pillTimer);
    pillFresh = seg !== null;
    if (seg) pillTimer = setTimeout(() => (pillFresh = false), SKIP_PILL_MS);
  });
  const pillShown = $derived(segment !== null && (pillFresh || uiShown) && !up && !panel);

  // X-05: the subtitle row whose "Show as second subtitle" action is open (right-click, menu key).
  let secondaryFor = $state<number | null>(null);

  // Main's brief readouts (delay change, automatic intro skip), for 2 s after they were raised.
  const NOTICE_MS = 2000;
  let notice = $state<{ key: string; params?: Record<string, string | number> } | null>(null);
  let noticeAt = 0;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const n = s?.notice;
    if (!n || n.at === noticeAt) return;
    noticeAt = n.at;
    const left = NOTICE_MS - (Date.now() - n.at);
    if (left <= 0) return;
    notice = { key: n.key, params: n.params };
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice = null), left);
  });

  function skipSegment(): void {
    if (segment) cmd({ type: 'skip', segment });
  }

  // Local clock for the countdown text; the deadline comes from main.
  let now = $state(Date.now());
  $effect(() => {
    if (!up?.deadline) return;
    const timer = setInterval(() => (now = Date.now()), 200);
    now = Date.now();
    return () => clearInterval(timer);
  });
  const upLeftMs = $derived(up ? (up.deadline ? Math.max(0, up.deadline - now) : up.leftMs) : 0);
  const upCode = $derived(
    up && up.seasonNumber !== undefined && up.episodeNumber !== undefined ? t('player.upNext.code', { season: up.seasonNumber, episode: up.episodeNumber }) : '',
  );

  // Scrub thumbnails. The BIF is fetched on first hover so a viewer who never scrubs never downloads it.
  let bifReady = $state('');
  function wantThumbs(): void {
    const tp = s?.trickplay;
    if (tp?.kind === 'bif' && bifReady !== tp.url) {
      const url = tp.url;
      void loadBif(url).then((ok) => ok && (bifReady = url));
    }
  }
  const hoverMs = $derived(hoverFraction === null ? 0 : hoverFraction * duration);
  const thumb = $derived.by(() => {
    if (hoverFraction === null || duration <= 0) return null;
    const trick = s?.trickplay;
    void bifReady;
    const tp = trick?.kind === 'tiles' || (trick && bifReady === trick.url) ? thumbAt(trick, hoverMs) : null;
    if (tp) return tp;
    // No trick-play: the chapter image is better than nothing.
    const ch = hoverChapter;
    return ch?.imageTag && item ? { src: imageUrl(item.id, 'Chapter', { index: ch.index, tag: ch.imageTag, maxWidth: THUMB_W, server: item.serverId }) } : null;
  });
  const tipHalf = $derived(thumb ? THUMB_W / 2 + 4 : 60);

  // Centre feedback for play/pause from any source (keys, clicks, media keys),
  // but not for the initial state of a new item.
  let lastPaused: boolean | undefined;
  let lastPausedItem: string | undefined;
  $effect(() => {
    const paused = s?.paused;
    const id = item?.id;
    if (paused !== undefined && lastPaused !== undefined && id === lastPausedItem && paused !== lastPaused && s?.active) {
      showFlash(paused ? 'pause' : 'play');
      say(t(paused ? 'player.osd.pause' : 'player.osd.play'));
    }
    lastPaused = paused;
    lastPausedItem = id;
  });

  function showFlash(kind: Flash, sec?: number): void {
    flash = { kind, n: (flash?.n ?? 0) + 1, sec };
  }

  function cmd(c: PlaybackCommand): void {
    // Any other playhead move drops the pending merged seek.
    if (pending && ['seek', 'seek-relative', 'skip', 'next', 'previous', 'zap', 'tune', 'stop'].includes(c.type)) cancelSeek();
    if (landing !== null && ['seek-relative', 'skip', 'next', 'previous', 'zap', 'tune', 'stop'].includes(c.type)) landing = null;
    void w.playback.command(c).catch(() => undefined);
  }

  // Polite live region: the seek badge and the play/pause disc, at most one announcement per second.
  let announce = $state('');
  let announcedAt = 0;
  function say(text: string): void {
    const n = Date.now();
    if (n - announcedAt < 1000) return;
    announcedAt = n;
    announce = text;
  }

  function seekPress(dir: 1 | -1, step: number, repeat: boolean): void {
    if (duration <= 0) return skip(dir * step);
    pending = press(pending, position, duration, dir * step, repeat);
    if (repeat) held = true;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(commitSeek, MERGE_MS);
    say(seekBadge);
  }
  function cancelSeek(): void {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    pending = null;
    held = false;
  }
  function commitSeek(): void {
    const p = pending;
    cancelSeek();
    if (p && p.target !== p.origin) seekTo(p.target);
  }
  // Absolute seek that holds the knob on the target until mpv reports it (see `landing`).
  function seekTo(ms: number): void {
    landing = ms;
    if (landingTimer) clearTimeout(landingTimer);
    landingTimer = setTimeout(() => (landing = null), 3000);
    cmd({ type: 'seek', positionMs: ms });
  }
  // Key-up after a hold commits at once.
  function onKeyUp(): void {
    if (held && pending) commitSeek();
    if (holdBy === 'key') endHold();
  }

  // Hold for 2x: the Seek forward key held down, or the mouse held on the picture. The speed in effect
  // comes back on release. Not for live, and not with bitstreamed audio (it cannot change speed).
  const HOLD_RATE = 2;
  let holdBy = $state<'key' | 'mouse' | null>(null);
  let holdFrom = 1;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let swallowClick = false;
  function startHold(by: 'key' | 'mouse'): boolean {
    if (holdBy || !s || s.live || s.paused || s.stats.audioBitstream || s.rate === HOLD_RATE) return false;
    holdBy = by;
    holdFrom = s.rate;
    cmd({ type: 'rate', value: HOLD_RATE, hold: true });
    return true;
  }
  function endHold(): void {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    if (!holdBy) return;
    holdBy = null;
    cmd({ type: 'rate', value: holdFrom, hold: true });
  }
  function onSurfaceDown(e: PointerEvent): void {
    swallowClick = false;
    if (e.button !== 0 || panel) return;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      // The click that ends a hold must not also pause.
      if (startHold('mouse')) swallowClick = true;
    }, 400);
  }
  const seekBadge = $derived.by(() => {
    if (!pending) return '';
    const sec = appliedSeconds(pending);
    return t('player.osd.seekBadge', { sign: sec < 0 ? '−' : '+', seconds: Math.abs(sec) });
  });

  // FF / REW media keys: chapters when the item has some, else the step.
  function chapterJump(forward: boolean, repeat: boolean): void {
    const starts = allChapters.map((c) => c.startMs);
    if (!starts.length) return seekPress(forward ? 1 : -1, stepShort, repeat);
    const to = chapterTarget(starts, position, forward);
    if (to !== null) seekTo(to);
  }

  // Wall clock for "Ends at" and the sleep timer, once per second.
  let wall = $state(Date.now());
  // "Ends at", computed in the same tick: stable while playing (the position samples drift against
  // the clock by up to their period, so a move under 2 s is ignored), follows the clock while paused.
  let endsMs = $state<number | null>(null);
  function tick(): void {
    wall = Date.now();
    if (!s || s.live || duration <= 0) {
      endsMs = null;
      return;
    }
    const at = wall + Math.max(0, duration - s.positionMs) / (s.rate || 1);
    if (endsMs === null || s.paused || Math.abs(at - endsMs) >= 2000) endsMs = at;
  }
  $effect(() => {
    untrack(tick);
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  });
  const endsAt = $derived(endsMs === null ? '' : fmt.time(endsMs));
  const sleep = $derived(s?.sleep);
  const sleepLeft = $derived(sleep?.endsAt && !sleep.promptUntil ? Math.max(0, sleep.endsAt - wall) : null);
  const promptLeft = $derived(sleep?.promptUntil ? Math.max(0, Math.ceil((sleep.promptUntil - wall) / 1000)) : null);
  // Announced at 30 s and 10 s only, not every second.
  const promptAnnounce = $derived(promptLeft === null ? '' : t('player.sleep.pausingIn', { seconds: promptLeft > 10 ? 30 : 10 }));
  function sleepContinue(): void {
    if (sleep) cmd({ type: 'sleep', minutes: sleep.minutes });
  }
  function sleepPause(): void {
    cmd({ type: 'sleep', minutes: null });
    // Live: stop the stream and release the tuner, never just pause.
    cmd(s?.live ? { type: 'stop' } : { type: 'pause' });
  }
  function focusFirst(node: HTMLElement): void {
    node.focus({ preventScroll: true });
  }

  // Picture format: main applies it (mpv properties, or Player.svelte's <video> styles) and raises the notice.
  // Shown at once, before main's state comes back, so quick repeated clicks or Z presses keep stepping.
  let asked = $state<VideoAspect | null>(null);
  $effect(() => {
    const a = s?.aspect;
    if (asked && a?.mode === asked.mode && a.zoom === asked.zoom) asked = null;
  });
  const aspect = $derived(asked ?? s?.aspect ?? { mode: 'fit' as AspectMode, zoom: 1.25 });
  function setAspect(mode: AspectMode, zoom = aspect.zoom): void {
    asked = { mode, zoom };
    cmd({ type: 'aspect', mode, zoom });
  }
  function nextAspect(): void {
    setAspect(ASPECT_MODES[(ASPECT_MODES.indexOf(aspect.mode) + 1) % ASPECT_MODES.length]);
  }
  function stepZoom(dir: 1 | -1): void {
    const i = ZOOM_STEPS.indexOf(aspect.zoom);
    setAspect('zoom', ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i < 0 ? 1 : i) + dir))]);
  }

  function skip(deltaMs: number): void {
    cmd({ type: 'seek-relative', deltaMs });
    showFlash(deltaMs < 0 ? 'back' : 'fwd', Math.abs(deltaMs) / 1000);
  }

  function poke(): void {
    visible = true;
    quietPause = false;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!panel && !dragging) visible = false;
    }, 3000);
  }

  // Re-arm the hide timer once a panel closes or a scrub ends: its earlier run did nothing while they were up.
  $effect(() => {
    if (!panel && !dragging) untrack(poke);
  });

  onDestroy(() => {
    if (hideTimer) clearTimeout(hideTimer);
    if (clickTimer) clearTimeout(clickTimer);
    if (pillTimer) clearTimeout(pillTimer);
    if (noticeTimer) clearTimeout(noticeTimer);
    if (pendingTimer) clearTimeout(pendingTimer);
    if (landingTimer) clearTimeout(landingTimer);
    if (volTimer) clearTimeout(volTimer);
  });

  function onSurfaceClick(): void {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    if (panel) {
      panel = null;
      return;
    }
    // Delay so a double-click toggles fullscreen without also pausing.
    if (clickTimer) return;
    clickTimer = setTimeout(() => {
      clickTimer = null;
      cmd({ type: 'toggle-pause' });
    }, 220);
  }

  function onSurfaceDblClick(): void {
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = null;
    cmd({ type: 'toggle-fullscreen' });
  }

  function fractionAt(clientX: number): number {
    if (!bar) return 0;
    const r = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }

  function onBarDown(e: PointerEvent): void {
    if (duration <= 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = true;
    dragFraction = fractionAt(e.clientX);
  }

  function onBarMove(e: PointerEvent): void {
    hoverFraction = fractionAt(e.clientX);
    if (dragging) dragFraction = hoverFraction;
  }

  function onBarUp(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    seekTo(fractionAt(e.clientX) * duration);
  }

  // One path for drag and keys: each step builds on the draft, not on the late published volume.
  function setVolume(v: number): void {
    v = Math.round(Math.min(volMax, Math.max(0, v)));
    volDraft = v;
    releaseVolDraft();
    cmd({ type: 'volume', value: v });
    if (s?.muted && v > 0) cmd({ type: 'mute', value: false });
  }

  function releaseVolDraft(): void {
    if (volTimer) clearTimeout(volTimer);
    volTimer = setTimeout(() => {
      if (!volDrag) volDraft = null;
    }, 400);
  }

  function volumeAt(e: PointerEvent): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setVolume(((e.clientX - r.left) / r.width) * volMax);
  }

  function cycle(tracks: Track[], current: number | null, withNone: boolean): number | null {
    const order: (number | null)[] = [...(withNone ? [null] : []), ...tracks.map((tr) => tr.index)];
    if (order.length === 0) return null;
    const i = order.indexOf(current);
    return order[(i + 1) % order.length];
  }

  function onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range') return;
    if (!s?.active || sleepOpen || qualityOpen || subSearchOpen || cast.picker) return;
    if (s.live && overlay?.onKey(e)) {
      e.preventDefault();
      return;
    }
    const row = resolve(e, 'vod', table);
    const id = row && !(s.live && row.noLive) ? row.id.slice(4) : null;
    // The play/pause disc stands alone while the controls are hidden, so subtitles stay readable.
    if (id === 'playPause' && !uiShown) quietPause = true;
    else poke();
    if (!row || !id) return;
    if (e.repeat && !row.repeatable) {
      e.preventDefault();
      return;
    }
    if (run(id, e, target)) e.preventDefault();
  }

  // One action of the shortcut table (shared/shortcuts.ts); false when it did nothing with the key.
  function run(id: string, e: KeyboardEvent, target: HTMLElement | null): boolean {
    const st = s!;
    switch (id) {
      case 'playPause':
        cmd({ type: 'toggle-pause' });
        break;
      case 'seekBack':
      case 'seekForward':
      case 'seekBackLong':
      case 'seekForwardLong':
        // Held Seek forward: 2x instead of a run of seeks; the tap's seek, still pending, is dropped.
        if (id === 'seekForward' && e.repeat && (holdBy === 'key' || startHold('key'))) {
          cancelSeek();
          break;
        }
        seekPress(id.startsWith('seekBack') ? -1 : 1, id.endsWith('Long') ? stepLong : stepShort, e.repeat);
        break;
      case 'rewind':
      case 'fastForward':
        chapterJump(id === 'fastForward', e.repeat);
        break;
      case 'volumeUp':
      case 'volumeDown':
        setVolume((volDraft ?? st.volume) + (id === 'volumeUp' ? 5 : -5)); // from the level under the mute, not 0
        break;
      case 'mute':
        cmd({ type: 'mute', value: !st.muted });
        break;
      case 'fullscreen':
        cmd({ type: 'toggle-fullscreen' });
        break;
      case 'skipSegment':
        // B27: the skip pill, the Up Next card and an open panel's buttons handle Enter themselves; a control that kept
        // focus after a mouse click (Play/Pause) must not swallow it.
        if (!segment || (target?.tagName === 'BUTTON' && (panel || target.closest('.skip-pill, .nextup')))) return false;
        skipSegment();
        break;
      case 'escape':
        if (promptLeft !== null) sleepContinue(); // Back answers "Still watching?" with Continue
        else if (panel) panel = null;
        else if (up && !up.stillWatching) cmd({ type: 'up-next-cancel' });
        else if (showStats) showStats = false;
        else if (st.fullscreen) cmd({ type: 'toggle-fullscreen' });
        else cmd({ type: 'stop' });
        break;
      case 'next':
        if (hasNext) cmd({ type: 'next' });
        break;
      case 'previous':
        cmd({ type: 'previous' });
        break;
      case 'audioTrack': {
        const next = cycle(st.audioTracks, st.audioIndex, false);
        if (next !== null) cmd({ type: 'audio', index: next });
        break;
      }
      case 'subtitleTrack': {
        const next = cycle(st.subtitleTracks, st.subtitleIndex, true);
        cmd({ type: 'subtitle', index: next ?? -1 });
        break;
      }
      case 'audioDelayUp':
      case 'audioDelayDown':
        cmd({ type: 'audio-delay', deltaMs: id.endsWith('Up') ? 100 : -100 });
        break;
      case 'subtitleDelayUp':
      case 'subtitleDelayDown':
        cmd({ type: 'subtitle-delay', deltaMs: id.endsWith('Up') ? 100 : -100 });
        break;
      case 'jump':
        if (duration <= 0 || !/^[0-9]$/.test(e.key)) return false;
        seekTo((Number(e.key) / 10) * duration);
        break;
      case 'info':
        showStats = !showStats;
        break;
      case 'aspect':
        nextAspect();
        break;
      case 'sleep':
        sleepOpen = true;
        break;
      case 'subSeekBack':
      case 'subSeekForward':
        cmd({ type: 'sub-seek', delta: id === 'subSeekBack' ? -1 : 1 });
        break;
      case 'speedDown':
      case 'speedUp':
        cmd({ type: 'rate', value: Math.max(0.25, Math.min(4, st.rate + (id === 'speedUp' ? 0.25 : -0.25))) });
        break;
      case 'speedReset':
        cmd({ type: 'rate', value: 1 });
        break;
      case 'quality':
        if (!st.qualityOptions) return false;
        qualityOpen = true;
        break;
      case 'subtitleSearch':
        if (!subSearch) return false;
        panel = null;
        subSearchOpen = true;
        break;
      default:
        return false;
    }
    return true;
  }

  function togglePanel(p: Exclude<Panel, null>, e: MouseEvent): void {
    e.stopPropagation();
    panel = panel === p ? null : p;
  }

  const statRows = $derived.by(() => {
    if (!s) return [] as [string, string][];
    const st = s.stats;
    const rows: [string, string | number | undefined][] = [
      [t('player.stats.player'), s.player === 'mpv' ? 'mpv' : t('player.stats.builtIn')],
      [t('player.stats.method'), s.playMethod ? t(`player.stats.methods.${s.playMethod}`) : undefined],
      [t('player.stats.container'), st.container],
      [t('player.stats.video'), [st.videoCodec, st.resolution].filter(Boolean).join(' · ') || undefined],
      [t('player.stats.dynamicRange'), st.hdr && st.hdrOutput ? t('player.stats.hdrOutput', { format: st.hdr, output: st.hdrOutput }) : st.hdr],
      [
        t('player.stats.frameRate'),
        st.frameRate
          ? st.displayFps
            ? t('player.stats.frameRateDisplay', { fps: fmt.number(st.frameRate), hz: fmt.number(st.displayFps) })
            : fmt.number(st.frameRate)
          : undefined,
      ],
      [t('player.stats.audio'), st.audioCodec && st.audioBitstream ? t(linux ? 'player.stats.audioBitstreamLinux' : 'player.stats.audioBitstream', { codec: st.audioCodec }) : st.audioCodec],
      [t('player.stats.bitrate'), st.bitrateKbps ? fmt.bitrate(st.bitrateKbps / 1000, 1) : undefined],
      [t('player.stats.decoding'), st.hwdec ? (st.hwdec === 'no' ? t('player.stats.software') : t('player.stats.hardware', { api: st.hwdec })) : undefined],
      [t('player.stats.droppedFrames'), st.droppedFrames],
      [t('player.stats.source'), s.offline ? t('player.stats.localFile') : t('player.stats.server')],
    ];
    return rows.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)] as [string, string]);
  });

  const trackLabel = $derived.by(() => {
    if (!s) return '';
    const sub = s.subtitleTracks.find((tr) => tr.index === s.subtitleIndex);
    return sub ? t('player.tracks.subtitlesOn') : t('player.tracks.audioAndSubtitles');
  });
</script>

<svelte:window onkeydown={onKey} onkeyup={onKeyUp} onmousemove={poke} onblur={() => ((panel = null), endHold())} />

<div
  class="osd on-media"
  class:mpv={mode === 'mpv'}
  class:hidden={!uiShown}
  onmouseleave={() => {
    if (s && !s.paused && !panel && !dragging) visible = false;
  }}
  role="presentation"
>
  <!-- Click layer: pause on click, fullscreen on double-click. -->
  <div class="surface" onclick={onSurfaceClick} ondblclick={onSurfaceDblClick} onpointerdown={onSurfaceDown} onpointerup={endHold} onpointerleave={endHold} onpointercancel={endHold} role="presentation"></div>

  {#if s?.live}<LiveOverlay bind:this={overlay} state={s} chrome={uiShown} />{/if}

  <div class="scrim top-scrim" aria-hidden="true"></div>
  <div class="scrim bottom-scrim" aria-hidden="true"></div>

  <header class="top" class:caption-gap={mode === 'html' && !s?.fullscreen}>
    <button class="round glass no-drag" title={t('player.osd.backHint')} aria-label={t('player.osd.back')} onclick={() => cmd({ type: 'stop' })}>
      <Icon name="chevronLeft" size={20} stroke={2.2} />
    </button>
    <div class="title">
      {#if titleTop}<div class="t1">{titleTop}</div>{/if}
      {#if titleSub}<div class="t2">{titleSub}</div>{/if}
    </div>
    <!-- Cast (cast-spec CA-04): top-level, top right. Hands off what plays here. -->
    {#if s?.item && !s.offline && !s.trailer && caps(sessionFor(s.item.serverId)?.server.kind).castSend}
      <button class="round glass no-drag" title={t('cast.button')} aria-label={t('cast.button')} aria-haspopup="dialog" onclick={() => s?.item && openCastPicker({ itemId: s.item.id, serverId: s.item.serverId })}>
        <Icon name="cast" size={18} />
      </button>
    {/if}
    {#if mode === 'mpv'}
      <div class="winbtns no-drag">
        <button title={t('player.osd.minimize')} aria-label={t('player.osd.minimize')} onclick={() => void w.window.minimize()}><Icon name="minimize" size={16} /></button>
        <button title={s?.fullscreen ? t('player.osd.exitFullScreen') : t('player.osd.fullScreen')} aria-label={s?.fullscreen ? t('player.osd.exitFullScreen') : t('player.osd.fullScreen')} onclick={() => cmd({ type: 'toggle-fullscreen' })}>
          <Icon name={s?.fullscreen ? 'exitFullscreen' : 'fullscreen'} size={16} />
        </button>
        <button class="close" title={t('common.actions.close')} aria-label={t('common.actions.close')} onclick={() => cmd({ type: 'stop' })}><Icon name="close" size={16} /></button>
      </div>
    {/if}
  </header>

  {#if showStats && s}
    <aside class="stats glass thick">
      <div class="stats-head">
        <span class="headline">{t('player.osd.info')}</span>
        <button class="mini" onclick={() => (showStats = false)} aria-label={t('common.actions.close')}><Icon name="close" size={12} stroke={2.4} /></button>
      </div>
      {#each statRows as [k, v] (k)}
        <div class="stat"><span class="k">{k}</span><span class="v mono">{v}</span></div>
      {/each}
    </aside>
  {/if}

  {#if flash}
    {#key flash.n}
      <div class="flash" class:f-play={flash.kind === 'play'} class:f-back={flash.kind === 'back'} class:f-fwd={flash.kind === 'fwd'} aria-hidden="true">
        <span class="flash-disc glass">
          {#if flash.kind === 'play'}<Icon name="play" size={38} fill />
          {:else if flash.kind === 'pause'}<Icon name="pause" size={36} fill />
          {:else}
            <Icon name={flash.kind === 'back' ? 'back10' : 'fwd30'} size={40} stroke={1.8} />
            <span class="flash-n mono">{flash.sec}</span>
          {/if}
        </span>
      </div>
    {/key}
  {/if}

  {#if pending}
    <div class="flash" aria-hidden="true"><span class="seek-pill glass mono">{seekBadge}</span></div>
  {/if}
  {#if holdBy}
    <div class="flash" role="status"><span class="seek-pill glass mono">{t('player.osd.holdSpeed')}</span></div>
  {/if}
  <div class="sr" role="status" aria-live="polite">{announce}</div>

  {#snippet spinner()}
    <svg class="spinner" width="46" height="46" viewBox="0 0 46 46" aria-hidden="true">
      <circle cx="23" cy="23" r="19" fill="none" stroke="rgb(255 255 255 / 0.14)" stroke-width="3.5" />
      <circle cx="23" cy="23" r="19" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="34 120" />
    </svg>
  {/snippet}
  {#if s?.reconnecting && s.active && !s.error}
    <!-- The stream dropped: main reopens it at the position (stream-recovery.ts); Retry after a minute. -->
    <div class="center">
      <div class="error glass thick" role="status">
        {@render spinner()}
        <div class="headline">{t('player.reconnect.title')}</div>
        {#if s.reconnecting.retry}
          <p>{t('player.reconnect.slow')}</p>
          <button class="btn" onclick={() => cmd({ type: 'reconnect-retry' })}>{t('player.reconnect.retry')}</button>
        {/if}
      </div>
    </div>
  {:else if s?.buffering && s.active && !s.error && !s.live?.tuning}
    <div class="center" aria-label={t('player.osd.loading')}>
      {@render spinner()}
    </div>
  {/if}

  {#if s?.error}
    <div class="center">
      <div class="error glass thick" role="alert">
        <span class="err-icon"><Icon name="exclamation" size={28} /></span>
        <div class="headline">{t('player.error.title')}</div>
        <p>{s.error}</p>
        <button class="btn" onclick={() => cmd({ type: 'stop' })}>{t('common.actions.close')}</button>
      </div>
    </div>
  {/if}

  {#if notice}
    <div class="notice glass" role="status" out:fade={{ duration: dur('fast') }}>{notice.key === 'player.quality.switched' ? t(notice.key, { label: qualityLabel(Number(notice.params?.bitrate)) }) : t(notice.key, notice.params)}</div>
  {/if}

  {#if segment}
    <div class="skip-wrap" out:fade={{ duration: dur('fast') }} class:lifted={uiShown} class:shown={pillShown}>
      <button class="skip-pill glass" tabindex={pillShown ? 0 : -1} onclick={skipSegment}>
        {t(`player.skip.${segment}`)}
      </button>
    </div>
  {/if}

  {#if promptLeft !== null}
    <div class="nextup sleep-prompt glass thick" class:lifted={uiShown} role="alertdialog" aria-label={t('player.sleep.stillWatching')}>
      <div class="headline">{t('player.sleep.stillWatching')}</div>
      <p class="nu-note mono" aria-hidden="true">{t('player.sleep.pausingIn', { seconds: promptLeft })}</p>
      <span class="sr" role="status">{promptAnnounce}</span>
      <div class="nextup-actions">
        <button class="btn light" use:focusFirst onclick={sleepContinue}>{t('player.sleep.continue')}</button>
        <button class="btn ghost" onclick={sleepPause}>{t('player.sleep.pause')}</button>
      </div>
    </div>
  {:else if up && !panel}
    <div class="nextup glass thick" class:lifted={uiShown} role={up.stillWatching ? 'alertdialog' : 'status'} aria-label={up.stillWatching ? t('player.upNext.stillWatching') : t('player.upNext.title')}>
      {#if up.stillWatching}
        <div class="headline">{t('player.upNext.stillWatching')}</div>
        <p class="nu-note">{t('player.upNext.pausedNote')}</p>
        <div class="nextup-actions">
          <button class="btn light" onclick={() => cmd({ type: 'next' })}><Icon name="play" size={14} fill /> {t('player.upNext.continue')}</button>
          <button class="btn ghost" onclick={() => cmd({ type: 'stop' })}>{t('player.upNext.stop')}</button>
        </div>
      {:else}
        <div class="nu-head">
          {#if up.imageItemId}
            <span class="nu-still">
              <img src={imageUrl(up.imageItemId, 'Primary', { tag: up.imageTag, maxWidth: 160, server: item?.serverId })} alt="" decoding="async" onload={(e) => (e.currentTarget as HTMLElement).classList.add('in')} />
            </span>
          {/if}
          <div class="nu-txt">
            <div class="footnote dim">{up.auto ? t('player.upNext.countdown', { seconds: Math.ceil(upLeftMs / 1000) }) : t('player.upNext.title')}</div>
            {#if upCode}<div class="nu-code">{upCode}</div>{/if}
            {#if up.name}<div class="headline nu-name">{up.name}</div>{/if}
          </div>
        </div>
        <div class="nextup-actions">
          <button class="btn light" onclick={() => cmd({ type: 'next' })}><Icon name="play" size={14} fill /> {t('player.upNext.watchNow')}</button>
          <button class="btn ghost" onclick={() => cmd({ type: 'up-next-cancel' })}>{t('common.actions.cancel')}</button>
        </div>
        {#if up.auto}
          <span class="countdown" style:transform="scaleX({1 - upLeftMs / up.countdownMs})" aria-hidden="true"></span>
        {/if}
      {/if}
    </div>
  {/if}

  <footer class="dock">
    <div class="capsule glass">
      {#if s?.live}<LiveTimeline state={s} />{:else}
      <div class="scrub-row">
        <span class="time mono">{clock(position)}</span>
        <div
          class="scrub"
          class:drag={dragging}
          bind:this={bar}
          bind:clientWidth={barW}
          role="slider"
          tabindex="0"
          aria-label={t('player.osd.position')}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration / 1000)}
          aria-valuenow={Math.round(position / 1000)}
          aria-valuetext={clock(position)}
          onpointerdown={onBarDown}
          onpointermove={onBarMove}
          onpointerup={onBarUp}
          onpointerenter={wantThumbs}
          onpointerleave={() => (hoverFraction = null)}
        >
          <div class="track">
            <span class="layer buf" style:transform="scaleX({bufFraction})"></span>
            <span class="layer hov" class:show={hoverFraction !== null && !dragging} style:transform="scaleX({hoverFraction ?? 0})"></span>
            <span class="layer fill" style:transform="scaleX({fraction})"></span>
            {#each chapters as ch (ch.startMs)}
              <span class="tick" style:left="{(ch.startMs / duration) * 100}%"></span>
            {/each}
          </div>
          <span class="knob" style:transform="translate3d({fraction * barW}px, 0, 0)"><span></span></span>
          {#if hoverFraction !== null && duration > 0}
            <div class="tip" style:transform="translate3d({Math.min(barW - tipHalf, Math.max(tipHalf, hoverFraction * barW))}px, 0, 0)">
              <span class="tip-in glass" class:has-thumb={thumb}>
                {#if thumb}
                  <span class="thumb">
                    {#if thumb.cell}
                      {@const sc = THUMB_W / thumb.cell.width}
                      <span
                        class="cell"
                        style:width="{THUMB_W}px"
                        style:height="{thumb.cell.height * sc}px"
                        style:background-image="url('{thumb.src}')"
                        style:background-size="{thumb.cell.cols * THUMB_W}px auto"
                        style:background-position="{-thumb.cell.col * THUMB_W}px {-thumb.cell.row * thumb.cell.height * sc}px"
                      ></span>
                    {:else}
                      <img src={thumb.src} alt="" decoding="async" />
                    {/if}
                  </span>
                {/if}
                {#if hoverChapter}<span class="tip-ch">{hoverChapter.name}</span>{/if}
                <span class="mono">{clock(hoverMs)}</span>
              </span>
            </div>
          {/if}
        </div>
        <span class="time mono dim">−{clock(Math.max(0, duration - position))}</span>
        {#if endsAt}<span class="ends dim">{t('player.osd.endsAt', { time: endsAt })}</span>{/if}
      </div>
      {/if}
      <div class="controls">
        <div class="side left">
          <button class="ctl" title={t('player.osd.muteHint')} aria-label={t('player.osd.mute')} onclick={() => s && cmd({ type: 'mute', value: !s.muted })}>
            <Icon name={volume === 0 ? 'mute' : 'volume'} size={20} />
          </button>
          <div
            class="vol"
            class:drag={volDrag}
            role="slider"
            tabindex="0"
            aria-label={t('player.osd.volume')}
            aria-valuemin={0}
            aria-valuemax={volMax}
            aria-valuenow={volume}
            onpointerdown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              volDrag = true;
              volumeAt(e);
            }}
            onpointermove={(e) => {
              if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) volumeAt(e);
            }}
            onpointerup={() => ((volDrag = false), releaseVolDraft())}
            onpointercancel={() => ((volDrag = false), releaseVolDraft())}
            onkeydown={(e) => {
              const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 5 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -5 : 0;
              if (!d) return;
              e.preventDefault();
              e.stopPropagation();
              setVolume(volume + d);
            }}
          >
            <span class="vol-track"><span class="vol-fill" style:transform="scaleX({volume / volMax})"></span></span>
          </div>
        </div>

        <div class="mid">
          <button class="ctl" title={t('player.osd.previousHint')} aria-label={t('player.osd.previous')} disabled={!hasPrev} onclick={() => cmd({ type: 'previous' })}><Icon name="prev" size={18} fill /></button>
          <button class="ctl skip" title={t('player.osd.skipBackHint', { seconds: stepShort / 1000 })} aria-label={t('player.osd.skipBack', { seconds: stepShort / 1000 })} onclick={() => skip(-stepShort)}>
            <Icon name="back10" size={26} /><span class="mono">{stepShort / 1000}</span>
          </button>
          <button class="ctl play" title={t('player.osd.playPauseHint')} aria-label={s?.paused ? t('player.osd.play') : t('player.osd.pause')} onclick={() => cmd({ type: 'toggle-pause' })}>
            <span class="pp glyph-play" class:show={s?.paused ?? true}><Icon name="play" size={30} fill /></span>
            <span class="pp" class:show={!(s?.paused ?? true)}><Icon name="pause" size={28} fill /></span>
          </button>
          <button class="ctl skip" title={t('player.osd.skipForwardHint', { seconds: stepShort / 1000 })} aria-label={t('player.osd.skipForward', { seconds: stepShort / 1000 })} onclick={() => skip(stepShort)}>
            <Icon name="fwd30" size={26} /><span class="mono">{stepShort / 1000}</span>
          </button>
          <button class="ctl" title={t('player.osd.nextHint')} aria-label={t('player.osd.next')} disabled={!hasNext} onclick={() => cmd({ type: 'next' })}><Icon name="next" size={18} fill /></button>
        </div>

        <div class="side right">
          {#if allChapters.length > 1}
            <div class="pop">
              <button class="ctl" class:on={panel === 'chapters'} title={t('player.osd.chapters')} aria-label={t('player.osd.chapters')} aria-expanded={panel === 'chapters'} onclick={(e) => togglePanel('chapters', e)}>
                <Icon name="list" size={20} />
              </button>
              <div class="panel glass thick" class:open={panel === 'chapters'} inert={panel !== 'chapters'} role="menu">
                <div class="col chapters">
                  <div class="col-h">{t('player.osd.chapters')}</div>
                  {#each allChapters as ch, i (ch.index)}
                    <button
                      class="chap"
                      class:current={i === currentChapter}
                      role="menuitemradio"
                      aria-checked={i === currentChapter}
                      onclick={() => {
                        seekTo(ch.startMs);
                        panel = null;
                      }}
                    >
                      <span class="chap-img">
                        {#if ch.imageTag && item && chaptersSeen}
                          <img
                            src={imageUrl(item.id, 'Chapter', { index: ch.index, tag: ch.imageTag, maxWidth: 112, server: item.serverId })}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            onload={(e) => (e.currentTarget as HTMLElement).classList.add('in')}
                          />
                        {/if}
                      </span>
                      <span class="chap-txt">
                        <span class="lbl">{ch.name}</span>
                        <span class="chap-t mono">{clock(ch.startMs)}</span>
                      </span>
                    </button>
                  {/each}
                </div>
              </div>
            </div>
          {/if}

          <div class="pop">
            <button class="ctl" class:on={panel === 'tracks'} title={t('player.tracks.buttonHint', { label: trackLabel })} aria-label={trackLabel} aria-expanded={panel === 'tracks'} onclick={(e) => togglePanel('tracks', e)}>
              <Icon name="bubble" size={20} />
            </button>
            <div class="panel glass thick tracks" class:open={panel === 'tracks'} inert={panel !== 'tracks'} role="menu">
              <div class="col">
                <div class="col-h">{t('player.tracks.audio')}</div>
                {#each s?.audioTracks ?? [] as track (track.index)}
                  <button role="menuitemradio" aria-checked={track.index === s?.audioIndex} onclick={() => { cmd({ type: 'audio', index: track.index }); panel = null; }}>
                    <span class="check">{#if track.index === s?.audioIndex}<Icon name="check" size={14} stroke={2.4} />{/if}</span>
                    <span class="lbl">{track.label}</span>
                  </button>
                {:else}
                  <div class="none">{t('player.tracks.noTracks')}</div>
                {/each}
              </div>
              <div class="col">
                <div class="col-h">{t('player.tracks.subtitles')}</div>
                <button role="menuitemradio" aria-checked={s?.subtitleIndex === null} onclick={() => { cmd({ type: 'subtitle', index: -1 }); panel = null; }}>
                  <span class="check">{#if s?.subtitleIndex === null}<Icon name="check" size={14} stroke={2.4} />{/if}</span>
                  <span class="lbl">{t('player.tracks.off')}</span>
                </button>
                {#each s?.subtitleTracks ?? [] as track (track.index)}
                  <button
                    role="menuitemradio"
                    aria-checked={track.index === s?.subtitleIndex}
                    onclick={() => { cmd({ type: 'subtitle', index: track.index }); panel = null; secondaryFor = null; }}
                    oncontextmenu={(e) => { e.preventDefault(); secondaryFor = s?.player === 'mpv' && !s.live && s.subtitleIndex !== null && track.index !== s.subtitleIndex ? track.index : null; }}
                  >
                    <span class="check">{#if track.index === s?.subtitleIndex}<Icon name="check" size={14} stroke={2.4} />{/if}</span>
                    <span class="lbl">{track.label}</span>
                    {#if track.isForced}<span class="tag">{t('player.tracks.forced')}</span>{/if}
                    {#if track.isExternal}<span class="tag">{t('player.tracks.external')}</span>{/if}
                    {#if track.index === s?.secondarySubtitleIndex}<span class="tag">{t('player.tracks.secondaryBadge')}</span>{/if}
                  </button>
                  {#if secondaryFor === track.index}
                    <button role="menuitemcheckbox" aria-checked={track.index === s?.secondarySubtitleIndex} onclick={() => { cmd({ type: 'secondary-subtitle', index: track.index === s?.secondarySubtitleIndex ? null : track.index }); panel = null; secondaryFor = null; }}>
                      <span class="check">{#if track.index === s?.secondarySubtitleIndex}<Icon name="check" size={14} stroke={2.4} />{/if}</span>
                      <span class="lbl">{t('player.tracks.secondary')}</span>
                    </button>
                  {/if}
                {/each}
                {#if subSearch}
                  <button role="menuitem" onclick={() => { panel = null; subSearchOpen = true; }}>
                    <span class="check"><Icon name="search" size={14} /></span>
                    <span class="lbl">{t('player.tracks.searchSubtitles')}</span>
                  </button>
                {/if}
              </div>
            </div>
          </div>

          <div class="pop">
            <button class="ctl" class:on={panel === 'speed'} title={t('player.speed.label')} aria-label={t('player.speed.label')} aria-expanded={panel === 'speed'} onclick={(e) => togglePanel('speed', e)}>
              <Icon name="gauge" size={20} />
              {#if s && s.rate !== 1}<span class="badge mono">{t('player.speed.rate', { rate: fmt.number(s.rate) })}</span>{/if}
            </button>
            <div class="panel glass thick narrow" class:open={panel === 'speed'} inert={panel !== 'speed'} role="menu">
              <div class="col">
                <div class="col-h">{t('player.speed.title')}</div>
                {#each SPEEDS as r (r)}
                  <button role="menuitemradio" aria-checked={r === s?.rate} onclick={() => { cmd({ type: 'rate', value: r }); panel = null; }}>
                    <span class="check">{#if r === s?.rate}<Icon name="check" size={14} stroke={2.4} />{/if}</span>
                    <span class="lbl">{r === 1 ? t('player.speed.normal') : t('player.speed.rate', { rate: fmt.number(r) })}</span>
                  </button>
                {/each}
              </div>
            </div>
          </div>

          <button
            class="ctl"
            class:on={Boolean(sleep)}
            title={t('player.osd.sleep')}
            aria-label={sleepLeft !== null ? t('player.osd.sleepActive', { time: clock(sleepLeft) }) : t('player.osd.sleep')}
            onclick={(e) => {
              e.stopPropagation();
              sleepOpen = true;
            }}
          >
            <Icon name="moon" size={19} />
            {#if sleepLeft !== null}<span class="badge mono">{clock(sleepLeft)}</span>{/if}
          </button>

          {#if s?.qualityOptions}
            {@const cap = s.currentQuality?.maxBitrate ?? null}
            <button
              class="ctl"
              class:on={cap !== null}
              title={t('player.osd.qualityHint')}
              aria-label={`${t('player.osd.quality')} · ${qualityLabel(cap)}`}
              onclick={(e) => {
                e.stopPropagation();
                qualityOpen = true;
              }}
            >
              <Icon name="settings" size={19} />
              {#if cap !== null}<span class="badge mono">{qualityLabel(cap).split(' ')[0]}</span>{/if}
            </button>
          {/if}

          <button class="ctl" class:on={showStats} title={t('player.osd.infoHint')} aria-label={t('player.osd.info')} onclick={() => (showStats = !showStats)}><Icon name="info" size={20} /></button>

          <div class="pop">
            <!-- A click moves to the next format and opens the list, so either way works. -->
            <button
              class="ctl"
              class:on={panel === 'aspect'}
              title={t('player.aspect.hint')}
              aria-label={t('player.aspect.label')}
              aria-expanded={panel === 'aspect'}
              onclick={(e) => {
                e.stopPropagation();
                nextAspect();
                panel = 'aspect';
              }}
            >
              <Icon name="aspect" size={20} />
            </button>
            <div class="panel glass thick narrow" class:open={panel === 'aspect'} inert={panel !== 'aspect'} role="menu">
              <div class="col">
                <div class="col-h">{t('player.aspect.title')}</div>
                {#each ASPECT_MODES as m (m)}
                  <div class="aspect-row">
                    <button role="menuitemradio" aria-checked={m === aspect.mode} onclick={() => setAspect(m)}>
                      <span class="check">{#if m === aspect.mode}<Icon name="check" size={14} stroke={2.4} />{/if}</span>
                      <span class="lbl">{m === 'zoom' && aspect.mode === 'zoom' ? t('player.aspect.zoomPercent', { percent: Math.round(aspect.zoom * 100) }) : t(`player.aspect.modes.${m}`)}</span>
                    </button>
                    {#if m === 'zoom' && aspect.mode === 'zoom'}
                      <button class="mini" aria-label={t('player.aspect.zoomOut')} disabled={aspect.zoom <= ZOOM_STEPS[0]} onclick={() => stepZoom(-1)}><Icon name="minimize" size={12} stroke={2.4} /></button>
                      <button class="mini" aria-label={t('player.aspect.zoomIn')} disabled={aspect.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} onclick={() => stepZoom(1)}><Icon name="plus" size={12} stroke={2.4} /></button>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          </div>

          <button class="ctl" title={t('player.osd.fullScreenHint')} aria-label={s?.fullscreen ? t('player.osd.exitFullScreen') : t('player.osd.fullScreen')} onclick={() => cmd({ type: 'toggle-fullscreen' })}>
            <Icon name={s?.fullscreen ? 'exitFullscreen' : 'fullscreen'} size={19} />
          </button>
        </div>
      </div>

    </div>
  </footer>
</div>

<SleepTimerSheet open={sleepOpen} {sleep} live={Boolean(s?.live)} now={wall} onclose={() => (sleepOpen = false)} oncommand={cmd} />
<QualitySheet open={qualityOpen && Boolean(s?.qualityOptions)} state={s} onclose={() => (qualityOpen = false)} oncommand={cmd} />
<SubtitleSearchSheet open={subSearchOpen && subSearch} state={s} onclose={() => (subSearchOpen = false)} oncommand={cmd} />
<CastPicker />

<style>
  .osd {
    position: fixed;
    inset: 0;
    z-index: 10;
    color: var(--label);
    overflow: hidden;
  }
  .osd.hidden {
    cursor: none;
  }
  .surface {
    position: absolute;
    inset: 0;
  }
  /* Keep a non-zero alpha so the transparent OSD window always receives the mouse. */
  .osd.mpv .surface {
    background: rgb(0 0 0 / 0.01);
  }

  /* Materials: blurred over the in-page <video>; over mpv (another window)
     blur has nothing to sample, so use a denser tinted fill instead. */
  .glass {
    background: var(--material);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    box-shadow:
      inset 0 0 0 0.5px var(--hairline),
      var(--shadow-2);
  }
  .glass.thick {
    background: var(--material-thick);
  }
  .mpv .glass {
    background: var(--material-thick);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

  /* ---- Fade groups ---- */
  .scrim,
  .top,
  .dock {
    transition:
      opacity var(--t-med) var(--ease),
      transform var(--t-slow) var(--ease);
  }
  .hidden .scrim,
  .hidden .top,
  .hidden .dock {
    opacity: 0;
    pointer-events: none;
    transition-duration: var(--t-slow);
  }
  .hidden .top {
    transform: translate3d(0, -10px, 0);
    -webkit-app-region: no-drag;
  }
  .hidden .dock {
    transform: translate3d(0, 16px, 0);
  }
  .scrim {
    position: absolute;
    left: 0;
    right: 0;
    pointer-events: none;
  }
  .top-scrim {
    top: 0;
    height: 180px;
    background: linear-gradient(to bottom, rgb(0 0 0 / 0.62), rgb(0 0 0 / 0.22) 55%, transparent);
  }
  .bottom-scrim {
    bottom: 0;
    height: 260px;
    background: linear-gradient(to top, rgb(0 0 0 / 0.6), rgb(0 0 0 / 0.2) 55%, transparent);
  }

  /* ---- Top bar ---- */
  .top {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 20px 24px 40px;
    -webkit-app-region: drag;
  }
  .top.caption-gap {
    padding-right: calc(var(--caption-buttons) + 12px);
  }
  .round {
    width: 40px;
    height: 40px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 999px;
    transition: transform var(--t-med) var(--spring);
  }
  .round:hover {
    transform: scale(1.06);
  }
  .round:active {
    transform: scale(0.92);
  }
  .title {
    min-width: 0;
    flex: 1;
    text-shadow: 0 1px 12px rgb(0 0 0 / 0.45);
  }
  .t1 {
    font-size: var(--fs-title-3);
    font-weight: 650;
    letter-spacing: -0.014em;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t2 {
    margin-top: 1px;
    font-size: var(--fs-callout);
    color: var(--label-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .winbtns {
    display: flex;
    align-self: flex-start;
    margin: -20px -24px 0 0;
  }
  .winbtns button {
    width: 46px;
    height: 36px;
    display: grid;
    place-items: center;
    color: var(--label-2);
  }
  .winbtns button:hover {
    background: var(--fill-3);
    color: var(--label);
  }
  .winbtns .close:hover {
    background: var(--red);
    color: #fff;
  }

  /* ---- Stats ---- */
  .stats {
    position: absolute;
    top: 84px;
    left: 24px;
    z-index: 4;
    min-width: 300px;
    padding: 14px 16px 12px;
    border-radius: var(--r-md);
    font-size: var(--fs-footnote);
    animation: pop var(--t-med) var(--spring) both;
    transform-origin: top left;
  }
  .stats-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .stats-head .headline {
    font-size: var(--fs-callout);
  }
  .mini {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--fill-2);
    color: var(--label-2);
  }
  .mini:hover {
    background: var(--fill-3);
    color: var(--label);
  }
  .stat {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    line-height: 1.8;
  }
  .stat .k {
    color: var(--label-2);
  }
  .stat .v {
    text-align: right;
  }

  /* ---- Centre feedback ---- */
  .center,
  .flash {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
  }
  .center {
    z-index: 3;
  }
  .f-back {
    padding-right: 50%;
  }
  .f-fwd {
    padding-left: 50%;
  }
  .flash-disc {
    position: relative;
    width: 88px;
    height: 88px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    animation: flash var(--t-slow) var(--ease-out) both;
  }
  /* The play/pause disc: 72 px (X-04), alone when the controls are hidden. */
  .flash:not(.f-back):not(.f-fwd) .flash-disc {
    width: 72px;
    height: 72px;
    animation-duration: var(--t-slow);
  }
  .seek-pill {
    display: flex;
    align-items: center;
    height: 44px;
    padding: 0 20px;
    border-radius: 999px;
    font-size: var(--fs-title-3);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .ends {
    flex: none;
    font-size: var(--fs-footnote);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .f-play .flash-disc :global(svg) {
    margin-left: 5px;
  }
  .flash-n {
    position: absolute;
    font-size: 11px;
    font-weight: 700;
    padding-top: 2px;
  }
  @keyframes flash {
    0% {
      opacity: 0;
      transform: scale(0.7);
    }
    22% {
      opacity: 1;
      transform: scale(1);
    }
    60% {
      opacity: 1;
    }
    100% {
      opacity: 0;
      transform: scale(1.18);
    }
  }
  .spinner {
    animation: spin var(--t-spin) linear infinite;
    filter: drop-shadow(0 2px 10px rgb(0 0 0 / 0.5));
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .error {
    pointer-events: auto;
    max-width: 420px;
    padding: 26px 28px 22px;
    border-radius: var(--r-xl);
    display: grid;
    justify-items: center;
    text-align: center;
    gap: 6px;
    animation: pop var(--t-med) var(--spring) both;
  }
  .err-icon {
    color: var(--label-2);
    margin-bottom: 4px;
  }
  .error p {
    margin: 0 0 12px;
    color: var(--label-2);
    font-size: var(--fs-callout);
  }

  /* ---- Up next ---- */
  .nextup {
    position: absolute;
    right: 28px;
    bottom: 28px;
    z-index: 3;
    width: 340px;
    padding: 16px 18px 18px;
    border-radius: var(--r-lg);
    overflow: hidden;
    animation: rise var(--t-slow) var(--ease-out) both;
    transition: transform var(--t-slow) var(--ease);
  }
  .nextup.lifted {
    transform: translate3d(0, -128px, 0);
  }
  .nextup .headline {
    margin: 2px 0 14px;
  }
  .nextup-actions {
    display: flex;
    gap: 6px;
  }
  .nextup .btn {
    height: 32px;
    padding: 0 14px;
  }
  .nu-head {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-bottom: 14px;
  }
  .nu-still {
    flex: none;
    width: 112px;
    height: 63px;
    border-radius: var(--r-xs);
    background: var(--fill-1);
    overflow: hidden;
  }
  .nu-still img,
  .chap-img img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity var(--t-med) var(--ease);
  }
  .nu-still :global(img.in),
  .chap-img :global(img.in) {
    opacity: 1;
  }
  .nu-txt {
    min-width: 0;
  }
  .dim {
    color: var(--label-2);
  }
  .nu-code {
    margin-top: 2px;
    font-size: var(--fs-caption);
    color: var(--label-2);
  }
  .nextup .nu-name {
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .nu-note {
    margin: -10px 0 14px;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }

  /* ---- Brief readout (delay, intro skipped) ---- */
  .notice {
    position: absolute;
    top: 84px;
    left: 50%;
    z-index: 3;
    translate: -50% 0;
    display: flex;
    align-items: center;
    height: 34px;
    padding: 0 16px;
    border-radius: 999px;
    font-size: var(--fs-callout);
    font-weight: 560;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    pointer-events: none;
    animation: notice-in var(--t-med) var(--ease-out) both;
  }
  @keyframes notice-in {
    from {
      opacity: 0;
      transform: translate3d(0, -6px, 0);
    }
  }

  /* ---- Skip intro / credits ---- */
  .skip-wrap {
    position: absolute;
    right: 28px;
    bottom: 28px;
    z-index: 3;
    opacity: 0;
    pointer-events: none;
    transition:
      opacity var(--t-slow) var(--ease),
      transform var(--t-slow) var(--ease);
  }
  .skip-wrap.shown {
    opacity: 1;
    pointer-events: auto;
    transition-duration: var(--t-med), var(--t-slow);
  }
  .skip-wrap.lifted {
    transform: translate3d(0, -128px, 0);
  }
  .skip-pill {
    position: relative;
    height: 44px;
    padding: 0 22px;
    border-radius: 999px;
    font-size: var(--fs-headline);
    font-weight: 600;
    color: var(--label);
    isolation: isolate;
    transition:
      transform var(--t-med) var(--spring);
  }
  /* Focus and hover turn the pill white, tvOS style; the fill fades rather than the background. */
  .skip-pill::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--label);
    opacity: 0;
    z-index: -1;
    transition: opacity var(--t-fast) var(--ease);
  }
  .skip-pill:is(:hover, :focus-visible) {
    color: #000;
    transform: scale(1.04);
  }
  .skip-pill:is(:hover, :focus-visible)::before {
    opacity: 1;
  }
  .skip-pill:active {
    transform: scale(0.96);
    transition-duration: calc(var(--t-fast) / 2);
  }
  .countdown {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: var(--label);
    transform-origin: left;
    /* motion-ok: interpolates between the countdown ticks, not a UI motion */
    transition: transform 300ms linear;
  }

  /* ---- Dock ---- */
  .dock {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 2;
    display: flex;
    justify-content: center;
    padding: 0 24px 24px;
    pointer-events: none;
  }
  .capsule {
    position: relative;
    pointer-events: auto;
    width: min(max(960px, 56vw), 100%);
    padding: 10px 18px 8px;
    border-radius: var(--r-lg);
  }
  .controls {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
  }
  .side {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .right {
    justify-content: flex-end;
  }
  .mid {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ctl {
    position: relative;
    width: 38px;
    height: 38px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    color: var(--label);
    isolation: isolate;
    transition:
      transform var(--t-med) var(--spring), opacity var(--t-fast) var(--ease);
  }
  .ctl::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--fill-3);
    opacity: 0;
    transform: scale(0.8);
    transition:
      opacity var(--t-fast) var(--ease),
      transform var(--t-med) var(--spring);
    z-index: -1;
  }
  .ctl:hover::before,
  .ctl.on::before {
    opacity: 1;
    transform: none;
  }
  .ctl:active {
    transform: scale(0.88);
    transition-duration: calc(var(--t-fast) / 2);
  }
  .ctl:disabled {
    opacity: 0.3;
    pointer-events: none;
  }
  .skip span {
    position: absolute;
    font-size: 8.5px;
    font-weight: 700;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -40%);
  }
  .badge {
    position: absolute;
    top: 0;
    right: -4px;
    padding: 0 3px;
    border-radius: 4px;
    font-size: 9px;
    background: var(--label);
    color: #000;
  }
  .play {
    width: 52px;
    height: 52px;
  }
  /* Play and pause glyphs cross-fade with a spin-free scale. */
  .pp {
    grid-area: 1 / 1;
    display: grid;
    place-items: center;
    opacity: 0;
    transform: scale(0.6);
    transition:
      opacity var(--t-fast) var(--ease),
      transform var(--t-med) var(--spring);
  }
  .pp.show {
    opacity: 1;
    transform: none;
  }
  .glyph-play {
    margin-left: 3px;
  }

  /* Volume */
  .vol {
    width: 92px;
    height: 24px;
    display: flex;
    align-items: center;
    margin: 0 6px 0 2px;
    touch-action: none;
    border-radius: 4px;
  }
  .vol-track {
    position: relative;
    width: 100%;
    height: 4px;
    border-radius: 4px;
    background: var(--fill-4);
    overflow: hidden;
    transition: transform var(--t-fast) var(--ease);
  }
  .vol:hover .vol-track {
    transform: scaleY(1.5);
  }
  .vol-fill {
    position: absolute;
    inset: 0;
    background: var(--label);
    transform-origin: left;
    transition: transform var(--t-fast) var(--ease);
  }
  .vol.drag .vol-fill {
    transition: none;
  }

  /* Scrubber */
  .scrub-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 2px;
  }
  .time {
    min-width: 8ch;
    font-size: var(--fs-footnote);
    color: var(--label);
  }
  .time.dim {
    color: var(--label-2);
    text-align: right;
  }
  .scrub {
    position: relative;
    flex: 1;
    height: 22px;
    display: flex;
    align-items: center;
    touch-action: none;
    border-radius: 4px;
  }
  .track {
    position: relative;
    width: 100%;
    height: 5px;
    border-radius: 5px;
    background: var(--fill-3);
    overflow: hidden;
    transition: transform var(--t-med) var(--spring);
  }
  .scrub:hover .track,
  .scrub.drag .track,
  .scrub:focus-visible .track {
    transform: scaleY(1.6);
  }
  .layer {
    position: absolute;
    inset: 0;
    transform-origin: left;
  }
  .buf {
    background: var(--fill-3);
  }
  .hov {
    background: var(--fill-3);
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .hov.show {
    opacity: 1;
  }
  .fill {
    background: var(--label);
  }
  .tick {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: rgb(0 0 0 / 0.55);
  }
  .knob {
    position: absolute;
    left: -7px;
    top: 4px;
    width: 14px;
    height: 14px;
    pointer-events: none;
  }
  .knob span {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 6px rgb(0 0 0 / 0.45);
    transform: scale(0);
    transition: transform var(--t-med) var(--spring);
  }
  .scrub:hover .knob span,
  .scrub:focus-visible .knob span {
    transform: scale(1);
  }
  .scrub.drag .knob span {
    transform: scale(1.25);
  }
  .tip {
    position: absolute;
    left: 0;
    bottom: 30px;
    z-index: 6;
    pointer-events: none;
  }
  .tip-in {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 64px;
    padding: 5px 10px;
    border-radius: var(--r-sm);
    transform: translateX(-50%);
    font-size: var(--fs-footnote);
    white-space: nowrap;
    animation: fade var(--t-fast) var(--ease) both;
  }
  .tip-in.has-thumb {
    padding: 4px 4px 6px;
    gap: 2px;
  }
  .thumb {
    width: 224px;
    height: 126px;
    margin-bottom: 4px;
    display: grid;
    place-items: center;
    border-radius: calc(var(--r-sm) - 4px);
    background: #000;
    overflow: hidden;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .cell {
    display: block;
    background-repeat: no-repeat;
  }
  .tip-ch {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--fs-caption);
    color: var(--label-2);
  }

  /* ---- Popover panels (always mounted so they can spring both ways) ---- */
  /* Panels anchor to the capsule, not the button, so they clear the scrubber. */
  .panel {
    position: absolute;
    right: 0;
    bottom: calc(100% + 10px);
    z-index: 5;
    display: flex;
    gap: 4px;
    max-height: min(60vh, 440px);
    overflow-y: auto;
    padding: 8px;
    border-radius: var(--r-lg);
    transform-origin: bottom right;
    opacity: 0;
    transform: scale(0.88) translate3d(0, 8px, 0);
    visibility: hidden;
    transition:
      opacity var(--t-fast) var(--ease),
      transform var(--t-fast) var(--ease),
      visibility 0s linear var(--t-fast);
  }
  .panel.open {
    opacity: 1;
    transform: none;
    visibility: visible;
    transition:
      opacity var(--t-fast) var(--ease),
      transform var(--t-slow) var(--spring),
      visibility 0s;
  }
  .col {
    min-width: 220px;
    max-width: 300px;
    display: flex;
    flex-direction: column;
  }
  .narrow .col {
    min-width: 150px;
  }
  .aspect-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .aspect-row > button:first-child {
    flex: 1;
  }
  .col .aspect-row .mini {
    flex: none;
    width: 24px;
    min-height: 24px;
    padding: 0;
    justify-content: center;
    border-radius: 50%;
  }
  .col .aspect-row .mini:disabled {
    opacity: 0.35;
  }
  .col + .col {
    padding-left: 4px;
    box-shadow: inset 1px 0 0 var(--separator);
  }
  .col-h {
    padding: 6px 10px 6px 34px;
    font-size: var(--fs-footnote);
    font-weight: 600;
    color: var(--label-2);
  }
  .col button {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    padding: 0 10px 0 6px;
    border-radius: var(--r-xs);
    text-align: left;
    font-size: var(--fs-callout);
    color: var(--label);
  }
  .col button:hover,
  .col button:focus-visible {
    background: var(--fill-3);
    box-shadow: none;
  }
  .col.chapters {
    min-width: 300px;
    max-width: 340px;
  }
  .chapters .col-h {
    padding-left: 6px;
  }
  .col button.chap {
    gap: 12px;
    min-height: 66px;
    padding: 6px;
  }
  .col button.chap.current {
    background: var(--fill-2);
  }
  .chap-img {
    flex: none;
    width: 96px;
    height: 54px;
    border-radius: var(--r-xs);
    background: var(--fill-1);
    overflow: hidden;
  }
  .chap-txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .chap-t {
    font-size: var(--fs-caption);
    color: var(--label-2);
  }
  .none {
    padding: 6px 10px 6px 34px;
    font-size: var(--fs-callout);
    color: var(--label-3);
  }
  .check {
    width: 22px;
    flex: none;
    display: grid;
    place-items: center;
    color: var(--label);
  }
  .lbl {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tag {
    flex: none;
    font-size: 10px;
    font-weight: 600;
    color: var(--label-2);
    background: var(--fill-2);
    border-radius: 4px;
    padding: 1px 5px;
  }

  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.92);
    }
  }
</style>
