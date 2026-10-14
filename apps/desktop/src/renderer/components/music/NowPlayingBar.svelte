<script lang="ts">
  import type { AudioDevice } from '../../../shared/contract';
  import { albumJump } from '../../../shared/music-ui';
  import { applyOverrides, resolve } from '../../../shared/shortcuts';
  import { itemPath } from '../../lib/api';
  import { w } from '../../lib/bridge';
  import { t } from '../../lib/i18n.svelte';
  import { imageUrl } from '../../lib/images';
  import { initials, placeholderBg, prefetchTrackArt } from '../../lib/music-art';
  import { command, ensureItems, known, musicActive, musicUi, openTrackMenu, toggleFavorite } from '../../lib/music-ui.svelte';
  import { back, navigate, router } from '../../lib/router.svelte';
  import { linux } from '../../lib/platform';
  import { playback, settings } from '../../lib/stores.svelte';
  import { deviceOptions, set as setSettings } from '../../routes/settings/shared.svelte';
  import BrowseMenu from '../BrowseMenu.svelte';
  import Icon from '../Icon.svelte';
  import QueuePanel from './QueuePanel.svelte';
  import SeekBar from './SeekBar.svelte';
  import Transport from './Transport.svelte';

  // The now-playing bar (music-spec §4.3): a 72 px material bar at the bottom of the main pane while a track is
  // the current item; the queue panel opens over the content above it. It also owns the music shortcuts.
  const s = $derived(playback.value);
  const active = $derived(musicActive());
  const it = $derived(s?.item);
  const track = $derived(it ? known[it.id] : undefined);
  const fav = $derived(Boolean(track?.UserData?.IsFavorite));
  const art = $derived(it?.imageItemId ? imageUrl(it.imageItemId, 'Primary', { tag: it.imageTag, maxHeight: 96, server: it.serverId }) : '');
  const artist = $derived(track?.ArtistItems?.[0] ?? track?.AlbumArtists?.[0]);

  $effect(() => {
    if (it?.id) void ensureItems([it.id], it.serverId);
  });
  // The next track's covers, fetched ahead so the bar and the player switch without a gap (music spec MU-A5).
  const nextId = $derived(s?.music?.queue.ids[s.music.queue.index + 1]);
  $effect(() => {
    if (nextId) void ensureItems([nextId], it?.serverId);
  });
  $effect(() => prefetchTrackArt(nextId ? known[nextId] : undefined));
  $effect(() => {
    if (!active) musicUi.queue = false;
  });

  // Window title (spec §2.6): "Wicaby — Title · Artist" while a track plays.
  $effect(() => {
    const title = active && it ? `Wicaby — ${it.name}${it.artists?.length ? ` · ${it.artists.join(', ')}` : ''}` : 'Wicaby';
    if (document.title !== title) document.title = title;
  });

  // Output device (spec §4.3): the Settings → Audio list, asked of main once, the first time the bar shows.
  let devices = $state<AudioDevice[] | null>(null);
  let devicesAsked = false;
  $effect(() => {
    if (!active || devicesAsked) return;
    devicesAsked = true;
    void w.settings
      .audioDevices()
      .then((d) => (devices = d))
      .catch(() => (devices = []));
  });
  const device = $derived(settings.value?.playback.audioDevice ?? 'auto');
  const outputs = $derived(deviceOptions(devices, device, linux).map((o) => ({ ...o, checked: o.value === device })));

  const fullScreen = () => (router.route.name === 'now-playing' ? back() : navigate('/now-playing'));

  // ---- Shortcuts (shared/shortcuts.ts, context 'music'). On document, in the bubble phase: after the window-capture
  // handlers of menus, sheets and the shortcut recorder (they stop the event) and after every element handler (the
  // guide, the photo grid, queue rows: a key they handle is defaultPrevented and stays theirs), before spatial nav.
  const isText = (el: Element | null) =>
    el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable) || (el instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range'].includes(el.type));
  function onKey(e: KeyboardEvent): void {
    const route = router.route.name;
    if (!musicActive() || e.defaultPrevented || route === 'player' || route === 'read') return;
    const el = document.activeElement;
    if (isText(el)) return;
    const row = resolve(e, 'music', applyOverrides(settings.value?.ui.shortcuts));
    if (!row) return;
    if (e.repeat && !row.repeatable) return e.preventDefault();
    const full = route === 'now-playing';
    const focused = el && el !== document.body;
    // Arrows move the focus between controls (full-screen player included); they seek and set the volume when
    // nothing has focus. In the full-screen player, ↓ with nothing below closes it (routes/NowPlaying.svelte).
    if (/^Arrow/.test(e.key) && !e.ctrlKey && focused) return;
    // Space presses the focused button, as everywhere.
    if (e.key === ' ' && focused && (el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement || (el instanceof HTMLInputElement && el.type !== 'range'))) return;
    if (row.id === 'music.close' && !full) return;
    e.preventDefault();
    run(row.id);
  }
  function run(id: string): void {
    const st = playback.value;
    if (!st?.music) return;
    const vol = (d: number) => command({ type: 'volume', value: Math.max(0, Math.min(100, st.volume + d)) });
    switch (id) {
      case 'music.playPause':
        return command({ type: 'toggle-pause' });
      case 'music.next':
        return command({ type: 'next' });
      case 'music.previous':
        return command({ type: 'previous' });
      case 'music.seekBack':
        return command({ type: 'seek-relative', deltaMs: -5000 });
      case 'music.seekForward':
        return command({ type: 'seek-relative', deltaMs: 5000 });
      case 'music.seekBackLong':
        return command({ type: 'seek-relative', deltaMs: -30000 });
      case 'music.seekForwardLong':
        return command({ type: 'seek-relative', deltaMs: 30000 });
      case 'music.volumeUp':
        return vol(5);
      case 'music.volumeDown':
        return vol(-5);
      case 'music.mute':
        return command({ type: 'mute', value: !st.muted });
      case 'music.shuffle':
        return command({ type: 'shuffle', value: !st.music.shuffle });
      case 'music.repeat':
        return command({ type: 'repeat', mode: ({ off: 'all', all: 'one', one: 'off' } as const)[st.music.repeat] });
      case 'music.lyrics':
        return router.route.name === 'now-playing' ? undefined : navigate('/now-playing?tab=lyrics');
      case 'music.queue':
        if (router.route.name === 'now-playing') return navigate('/now-playing?tab=queue', { replace: true });
        musicUi.queue = !musicUi.queue;
        return;
      case 'music.favorite':
        if (track) void toggleFavorite(track);
        return;
      case 'music.mini':
        return void w.window.mini('toggle');
      case 'music.close':
        return back();
      case 'music.showPlaying':
        return void showPlaying();
      case 'music.nextAlbum':
      case 'music.previousAlbum':
        return void jumpAlbum(id === 'music.nextAlbum' ? 1 : -1);
    }
  }

  // Ctrl+L (music spec C9): the playing track's album page, its row scrolled into view and focused.
  async function showPlaying(): Promise<void> {
    const cur = playback.value?.item;
    if (!cur?.albumId) return;
    navigate(itemPath({ Id: cur.albumId, ServerId: cur.serverId }));
    for (let n = 0; n < 40; n++) {
      const row = document.querySelector<HTMLElement>(`.tracks [data-id="${CSS.escape(cur.id)}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center' });
        return row.focus({ preventScroll: true });
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // Ctrl+Alt+→/← (C9): the first track of the next album in the queue, or of the previous one.
  async function jumpAlbum(dir: 1 | -1): Promise<void> {
    const q = playback.value?.music?.queue;
    if (!q) return;
    const ids = [...q.ids];
    await ensureItems(ids, playback.value?.item?.serverId);
    const to = albumJump(ids.map((x) => known[x]?.AlbumId), q.index, dir);
    if (to !== null) command({ type: 'queue-jump', index: to });
  }

  // Mouse wheel on the volume (C8): ±5 per notch.
  function wheelVolume(e: WheelEvent): void {
    const st = playback.value;
    if (!st || !e.deltaY) return;
    e.preventDefault();
    command({ type: 'volume', value: Math.max(0, Math.min(100, st.volume + (e.deltaY < 0 ? 5 : -5))) });
  }
</script>

<svelte:document onkeydown={onKey} />

{#if active && it && s}
  {#if musicUi.queue}<QueuePanel />{/if}
  <div class="bar material" role="region" aria-label={t('music.bar.label')} data-now-playing-bar>
    <div class="left">
      <button class="art" style:view-transition-name={router.route.name === 'now-playing' ? undefined : 'np-art'} aria-label={t('music.bar.art')} onclick={fullScreen}>
        {#if art}<img src={art} alt="" decoding="async" />{:else}<span class="ph-initials" style:background={placeholderBg(it.album ?? it.name)}>{initials(it.album ?? it.name)}</span>{/if}
      </button>
      <div class="txt" role="presentation" oncontextmenu={(e) => track && openTrackMenu(track, e, e.currentTarget.parentElement?.querySelector('.bar-more') ?? null)}>
        <span class="title headline" data-title>{it.name}</span>
        <span class="sub callout">
          {#if artist}<a href={`#${itemPath({ Id: artist.Id, ServerId: it.serverId })}`} data-artist>{(it.artists ?? []).join(', ') || it.albumArtist}</a>{:else}<span data-artist>{(it.artists ?? []).join(', ') || (it.albumArtist ?? '')}</span>{/if}
          {#if it.album}
            <span class="sep" aria-hidden="true">·</span>
            {#if it.albumId}<a href={`#${itemPath({ Id: it.albumId, ServerId: it.serverId })}`} data-album>{it.album}</a>{:else}<span data-album>{it.album}</span>{/if}
          {/if}
        </span>
      </div>
      {#if track}
        <button class="icon-btn" data-fav class:on={fav} aria-pressed={fav} title={t(fav ? 'music.favorite.remove' : 'music.favorite.add')} aria-label={t(fav ? 'music.favorite.remove' : 'music.favorite.add')} onclick={() => toggleFavorite(track)}>
          <Icon name="heart" size={16} fill={fav} stroke={fav ? 0 : 1.9} />
        </button>
        <button class="icon-btn bar-more" aria-haspopup="menu" title={t('music.actions.more', { name: it.name })} aria-label={t('music.actions.more', { name: it.name })} onclick={(e) => openTrackMenu(track, e, e.currentTarget)}>
          <Icon name="ellipsis" size={16} />
        </button>
      {/if}
    </div>
    <div class="centre">
      <Transport />
      <SeekBar positionMs={s.positionMs} durationMs={s.durationMs} />
    </div>
    <div class="right">
      <button class="icon-btn" data-open-lyrics title={t('music.bar.lyrics')} aria-label={t('music.bar.lyrics')} onclick={() => navigate('/now-playing?tab=lyrics')}><Icon name="lyrics" size={17} /></button>
      <button class="icon-btn" data-queue class:on={musicUi.queue} aria-pressed={musicUi.queue} title={t('music.bar.queue')} aria-label={t('music.bar.queue')} onclick={() => (musicUi.queue = !musicUi.queue)}><Icon name="queue" size={17} /></button>
      <button class="icon-btn" title={t(s.muted ? 'music.bar.unmute' : 'music.bar.mute')} aria-label={t(s.muted ? 'music.bar.unmute' : 'music.bar.mute')} onclick={() => command({ type: 'mute', value: !s.muted })} onwheel={wheelVolume}>
        <Icon name={s.muted || s.volume === 0 ? 'mute' : 'volume'} size={17} />
      </button>
      <input class="volume" type="range" min="0" max="100" step="1" value={s.volume} style:--pct="{s.muted ? 0 : s.volume}%" aria-label={t('music.bar.volume')} oninput={(e) => command({ type: 'volume', value: Number(e.currentTarget.value) })} onwheel={wheelVolume} />
      <BrowseMenu label={t('music.bar.output')} icon="speaker" compact up align="end" options={outputs} onselect={(v) => v !== device && void setSettings({ playback: { audioDevice: v } })} />
      <button class="icon-btn" data-open-mini title={t('music.mini.open')} aria-label={t('music.mini.open')} onclick={() => w.window.mini('open')}><Icon name="pip" size={16} /></button>
      <button class="icon-btn" title={t('music.bar.fullScreen')} aria-label={t('music.bar.fullScreen')} onclick={fullScreen}><Icon name="fullscreen" size={16} /></button>
    </div>
  </div>
{/if}

<style>
  .bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 31;
    height: 72px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(320px, 1.4fr) minmax(0, 1fr);
    align-items: center;
    gap: 16px;
    padding: 0 16px;
    border-top: 1px solid var(--separator);
    border-bottom-left-radius: var(--r-md);
    animation: bar-in var(--t-med) var(--ease) both;
  }
  @keyframes bar-in {
    from {
      transform: translateY(16px);
      opacity: 0;
    }
  }
  .left {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .art {
    flex: none;
    width: 48px;
    height: 48px;
    display: grid;
    place-items: center;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    overflow: hidden;
    color: var(--label-3);
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .art .ph-initials {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    font-size: 17px;
    font-weight: 650;
    color: rgb(255 255 255 / 0.92);
  }
  .txt {
    display: grid;
    min-width: 0;
  }
  .title,
  .sub {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub,
  .sub a {
    color: var(--label-2);
    text-decoration: none;
  }
  .sub a:hover {
    color: var(--label);
    text-decoration: underline;
  }
  .centre {
    display: grid;
    justify-items: center;
    gap: 2px;
  }
  .right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    flex: none;
    border-radius: var(--r-xs);
    color: var(--label-2);
  }
  .icon-btn:hover,
  .icon-btn:focus-visible {
    color: var(--label);
    background: var(--fill-2);
  }
  .icon-btn.on {
    background: var(--fill-2);
    color: var(--label);
  }
  .volume {
    -webkit-appearance: none;
    appearance: none;
    width: 96px;
    height: 14px;
    background: transparent;
  }
  .volume::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(to right, var(--label-2) var(--pct), var(--fill-3) var(--pct));
  }
  .volume::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -4px;
    border-radius: 50%;
    background: var(--label);
  }
</style>
