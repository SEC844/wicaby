<script lang="ts">
  // A title's menu (lib/item-menu.svelte.ts), as Emby's long press offers it, in a Wicaby sheet: the artwork and the
  // title on top, then
  // - play: resume (or play), from the start, shuffle (a series, a season, a collection);
  // - go: its page, its series;
  // - mark watched or not, favourite, remove from Continue watching (with an undo), add to a playlist or a collection;
  // - for who may: refresh the metadata (an administrator), delete (the server's CanDelete for this user).
  // The title is read again on open (watched state, favourite, CanDelete as of now); every change refreshes the rows.
  import type { BaseItem } from '$shared/models';
  import { acceptsList, ApiError, listTargets, type Api, type ListKind } from '$tv/api';
  import { removeFromContinue, undoRemove } from '$tv/continue-watching';
  import { clock, episodeLine } from '$tv/format';
  import { t } from '$tv/i18n.svelte';
  import { changed } from '$tv/load.svelte';
  import { play, shuffle } from '$tv/playback';
  import { apiOf } from '$tv/session.svelte';
  import { showToast } from '$tv/toast.svelte';
  import Check from '@lucide/svelte/icons/check';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import FolderPlus from '@lucide/svelte/icons/folder-plus';
  import Heart from '@lucide/svelte/icons/heart';
  import Info from '@lucide/svelte/icons/info';
  import ListPlus from '@lucide/svelte/icons/list-plus';
  import Play from '@lucide/svelte/icons/play';
  import Plus from '@lucide/svelte/icons/plus';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Shuffle from '@lucide/svelte/icons/shuffle';
  import Trash from '@lucide/svelte/icons/trash-2';
  import Tv from '@lucide/svelte/icons/tv';
  import Undo from '@lucide/svelte/icons/undo-2';
  import type { Component } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { closeItemMenu, type ItemMenuContext } from '../lib/item-menu.svelte';
  import { itemRoute, nav } from '../lib/nav.svelte';
  import { showAlert } from '../lib/overlay.svelte';
  import { showSnack } from '../lib/snackbar.svelte';
  import { isAdmin } from '../lib/user';
  import Spinner from './Spinner.svelte';
  import TextField from './TextField.svelte';

  let { item: shown, ctx }: { item: BaseItem; ctx: ItemMenuContext } = $props();

  // svelte-ignore state_referenced_locally
  const client: Api = apiOf(shown.ServerId)!;
  // svelte-ignore state_referenced_locally
  let item = $state<BaseItem & { CanDelete?: boolean }>(shown);
  let admin = $state(false);

  $effect(() => {
    const id = shown.Id;
    const q = { Fields: 'CanDelete' };
    const fresh = client.isEmby ? client.get<BaseItem>(`/Users/${client.userId}/Items/${id}`, q) : client.get<BaseItem>(`/Items/${id}`, { ...q, userId: client.userId });
    void fresh.then((it) => (item = { ...shown, ...it, ServerId: shown.ServerId ?? client.serverId }), () => {});
    void isAdmin(client).then((on) => (admin = on));
  });

  const episode = $derived(item.Type === 'Episode');
  const title = $derived(episode && item.SeriesName ? item.SeriesName : item.Name);
  const line = $derived(episode ? (episodeLine(item) ?? '') : [item.ProductionYear, item.OfficialRating].filter(Boolean).join(' · '));
  const art = $derived(client.thumb(item, 240) ?? client.poster(item, 200));
  const at = $derived((item.UserData?.PlaybackPositionTicks ?? 0) / 10_000);
  const playable = $derived(['Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer'].includes(item.Type ?? ''));
  const shufflable = $derived(['Series', 'Season', 'BoxSet', 'Folder', 'CollectionFolder', 'Playlist'].includes(item.Type ?? ''));
  const played = $derived(item.UserData?.Played === true);
  const favorite = $derived(item.UserData?.IsFavorite === true);

  // ---- Steps: the actions, then a playlist or collection to add to, then the new one's name ----
  let kind = $state<ListKind | null>(null);
  let targets = $state<BaseItem[] | null>(null);
  let naming = $state(false);
  let name = $state('');
  let busy = $state(false);

  function done(): void {
    closeItemMenu();
  }
  // A server call, then the rows reload; a refusal says so.
  async function act(run: () => Promise<unknown>, ok?: string): Promise<void> {
    done();
    try {
      await run();
      changed();
      if (ok) showToast(ok);
    } catch (e) {
      showToast(e instanceof ApiError && e.status ? t('web_action_failed') : t('load_error'));
    }
  }

  function removeContinue(): void {
    // A row painted from the stored cache has its dates as a plain object (JSON keeps no Map).
    const series = ctx.continueRow instanceof Map ? ctx.continueRow : new Map<string, string>();
    const it = item;
    void act(async () => {
      await removeFromContinue(client, it, series);
      showSnack({ text: t('removed_from_continue'), action: t('undo'), run: () => void undoRemove(client, it).then(changed) });
    });
  }

  async function chooseList(k: ListKind): Promise<void> {
    kind = k;
    targets = null;
    targets = await client.lists(k).then((all) => listTargets(k, item, all), () => []);
  }
  async function addTo(list: BaseItem | null): Promise<void> {
    if (!kind || busy) return;
    const k = kind;
    busy = true;
    try {
      if (list) await client.addToList(k, list.Id, item);
      else await client.createList(k, name.trim(), item);
      changed();
      showToast(t('list_added', list?.Name ?? name.trim()));
      done();
    } catch {
      busy = false;
      showToast(t('web_action_failed'));
    }
  }

  function remove(): void {
    const it = item;
    done();
    showAlert({
      title: t('web_delete_title', it.Name),
      message: t('web_delete_body'),
      actions: [
        { label: t('delete'), destructive: true, run: () => void act(() => client.del(`/Items/${it.Id}`), t('web_deleted', it.Name)) },
        { label: t('cancel'), run: () => {} },
      ],
    });
  }

  type Row = { icon: Component; label: string; run: () => void; destructive?: boolean; on?: boolean };
  const groups = $derived.by<Row[][]>(() => {
    const g: Row[][] = [];
    const playing: Row[] = [];
    if (playable) {
      if (at > 0) {
        playing.push({ icon: Play, label: t('resume_at', clock(at)), run: () => (done(), play(item)) });
        playing.push({ icon: RotateCcw, label: t('from_start'), run: () => (done(), play(item, { fromStart: true })) });
      } else playing.push({ icon: Play, label: t('play'), run: () => (done(), play(item, { fromStart: true })) });
    }
    if (shufflable) playing.push({ icon: Shuffle, label: t('shuffle'), run: () => (done(), void shuffle(item)) });
    if (playing.length) g.push(playing);

    const going: Row[] = [];
    if (!ctx.onPage) going.push({ icon: Info, label: t('more_info'), run: () => (done(), nav.push(itemRoute(item))) });
    if (episode && item.SeriesId) going.push({ icon: Tv, label: t('web_go_series'), run: () => (done(), nav.push({ name: 'detail', id: item.SeriesId!, serverId: item.ServerId })) });
    if (going.length) g.push(going);

    const mine: Row[] = [{ icon: Check, label: t(played ? 'mark_unplayed' : 'mark_played'), on: played, run: () => void act(() => client.setPlayed(item.Id, !played)) }];
    mine.push({ icon: Heart, label: t(favorite ? 'web_favorite_remove' : 'web_favorite_add'), on: favorite, run: () => void act(() => client.setFavorite(item.Id, !favorite)) });
    if (ctx.continueRow || at > 0) mine.push({ icon: EyeOff, label: t('remove_from_continue'), run: removeContinue });
    if (acceptsList('playlist', item)) mine.push({ icon: ListPlus, label: t('add_to_playlist'), run: () => void chooseList('playlist') });
    if (acceptsList('collection', item)) mine.push({ icon: FolderPlus, label: t('add_to_collection'), run: () => void chooseList('collection') });
    g.push(mine);

    const manage: Row[] = [];
    if (admin) {
      const q = { Recursive: true, MetadataRefreshMode: 'FullRefresh', ImageRefreshMode: 'FullRefresh', ReplaceAllMetadata: false, ReplaceAllImages: false };
      manage.push({ icon: RefreshCw, label: t('web_refresh'), run: () => void act(() => client.post(`/Items/${item.Id}/Refresh`, undefined, q), t('web_refresh_started')) });
    }
    if (item.CanDelete) manage.push({ icon: Trash, label: t('delete'), destructive: true, run: remove });
    if (manage.length) g.push(manage);
    return g;
  });
