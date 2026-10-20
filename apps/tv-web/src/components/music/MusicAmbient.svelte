<script lang="ts">
  // Android TV Ambient (music/Ambient.kt, music spec §4.7): black, the album art at 25 % opacity drifting a pixel a
  // second (OLED safe, no full-frame animation), the title, the artist and the current lyric line; the clock drifts
  // too, dimmed. The now-playing screen turns into it after 2 minutes without input, the screensaver shows it while
  // music plays.
  import { onMount } from 'svelte';
  import type { MusicSession } from '../../lib/music.svelte';
  import Clock from '../Clock.svelte';

  let { session }: { session: MusicSession } = $props();
  const DRIFT = 24;

  const item = $derived(session.current);
  const art = $derived(item ? session.api.poster(item, 720) : undefined);
  const artist = $derived(item?.Artists?.join(', ') || item?.AlbumArtist);
  // The synced line playing now (the last one started), none for plain or no lyrics.
  const lyrics = $derived(session.currentId ? session.lyrics.get(session.currentId) : undefined);
  const line = $derived.by(() => {
    if (!lyrics?.synced) return undefined;
    let text: string | undefined;
    for (const l of lyrics.lines) if ((l.startMs ?? 0) <= session.positionMs) text = l.text || undefined;
    return text;
  });

  // A triangle wave, ±DRIFT px, one step a second: the picture never sits still on the same pixels.
  let t = $state(0);
  const d = $derived(t < DRIFT * 2 ? t - DRIFT : DRIFT * 3 - t);
  onMount(() => {
    void session.loadLyrics();
    const timer = setInterval(() => (t = (t + 1) % (DRIFT * 4)), 1000);
    return () => clearInterval(timer);
  });
</script>

<div class="ambient">
  <div class="block" style="transform:translate3d({d}px,{d / 2}px,0)">
    <div class="art">{#if art}<img src={art} alt="" />{/if}</div>
    <p class="t-title2 title ellipsis">{item?.Name ?? ''}</p>
    {#if artist}<p class="t-callout artist ellipsis">{artist}</p>{/if}
    {#if line}<p class="t-title3 line">{line}</p>{/if}
  </div>
  <div class="clock" style="transform:translate3d({-d}px,{-d / 2}px,0)"><Clock /></div>
</div>

<style>
  .ambient {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 200;
    background: #000;
  }
  .block {
    position: absolute;
    top: 50%;
    left: 96rem;
    max-width: 640rem;
    margin-top: -220rem;
  }
  .art {
    width: 260rem;
    height: 260rem;
    border-radius: var(--r-lg);
    overflow: hidden;
    opacity: 0.25;
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  p {
    margin: 0;
  }
  .title {
    margin-top: 24rem;
    color: var(--label-2);
  }
  .artist {
    margin-top: 4rem;
    color: var(--label-3);
  }
  .line {
    margin-top: 20rem;
    color: var(--label-2);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .clock {
    position: absolute;
    right: 40rem;
    bottom: 40rem;
    opacity: 0.6;
  }
</style>
