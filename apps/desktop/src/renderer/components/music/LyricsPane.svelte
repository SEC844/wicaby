<script lang="ts" module>
  // Per-track offsets (s), kept on this device: the last 500 tracks, oldest dropped first.
  const OFFSETS_KEY = 'wicaby.music.lyricsOffsets';
  function readOffsets(): Record<string, number> {
    try {
      return JSON.parse(localStorage.getItem(OFFSETS_KEY) ?? '{}') as Record<string, number>;
    } catch {
      return {};
    }
  }
  function writeOffset(id: string, value: number): void {
    try {
      const all = readOffsets();
      delete all[id];
      if (value) all[id] = value;
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete all[k];
      localStorage.setItem(OFFSETS_KEY, JSON.stringify(all));
    } catch {
      // Best effort: the offset still applies for this session.
    }
  }
</script>

<script lang="ts">
  import type { NowPlayingItem } from '../../../shared/contract';
  import type { Lyrics } from '../../../shared/music';
  import { apiFor } from '../../lib/api';
  import { w } from '../../lib/bridge';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { lyrics as fetchLyrics } from '../../lib/music';
  import { command } from '../../lib/music-ui.svelte';
  import { settings } from '../../lib/stores.svelte';
  import Icon from '../Icon.svelte';

  // Server lyrics of the playing track (music-spec MU-05). Synced: the current line (the last one starting at or
  // before the position plus the offset) sits at 35 % of the height; click a line to seek there. Plain lyrics as
  // paragraphs; none, or any failure, shows the empty message (no toast).
  let { item, positionMs }: { item: NowPlayingItem; positionMs: number } = $props();

  let lyrics = $state<Lyrics | null>(null);
  // MU-13: 'lrclib' when the server had none and Settings > Audio allows lrclib.net (asked by main, cached there).
  let source = $state<'server' | 'lrclib'>('server');
  let loading = $state(true);
  let offset = $state(0);

  // Primitives: the state publishes a new item object on every time update.
  const trackId = $derived(item.id);
  const trackServer = $derived(item.serverId);
  $effect(() => {
    const id = trackId;
    const sid = trackServer;
    loading = true;
    lyrics = null;
    source = 'server';
    offset = readOffsets()[id] ?? 0;
    let live = true;
    apiFor(sid)
      .item(id)
      .then(async (full) => {
        const own = await fetchLyrics(full, sid);
        if (own || settings.value?.music.lyricsProvider !== 'server+lrclib' || !full.Name) return { l: own, from: 'server' as const };
        const artist = full.ArtistItems?.[0]?.Name ?? full.Artists?.[0] ?? full.AlbumArtist ?? '';
        const l = await w.music.lrclib({ id: full.Id, artist, title: full.Name, album: full.Album ?? '', durationMs: (full.RunTimeTicks ?? 0) / 10_000 });
        return { l, from: 'lrclib' as const };
      })
      .catch(() => ({ l: null, from: 'server' as const }))
      .then(({ l, from }) => {
        if (!live) return;
        lyrics = l;
        source = from;
        loading = false;
      });
    return () => (live = false);
  });

  function shift(by: number): void {
    offset = Math.round((offset + by) * 10) / 10;
    writeOffset(item.id, offset);
  }

  const current = $derived.by(() => {
    if (!lyrics?.synced) return -1;
    const at = positionMs + offset * 1000;
    let c = -1;
    lyrics.lines.forEach((l, i) => (l.startMs ?? 0) <= at && (c = i));
    return c;
  });

  let box = $state<HTMLDivElement>();
  let lineEls = $state<HTMLElement[]>([]);
  let boxH = $state(0);
  let boxW = $state(0);
  const y = $derived.by(() => {
    // Read so a width-only resize (lines re-wrap, offsets move) recentres too.
    void boxW;
    const el = lineEls[Math.max(0, current)];
    return el ? boxH * 0.35 - el.offsetTop - el.offsetHeight / 2 : boxH * 0.35;
  });
</script>

<div class="lyrics" data-lyrics={loading ? 'loading' : lyrics ? (lyrics.synced ? 'synced' : 'plain') : 'none'}>
  {#if loading}
    <div class="sk skeleton"></div>
  {:else if !lyrics}
    <p class="none callout">{t('music.lyrics.none')}</p>
  {:else if lyrics.synced}
    <div class="box" bind:this={box} bind:clientHeight={boxH} bind:clientWidth={boxW}>
      <ol class="lines" style:transform="translateY({y}px)" data-current={current}>
        {#each lyrics.lines as line, i (i)}
          <li bind:this={lineEls[i]}>
            <button class="title-2 line" class:now={i === current} class:past={i < current} data-start={line.startMs} onclick={() => command({ type: 'seek', positionMs: Math.max(0, (line.startMs ?? 0) - offset * 1000) })}>
              {line.text || '♪'}
            </button>
          </li>
        {/each}
      </ol>
    </div>
    <div class="offset caption">
      <span>{t('music.lyrics.offset')}</span>
      <button class="btn ghost icon" title={t('music.lyrics.later')} aria-label={t('music.lyrics.later')} onclick={() => shift(-0.1)}>−</button>
      <span class="mono" data-offset={offset}>{t('music.lyrics.offsetValue', { value: fmt.number(offset, { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'exceptZero' }) })}</span>
      <button class="btn ghost icon" title={t('music.lyrics.earlier')} aria-label={t('music.lyrics.earlier')} onclick={() => shift(0.1)}>+</button>
    </div>
  {:else}
    <div class="plain">
      <p class="caption unsynced"><Icon name="lyrics" size={12} /> {t('music.lyrics.unsynced')}</p>
      {#each lyrics.lines as line, i (i)}
        {#if line.text}<p class="title-3">{line.text}</p>{:else}<p class="gap" aria-hidden="true"></p>{/if}
      {/each}
    </div>
  {/if}
  {#if lyrics && source === 'lrclib'}<p class="caption source" data-source="lrclib">{t('music.lyrics.source.lrclib')}</p>{/if}
</div>

<style>
  .lyrics {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .box {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    mask-image: linear-gradient(transparent, #000 12%, #000 80%, transparent);
  }
  .lines {
    list-style: none;
    margin: 0;
    padding: 0;
    transition: transform var(--t-med) var(--ease);
  }
  :global(html[data-reduce-motion]) .lines {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .lines {
      transition: none;
    }
  }
  .line {
    display: block;
    width: 100%;
    padding: 6px 0;
    text-align: left;
    color: var(--label-2);
  }
  .line.past {
    color: var(--label-3);
  }
  .line.now {
    color: var(--label);
  }
  .line:hover,
  .line:focus-visible {
    color: var(--label);
  }
  .offset {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 10px;
    color: var(--label-3);
  }
  .offset .btn {
    width: 26px;
    height: 26px;
  }
  .plain {
    overflow-y: auto;
  }
  .plain p {
    margin: 0 0 8px;
  }
  .plain .gap {
    height: 18px;
  }
  .unsynced {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--label-3);
  }
  .source {
    flex: none;
    padding-top: 6px;
    color: var(--label-3);
  }
  .none {
    margin: auto 0;
    color: var(--label-3);
    text-align: center;
  }
  .sk {
    height: 22px;
    width: 60%;
    margin-top: 30%;
    border-radius: 6px;
  }
</style>