</script>

<div class="scrim" role="presentation" onclick={done} transition:fade={{ duration: 180 }}></div>
<div class="sheet" role="dialog" aria-modal="true" aria-label={title} transition:fly={{ y: 480, duration: 320, opacity: 1 }}>
  <span class="handle" aria-hidden="true"></span>
  <div class="head">
    {#if kind}
      <button class="round bare back" aria-label={t('back')} onclick={() => (naming ? (naming = false) : (kind = null))}><ChevronLeft size={22} aria-hidden="true" /></button>
      <p class="headline grow">{t(kind === 'playlist' ? 'add_to_playlist_title' : 'add_to_collection_title')}</p>
    {:else}
      <span class="art" style:background-image={art ? `url(${art})` : undefined}></span>
      <span class="grow">
        <span class="headline ellipsis">{title}</span>
        {#if line}<span class="footnote label-2 ellipsis">{line}</span>{/if}
      </span>
    {/if}
  </div>

  <div class="rows">
    {#if !kind}
      {#each groups as group, gi (gi)}
        {#if gi > 0}<span class="sep" aria-hidden="true"></span>{/if}
        {#each group as row (row.label)}
          {@const Icon = row.icon}
          <button class="row" class:destructive={row.destructive} class:on={row.on} onclick={row.run}>
            <Icon size={20} aria-hidden="true" />
            <span class="text">{row.label}</span>
          </button>
        {/each}
      {/each}
    {:else if naming}
      <form class="naming" onsubmit={(e) => (e.preventDefault(), name.trim() && void addTo(null))}>
        <TextField bind:value={name} label={t(kind === 'playlist' ? 'new_playlist_name' : 'new_collection_name')} autocapitalize="sentences" />
        <button class="pill primary" disabled={!name.trim() || busy}>{busy ? '…' : t('list_create')}</button>
      </form>
    {:else if targets === null}
      <div class="wait"><Spinner /></div>
    {:else}
      <button class="row" onclick={() => ((naming = true), (name = ''))}><Plus size={20} aria-hidden="true" /><span class="text">{t(kind === 'playlist' ? 'new_playlist' : 'new_collection')}</span></button>
      {#if !targets.length}<p class="footnote label-2 empty">{t(kind === 'playlist' ? 'no_playlists' : 'no_collections')}</p>{/if}
      {#each targets as list (list.Id)}
        <button class="row" disabled={busy} onclick={() => void addTo(list)}><span class="dot" aria-hidden="true"></span><span class="text">{list.Name}</span></button>
      {/each}
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    background: rgb(0 0 0 / 0.45);
    z-index: 50;
  }
  .sheet {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    max-height: 82%;
    display: flex;
    flex-direction: column;
    padding: 0 max(12px, var(--safe-right)) calc(var(--safe-bottom) + 10px) max(12px, var(--safe-left));
    border-radius: var(--r-xl) var(--r-xl) 0 0;
    background: var(--bg-elevated);
    z-index: 51;
  }
  .handle {
    align-self: center;
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--fill-4);
    margin: 10px 0 12px;
    flex: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 12px 14px;
    border-bottom: 0.5px solid var(--separator);
    margin-bottom: 6px;
  }
  .art {
    width: 96px;
    aspect-ratio: 16 / 9;
    border-radius: var(--r-sm);
    background: var(--bg-elevated-2) center / cover no-repeat;
    flex: none;
  }
  .grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .back {
    margin-left: -10px;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rows {
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .row {
    width: 100%;
    min-height: 50px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 12px;
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--label);
    font-size: var(--fs-body);
  }
  .row :global(svg) {
    color: var(--label-2);
    flex: none;
  }
  .row.on :global(svg) {
    color: var(--accent);
  }
  .row:active {
    background: var(--fill-2);
  }
  .row.destructive,
  .row.destructive :global(svg) {
    color: var(--red);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .sep {
    display: block;
    height: 0.5px;
    margin: 6px 12px;
    background: var(--separator);
  }
  .dot {
    width: 20px;
    height: 20px;
    border-radius: 6px;
    background: var(--fill-3);
    flex: none;
  }
  .naming {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 8px 12px;
  }
  .empty {
    padding: 8px 12px;
  }
  .wait {
    display: grid;
    place-items: center;
    padding: 28px;
  }
</style>
