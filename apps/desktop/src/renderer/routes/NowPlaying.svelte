<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import LyricsPane from '../components/music/LyricsPane.svelte';
  import QueuePanel from '../components/music/QueuePanel.svelte';
  import SeekBar from '../components/music/SeekBar.svelte';
  import Transport from '../components/music/Transport.svelte';
  import Segmented from '../components/Segmented.svelte';
  import TitleBar from '../components/TitleBar.svelte';
  import { itemPath } from '../lib/api';
  import { t } from '../lib/i18n.svelte';
  import { imageUrl } from '../lib/images';
  import { ensureItems, known, musicActive, toggleFavorite } from '../lib/music-ui.svelte';
  import { back, navigate, router } from '../lib/router.svelte';
  import { playback } from '../lib/stores.svelte';

  // The full-screen player (music-spec §4.3): the album art, scaled down to 64 px then blurred, under a --bg scrim
  // (opaque with "Réduire la transparence"); art, title, links, controls on the left; lyrics or the queue on the
  // right. Escape (the music shortcuts) or ↓ (onKey below) closes it; the art morphs from the bar's
  // (view-transition-name).
  const s = $derived(playback.value);
  const it = $derived(s?.item);
  const track = $derived(it ? known[it.id] : undefined);
  const fav = $derived(Boolean(track?.UserData?.IsFavorite));
  const art = (h: number) => (it?.imageItemId ? imageUrl(it.imageItemId, 'Primary', { tag: it.imageTag, maxHeight: h, server: it.serverId }) : '');
  const artist = $derived(track?.ArtistItems?.[0] ?? track?.AlbumArtists?.[0]);
  const tab = $derived((router.route.query.get('tab') === 'queue' ? 'queue' : 'lyrics') as 'lyrics' | 'queue');

  $effect(() => {
    if (it?.id) void ensureItems([it.id], it.serverId);
  });
  // The music stopped (end of the queue, stop from the tray): nothing to show.
  $effect(() => {
    if (playback.value && !musicActive()) back('/home');
  });

  // A link closes the player in place: the page replaces it in history.
  const go = (path: string) => navigate(path, { replace: true });

  // ↓ closes the player (spec §4.3) once no handler took it: the music shortcuts take it with nothing focused
  // (volume), spatial nav when there is a control below. Read after the dispatch, so listener order does not matter.
  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'ArrowDown' || e.repeat || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    setTimeout(() => !e.defaultPrevented && router.route.name === 'now-playing' && back());
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="np" role="dialog" aria-modal="true" aria-label={t('music.bar.label')} data-now-playing>
  <div class="bg" aria-hidden="true">
    {#if art(64)}<img src={art(64)} alt="" />{/if}
  </div>
  <div class="scrim" aria-hidden="true"></div>
  <TitleBar minimal />
  <button class="btn ghost icon close" title={t('music.bar.close')} aria-label={t('music.bar.close')} onclick={() => back()}><Icon name="chevronDown" size={20} /></button>
  {#if it && s}
    <div class="body">
      <section class="left">
        <div class="art" style:view-transition-name="np-art">
          {#if art(480)}<img src={art(480)} alt="" decoding="async" />{:else}<Icon name="music" size={64} />{/if}
        </div>
        <div class="meta">
          <div class="names">
            <h1 class="title-1">{it.name}</h1>
            <p class="callout links">
              {#if artist}<a href={`#${itemPath({ Id: artist.Id, ServerId: it.serverId })}`} onclick={(e) => (e.preventDefault(), go(itemPath({ Id: artist.Id, ServerId: it.serverId })))}>{(it.artists ?? []).join(', ') || it.albumArtist}</a>{:else}{(it.artists ?? []).join(', ')}{/if}
              {#if it.album}
                ·
                {#if it.albumId}<a href={`#${itemPath({ Id: it.albumId, ServerId: it.serverId })}`} onclick={(e) => (e.preventDefault(), go(itemPath({ Id: it.albumId!, ServerId: it.serverId })))}>{it.album}</a>{:else}{it.album}{/if}
              {/if}
            </p>
          </div>
          {#if track}
            <button class="btn ghost icon heart" class:on={fav} aria-pressed={fav} aria-label={t(fav ? 'music.favorite.remove' : 'music.favorite.add')} onclick={() => toggleFavorite(track)}>
              <Icon name="heart" size={20} fill={fav} stroke={fav ? 0 : 1.9} />
            </button>
          {/if}
        </div>
        <SeekBar positionMs={s.positionMs} durationMs={s.durationMs} />
        <Transport large />
      </section>
      <section class="right">
        <Segmented
          value={tab}
          label={t('music.bar.label')}
          options={[
            { value: 'lyrics', label: t('music.lyrics.title') },
            { value: 'queue', label: t('music.bar.queue') },
          ]}
          onchange={(v) => navigate(`/now-playing?tab=${v}`, { replace: true })}
        />
        <div class="pane-body">
          {#if tab === 'lyrics'}<LyricsPane item={it} positionMs={s.positionMs} />{:else}<QueuePanel embedded />{/if}
        </div>
      </section>
    </div>
  {/if}
</div>

<style>
  .np {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg);
    animation: up var(--t-med) var(--ease) both;
  }
  @keyframes up {
    from {
      opacity: 0;
      transform: translateY(24px);
    }
  }
  .np :global(.titlebar) {
    position: absolute;
    inset: 0 0 auto 0;
    z-index: 3;
  }
  .bg {
    position: absolute;
    inset: -80px;
  }
  .bg img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: blur(60px) saturate(1.2);
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
  }
  :global(html[data-reduce-transparency]) .scrim {
    background: var(--bg);
  }
  .close {
    position: absolute;
    top: calc(var(--titlebar) + 8px);
    left: 20px;
    z-index: 4;
  }
  .body {
    position: relative;
    z-index: 1;
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(280px, 480px) minmax(0, 1fr);
    gap: clamp(32px, 5vw, 88px);
    padding: calc(var(--titlebar) + 48px) clamp(32px, 6vw, 96px) 40px;
  }
  .left {
    display: grid;
    align-content: center;
    gap: 18px;
    min-width: 0;
  }
  .art {
    width: 100%;
    max-width: 480px;
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    border-radius: var(--r-lg);
    background: var(--fill-2);
    box-shadow: var(--shadow-3);
    overflow: hidden;
    color: var(--label-3);
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .meta {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }
  .names {
    flex: 1;
    min-width: 0;
  }
  .names h1 {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .links {
    margin: 4px 0 0;
    color: var(--label-2);
  }
  .links a {
    color: inherit;
    text-decoration: none;
  }
  .links a:hover {
    color: var(--label);
    text-decoration: underline;
  }
  .heart.on {
    color: var(--label);
  }
  .right {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 18px;
    min-width: 0;
    min-height: 0;
  }
  .pane-body {
    flex: 1;
    width: 100%;
    min-height: 0;
  }
</style>
