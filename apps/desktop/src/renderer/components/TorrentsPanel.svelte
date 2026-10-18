<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Torrent, TorrentAction } from '../../shared/contract';
  import { w } from '../lib/bridge';
  import { bytes } from '../lib/format';
  import { fmt, t } from '../lib/i18n.svelte';
  import { linux } from '../lib/platform';
  import { navigate } from '../lib/router.svelte';
  import { errorMessage, toast } from '../lib/stores.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';
  import Toggle from './Toggle.svelte';
  import TorrentSettings from './TorrentSettings.svelte';
  import TorrentsAddSheet from './TorrentsAddSheet.svelte';
  import { eta, initTorrents, isBroken, isDownloading, isPaused, speed, stateLabel, torrents } from '../lib/torrents.svelte';

  const st = $derived(torrents.value);
  const list = $derived(st?.torrents ?? []);

  let addOpen = $state(false);
  let addFiles = $state<File[]>([]);
  let addMagnet = $state('');
  let external = $state(false);
  let settingsOpen = $state(false);
  let removing = $state<Torrent | null>(null);
  let removeFiles = $state(false);
  let menu = $state<{ hash: string; x: number; y: number; up: boolean } | null>(null);
  let menuEl = $state<HTMLDivElement>();
  let retrying = $state(false);

  // Fast polling only while the list is on screen and the window has focus.
  function mode(): 'fg' | 'bg' | 'off' {
    if (document.visibilityState !== 'visible') return 'off';
    return document.hasFocus() ? 'fg' : 'bg';
  }

  async function takeMagnet(): Promise<void> {
    const m = await w.torrents.takeMagnet();
    if (!m) return;
    addFiles = [];
    addMagnet = m;
    external = true;
    addOpen = true;
  }

  onMount(() => {
    initTorrents();
    const sync = () => void w.torrents.watch(mode());
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    void takeMagnet();
    const offMagnet = w.torrents.onMagnet(() => void takeMagnet());
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      offMagnet();
      void w.torrents.watch('off');
    };
  });

  // Files dropped anywhere in the window land here.
  $effect(() => {
    if (!torrents.dropped.length || st?.status !== 'online') return;
    addFiles = torrents.dropped;
    torrents.dropped = [];
    addMagnet = '';
    external = false;
    addOpen = true;
  });

  function openAdd(): void {
    addFiles = [];
    addMagnet = '';
    external = false;
    addOpen = true;
  }

  async function run(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  const act = (tor: Torrent, action: TorrentAction) => {
    menu = null;
    void run(() => w.torrents.action([tor.hash], action));
  };

  // `tor` comes in as an argument: the menu's {@const} reads undefined once `menu` is cleared.
  function setCategory(tor: Torrent, category: string): void {
    menu = null;
    void run(() => w.torrents.setCategory([tor.hash], category));
  }

  function askRemove(tor: Torrent): void {
    menu = null;
    removeFiles = false;
    removing = tor;
  }

  async function retry(): Promise<void> {
    retrying = true;
    // off → fg forces an immediate poll.
    await w.torrents.watch('off');
    await w.torrents.watch(mode());
    setTimeout(() => (retrying = false), 1200);
  }

  async function confirmRemove(): Promise<void> {
    const tor = removing;
    removing = null;
    if (tor) await run(() => w.torrents.remove([tor.hash], removeFiles));
  }

  async function openMenu(tor: Torrent, e: MouseEvent): Promise<void> {
    if (menu?.hash === tor.hash) {
      menu = null;
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const up = r.bottom + 420 > window.innerHeight && r.top > 420;
    menu = { hash: tor.hash, x: window.innerWidth - r.right, y: up ? window.innerHeight - r.top + 6 : r.bottom + 6, up };
    await tick();
    menuEl?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }

  // The page scroller is a containing block for position: fixed; float on <body> instead.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  const menuTorrent = $derived(menu ? list.find((x) => x.hash === menu?.hash) : undefined);

  function detail(tor: Torrent): string {
    const parts: string[] = [stateLabel(tor)];
    if (tor.progress < 1) parts.push(t('torrents.panel.progress', { done: bytes(tor.size * tor.progress), total: bytes(tor.size) }));
    else parts.push(bytes(tor.size), t('torrents.panel.ratio', { ratio: fmt.number(tor.ratio, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }));
    if (isDownloading(tor) && eta(tor.eta)) parts.push(t('common.time.remaining', { time: eta(tor.eta) }));
    return parts.join(' · ');
  }

  const percent = (p: number) => fmt.number(Math.floor(p * 1000) / 1000, { style: 'percent', maximumFractionDigits: 1 });
</script>

<svelte:window
  onpointerdown={(e) => {
    if (menu && menuEl && !menuEl.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.more')) menu = null;
  }}
  onkeydown={(e) => {
    if (menu && e.key === 'Escape') {
      e.preventDefault();
      menu = null;
    }
  }}
  onresize={() => (menu = null)}
/>

{#if !st || st.status === 'connecting'}
  <div class="quiet callout muted">{t('torrents.panel.connecting')}</div>
{:else if st.status === 'unconfigured'}
  <div class="empty">
    <span class="glyph"><Icon name="download" size={28} /></span>
    <h2 class="title-3">{t('torrents.panel.setup.title')}</h2>
    <p>{t('torrents.panel.setup.body')}</p>
    <button type="button" class="btn primary" onclick={() => (settingsOpen = true)}>{t('torrents.panel.setup.button')}</button>
  </div>
{:else if st.status !== 'online'}
  <div class="banner">
    <span class="banner-icon"><Icon name={st.status === 'offline' ? 'wifiOff' : 'lock'} size={18} /></span>
    <div class="txt">
      <div class="headline">
        {t(st.status === 'offline' ? 'torrents.panel.banner.offline' : st.status === 'auth' ? 'torrents.panel.banner.auth' : 'torrents.panel.banner.certificate')}
      </div>
      <div class="desc">
        {#if st.status === 'certificate'}
          {st.certificate?.host
            ? t(linux ? 'torrents.panel.banner.certificateBodyLinux' : 'torrents.panel.banner.certificateBody', { host: st.certificate.host })
            : t(linux ? 'torrents.panel.banner.certificateBodyUnnamedLinux' : 'torrents.panel.banner.certificateBodyUnnamed')}
        {:else}
          {st.error ?? t('torrents.panel.banner.noResponse')}
          {st.status === 'offline' ? t('torrents.panel.banner.offlineHint') : ''}
        {/if}
      </div>
    </div>
    {#if st.status === 'offline'}
      <button type="button" class="btn" disabled={retrying} onclick={retry}><Icon name="refresh" size={16} /> {retrying ? t('torrents.panel.banner.connecting') : t('common.actions.retry')}</button>
    {/if}
    <button type="button" class="btn" onclick={() => (settingsOpen = true)}>{t('torrents.panel.banner.settings')}</button>
  </div>
{:else}
  <div class="bar">
    <div class="speeds tabular" aria-label={t('torrents.panel.speedsAria')}>
      <span title={t('torrents.panel.download')}><Icon name="arrowDown" size={14} /> {speed(st.transfer.dlSpeed)}</span>
      <span title={t('torrents.panel.upload')}><Icon name="arrowUp" size={14} /> {speed(st.transfer.upSpeed)}</span>
      {#if st.transfer.freeSpace !== undefined}<span class="free">{t('torrents.panel.free', { size: bytes(st.transfer.freeSpace) })}</span>{/if}
    </div>
    <label class="alt">
      <span>{t('torrents.panel.altSpeed')}</span>
      <Toggle label={t('torrents.panel.altSpeedAria')} checked={st.transfer.altSpeed} onchange={() => run(() => w.torrents.toggleAltSpeed())} />
    </label>
    <button type="button" class="btn icon ghost" title={t('torrents.panel.settings')} aria-label={t('torrents.panel.settings')} onclick={() => (settingsOpen = true)}><Icon name="settings" size={16} /></button>
    <button type="button" class="btn primary" onclick={openAdd}><Icon name="plus" size={16} /> {t('common.actions.add')}</button>
  </div>

  {#if list.length === 0}
    <div class="empty small">
      <h2 class="title-3">{t('torrents.panel.empty.title')}</h2>
      <p>{t('torrents.panel.empty.body')}</p>
    </div>
  {:else}
    <ul class="list">
      {#each list as tor (tor.hash)}
        {@const paused = isPaused(tor)}
        <li class="row" class:dim={paused}>
          <div class="meta">
            <div class="t" title={tor.name}>{tor.name}</div>
            <div class="st" class:bad={isBroken(tor)}>{detail(tor)}</div>
            {#if tor.progress < 1}
              <div class="track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(tor.progress * 100)}>
                <span class="fill" class:paused style:transform="scaleX({tor.progress})"></span>
              </div>
            {/if}
            <div class="sub tabular">
              {#if tor.dlspeed && !paused}<span><Icon name="arrowDown" size={12} /> {speed(tor.dlspeed)}</span>{/if}
              {#if tor.upspeed && !paused}<span><Icon name="arrowUp" size={12} /> {speed(tor.upspeed)}</span>{/if}
              <span title={t('torrents.panel.peersTitle')}>{t('torrents.panel.peers', { seeds: tor.seeds, seedsTotal: tor.seedsTotal, peers: tor.peers, peersTotal: tor.peersTotal })}</span>
              {#if tor.available}
                <button type="button" class="avail" onclick={() => navigate(`/item/${tor.available?.serverId}/${tor.available?.itemId}`)}>{t('torrents.panel.available', { library: tor.available.libraryName })}</button>
              {/if}
            </div>
          </div>
          {#if tor.category}<span class="chip">{tor.category}</span>{/if}
          <span class="pct tabular">{tor.progress < 1 ? percent(tor.progress) : ''}</span>
          <div class="acts">
            <button
              type="button"
              class="btn icon ghost"
              title={paused ? t('common.actions.resume') : t('torrents.panel.pause')}
              aria-label={paused ? t('common.actions.resume') : t('torrents.panel.pause')}
              onclick={() => act(tor, paused ? 'resume' : 'pause')}
            >
              <Icon name={paused ? 'play' : 'pause'} size={16} />
            </button>
            <button type="button" class="btn icon ghost more" title={t('torrents.panel.more')} aria-label={t('torrents.panel.more')} aria-haspopup="menu" aria-expanded={menu?.hash === tor.hash} onclick={(e) => openMenu(tor, e)}>
              <Icon name="ellipsis" size={16} />
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
{/if}

{#if menu && menuTorrent}
  {@const tor = menuTorrent}
  <div class="menu material" class:up={menu.up} role="menu" bind:this={menuEl} use:portal style:right="{menu.x}px" style:top={menu.up ? undefined : `${menu.y}px`} style:bottom={menu.up ? `${menu.y}px` : undefined}>
    <button type="button" role="menuitemcheckbox" aria-checked={tor.forceStart} onclick={() => act(tor, 'force-start')}>
      <span class="check">{#if tor.forceStart}<Icon name="check" size={14} />{/if}</span>{t('torrents.menu.forceStart')}
    </button>
    <button type="button" role="menuitem" onclick={() => act(tor, 'recheck')}><span class="check"></span>{t('torrents.menu.recheck')}</button>
    <hr />
    <button type="button" role="menuitem" disabled={tor.priority <= 0} onclick={() => act(tor, 'priority-up')}><span class="check"></span>{t('torrents.menu.moveUp')}</button>
    <button type="button" role="menuitem" disabled={tor.priority <= 0} onclick={() => act(tor, 'priority-down')}><span class="check"></span>{t('torrents.menu.moveDown')}</button>
    <button type="button" role="menuitemcheckbox" aria-checked={tor.sequential} onclick={() => act(tor, 'sequential')}>
      <span class="check">{#if tor.sequential}<Icon name="check" size={14} />{/if}</span>{t('torrents.menu.sequential')}
    </button>
    <button type="button" role="menuitemcheckbox" aria-checked={tor.firstLast} onclick={() => act(tor, 'first-last')}>
      <span class="check">{#if tor.firstLast}<Icon name="check" size={14} />{/if}</span>{t('torrents.menu.firstLast')}
    </button>
    <hr />
    <div class="mh">{t('torrents.menu.category')}</div>
    {#each [{ name: '' }, ...(st?.categories ?? [])] as c (c.name)}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={tor.category === c.name}
        onclick={() => setCategory(tor, c.name)}
      >
        <span class="check">{#if tor.category === c.name}<Icon name="check" size={14} />{/if}</span>{c.name || t('torrents.menu.noCategory')}
      </button>
    {/each}
    <hr />
    <button
      type="button"
      role="menuitem"
      onclick={() => askRemove(tor)}><span class="check"><Icon name="trash" size={14} /></span>{t('torrents.menu.remove')}</button
    >
  </div>
{/if}

{#if torrents.dragging && st?.status === 'online'}
  <div class="drop" aria-hidden="true" use:portal>
    <div class="drop-card material">
      <Icon name="download" size={24} />
      <span class="headline">{t('torrents.drop')}</span>
    </div>
  </div>
{/if}

<TorrentsAddSheet open={addOpen} onclose={() => (addOpen = false)} bind:files={addFiles} bind:magnet={addMagnet} {external} />

<Sheet open={removing !== null} onclose={() => (removing = null)} label={t('torrents.remove.label')} width={440}>
  <div class="confirm">
    <h2 class="title-3">{t('torrents.remove.title')}</h2>
    <p class="name">{removing?.name}</p>
    <label class="opt">
      <span>
        <span class="lbl">{t('torrents.remove.deleteFiles')}</span>
        <span class="caption">{t('torrents.remove.deleteFilesDesc')}</span>
      </span>
      <Toggle label={t('torrents.remove.deleteFiles')} checked={removeFiles} onchange={(v) => (removeFiles = v)} />
    </label>
    <div class="actions">
      <button type="button" class="btn" data-autofocus onclick={() => (removing = null)}>{t('common.actions.cancel')}</button>
      <button type="button" class="btn danger" onclick={confirmRemove}>{removeFiles ? t('torrents.remove.confirmWithFiles') : t('common.actions.delete')}</button>
    </div>
  </div>
</Sheet>

<Sheet open={settingsOpen} onclose={() => (settingsOpen = false)} label={t('torrents.panel.settings')} width={640}>
  <div class="settings">
    <h2 class="title-3">qBittorrent</h2>
    <TorrentSettings />
  </div>
</Sheet>

<style>
  .quiet {
    padding: 40px 4px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 14px;
  }
  .speeds {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 18px;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .speeds span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .speeds .free {
    color: var(--label-3);
  }
  .alt {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    margin-right: 4px;
    font-size: var(--fs-callout);
    color: var(--label-2);
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
    padding: 10px 10px 10px 14px;
    border-radius: var(--r-xs);
  }
  .row:hover,
  .row:focus-within {
    background: var(--fill-1);
  }
  .row + .row::before {
    content: '';
    position: absolute;
    top: -0.5px;
    left: 14px;
    right: 10px;
    height: 1px;
    background: var(--separator);
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
  .row.dim .t {
    color: var(--label-2);
  }
  .st,
  .sub {
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .st.bad {
    color: var(--danger);
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 14px;
    color: var(--label-3);
  }
  .sub span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .avail {
    color: var(--label);
    font-weight: 500;
    border-radius: 4px;
  }
  .avail:hover,
  .avail:focus-visible {
    text-decoration: underline;
  }
  .track {
    height: 4px;
    margin: 7px 0 3px;
    max-width: 520px;
    border-radius: 2px;
    background: var(--fill-2);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
    transition: transform var(--t-med) var(--ease);
  }
  .fill.paused {
    background: var(--label-3);
  }
  .chip {
    flex: none;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pct {
    flex: none;
    width: 52px;
    text-align: right;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .acts {
    flex: none;
    display: flex;
    gap: 2px;
  }

  .menu {
    position: fixed;
    z-index: 150;
    min-width: 260px;
    max-height: min(480px, calc(100vh - 80px));
    overflow-y: auto;
    padding: 4px;
    border-radius: var(--r-sm);
    box-shadow:
      inset 0 0 0 1px var(--hairline),
      var(--shadow-2);
    animation: menu-in var(--t-fast) var(--ease-out) both;
  }
  @keyframes menu-in {
    from {
      opacity: 0;
      transform: translate3d(0, -3px, 0);
    }
  }
  .menu.up {
    animation-name: menu-up;
  }
  @keyframes menu-up {
    from {
      opacity: 0;
      transform: translate3d(0, 3px, 0);
    }
  }
  .menu button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 12px 0 6px;
    border-radius: var(--r-xs);
    text-align: left;
    font-size: var(--fs-callout);
    color: var(--label);
  }
  .menu button:hover:not(:disabled),
  .menu button:focus-visible {
    background: var(--fill-3);
  }
  .menu button:disabled {
    color: var(--label-4);
  }
  .menu hr {
    margin: 4px 8px;
    border: 0;
    height: 1px;
    background: var(--separator);
  }
  .mh {
    padding: 4px 10px 2px 30px;
    font-size: var(--fs-caption);
    color: var(--label-3);
  }
  .check {
    width: 18px;
    flex: none;
    display: grid;
    place-items: center;
    color: var(--label-2);
  }

  .banner {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
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
  .banner .desc {
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }

  .empty {
    display: grid;
    justify-items: center;
    text-align: center;
    padding: 72px 20px;
  }
  .empty.small {
    padding: 48px 20px;
  }
  .glyph {
    display: grid;
    color: var(--label-3);
  }
  .empty h2 {
    margin: 16px 0 6px;
  }
  .empty.small h2 {
    margin-top: 0;
  }
  .empty p {
    max-width: 440px;
    margin: 0 0 22px;
    color: var(--label-2);
    line-height: 1.55;
  }

  .drop {
    position: fixed;
    inset: 0;
    z-index: 180;
    display: grid;
    place-items: center;
    background: var(--scrim);
    pointer-events: none;
    animation: fade var(--t-fast) var(--ease) both;
  }
  .drop-card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 18px 26px;
    border-radius: var(--r-lg);
    color: var(--label);
    box-shadow:
      inset 0 0 0 1px var(--hairline),
      var(--shadow-3);
  }

  .confirm,
  .settings {
    padding: 26px 28px 24px;
  }
  .confirm h2,
  .settings h2 {
    margin: 0 40px 6px 0;
  }
  .settings h2 {
    margin-bottom: 18px;
  }
  .name {
    margin: 0 0 18px;
    color: var(--label-2);
    word-break: break-word;
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
    border-radius: var(--r-sm);
    background: var(--fill-1);
  }
  .opt > span {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .opt .lbl {
    font-weight: 500;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 22px;
  }
</style>
