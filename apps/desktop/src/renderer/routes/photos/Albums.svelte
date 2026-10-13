<script lang="ts">
  // Albums tab (photos spec F3, PH-04): the library's PhotoAlbum folders, read-only. Opening one shows its timeline.
  // shortcut: an album without its own Primary image shows a placeholder, not its first photo; add that query if
  // real servers leave many albums without one.
  import type { BaseItem } from '../../../shared/models';
  import Icon from '../../components/Icon.svelte';
  import { apiFor } from '../../lib/api';
  import { t } from '../../lib/i18n.svelte';
  import { imageUrl } from '../../lib/images';
  import { reveal } from '../../lib/motion';
  import { errorMessage } from '../../lib/stores.svelte';

  let { lib, server, onopen }: { lib: BaseItem; server?: string; onopen: (album: BaseItem) => void } = $props();

  let albums = $state<BaseItem[] | null>(null);
  let error = $state('');

  $effect(() => {
    apiFor(server)
      .items({ ParentId: lib.Id, IncludeItemTypes: 'PhotoAlbum', Recursive: false, SortBy: 'SortName', SortOrder: 'Ascending' })
      .then((r) => (albums = r.Items))
      .catch((err) => (error = errorMessage(err)));
  });
</script>

{#if error}
  <div class="note"><Icon name="exclamation" size={16} /> {error}</div>
{:else if albums && albums.length === 0}
  <div class="note">{t('photos.albums.empty')}</div>
{:else if albums}
  <div class="albums">
    {#each albums as a (a.Id)}
      {@const src = a.ImageTags?.Primary ? imageUrl(a.Id, 'Primary', { tag: a.ImageTags.Primary, maxHeight: 240, server: a.ServerId }) : ''}
      <button class="album" onclick={() => onopen(a)}>
        <span class="cover">
          {#if src}<img class="reveal" use:reveal {src} alt="" loading="lazy" decoding="async" draggable="false" />{:else}<Icon name="images" size={32} />{/if}
        </span>
        <span class="name headline">{a.Name}</span>
        {#if a.ChildCount !== undefined}<span class="footnote">{t('photos.albums.count', { count: a.ChildCount })}</span>{/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .albums {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(clamp(180px, 15vw, 260px), 1fr));
    gap: 24px clamp(14px, 1.3vw, 22px);
    padding: 8px var(--gutter) 0;
  }
  .album {
    display: grid;
    gap: 4px;
    padding: 0;
    text-align: left;
    border-radius: var(--r-md);
  }
  .cover {
    position: relative;
    display: grid;
    place-items: center;
    aspect-ratio: 3 / 2;
    overflow: hidden;
    margin-bottom: 6px;
    border-radius: var(--r-md);
    background: var(--fill-1);
    color: var(--label-3);
    transition:
      scale var(--t-med) var(--spring),
      box-shadow var(--t-med) var(--ease);
  }
  .album:is(:hover, :focus-visible) .cover {
    scale: 1.03;
    box-shadow: var(--shadow-3);
  }
  .cover img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 48px var(--gutter);
    color: var(--label-3);
  }
</style>
