<script lang="ts" module>
  // Remembered across visits, like the Settings pane.
  let lastTab: 'offline' | 'torrents' = 'offline';
</script>

<script lang="ts">
  import type { DownloadEntry } from '../../shared/contract';
  import Icon from '../components/Icon.svelte';
  import Segmented from '../components/Segmented.svelte';
  import TorrentsPanel from '../components/TorrentsPanel.svelte';
  import VpnPanel from '../components/VpnPanel.svelte';
  import { w } from '../lib/bridge';
  import { bytes, episodeCode, runtime, typeLabel } from '../lib/format';
  import { fmt, t, tParts } from '../lib/i18n.svelte';
  import { offlinePosterUrl } from '../lib/images';
  import { navigate, router } from '../lib/router.svelte';
  import { downloads, errorMessage, multiServer, serverName, session, toast } from '../lib/stores.svelte';

  const list = $derived(downloads.list);
  const active = $derived(list.filter((d) => d.status !== 'done').sort((a, b) => a.addedAt - b.addedAt));
  const done = $derived(list.filter((d) => d.status === 'done').sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)));
  const speed = $derived(active.reduce((s, d) => s + (d.status === 'downloading' ? d.bytesPerSecond : 0), 0));
  const offline = $derived(session.value.status === 'offline');

  // ?tab=torrents comes from a magnet link, a dropped .torrent or a notification.
  let tab = $state<'offline' | 'torrents'>(router.route.query.get('tab') === 'torrents' ? 'torrents' : lastTab);
  $effect(() => {
    if (router.route.query.get('tab') === 'torrents') tab = 'torrents';
  });
  $effect(() => {
    lastTab = tab;
  });

  // Storage breakdown for the summary bar.
  const size = (d: DownloadEntry) => d.totalBytes || d.receivedBytes;
  const storage = $derived.by(() => {
    const sum = (f: (d: DownloadEntry) => boolean) => done.filter(f).reduce((n, d) => n + size(d), 0);
    return [
      // Monochrome steps of the label colour: the meter reads by order, not hue.
      { label: t('downloads.storage.movies'), color: 'var(--label)', bytes: sum((d) => d.type === 'Movie') },
      { label: t('downloads.storage.episodes'), color: 'var(--label-2)', bytes: sum((d) => d.type === 'Episode') },
      { label: t('downloads.storage.other'), color: 'var(--label-3)', bytes: sum((d) => d.type !== 'Movie' && d.type !== 'Episode') },
      { label: t('downloads.storage.inProgress'), color: 'var(--fill-4)', bytes: active.reduce((n, d) => n + d.receivedBytes, 0) },
    ].filter((p) => p.bytes > 0);
  });
  const totalBytes = $derived(storage.reduce((n, p) => n + p.bytes, 0));

  let confirming = $state<string | null>(null);
  let retrying = $state(false);

  const RING = 2 * Math.PI * 15;

  function frac(d: DownloadEntry): number {
    return d.totalBytes > 0 ? Math.min(1, d.receivedBytes / d.totalBytes) : 0;
  }

  function eta(d: DownloadEntry): string {
    if (d.status !== 'downloading' || !d.bytesPerSecond || !d.totalBytes) return '';
    const s = Math.max(0, (d.totalBytes - d.receivedBytes) / d.bytesPerSecond);
    if (s < 60) return t('downloads.eta.seconds', { count: Math.ceil(s) });
    return fmt.duration(Math.ceil(s / 60) * 60_000);
  }

  // "1,2 Go sur 4,0 Go", or just the received size while the total is unknown.
  function received(d: DownloadEntry): string {
    return d.totalBytes ? t('downloads.status.progress', { received: bytes(d.receivedBytes), total: bytes(d.totalBytes) }) : bytes(d.receivedBytes);
  }

  function status(d: DownloadEntry): string {
    switch (d.status) {
      case 'queued':
        return t('downloads.status.queued');
      case 'paused':
        return `${t('downloads.status.paused')} · ${received(d)}`;
      case 'error':
        return d.error || t('downloads.status.failed');
      default: {
        const parts = [received(d)];
        if (d.bytesPerSecond) parts.push(fmt.speed(d.bytesPerSecond));
        if (eta(d)) parts.push(t('common.time.remaining', { time: eta(d) }));
        return parts.join(' · ');
      }
    }
  }

  function title(d: DownloadEntry): string {
    return d.seriesName ?? d.name;
  }

  function subtitle(d: DownloadEntry): string {
    // Several servers: each copy says where it came from.
    const server = multiServer() ? serverName(d.serverId) : '';
    if (d.seriesName) return [episodeCode({ ParentIndexNumber: d.seasonNumber, IndexNumber: d.episodeNumber }), d.name, server].filter(Boolean).join(' · ');
    return [typeLabel(d.type), runtime(d.runTimeTicks), server].filter(Boolean).join(' · ');
  }

  // Books open in the reader; everything else plays.
  function open(d: DownloadEntry): void {
    if (d.type === 'Book') navigate(`/read/${d.serverId}/${d.itemId}`);
    else void run(() => w.playback.play({ itemIds: [d.itemId], serverId: d.serverId }));
  }

  async function run(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  async function retryServer(): Promise<void> {
    // Every server that is down, at once.
    const ids = session.value.sessions.filter((s) => s.status === 'offline').map((s) => s.server.id);
    if (ids.length === 0) return;
    retrying = true;
    try {
      const states = await Promise.all(ids.map((id) => w.servers.select(id)));
      if (states.every((s) => s.status === 'offline')) toast('error', t('downloads.offline.stillUnreachable'));
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      retrying = false;
    }
  }

  async function pickVpnServer(address: string): Promise<void> {
    retrying = true;
    try {
      const server = await w.servers.add(address);
      const s = await w.servers.select(server.id);
      if (s.status === 'offline') toast('error', t('downloads.offline.stillUnreachable'));
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      retrying = false;
    }
  }

  async function remove(id: string): Promise<void> {
    confirming = null;
    await run(() => w.downloads.remove(id));
  }
</script>

{#snippet thumb(d: DownloadEntry)}
  <span class="thumb">
    <span class="ph">{title(d).slice(0, 1)}</span>
    {#if d.posterPath}
      <!-- Fades in over the initial; a broken poster simply stays invisible. -->
      <img src={offlinePosterUrl(d.id)} alt="" loading="lazy" decoding="async" onload={(e) => e.currentTarget.classList.add('loaded')} />
    {/if}
  </span>
{/snippet}

{#snippet confirm(d: DownloadEntry, label: string)}
  <span class="confirm">
    <button type="button" class="btn danger sm" onclick={() => remove(d.id)}>{label}</button>
    <button type="button" class="btn icon ghost sm" aria-label={t('downloads.actions.keep')} title={t('downloads.actions.keep')} onclick={() => (confirming = null)}><Icon name="close" size={14} /></button>
  </span>
{/snippet}

<div class="page fade-in">
  <header class="head">
    <h1 class="page-title">{t('downloads.title')}</h1>
    <Segmented
      label={t('downloads.tabs.label')}
      value={tab}
      options={[
        { value: 'offline', label: t('downloads.tabs.offline') },
        { value: 'torrents', label: t('downloads.tabs.torrents') },
      ]}
      onchange={(v) => (tab = v)}
    />
    <span class="spacer"></span>
    {#if tab === 'offline' && list.length > 0}
      <button type="button" class="btn ghost" onclick={() => w.app.openPath('downloads')}><Icon name="folderOpen" size={16} /> {t('downloads.openFolder')}</button>
    {/if}
  </header>

  {#if tab === 'torrents'}
    <TorrentsPanel />
  {:else}
  {#if offline}
    <div class="banner">
      <span class="banner-icon"><Icon name="wifiOff" size={18} /></span>
      <div class="txt">
        <div class="headline">{t('downloads.offline.title')}</div>
        <div class="desc">{session.value.server?.name ? t('downloads.offline.body', { server: session.value.server.name }) : t('downloads.offline.bodyUnnamed')}</div>
        <div class="vpn">
          <VpnPanel compact disabled={retrying} onpick={(a) => pickVpnServer(a)} onconnected={() => void retryServer()} />
        </div>
      </div>
      <button type="button" class="btn" disabled={retrying} onclick={retryServer}>
        <Icon name="refresh" size={16} />
        {retrying ? t('downloads.offline.connecting') : t('common.actions.retry')}
      </button>
    </div>
  {/if}

  {#if list.length === 0}
    <div class="empty">
      <span class="glyph"><Icon name="download" size={28} /></span>
      <h2 class="title-3">{t('downloads.empty.title')}</h2>
      <p>{t('downloads.empty.body')}</p>
      {#if !offline}
        <button type="button" class="btn primary" onclick={() => navigate('/home')}>{t('downloads.empty.browse')}</button>
      {/if}
    </div>
  {:else}
    <section class="storage">
      <div class="storage-head">
        <span class="headline">{t('downloads.storage.title')}</span>
        <span class="callout muted">{#each tParts('downloads.storage.summary') as part, i (i)}{#if part.slot === 'size'}<b>{bytes(totalBytes)}</b>{:else if part.slot === 'items'}{t('common.count.items', { count: done.length })}{:else}{part.text}{/if}{/each}</span>
      </div>
      <div class="meter" role="img" aria-label={t('downloads.storage.meter')}>
        {#each storage as p (p.label)}
          <span class="seg" style:flex-grow={p.bytes} style:--c={p.color}></span>
        {/each}
      </div>
      <div class="legend">
        {#each storage as p (p.label)}
          <span><i style:--c={p.color}></i>{p.label}<span class="muted">{bytes(p.bytes)}</span></span>
        {/each}
      </div>
    </section>
  {/if}

  {#if active.length}
    <section>
      <header class="sec">
        <h2>{t('downloads.sections.active')}</h2>
        {#if speed > 0}<span class="footnote tabular">{fmt.speed(speed)}</span>{/if}
      </header>
      <ul class="list">
        {#each active as d (d.id)}
          {@const p = frac(d)}
          <li class="row" class:err={d.status === 'error'}>
            {@render thumb(d)}
            <div class="meta">
              <div class="t">{title(d)}</div>
              <div class="s">{subtitle(d)}</div>
              <div class="st" class:bad={d.status === 'error'} title={d.status === 'error' ? d.error : undefined}>{status(d)}</div>
            </div>
            <div class="acts">
              {#if confirming === d.id}
                {@render confirm(d, t('downloads.actions.cancelDownload'))}
              {:else}
                <button type="button" class="btn icon ghost" title={t('common.actions.delete')} aria-label={t('common.actions.delete')} onclick={() => (confirming = d.id)}><Icon name="trash" size={16} /></button>
              {/if}
              {#if d.status === 'downloading' || d.status === 'queued'}
                <button
                  type="button"
                  class="ring"
                  class:spin={d.status === 'queued' || !d.totalBytes}
                  title={t('downloads.actions.pause')}
                  aria-label={t('downloads.actions.pauseProgress', { percent: fmt.number(p, { style: 'percent', maximumFractionDigits: 0 }) })}
                  onclick={() => run(() => w.downloads.pause(d.id))}
                >
                  {@render ring(d.status === 'queued' || !d.totalBytes ? 0.25 : p, d.status === 'queued')}
                  <Icon name="stop" size={12} fill stroke={0} />
                </button>
              {:else}
                <button
                  type="button"
                  class="ring"
                  class:bad={d.status === 'error'}
                  title={d.status === 'error' ? t('common.actions.retry') : t('common.actions.resume')}
                  aria-label={d.status === 'error' ? t('common.actions.retry') : t('common.actions.resume')}
                  disabled={offline}
                  onclick={() => run(() => w.downloads.resume(d.id))}
                >
                  {@render ring(p, true)}
                  <Icon name={d.status === 'error' ? 'refresh' : 'download'} size={14} stroke={2.2} />
                </button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if done.length}
    <section>
      <header class="sec"><h2>{t('downloads.sections.done')}</h2></header>
      <ul class="list">
        {#each done as d (d.id)}
          <li class="row done">
            <button type="button" class="poster-btn" aria-label={t('downloads.actions.playItem', { name: d.name })} onclick={() => open(d)}>
              {@render thumb(d)}
              <span class="hover-play"><Icon name="play" size={16} fill /></span>
            </button>
            <div class="meta">
              <div class="t" title={title(d)}>{title(d)}</div>
              <div class="s" title={subtitle(d)}>{subtitle(d)}</div>
              <div class="st">{bytes(size(d))}</div>
            </div>
            <div class="acts">
              {#if confirming === d.id}
                {@render confirm(d, t('downloads.actions.deleteFile'))}
              {:else}
                <button type="button" class="btn icon ghost" title={t('downloads.actions.reveal')} aria-label={t('downloads.actions.reveal')} onclick={() => run(() => w.downloads.reveal(d.id))}>
                  <Icon name="folderOpen" size={16} />
                </button>
                <button type="button" class="btn icon ghost" title={t('common.actions.delete')} aria-label={t('common.actions.delete')} onclick={() => (confirming = d.id)}><Icon name="trash" size={16} /></button>
                <button type="button" class="btn sm play-btn" onclick={() => open(d)}><Icon name="play" size={12} fill /> {t('common.actions.play')}</button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {/if}
</div>

{#snippet ring(p: number, dim: boolean)}
  <svg class="ring-svg" width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
    <circle cx="17" cy="17" r="15" class="ring-track" />
    <circle cx="17" cy="17" r="15" class="ring-fill" class:dim stroke-dasharray={RING} stroke-dashoffset={RING * (1 - p)} />
  </svg>
{/snippet}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 20px;
    margin-bottom: 20px;
  }
  .head .page-title {
    margin: 0;
  }
  .spacer {
    flex: 1;
  }

  /* Offline banner */
  .banner {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
    margin-bottom: 20px;
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
  }
  .banner-icon {
    flex: none;
    display: grid;
    color: var(--label-2);
  }
  .banner .txt {
    flex: 1;
    min-width: 0;
  }
  .vpn:not(:empty) {
    margin-top: 10px;
  }
  .desc {
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }

  /* Storage summary */
  .storage {
    padding: 16px 18px;
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
  }
  .storage-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .storage-head .headline {
    font-size: var(--fs-body);
    font-weight: 500;
  }
  .storage-head b {
    color: var(--label);
    font-weight: 600;
  }
  .meter {
    display: flex;
    gap: 2px;
    height: 6px;
    border-radius: 3px;
    overflow: hidden;
    background: var(--fill-2);
  }
  .seg {
    flex-basis: 0;
    min-width: 4px;
    background: var(--c);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    margin-top: 12px;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .legend > span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .legend .muted {
    color: var(--label-3);
  }
  .legend i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--c);
  }

  /* Sections & lists */
  section + section,
  .storage + section {
    margin-top: 32px;
  }
  .sec {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 0 2px 8px;
  }
  .sec h2 {
    margin: 0;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
  }
  .sec .footnote {
    color: var(--label-3);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 4px;
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 10px;
    border-radius: var(--r-xs);
  }
  .row:hover,
  .row:focus-within {
    background: var(--fill-1);
  }
  /* Inset separator that starts after the thumbnail. */
  .row + .row::before {
    content: '';
    position: absolute;
    top: -0.5px;
    left: 64px;
    right: 10px;
    height: 1px;
    background: var(--separator);
  }
  .thumb {
    position: relative;
    flex: none;
    width: 40px;
    height: 60px;
    border-radius: var(--r-xs);
    overflow: hidden;
    background: var(--fill-2);
    box-shadow: inset 0 0 0 0.5px var(--hairline);
    display: block;
  }
  .thumb img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity var(--t-med) var(--ease);
  }
  .thumb img:global(.loaded) {
    opacity: 1;
  }
  .ph {
    height: 100%;
    display: grid;
    place-items: center;
    font-size: 20px;
    font-weight: 700;
    color: var(--label-3);
    background: var(--bg-elevated-2);
  }
  .meta {
    flex: 1;
    min-width: 0;
  }
  .t {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .s,
  .st {
    font-size: var(--fs-footnote);
    color: var(--label-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .st {
    margin-top: 2px;
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
  }
  .st.bad {
    color: var(--danger);
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }
  .row.done .acts .btn.icon {
    opacity: 0;
    transition:
      opacity var(--t-fast) var(--ease);
  }
  .row.done:hover .acts .btn.icon,
  .row.done:focus-within .acts .btn.icon {
    opacity: 1;
  }
  .confirm {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    animation: fade var(--t-fast) var(--ease) both;
  }
  .btn.sm {
    height: 30px;
    padding: 0 12px;
    font-size: var(--fs-footnote);
  }
  .btn.icon.sm {
    width: 30px;
    padding: 0;
  }
  .btn.danger {
    background: var(--fill-2);
  }
  .btn.danger:hover {
    background: var(--fill-3);
  }
  .play-btn {
    margin-left: 4px;
    gap: 6px;
  }

  /* Poster play affordance */
  .poster-btn {
    position: relative;
    flex: none;
    border-radius: var(--r-xs);
  }
  .hover-play {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    border-radius: var(--r-xs);
    background: rgb(0 0 0 / 0.45);
    color: #fff;
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .poster-btn:hover .hover-play,
  .poster-btn:focus-visible .hover-play {
    opacity: 1;
  }

  /* Circular progress button, App Store style. */
  .ring {
    position: relative;
    width: 34px;
    height: 34px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--label);
  }
  .ring:hover,
  .ring:focus-visible {
    background: var(--fill-2);
  }
  .ring:disabled {
    opacity: 0.4;
  }
  .ring-svg {
    position: absolute;
    inset: 0;
    transform: rotate(-90deg);
  }
  .ring.spin .ring-svg {
    animation: spin var(--t-spin) linear infinite;
  }
  @keyframes spin {
    from {
      transform: rotate(-90deg);
    }
    to {
      transform: rotate(270deg);
    }
  }
  .ring-track {
    fill: none;
    stroke: var(--fill-3);
    stroke-width: 2;
  }
  .ring-fill {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }
  .ring-fill.dim {
    stroke: var(--label-3);
  }
  .ring.bad .ring-fill {
    stroke: currentColor;
  }

  /* Empty state */
  .empty {
    display: grid;
    justify-items: center;
    text-align: center;
    padding: 80px 20px;
  }
  .glyph {
    display: grid;
    color: var(--label-3);
  }
  .empty h2 {
    margin: 16px 0 6px;
  }
  .empty p {
    max-width: 440px;
    margin: 0 0 22px;
    color: var(--label-2);
    line-height: 1.55;
  }
</style>
