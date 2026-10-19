<script lang="ts">
  // Android TV MorePill + ItemActionsSheet (ItemActions.kt): "…" on the details page. Add to a playlist or a
  // collection, mark the earlier episodes as watched; hidden when the item takes none of them. One sheet, three steps:
  // the actions, then the lists of that kind ("New…" first), then the name of the new one on the TV keyboard.
  import type { BaseItem } from '$shared/models';
  import { tick } from 'svelte';
  import { acceptsList, listTargets, previousEpisodes, type Api, type ListKind } from '../lib/api';
  import { focusFirst } from '../lib/focus';
  import { plural, t } from '../lib/i18n.svelte';
  import { edgeDelta } from '../lib/scroll';
  import { changed } from '../lib/load.svelte';
  import { showToast } from '../lib/toast.svelte';
  import Pill from './Pill.svelte';
  import Sheet from './Sheet.svelte';
  import SheetButton from './SheetButton.svelte';
  import Spinner from './Spinner.svelte';
  import TextField from './TextField.svelte';

  let { api, item }: { api: Api; item: BaseItem } = $props();

  const kinds = $derived((['playlist', 'collection'] as ListKind[]).filter((k) => acceptsList(k, item)));
  const previous = $derived(item.Type === 'Episode' && !!item.SeriesId);

  let open = $state(false);
  let kind = $state<ListKind | null>(null);
  let naming = $state(false);
  let name = $state('');
  let busy = false;
  let targets = $state<BaseItem[] | null>(null);
  let card = $state<HTMLDivElement>();
  let lists = $state<HTMLDivElement>();

  // The lists scroll with the focus (Android verticalScroll + BringIntoView).
  function showFocused(e: CustomEvent): void {
    if (!lists) return;
    const r = (e.target as HTMLElement).getBoundingClientRect();
    lists.scrollTop += edgeDelta(r.top - lists.getBoundingClientRect().top, r.height, lists.clientHeight, 0);
  }

  function show(): void {
    kind = null;
    naming = false;
    name = '';
    busy = false;
    open = true;
  }

  // Each step starts on its first button, as Android's LaunchedEffect(kind).
  async function step(): Promise<void> {
    await tick();
    if (card) focusFirst(card);
  }

  async function choose(k: ListKind): Promise<void> {
    kind = k;
    targets = null;
    void step();
    // A playlist keeps one media type: the others are left out, as on desktop.
    targets = await api.lists(k).then((all) => listTargets(k, item, all), () => []);
  }

  // Changes on the server, then every row on show reloads and the sheet closes.
  async function submit(added: string, block: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await block();
      changed();
      showToast(t('list_added', added));
      open = false;
    } catch {
      busy = false;
      showToast(t('server_pref_failed'));
    }
  }

  function create(): void {
    const n = name.trim().slice(0, 120);
    if (n && kind) {
      const k = kind;
      void submit(n, () => api.createList(k, n, item));
    }
  }

  // Desktop's markPlayed: the sheet is already closed, the marking outlives it under a progress toast, then a count
  // toast; every row reloads whatever happened.
  async function markPrevious(): Promise<void> {
    open = false;
    let shownAt = 0;
    try {
      const all = await api.episodes(item.SeriesId!);
      const n = await api.markPlayed(previousEpisodes(all, item), true, (done, total) => {
        // Replaced at most every 1.5 s so it stays readable.
        if (done === 0 || Date.now() - shownAt >= 1500) {
          showToast(t('marking_progress', done, total));
          shownAt = Date.now();
        }
      });
      showToast(plural('marked_watched_count', n, n));
    } catch {
      showToast(t('server_pref_failed'));
    } finally {
      changed();
    }
  }
</script>

{#if kinds.length || previous}
  <Pill icon="More" description={t('item_more')} onclick={show} />
{/if}

{#if open}
  <Sheet width={520} onclose={() => (open = false)}>
    <div bind:this={card}>
      <h2 class="t-title3 ellipsis">
        {kind === null ? item.Name : kind === 'playlist' ? t('add_to_playlist_title') : t('add_to_collection_title')}
      </h2>
      {#if kind === null}
        {#each kinds as k (k)}
          <SheetButton text={k === 'playlist' ? t('add_to_playlist') : t('add_to_collection')} icon="ListAdd" onclick={() => choose(k)} />
        {/each}
        {#if previous}
          <SheetButton text={t('mark_previous_played')} icon="Check" onclick={markPrevious} />
        {/if}
      {:else if naming}
        <TextField bind:value={name} placeholder={kind === 'playlist' ? t('new_playlist_name') : t('new_collection_name')} autofocus onsubmit={create} />
        <div class="create"><SheetButton text={t('list_create')} onclick={create} /></div>
      {:else}
        <div class="lists" bind:this={lists} ontvfocus={showFocused}>
          <SheetButton
            text={kind === 'playlist' ? t('new_playlist') : t('new_collection')}
            icon="Plus"
            onclick={() => {
              naming = true;
              void step();
            }}
          />
          {#if targets === null}
            <div class="center"><Spinner size={28} /></div>
          {:else if !targets.length}
            <p class="t-callout empty">{kind === 'playlist' ? t('no_playlists') : t('no_collections')}</p>
          {:else}
            {#each targets as l (l.Id)}
              <SheetButton text={l.Name} centered={false} onclick={() => submit(l.Name, () => api.addToList(kind!, l.Id, item))} />
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  </Sheet>
{/if}

<style>
  h2 {
    margin: 0 0 18rem;
    text-align: center;
  }
  .create {
    margin-top: 12rem;
  }
  .lists {
    max-height: 340rem;
    overflow: hidden;
  }
  .center {
    display: flex;
    justify-content: center;
    margin-top: 8rem;
  }
  .empty {
    margin: 8rem 0 0;
    color: var(--label-3);
    text-align: center;
  }
</style>
