<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { PlaybackState } from '../../shared/contract';
  import Osd from '../components/Osd.svelte';
  import { w } from '../lib/bridge';
  import { locale, t } from '../lib/i18n.svelte';
  import { imageUrl } from '../lib/images';
  import { linux } from '../lib/platform';
  import { settings } from '../lib/stores.svelte';

  // Root of the transparent window that floats above mpv's video window.
  let pbState = $state<PlaybackState | null>(null);
  let audio: HTMLAudioElement | null = null;
  let silentUrl: string | null = null;
  let off: (() => void) | null = null;

  // One second of 8 kHz mono 16-bit silence. Chromium only hands
  // navigator.mediaSession to Windows (SMTC, media keys, volume flyout) while
  // a media element plays, and mpv renders outside the page. Same on Linux, where
  // Chromium publishes the session over MPRIS.
  function silentWav(): string {
    const rate = 8000;
    const samples = rate;
    const buf = new ArrayBuffer(44 + samples * 2);
    const v = new DataView(buf);
    const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + samples * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, samples * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  const cmd = (c: Parameters<typeof w.playback.command>[0]) => void w.playback.command(c).catch(() => undefined);

  function installHandlers(): void {
    const ms = navigator.mediaSession;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // Action not supported by this Chromium build.
      }
    };
    set('play', () => cmd({ type: 'resume' }));
    set('pause', () => cmd({ type: 'pause' }));
    set('stop', () => cmd({ type: 'stop' }));
    set('nexttrack', () => cmd({ type: 'next' }));
    set('previoustrack', () => cmd({ type: 'previous' }));
    set('seekbackward', (d) => cmd({ type: 'seek-relative', deltaMs: -(d.seekOffset ?? 10) * 1000 }));
    set('seekforward', (d) => cmd({ type: 'seek-relative', deltaMs: (d.seekOffset ?? 30) * 1000 }));
    set('seekto', (d) => {
      if (d.seekTime !== undefined) cmd({ type: 'seek', positionMs: d.seekTime * 1000 });
    });
  }

  // The veil over mpv's picture. Opening: main calls __wicabyVeil once it showed this window
  // (window-manager.ts createPlaybackWindows) and brings mpv's window in, and hides its own, when it resolves
  // (veil opaque); the veil lifts on the first frame after that. Exit (MpvPlayer.leave): up on 'out', down on
  // 'reveal'. Never with reduced motion.
  let opening = $state(true);
  let shown = $state(false);
  let held = $state(true);
  let veilUp: (() => void) | null = null;
  $effect(() => {
    if (!held && pbState?.active && !pbState.buffering) opening = false;
  });
  const veil = $derived(pbState?.exiting ? pbState.exiting === 'out' : opening && shown);
  (window as { __wicabyVeil?: () => Promise<void> }).__wicabyVeil = () =>
    new Promise<void>((resolve) => {
      veilUp = () => {
        veilUp = null;
        resolve();
        setTimeout(() => (held = false), 50);
      };
      requestAnimationFrame(() => (shown = true));
      setTimeout(() => veilUp?.(), 600);
    });

  onMount(() => {
    off = w.playback.onState((s) => {
      pbState = s;
    });
    void w.playback.getState().then((s) => (pbState ??= s));
    installHandlers();
  });

  onDestroy(() => {
    off?.();
    audio?.pause();
    audio = null;
    if (silentUrl) URL.revokeObjectURL(silentUrl);
  });

  // Silent keep-alive element. Skipped with WASAPI exclusive mode, where a
  // second shared stream on the device would fight mpv for the endpoint. Linux keeps it:
  // it is the only path for MPRIS and media keys there (needsGlobalMediaKeys, tray.ts).
  $effect(() => {
    const active = Boolean(pbState?.active);
    const paused = Boolean(pbState?.paused);
    const exclusive = !linux && Boolean(settings.value?.playback.audioExclusive);
    if (!active || exclusive) {
      audio?.pause();
      return;
    }
    if (!audio) {
      silentUrl = silentWav();
      audio = new Audio(silentUrl);
      audio.loop = true;
    }
    if (paused) audio.pause();
    else void audio.play().catch(() => undefined);
  });

  // Metadata shown in the Windows media flyout.
  let metaKey = '';
  $effect(() => {
    const item = pbState?.item;
    if (!item) return;
    // Live (§8.3): title = programme, artist = "{numéro} · {chaîne}", artwork = logo, on each adoption.
    const lv = pbState?.live;
    const ch = lv?.channel;
    const key = `${item.id}|${locale.current}|${ch?.id ?? ''}|${lv?.now?.id ?? ''}`;
    if (key === metaKey) return;
    metaKey = key;
    const [artId, artTag] = ch ? [ch.logoTag ? ch.id : '', ch.logoTag] : [item.imageItemId, item.imageTag];
    const artwork = artId ? [{ src: imageUrl(artId, 'Primary', { tag: artTag, maxHeight: 512, server: item.serverId }), sizes: '512x512', type: 'image/jpeg' }] : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ch ? lv?.now?.title || ch.name : item.name,
      artist: ch ? [ch.number, ch.name].filter(Boolean).join(' · ') : (item.seriesName ?? (item.year ? String(item.year) : '')),
      album: item.seriesName && item.seasonNumber !== undefined ? t('player.session.season', { season: item.seasonNumber }) : 'Wicaby',
      artwork,
    });
  });

  $effect(() => {
    const s = pbState;
    if (!s?.active) {
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    navigator.mediaSession.playbackState = s.paused ? 'paused' : 'playing';
    if (s.durationMs > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: s.durationMs / 1000,
          position: Math.min(s.durationMs, Math.max(0, s.positionMs)) / 1000,
          playbackRate: s.rate || 1,
        });
      } catch {
        // Invalid intermediate state (position beyond a stale duration).
      }
    }
  });
</script>

<!-- The veil sits under the controls: the loader stays visible while the picture is still black. -->
<div class="osd-root" class:leaving={pbState?.exiting}>
  <div class="veil" class:on={veil} aria-hidden="true" ontransitionend={() => veil && veilUp?.()}></div>
  <Osd state={pbState} mode="mpv" />
</div>

<style>
  .osd-root {
    position: fixed;
    inset: 0;
    background: transparent;
    overflow: hidden;
  }
  .leaving > :global(:not(.veil)) {
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms var(--ease-out);
  }
  /* Durations match EXIT_FADE_MS and EXIT_REVEAL_MS (main/playback/player.ts). */
  .veil {
    position: fixed;
    inset: 0;
    background: #000;
    opacity: 0;
    pointer-events: none;
    transition: opacity 200ms var(--ease-out);
  }
  /* Even all the way to black, so it holds black for a frame or two, not half the time. */
  .veil.on {
    opacity: 1;
    transition: opacity 220ms var(--ease-in-out);
  }
</style>
