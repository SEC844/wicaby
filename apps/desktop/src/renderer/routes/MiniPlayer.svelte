<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { w } from '../lib/bridge';
  import { t } from '../lib/i18n.svelte';
  import { imageUrl } from '../lib/images';
  import { initials, placeholderBg } from '../lib/music-art';
  import { command } from '../lib/music-ui.svelte';
  import { playback } from '../lib/stores.svelte';

  // The music mini player's window (music-spec §4.4, MU-10): 360 × 96, always on top. Art, title and artist,
  // previous / play / next, a 2 px progress line; hovering shows Agrandir and close. The art and Agrandir close it,
  // which brings the main window back (window-manager.ts).
  const s = $derived(playback.value);
  const it = $derived(s?.active && s.music ? s.item : undefined);
  const art = $derived(it?.imageItemId ? imageUrl(it.imageItemId, 'Primary', { tag: it.imageTag, maxHeight: 160, server: it.serverId }) : '');
  const artist = $derived(it ? (it.artists ?? []).join(', ') || (it.albumArtist ?? '') : '');
  const progress = $derived(s && s.durationMs > 0 ? Math.min(1, s.positionMs / s.durationMs) : 0);
  const close = () => void w.window.mini('close');

  $effect(() => {
    const title = it ? `${it.name}${artist ? ` · ${artist}` : ''}` : 'Wicaby';
    if (document.title !== title) document.title = title;
  });
</script>

<div class="mini material drag" data-mini>
  <button class="art no-drag" title={t('music.mini.expand')} aria-label={t('music.mini.expand')} onclick={close}>
    {#if art}<img src={art} alt="" decoding="async" />{:else if it}<span class="ph-initials" style:background={placeholderBg(it.album ?? it.name)}>{initials(it.album ?? it.name)}</span>{:else}<Icon name="music" size={22} />{/if}
  </button>
  <div class="txt">
    <span class="title headline" data-title>{it?.name ?? 'Wicaby'}</span>
    <span class="sub callout" data-artist>{artist}</span>
  </div>
  <div class="ctls no-drag">
    <button class="ctl" data-ctl="previous" disabled={!it} title={t('music.bar.previous')} aria-label={t('music.bar.previous')} onclick={() => command({ type: 'previous' })}>
      <Icon name="prev" size={16} fill stroke={0} />
    </button>
    <button class="ctl play" data-ctl="play" disabled={!it} title={t(s?.paused ? 'music.bar.play' : 'music.bar.pause')} aria-label={t(s?.paused ? 'music.bar.play' : 'music.bar.pause')} onclick={() => command({ type: 'toggle-pause' })}>
      <Icon name={s?.paused || !it ? 'play' : 'pause'} size={16} fill stroke={0} />
    </button>
    <button class="ctl" data-ctl="next" disabled={!it} title={t('music.bar.next')} aria-label={t('music.bar.next')} onclick={() => command({ type: 'next' })}>
      <Icon name="next" size={16} fill stroke={0} />
    </button>
  </div>
  <div class="hover no-drag">
    <button class="ctl small" data-mini-expand title={t('music.mini.expand')} aria-label={t('music.mini.expand')} onclick={close}><Icon name="fullscreen" size={12} /></button>
    <button class="ctl small" data-mini-close title={t('music.mini.close')} aria-label={t('music.mini.close')} onclick={close}><Icon name="close" size={12} /></button>
  </div>
  <div class="line" aria-hidden="true"><span style:transform="scaleX({progress})"></span></div>
</div>

<style>
  .mini {
    position: relative;
    height: 100vh;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px;
    overflow: hidden;
  }
  .art {
    flex: none;
    width: 64px;
    height: 64px;
    display: grid;
    place-items: center;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    color: var(--label-3);
    overflow: hidden;
  }
  .art .ph-initials {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    font-size: 22px;
    font-weight: 650;
    color: rgb(255 255 255 / 0.92);
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: grid;
  }
  .title,
  .sub {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    color: var(--label-2);
  }
  .ctls {
    flex: none;
    display: flex;
    gap: 2px;
  }
  .ctl {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    color: var(--label);
  }
  .ctl:hover,
  .ctl:focus-visible {
    background: var(--fill-2);
  }
  .ctl:disabled {
    color: var(--label-4);
    pointer-events: none;
  }
  .ctl.play {
    background: var(--accent);
    color: var(--accent-fg);
  }
  .hover {
    position: absolute;
    top: 4px;
    right: 4px;
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .mini:hover .hover,
  .hover:focus-within {
    opacity: 1;
  }
  .ctl.small {
    width: 22px;
    height: 22px;
    color: var(--label-2);
  }
  .line {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    background: var(--fill-2);
  }
  .line span {
    display: block;
    height: 100%;
    background: var(--label-2);
    transform-origin: left;
  }
  @media (prefers-reduced-motion: reduce) {
    .hover,
    .ctl {
      transition: none;
    }
  }
</style>
