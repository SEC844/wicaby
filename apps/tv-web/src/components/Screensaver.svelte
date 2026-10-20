<script lang="ts">
  // Android TV Screensaver (Chrome.kt, photos/PhotoScreensaver.kt): film and series backdrops (the default), or the
  // photos of an album or library, or "On this day" (photos spec PH-07); 9 s each, a 1.6 s crossfade and the ×1.08
  // drift that also moves pixels against burn-in. A photo sits over a dimmed copy of itself; its caption is the date,
  // never a place (a screensaver plays to anyone in the room). Music playing: the ambient now-playing layout instead.
  import type { BaseItem } from '$shared/models';
  import { onMount } from 'svelte';
  import type { Api } from '../lib/api';
  import { locale } from '../lib/i18n.svelte';
  import { music } from '../lib/music.svelte';
  import { memoryPhotos, photoDate, photoUrl, randomPhotos, VIEWER_PX } from '../lib/photos.svelte';
  import { settings } from '../lib/settings.svelte';
  import Clock from './Clock.svelte';
  import MusicAmbient from './music/MusicAmbient.svelte';

  let { api }: { api: Api } = $props();

  interface Slide {
    key: string;
    url: string;
    caption: string;
    photo: boolean;
  }

  let slides = $state<Slide[]>([]);
  let index = $state(0);
  const source = settings.screensaverSource.value;
  const album = settings.screensaverAlbum.value || undefined;

  async function load(): Promise<Slide[]> {
    if (source === 'photos' || source === 'memories') {
      const photos = await (source === 'memories' ? memoryPhotos(api, album) : randomPhotos(api, album)).catch(() => []);
      return photos.flatMap((p) => {
        const url = photoUrl(api, p.asset, VIEWER_PX);
        return url ? [{ key: p.item.Id, url, caption: photoDate(p.asset.takenAt, locale.current), photo: true }] : [];
      });
    }
    const r = await api
      .items({ IncludeItemTypes: 'Movie,Series', Recursive: true, SortBy: 'Random', Limit: 40, ImageTypes: 'Backdrop', EnableImageTypes: 'Backdrop,Logo' })
      .catch(() => ({ Items: [] as BaseItem[] }));
    return r.Items.flatMap((i) => {
      const url = api.backdrop(i, 1920);
      return url ? [{ key: i.Id, url, caption: i.Name, photo: false }] : [];
    });
  }

  onMount(() => {
    let stopped = false;
    void load().then((s) => !stopped && (slides = s));
    const timer = setInterval(() => slides.length && (index = (index + 1) % slides.length), 9000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  });

  const current = $derived(slides[index]);
</script>

{#if music.session?.playing}
  <MusicAmbient session={music.session} />
{:else}
  <div class="saver">
    {#each slides as s, i (s.key)}
      {#if i === index || i === (index - 1 + slides.length) % slides.length}
        <div class="slide" class:shown={i === index}>
          {#if s.photo}<img class="blur" src={s.url} alt="" />{/if}
          <img class="pic" class:fit={s.photo} class:drift={i === index} src={s.url} alt="" />
        </div>
      {/if}
    {/each}
    <div class="shade"></div>
    <div class="bottom">
      <span class="t-title3 caption ellipsis">{current?.caption ?? ''}</span>
      <Clock />
    </div>
  </div>
{/if}

<style>
  .saver {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 200;
    overflow: hidden;
    background: #000;
    animation: in 1200ms var(--ease-out) both;
  }
  @keyframes in {
    from {
      opacity: 0;
    }
  }
  .slide {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    opacity: 0;
    transition: opacity 1600ms linear;
  }
  .slide.shown {
    opacity: 1;
  }
  .pic,
  .blur {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .pic.fit {
    object-fit: contain;
  }
  /* A dimmed copy of the photo behind it (Android blurs from API 31; the TV engines dim only, like older Androids). */
  .blur {
    opacity: 0.35;
  }
  .drift {
    animation: drift 11s linear both;
  }
  @keyframes drift {
    to {
      transform: scale(1.08);
    }
  }
  .shade {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(transparent 55%, rgba(0, 0, 0, 0.7));
  }
  .bottom {
    position: absolute;
    left: 56rem;
    right: 56rem;
    bottom: 40rem;
    display: flex;
    align-items: flex-end;
  }
  .caption {
    flex: 1;
    min-width: 0;
    margin-right: 24rem;
    color: var(--label-2);
  }
</style>
