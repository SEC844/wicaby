<script lang="ts">
  // Milestone 0 (walking skeleton): proves the toolchain on the oldest target engine. Shows the engine, the remote
  // keys as they arrive, and plays a test stream through the platform player. Replaced by the real shell next.
  import { onMount } from 'svelte';
  import { createPlayer, exitApp, platform } from './platform';
  import { keyOf, type Key } from './platform/keys';
  import type { VideoPlayer } from './platform/player';

  const TEST_STREAM =
    import.meta.env.VITE_TEST_STREAM ??
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

  let video: HTMLVideoElement;
  let player: VideoPlayer | undefined;
  let lastKey = $state<Key | '—'>('—');
  let status = $state('idle');
  let position = $state(0);
  let playing = $state(false);
  const engine = navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? '?';

  async function start(): Promise<void> {
    player ??= createPlayer(video);
    player.on('time', (ms) => (position = ms));
    player.on('error', (m) => (status = `error: ${m}`));
    player.on('ended', () => { status = 'ended'; playing = false; });
    status = 'opening';
    try {
      await player.open(TEST_STREAM);
      player.play();
      playing = true;
      status = `playing (${player.audioTracks().length} audio, ${player.textTracks().length} text tracks)`;
    } catch (e) {
      status = `error: ${(e as Error).message}`;
    }
  }

  $effect(() => {
    document.body.classList.toggle('playing', playing);
  });

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keyOf(e);
      if (!k) return;
      e.preventDefault();
      lastKey = k;
      if (k === 'ok' && !playing) void start();
      else if (k === 'playPause' || k === 'pause' || k === 'play') player?.[player.paused ? 'play' : 'pause']();
      else if (k === 'right') player?.seek(player.positionMs + 10_000);
      else if (k === 'left') player?.seek(player.positionMs - 10_000);
      else if (k === 'back') {
        if (playing) { player?.stop(); playing = false; status = 'stopped'; } else exitApp();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

<video bind:this={video} class:hidden={!playing}></video>
<main class:playing>
  <h1>Wicaby</h1>
  <p>platform {platform} · Chromium {engine}</p>
  <p>last key: <b>{lastKey}</b></p>
  <p>player: {status} · {Math.round(position / 1000)} s</p>
  <p class="hint">OK: play test stream · ◀ ▶: seek 10 s · Back: stop / exit</p>
</main>

<style>
  :global(html, body) {
    margin: 0;
    width: 1920px;
    height: 1080px;
    overflow: hidden;
    background: #0b0b0d;
    color: #f5f5f7;
    font: 32px/1.4 system-ui, sans-serif;
  }
  /* AVPlay draws behind the page: the page must be see-through while it plays (:has() is Chromium 105+). */
  :global(body.playing) { background: transparent; }
  video { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #000; }
  video.hidden { display: none; }
  main { position: relative; padding: 96px; }
  main.playing { background: linear-gradient(rgba(0, 0, 0, 0.6), transparent 40%); }
  h1 { margin: 0 0 24px; font-size: 64px; }
  .hint { opacity: 0.6; }
</style>
