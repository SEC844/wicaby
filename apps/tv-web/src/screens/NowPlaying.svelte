<script lang="ts">
  // Android TV NowPlaying (music/MusicActivity.kt): the art over its own blurred copy, the track, the seek bar (Left /
  // Right step 10 s), the controls (previous, play, next, shuffle, repeat, favorite, mix, lyrics), the lyrics beside
  // them, and the queue as a row. OK on an entry plays it; holding OK puts it in edit mode, where Left / Right move it,
  // OK or Back is done, and holding OK again takes it out of the queue. The media keys work wherever the focus is.
  // Back leaves the screen with the music still playing.
  import { getContext, onMount } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Cover from '../components/music/Cover.svelte';
  import HScroll from '../components/HScroll.svelte';
  import { focusable, focused, setFocus } from '../lib/focus';
  import { clock } from '../lib/format';
  import { t } from '../lib/i18n.svelte';
  import { music } from '../lib/music.svelte';
  import { nav, onBack, SCREEN } from '../lib/nav.svelte';
  import { overlay } from '../lib/overlay.svelte';
  import { showToast } from '../lib/toast.svelte';
  import { keyOf } from '../platform/keys';

  const SEEK_MS = 10_000;
  const s = $derived(music.session);
  const item = $derived(s?.current);
  const art = $derived(item && s ? s.api.poster(item, 720) : undefined);
  const artist = $derived(item?.Artists?.join(', ') || item?.AlbumArtist);

  // The heart as the server last answered.
  let favorite = $state<boolean | null>(null);
  $effect(() => {
    void item?.Id;
    favorite = null;
  });
  const isFavorite = $derived(favorite ?? item?.UserData?.IsFavorite === true);
  async function toggleFavorite(): Promise<void> {
    if (!s || !item) return;
    const on = !isFavorite;
    await s.api.setFavorite(item.Id, on).then(() => (favorite = on)).catch(() => {});
  }

  // --- Lyrics: the line playing (synced) stays in view, two lines below the top ---
  let showLyrics = $state(false);
  const lyrics = $derived(s && s.currentId ? s.lyrics.get(s.currentId) : undefined);
  $effect(() => {
    if (showLyrics && s) void s.loadLyrics();
  });
  const lyricIndex = $derived.by(() => {
    if (!lyrics?.synced || !s) return -1;
    let i = -1;
    lyrics.lines.forEach((l, k) => {
      if ((l.startMs ?? Infinity) <= s.positionMs) i = k;
    });
    return i;
  });
  let lyricsBox = $state<HTMLDivElement>();
  $effect(() => {
    const box = lyricsBox;
    if (!box || lyricIndex < 0) return;
    const line = box.children[Math.max(0, lyricIndex - 2)] as HTMLElement | undefined;
    if (line) box.scrollTop = line.offsetTop - box.offsetTop;
  });

  async function mix(): Promise<void> {
    if (s && !(await s.mix())) showToast(t('music_mix_none'));
  }

  // --- Queue edit mode ---
  let editing = $state<number | null>(null);
  function queueKey(e: KeyboardEvent): boolean {
    const el = focused();
    const i = Number(el?.getAttribute('data-queue') ?? -1);
    if (!s || i < 0) return false;
    const key = keyOf(e);
    if (editing === null) return false;
    if (key === 'left' || key === 'right') {
      const to = i + (key === 'left' ? -1 : 1);
      if (to >= 0 && to < s.queue.ids.length) {
        s.move(i, to);
        editing = to;
        requestAnimationFrame(() => {
          const moved = document.querySelector<HTMLElement>(`[data-screen-top] [data-queue="${to}"]`);
          if (moved) setFocus(moved);
        });
      }
      return true;
    }
    if (key === 'ok' && !e.repeat) {
      editing = null;
      return true;
    }
    return key === 'up' || key === 'down';
  }
  function onlong(e: CustomEvent): void {
    const i = Number((e.target as HTMLElement).getAttribute('data-queue') ?? -1);
    if (!s || i < 0) return;
    e.preventDefault();
    if (editing === i) {
      // Held again in edit mode: out of the queue; the focus goes to the entry that slid into its place.
      editing = null;
      s.remove(i);
      requestAnimationFrame(() => {
        const next = document.querySelector<HTMLElement>(`[data-screen-top] [data-queue="${Math.min(i, (s?.queue.ids.length ?? 1) - 1)}"]`);
        if (next) setFocus(next);
      });
    } else editing = i;
  }

  const screen = getContext<number>(SCREEN);
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlay.alert || !document.querySelector('[data-screen-top] .now-playing') || !s) return;
      const key = keyOf(e);
      const consume = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (key === 'playPause' || key === 'play' || key === 'pause') return consume(), void (!e.repeat && s.playPause());
      if (key === 'next') return consume(), s.next();
      if (key === 'prev') return consume(), s.previous();
      if (key === 'ff') return consume(), s.seek(s.positionMs + SEEK_MS);
      if (key === 'rw') return consume(), s.seek(s.positionMs - SEEK_MS);
      if (key === 'stop') return consume(), nav.back();
      if (queueKey(e)) return consume();
      // The seek bar keeps Left and Right.
      if ((key === 'left' || key === 'right') && focused()?.classList.contains('seek')) return consume(), s.seek(s.positionMs + (key === 'left' ? -SEEK_MS : SEEK_MS));
    };
    window.addEventListener('keydown', onKey, true);
    const stop = onBack(screen, () => {
      if (editing !== null) return (editing = null), true;
      return false;
    });
    return () => {
      window.removeEventListener('keydown', onKey, true);
      stop();
    };
  });

  // Leaving when the session ends (the queue emptied).
  $effect(() => {
    if (!s || s.released) nav.back();
  });

  const f = $derived(s && s.durationMs > 0 ? Math.min(1, s.positionMs / s.durationMs) : 0);
  const repeatIcon = $derived(s?.queue.repeat === 'one' ? 'RepeatOne' : 'Repeat');
  const repeatLabel = $derived(s?.queue.repeat === 'one' ? t('music_repeat_one') : s?.queue.repeat === 'all' ? t('music_repeat_all') : t('music_repeat_off'));
