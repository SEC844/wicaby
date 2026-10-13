<script lang="ts">
  import { onMount } from 'svelte';
  import type { BaseItem } from '../../../shared/models';
  import { applyLens, CATEGORY_BITS, genreFlags } from '../../../shared/livetv/lens';
  import type { Category, ChannelRow } from '../../../shared/livetv/model';
  import ChannelTile from '../../components/ChannelTile.svelte';
  import { channelLogoUrl, logoPlate } from '../../components/Guide.svelte';
  import Icon from '../../components/Icon.svelte';
  import NowList from '../../components/livetv/NowList.svelte';
  import ProgramCard from '../../components/livetv/ProgramCard.svelte';
  import Row from '../../components/Row.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { legacyChannel, liveGate, playChannel } from '../../lib/livetv.svelte';
  import type { LiveTvStore, Program } from '../../lib/livetv.svelte';

  // "En direct" (§3.1): Reprendre, favourites, recents, on now, category rails (built on the client
  // from genres when the server rail is empty, §6.6), recording now, then every channel as a list.
  let { store, onguide }: { store: LiveTvStore; onguide: () => void } = $props();

  const RAILS: { cat: Category; key: string }[] = [
    { cat: 'sports', key: 'sports' },
    { cat: 'movies', key: 'movies' },
    { cat: 'news', key: 'news' },
    { cat: 'kids', key: 'kids' },
    { cat: 'series', key: 'series' },
  ];

  let onNow = $state.raw<Program[]>([]);
  let rails = $state.raw<Partial<Record<Category, Program[]>>>({});
  let recording = $state.raw<BaseItem[]>([]);
  let loaded = $state(false);

  const hidden = $derived(new Set(store.prefs.hidden));
  const byId = $derived(new Map(store.channels.map((r) => [r.id, r])));
  const all = $derived(applyLens({ rows: store.channels, lens: { kind: 'all' }, prefs: store.lensPrefs, sort: store.sort, favFirst: store.favFirst }));
  const favorites = $derived(store.favorites.slice(0, 30).map((r) => legacyChannel(r, store)));
  const recents = $derived(
    store.mru
      .map((id) => byId.get(id))
      .filter((r): r is ChannelRow => !!r && !hidden.has(r.id))
      .map((r) => legacyChannel(r, store)),
  );
  const last = $derived(recents[0] ?? null);
  const channelOf = (p: Program) => {
    const r = p.ChannelId ? byId.get(p.ChannelId) : undefined;
    return r ? legacyChannel(r, store) : null;
  };

  // A server rail that came back empty is rebuilt from the "on now" programmes' genres.
  function railFor(cat: Category): Program[] {
    const server = rails[cat] ?? [];
    if (server.length) return server;
    return onNow.filter((p) => (genreFlags((p as Program & { Genres?: string[] }).Genres ?? []) & CATEGORY_BITS[cat]) !== 0);
  }

  async function load(): Promise<void> {
    const [now, rec, ...cats] = await Promise.allSettled([store.onNow(), store.dvr.loadRecordings(true), ...RAILS.map((r) => store.onNow(r.cat))]);
    if (now.status === 'fulfilled') onNow = now.value as unknown as Program[];
    if (rec.status === 'fulfilled') recording = rec.value.map((d) => ({ ...d, ServerId: store.serverId }) as unknown as BaseItem);
    const next: Partial<Record<Category, Program[]>> = {};
    cats.forEach((c, i) => {
      if (c.status === 'fulfilled') next[RAILS[i].cat] = c.value as unknown as Program[];
    });
    rails = next;
    loaded = true;
  }

  onMount(() => {
    void load();
    return liveGate.every(5 * 60_000, () => void load(), 'open');
  });
</script>

<div class="now">
  {#if last}
    {@const cur = last.CurrentProgram}
    <button class="resume" onclick={() => playChannel(last.Id, store.serverId)}>
      {#if last.ImageTags?.Primary}
        <img class="logo" src={channelLogoUrl({ id: last.Id, serverId: store.serverId, logoTag: last.ImageTags.Primary }, 48)} alt={t('livetv.channel.logoAlt', { name: last.Name })} crossorigin="anonymous" use:logoPlate />
      {/if}
      <span class="r-text">
        <span class="headline">{t('livetv.now.resume', { channel: last.Name })}</span>
        {#if cur}<span class="footnote">{cur.Name}</span>{/if}
      </span>
      <Icon name="play" size={18} fill stroke={0} />
    </button>
  {/if}

  {#if favorites.length}
    <Row title={t('livetv.now.rows.favorites')} variant="thumb">
      {#each favorites as c (c.Id)}<div class="cell"><ChannelTile channel={c} /></div>{/each}
    </Row>
  {/if}
  {#if recents.length}
    <Row title={t('livetv.now.rows.recents')} variant="thumb">
      {#each recents as c (c.Id)}<div class="cell"><ChannelTile channel={c} /></div>{/each}
    </Row>
  {/if}
  {#if onNow.length}
    <Row title={t('livetv.now.rows.onNow')} variant="thumb">
      {#each onNow as p (p.Id)}<div class="cell"><ProgramCard program={p} channel={channelOf(p)} /></div>{/each}
    </Row>
  {/if}
  {#each RAILS as rail (rail.cat)}
    {@const items = railFor(rail.cat)}
    {#if items.length}
      <Row title={t(`livetv.now.rows.${rail.key}`)} variant="thumb">
        {#each items as p (p.Id)}<div class="cell"><ProgramCard program={p} channel={channelOf(p)} /></div>{/each}
      </Row>
    {/if}
  {/each}
  {#if recording.length}
    <Row title={t('livetv.now.rows.recording')} variant="thumb" items={recording} />
  {/if}

  {#if loaded && !onNow.length && !all.length}
    <div class="state">
      <Icon name="live" size={36} />
      <p class="footnote">{t('livetv.now.empty')}</p>
      <button class="btn" onclick={onguide}>{t('livetv.now.openGuide')}</button>
    </div>
  {/if}

  {#if all.length}
    <section>
      <h2 class="sec">{t('livetv.now.rows.allChannels')}</h2>
      <NowList {store} rows={all} />
    </section>
  {/if}
</div>

<style>
  .now {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
  /* Rows bring their own gutter; the page has one already. */
  .now > :global(section.row) {
    margin-inline: calc(-1 * var(--gutter));
  }
  .cell {
    width: var(--card-w);
  }
  .resume {
    display: flex;
    align-items: center;
    gap: 16px;
    justify-self: start;
    min-width: min(100%, 420px);
    margin-bottom: 16px;
    padding: 14px 18px;
    border-radius: var(--r-lg);
    background: var(--bg-elevated);
    text-align: left;
    transition: transform var(--t-med) var(--spring);
  }
  .resume:is(:hover, :focus-visible) {
    transform: scale(1.02);
    box-shadow: var(--shadow-3);
  }
  .logo {
    width: 96px;
    height: 48px;
    object-fit: contain;
    border-radius: var(--r-xs);
  }
  .logo:global([data-plate]) {
    padding: 3px 6px;
    background: color-mix(in srgb, var(--label) 85%, transparent);
  }
  .r-text {
    flex: 1;
    display: grid;
  }
  .state {
    display: grid;
    justify-items: center;
    gap: 10px;
    padding: 60px 0;
    color: var(--label-3);
  }
  .sec {
    margin: 24px 0 14px;
    font-size: var(--fs-title-3);
    font-weight: 650;
    letter-spacing: -0.016em;
  }
</style>
