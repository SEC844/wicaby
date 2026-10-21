<script lang="ts">
  // Bibliothèques: every library as a wide card with its own artwork (or an icon on its tint), as the Apple TV app
  // lists its sections. Video libraries open their grid; music, photos, books and Live TV get their pages with M3.
  import type { BaseItem } from '$shared/models';
  import { t } from '$tv/i18n.svelte';
  import { useLoad } from '$tv/load.svelte';
  import { api } from '$tv/session.svelte';
  import BookOpen from '@lucide/svelte/icons/book-open';
  import Film from '@lucide/svelte/icons/film';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Music from '@lucide/svelte/icons/music';
  import Radio from '@lucide/svelte/icons/radio';
  import Tv from '@lucide/svelte/icons/tv';
  import LargeTitlePage from '../components/LargeTitlePage.svelte';
  import { nav } from '../lib/nav.svelte';

  const a = api()!;
  const views = useLoad<BaseItem[]>(() => 'views', () => a.views(), { persist: true });
  const dpr = Math.min(3, window.devicePixelRatio || 2);
  const ICONS: Record<string, typeof Film> = { movies: Film, tvshows: Tv, music: Music, photos: ImageIcon, homevideos: ImageIcon, books: BookOpen, livetv: Radio };

  function open(v: BaseItem): void {
    nav.push({ name: 'folder', id: v.Id, title: v.Name, serverId: v.ServerId });
  }
</script>

<LargeTitlePage title={t('nav_libraries')} tab="libraries">
  <div class="list">
    {#each views.value ?? [] as v (v.Id)}
      {@const Icon = ICONS[v.CollectionType ?? ''] ?? FolderIcon}
      {@const art = v.ImageTags?.Primary ? a.image(v.Id, 'Primary', v.ImageTags.Primary, { maxWidth: Math.round(400 * dpr) }) : undefined}
      <button class="lib pressable" onclick={() => open(v)}>
        {#if art}
          <img src={art} alt="" loading="lazy" decoding="async" />
        {:else}
          <span class="icon"><Icon size={34} strokeWidth={1.5} aria-hidden="true" /></span>
        {/if}
        <span class="shade"></span>
        <span class="title-3 name">{v.Name}</span>
      </button>
    {/each}
  </div>
</LargeTitlePage>

<style>
  .list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
    gap: 14px;
    padding: 8px max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
  }
  .lib {
    position: relative;
    aspect-ratio: 16 / 7;
    border-radius: var(--r-lg);
    overflow: hidden;
    background: linear-gradient(135deg, var(--bg-elevated-2), var(--bg-elevated));
    box-shadow: inset 0 0 0 0.5px var(--hairline);
  }
  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .icon {
    position: absolute;
    top: 16px;
    left: 18px;
    color: var(--label-2);
  }
  .shade {
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, rgb(0 0 0 / 0.6), rgb(0 0 0 / 0) 60%);
  }
  .name {
    position: absolute;
    left: 18px;
    right: 18px;
    bottom: 14px;
    color: #fff;
    text-align: left;
  }
</style>