</script>

<div class="now-playing">
  {#if art}<img class="blur" src={art} alt="" />{/if}
  <div class="shade"></div>
  {#if s && item}
    <div class="body">
      <div class="top">
        {#if !showLyrics}
          <Cover src={art} name={item.Album ?? item.Name} size={280} font={96} />
          <span class="gap"></span>
        {/if}
        <div class="info">
          <p class="t-eyebrow label-3">{t('music_now_playing').toUpperCase()}</p>
          <p class="t-title1 title">{item.Name}</p>
          {#if artist}<p class="t-title3 label-2 line">{artist}</p>{/if}
          {#if item.Album}<p class="t-callout label-3 line">{item.Album}</p>{/if}
          <button class="seek" use:focusable aria-label={t('music_position')}>
            <span class="bar"><span style="transform:scaleX({f})"></span></span>
          </button>
          <div class="times mono"><span>{clock(s.positionMs)}</span><span class="label-3">{clock(s.durationMs)}</span></div>
          <div class="controls">
            <button class="ctrl" use:focusable aria-label={t('music_previous')} onclick={() => s.previous()}><Icon name="Previous" size={22} /></button>
            <button class="ctrl primary" use:focusable={true} aria-label={s.playing ? t('music_pause') : t('play')} onclick={() => s.playPause()}>
              <Icon name={s.playing ? 'Pause' : 'Play'} size={28} />
            </button>
            <button class="ctrl" use:focusable aria-label={t('music_next')} onclick={() => s.next()}><Icon name="Next" size={22} /></button>
            <button class="ctrl" class:on={s.queue.unshuffled !== null} use:focusable aria-label={s.queue.unshuffled !== null ? t('music_shuffle_on') : t('music_shuffle_off')} onclick={() => s.toggleShuffle()}>
              <Icon name="Shuffle" size={22} />
            </button>
            <button class="ctrl" class:on={s.queue.repeat !== 'off'} use:focusable aria-label={repeatLabel} onclick={() => s.cycleRepeat()}><Icon name={repeatIcon} size={22} /></button>
            <button class="ctrl" class:on={isFavorite} use:focusable aria-label={t('favorite')} onclick={toggleFavorite}><Icon name={isFavorite ? 'Heart' : 'HeartOutline'} size={22} /></button>
            <button class="ctrl" use:focusable aria-label={t('music_mix')} onclick={mix}><Icon name="Mix" size={22} /></button>
            <button class="ctrl" class:on={showLyrics} use:focusable aria-label={t('music_lyrics')} onclick={() => (showLyrics = !showLyrics)}><Icon name="Lyrics" size={22} /></button>
          </div>
        </div>
        {#if showLyrics}
          <div class="lyrics" bind:this={lyricsBox}>
            {#if lyrics && !lyrics.lines.length}
              <p class="t-callout label-3">{t('music_no_lyrics')}</p>
            {:else if lyrics}
              {#each lyrics.lines as line, i (i)}
                <p class={lyrics.synced ? 't-title3' : 't-body'} class:now={lyrics.synced && i === lyricIndex} class:past={lyrics.synced && i !== lyricIndex}>{line.text || '♪'}</p>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
      {#if s.queue.ids.length}
        <div class="queue">
          <p class="t-eyebrow label-3">
            {t('queue')} · {t('queue_position', s.queue.index + 1, s.queue.ids.length)}{editing !== null ? ` · ${t('music_queue_edit_hint')}` : ''}
          </p>
          <HScroll spacing={12} padding={[8, 64, 8, 64]}>
            {#each s.queue.ids as qid, i (`${i}:${qid}`)}
              {@const q = s.known.get(qid)}
              <div data-row-item>
                <button class="entry" class:playing={i === s.queue.index} class:editing={editing === i} use:focusable data-queue={i} ontvlongpress={onlong} onclick={() => editing === null && s.jump(i)}>
                  <span class="thumb">
                    <Cover src={q ? s.api.poster(q, 160) : undefined} name={q?.Album ?? q?.Name ?? ''} size={48} font={18} />
                    {#if editing === i}<span class="move"><Icon name="Move" size={22} /></span>{/if}
                  </span>
                  <span class="entry-text">
                    <span class="t-callout ellipsis">{q?.Name ?? '…'}</span>
                    {#if editing === i}<span class="t-caption sub">{t('music_queue_edit')}</span>{:else if q?.Artists?.length}<span class="t-caption sub ellipsis">{q.Artists.join(', ')}</span>{/if}
                  </span>
                  {#if i === s.queue.index}<span class="dot"></span>{/if}
                </button>
              </div>
            {/each}
          </HScroll>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .now-playing {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
    background: var(--bg);
  }
  .blur {
    position: absolute;
    top: -10%;
    left: -10%;
    width: 120%;
    height: 120%;
    object-fit: cover;
    filter: blur(48rem);
    opacity: 0.5;
  }
  .shade {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(to right, rgba(0, 0, 0, 0.25), rgba(0, 0, 0, 0.8));
  }
  .body {
    position: absolute;
    top: 40rem;
    left: 64rem;
    right: 64rem;
    bottom: 24rem;
    display: flex;
    flex-direction: column;
  }
  .top {
    flex: 1;
    display: flex;
    align-items: center;
    min-height: 0;
  }
  .gap {
    width: 48rem;
    flex-shrink: 0;
  }
  .info {
    flex: 1;
    min-width: 0;
  }
  p {
    margin: 0;
  }
  .title {
    margin-top: 6rem;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .line {
    margin-top: 4rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .seek {
    display: flex;
    align-items: center;
    width: 100%;
    height: 20rem;
    margin-top: 24rem;
  }
  .seek .bar {
    position: relative;
    display: block;
    width: 100%;
    height: 4rem;
    overflow: hidden;
    border-radius: 4rem;
    background: var(--fill-2);
    transition: height var(--t-fast);
  }
  .seek:global(.focused) .bar {
    height: 8rem;
    background: var(--fill-4);
  }
  .seek .bar span {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
  }
  .times {
    display: flex;
    justify-content: space-between;
    margin-top: 8rem;
    color: var(--label-2);
  }
  .mono {
    font-family: 'Geist Mono', monospace;
    font-size: 15rem;
  }
  .controls {
    display: flex;
    align-items: center;
    margin-top: 20rem;
  }
  .ctrl {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44rem;
    height: 44rem;
    margin-right: 12rem;
    border-radius: 50%;
    background: var(--fill-2);
    color: var(--label-2);
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .ctrl.on {
    background: var(--fill-4);
    color: var(--label);
  }
  .ctrl.primary {
    width: 56rem;
    height: 56rem;
    background: var(--accent);
    color: var(--on-accent);
  }
  .ctrl:global(.focused) {
    background: #fff;
    color: #000;
    transform: scale(1.12);
  }
  .lyrics {
    width: 320rem;
    height: 100%;
    margin-left: 32rem;
    padding: 24rem 12rem;
    overflow: hidden;
  }
  .lyrics p {
    margin-bottom: 10rem;
    color: var(--label-2);
  }
  .lyrics .now {
    color: var(--label);
  }
  .lyrics .past {
    color: var(--label-3);
  }
  /* Edge to edge, like the rows: entries scroll out under the screen's edges, not a hard cut at the margin. */
  .queue {
    margin: 16rem -64rem 0;
  }
  .queue > p {
    padding: 0 64rem;
  }
  .entry {
    display: flex;
    align-items: center;
    width: 220rem;
    padding: 8rem;
    border-radius: var(--r-md);
    background: var(--fill-1);
    color: var(--label);
    text-align: left;
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .entry.playing {
    background: var(--fill-3);
  }
  .entry:global(.focused) {
    background: #fff;
    color: #000;
    transform: scale(1.05);
  }
  .thumb {
    position: relative;
    flex-shrink: 0;
  }
  .thumb :global(.cover) {
    border-radius: var(--r-xs);
  }
  .move {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    border-radius: var(--r-xs);
  }
  .entry-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    margin-left: 10rem;
  }
  .sub {
    color: var(--label-3);
  }
  .entry:global(.focused) .sub {
    color: rgba(0, 0, 0, 0.6);
  }
  .dot {
    width: 8rem;
    height: 8rem;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--accent);
  }
</style>
