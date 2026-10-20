<script lang="ts">
  import type { SongIdResult } from '../../shared/contract';
  import type { BaseItem } from '../../shared/models';
  import { untrack } from 'svelte';
  import { songLinks } from '../../shared/song-id';
  import { apiFor } from '../lib/api';
  import { w } from '../lib/bridge';
  import { t } from '../lib/i18n.svelte';
  import { errorMessage } from '../lib/stores.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  // "What's this song?" (main/playback/song-id.ts): Shazam names the music of the last seconds; then the
  // track can be looked up in this server's music and queued after the film. The first use explains what
  // is sent before anything is.
  let { open, serverId, onclose }: { open: boolean; serverId: string | undefined; onclose: () => void } = $props();

  const NOTICE_KEY = 'wicaby.songIdNotice';
  let noticeSeen = $state(read());
  let result = $state<SongIdResult | null>(null);
  let busy = $state(false);
  // undefined: not looked up yet; null: not in the library.
  let found = $state<BaseItem | null | undefined>(undefined);
  let lookup = $state<'idle' | 'busy' | 'queued' | string>('idle');
  // Only the latest identification's answer counts (a reopening asks again).
  let runs = 0;

  function read(): boolean {
    try {
      return localStorage.getItem(NOTICE_KEY) === '1';
    } catch {
      return false;
    }
  }

  async function identify(): Promise<void> {
    if (!noticeSeen) {
      noticeSeen = true;
      try {
        localStorage.setItem(NOTICE_KEY, '1');
      } catch {
        // Shown again next time: harmless.
      }
    }
    busy = true;
    result = null;
    found = undefined;
    lookup = 'idle';
    const run = ++runs;
    const r = await w.playback.identifySong().catch((): SongIdResult => ({ error: 'failed' }));
    if (run !== runs) return;
    result = r;
    busy = false;
  }

  // Every opening asks again: the music has moved on since the last one.
  // Tracks open only: identify() flipping noticeSeen on first use must not start a second one.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      if (noticeSeen) void identify();
    });
  });

  const song = $derived(result && 'song' in result ? result.song : null);
  const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  async function findInLibrary(): Promise<void> {
    if (!song) return;
    lookup = 'busy';
    try {
      const r = await apiFor(serverId).items({ SearchTerm: song.title, IncludeItemTypes: 'Audio', Recursive: true, Limit: 25, Fields: 'Artists' });
      // Shazam's artist may be "A & B" or "A feat. B": any of the track's artists in it counts.
      const artist = norm(song.artist);
      found = r.Items.find((i) => [...(i.Artists ?? []), i.AlbumArtist ?? ''].some((a) => norm(a) && artist.includes(norm(a)))) ?? null;
      lookup = 'idle';
    } catch (err) {
      lookup = errorMessage(err);
    }
  }

  async function playLater(): Promise<void> {
    if (!found) return;
    try {
      await w.playback.play({ itemIds: [found.Id], serverId, command: 'PlayLast' });
      lookup = 'queued';
    } catch (err) {
      lookup = errorMessage(err);
    }
  }
</script>

<Sheet {open} {onclose} label={t('player.songId.title')} width={420}>
  <div class="body">
    <h2 class="title-3">{t('player.songId.title')}</h2>
    {#if !noticeSeen}
      <p class="footnote">{t('player.songId.notice')}</p>
      <div class="actions"><button class="btn primary" data-autofocus onclick={identify}>{t('player.songId.identify')}</button></div>
    {:else if busy}
      <p class="status"><span class="spin" aria-hidden="true"></span>{t('player.songId.listening')}</p>
    {:else if song}
      <div class="card">
        {#if song.coverUrl}<img src={song.coverUrl} alt="" width="96" height="96" />{:else}<div class="art"><Icon name="music" size={32} /></div>{/if}
        <div class="meta">
          <div class="headline">{song.title}</div>
          <div class="sub">{song.artist}</div>
          {#if song.album}<div class="footnote">{song.album}</div>{/if}
        </div>
      </div>
      <ul class="links">
        {#each songLinks(song) as l (l.id)}
          <li><button class="btn" onclick={() => w.app.openExternal(l.url)}><Icon name="externalLink" size={14} /> {t(`player.songId.links.${l.id}`)}</button></li>
        {/each}
      </ul>
      <div class="actions">
        {#if found}
          <span class="footnote">{t('player.songId.inLibrary')}</span>
          <button class="btn primary" disabled={lookup === 'queued'} onclick={playLater}><Icon name="queue" size={15} /> {lookup === 'queued' ? t('player.songId.queued') : t('player.songId.playLater')}</button>
        {:else if found === null}
          <span class="footnote">{t('player.songId.notInLibrary')}</span>
        {:else}
          <button class="btn" disabled={lookup === 'busy'} onclick={findInLibrary}><Icon name="search" size={15} /> {t('player.songId.findInLibrary')}</button>
        {/if}
      </div>
      {#if lookup !== 'idle' && lookup !== 'busy' && lookup !== 'queued'}<p class="footnote error">{lookup}</p>{/if}
    {:else if result && 'error' in result}
      <p class="status">{t(`player.songId.errors.${result.error}`)}</p>
      <div class="actions"><button class="btn" data-autofocus onclick={identify}>{t('common.actions.retry')}</button></div>
    {/if}
  </div>
</Sheet>

<style>
  .body {
    padding: 24px 24px 20px;
  }
  h2 {
    margin: 0 0 12px;
    padding-right: 40px;
  }
  .footnote {
    margin: 0;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px 0;
    color: var(--label-2);
  }
  .card {
    display: flex;
    gap: 14px;
    align-items: center;
  }
  img,
  .art {
    width: 96px;
    height: 96px;
    flex: none;
    border-radius: var(--r-sm);
    object-fit: cover;
    background: var(--fill-2);
  }
  .art {
    display: grid;
    place-items: center;
    color: var(--label-3);
  }
  .meta {
    min-width: 0;
  }
  .headline,
  .sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    color: var(--label-2);
  }
  .links {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 16px 0 0;
    padding: 0;
  }
  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    margin-top: 16px;
  }
  .error {
    margin-top: 8px;
    color: var(--red);
  }
  .spin {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--label-3);
    border-top-color: var(--label);
    animation: spin var(--t-spin) linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
