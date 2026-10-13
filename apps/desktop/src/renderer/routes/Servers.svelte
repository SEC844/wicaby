<script lang="ts">
  import { kindLabel as sharedKindLabel } from '../../shared/server-caps';
  import FileSourceSheet from '../components/FileSourceSheet.svelte';
  import { onMount, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import type { DiscoveredServer, ServerInfo, ServerSession, SessionState } from '../../shared/contract';
  import Icon from '../components/Icon.svelte';
  import Logo from '../components/Logo.svelte';
  import VpnPanel from '../components/VpnPanel.svelte';
  import { w } from '../lib/bridge';
  import { plainHttpToPublic } from '../lib/address';
  import { t, tParts } from '../lib/i18n.svelte';
  import { navigate } from '../lib/router.svelte';
  import { errorMessage, onlineSessions, session, toast } from '../lib/stores.svelte';

  // The first-run setup (routes/welcome/Where.svelte) shows one part of this page at a time and takes the
  // server once it answers, instead of this page navigating: `section` picks the part, `onready` gets the server.
  let {
    section,
    onready,
    onbyaddress,
  }: {
    section?: 'lan' | 'vpn' | 'public';
    onready?: (server: ServerInfo, status: ServerSession['status']) => void;
    // VPN part: "Add by Address" when the network has no other device.
    onbyaddress?: () => void;
  } = $props();

  let embedEl = $state<HTMLDivElement>();
  let saved = $state<ServerInfo[]>([]);
  let found = $state<DiscoveredServer[]>([]);
  let scanning = $state(false);
  let address = $state('');
  let busy = $state<string | null>(null);
  let unreachable = $state<ServerInfo | null>(null);
  let mode = $state<'address' | 'connect'>('address');
  let connectUser = $state('');
  let connectPass = $state('');

  // Already signed in somewhere: this page adds servers instead of choosing one.
  const signedIn = $derived(onlineSessions().length > 0);
  const stateOf = (id: string) => session.value.sessions.find((s) => s.server.id === id);

  const tempo = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tempo')) || 1;

  async function connect(e: SubmitEvent) {
    e.preventDefault();
    if (!connectUser.trim() || !connectPass) return;
    busy = 'connect';
    unreachable = null;
    try {
      const servers = await w.servers.embyConnect(connectUser.trim(), connectPass);
      connectPass = '';
      await refreshSaved();
      if (servers.length === 0) {
        toast('info', t('onboarding.servers.connect.none'));
      } else if (servers.length === 1) {
        afterSelect(await w.servers.select(servers[0].id), servers[0]);
      } else {
        toast('success', t('onboarding.servers.connect.added', { count: servers.length }));
      }
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = null;
    }
  }

  const fresh = $derived(found.filter((f) => !saved.some((s) => s.id === f.id)));

  async function refreshSaved() {
    try {
      saved = await w.servers.list();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      // Keep the searching state up long enough to read as a scan.
      const [list] = await Promise.all([w.servers.discover(), new Promise((r) => setTimeout(r, 1200))]);
      found = list;
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      scanning = false;
    }
  }

  // The aggregate state stays signed in while another server is; what matters is this server's session.
  function afterSelect(state: SessionState, server: ServerInfo) {
    const s = state.sessions.find((x) => x.server.id === server.id);
    if (onready) {
      if (s?.status === 'offline') toast('error', t('onboarding.servers.unreachable.title', { name: server.name }));
      else if (s) onready(server, s.status);
      return;
    }
    if (s?.status === 'signed-in') navigate('/home', { replace: true });
    else if (s?.status === 'server-selected') navigate(`/login/${server.id}`, { replace: true });
    else if (s?.status === 'offline') unreachable = s.server;
  }

  async function select(server: ServerInfo) {
    if (stateOf(server.id)?.status === 'signed-in') return navigate('/home');
    busy = server.id;
    unreachable = null;
    try {
      afterSelect(await w.servers.select(server.id), server);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = null;
      void refreshSaved();
    }
  }

  async function addAndSelect(input: string, key: string) {
    const value = input.trim();
    if (!value) return;
    busy = key;
    unreachable = null;
    try {
      const server = await w.servers.add(value);
      await refreshSaved();
      afterSelect(await w.servers.select(server.id), server);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = null;
    }
  }

  async function remove(server: ServerInfo, e: Event) {
    e.stopPropagation();
    try {
      await w.servers.remove(server.id);
      if (unreachable?.id === server.id) unreachable = null;
      await refreshSaved();
      toast('info', t('onboarding.servers.toast.removed', { name: server.name }));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  async function signOut(server: ServerInfo, e: Event) {
    e.stopPropagation();
    try {
      await w.session.logout(server.id);
      await refreshSaved();
      toast('info', t('onboarding.servers.toast.signedOut', { name: server.name }));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  function status(server: ServerInfo): string {
    const s = stateOf(server.id);
    if (s?.status === 'signed-in') return s.user ? t('onboarding.servers.status.connectedAs', { user: s.user.name }) : t('onboarding.servers.status.connected');
    if (s?.status === 'connecting') return t('onboarding.servers.status.connecting');
    if (s?.status === 'offline') return t('common.status.offline');
    return `${server.userName ? `${server.userName} · ` : ''}${since(server.lastConnected)}`;
  }

  const WAKE_RETRY_S = 15;

  async function wake(server: ServerInfo) {
    try {
      const sent = await w.servers.wake(server.id);
      if (!sent) {
        toast('info', t('onboarding.servers.toast.wakeNoAddress'));
        return;
      }
      toast('success', t('onboarding.servers.toast.wakeSent', { seconds: WAKE_RETRY_S }));
      setTimeout(() => void select(server), WAKE_RETRY_S * 1000);
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  function since(ts?: number): string {
    if (!ts) return t('onboarding.servers.since.never');
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return t('onboarding.servers.since.justNow');
    if (min < 60) return t('onboarding.servers.since.minutes', { count: min });
    const h = Math.round(min / 60);
    if (h < 48) return t('onboarding.servers.since.hours', { count: h });
    return t('onboarding.servers.since.days', { count: Math.round(h / 24) });
  }

  // Brand names (shared/server-caps.ts); a file source says "Files".
  const kindLabel = (kind: string) => sharedKindLabel(kind, t('files.kind'));
  // A local folder, WebDAV or SMB source can be added without any server (file-sources-spec §9.1).
  let addingFiles = $state(false);
  const vpnLabel = (server: ServerInfo) => (server.vpn === 'netbird' ? 'NetBird · ' : server.vpn ? 'Tailscale · ' : '');

  onMount(() => {
    // The connecting splash unmounts this page, so an offline result lands on a fresh instance.
    if (session.value.status === 'offline' && session.value.server && !signedIn) unreachable = session.value.server;
    void refreshSaved();
    if (section !== 'vpn' && section !== 'public') void scan();
    // Opened from a card: focus goes to the part's first control.
    if (section) void tick().then(() => embedEl?.querySelector<HTMLElement>(section === 'lan' ? 'input' : 'input, button')?.focus());
  });
</script>

{#snippet nearby()}
  <section class="group">
    <div class="group-head">
      <h2 class="group-title">{t('onboarding.servers.nearby.title')}</h2>
      <button class="rescan" onclick={scan} disabled={scanning}>
        {#if scanning}<span class="spinner small"></span> {t('onboarding.servers.nearby.searchingShort')}{:else}<Icon name="refresh" size={13} stroke={2} /> {t('common.actions.refresh')}{/if}
      </button>
    </div>
    {#if scanning && fresh.length === 0}
      <div class="inset searching" in:fade={{ duration: 200 * tempo() }}>
        <span class="beacon"><Icon name="wifi" size={18} /></span>
        <span>{t('onboarding.servers.nearby.searching')}</span>
      </div>
    {:else if fresh.length === 0}
      <p class="inset empty" in:fade={{ duration: 200 * tempo() }}>
        {found.length > 0 ? t('onboarding.servers.nearby.allSaved') : t('onboarding.servers.nearby.none')}
      </p>
    {:else}
      <ul class="inset">
        {#each fresh as server, i (server.id)}
          <li class="reveal" style:--i={Math.min(i, 12)}>
            <button class="row" onclick={() => addAndSelect(server.address, server.id)} disabled={busy !== null}>
              <span class="tile"><Icon name="server" size={17} /></span>
              <span class="meta">
                <span class="name">{server.name}</span>
                <span class="sub">{kindLabel(server.kind)} · <span class="mono">{server.address}</span></span>
              </span>
              {#if busy === server.id}
                <span class="spinner"></span>
              {:else}
                <span class="add">{t('common.actions.add')}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/snippet}

{#snippet methods()}
  <section class="group">
    {#if section !== 'lan'}
      <div class="segmented" role="tablist" aria-label={t('onboarding.servers.method.aria')}>
        <span class="thumb" class:right={mode === 'connect'} aria-hidden="true"></span>
        <button role="tab" class:on={mode === 'address'} aria-selected={mode === 'address'} onclick={() => (mode = 'address')}>{t('onboarding.servers.method.address')}</button>
        <button role="tab" class:on={mode === 'connect'} aria-selected={mode === 'connect'} onclick={() => (mode = 'connect')}>Emby Connect</button>
      </div>
    {/if}

    {#if mode === 'address'}
      <form
        class="form"
        in:fly={{ x: -12, duration: 260 * tempo(), easing: cubicOut }}
        onsubmit={(e) => {
          e.preventDefault();
          void addAndSelect(address, 'manual');
        }}
      >
        <div class="inline">
          <input
            class="field"
            placeholder={section === 'public' ? t('welcome.where.public.placeholder') : t('onboarding.servers.address.placeholder')}
            bind:value={address}
            spellcheck="false"
            autocomplete="off"
            aria-label={t('onboarding.servers.address.aria')}
          />
          <button class="btn primary" type="submit" disabled={!address.trim() || busy !== null}>
            {#if busy === 'manual'}<span class="spinner on-accent"></span>{:else}{t('common.actions.continue')}{/if}
          </button>
        </div>
        {#if section === 'public' && plainHttpToPublic(address)}
          <p class="caution" role="status"><Icon name="exclamation" size={14} /> {t('welcome.where.public.insecure')}</p>
        {/if}
        <p class="hint">
          {#each tParts('onboarding.servers.address.hint') as part, i (i)}{#if part.slot === 'https'}<span class="mono">https://</span>{:else if part.slot === 'http'}<span class="mono">http://…:8096</span>{:else if part.slot === 'path'}<span class="mono">/emby</span>{:else}{part.text}{/if}{/each}
        </p>
      </form>
    {:else}
      <form class="form" in:fly={{ x: 12, duration: 260 * tempo(), easing: cubicOut }} onsubmit={connect}>
        <div class="stack">
          <input class="field" placeholder={t('onboarding.servers.connect.userPlaceholder')} bind:value={connectUser} autocomplete="username" spellcheck="false" />
          <input class="field" type="password" placeholder={t('onboarding.fields.password')} bind:value={connectPass} autocomplete="current-password" />
        </div>
        <button class="btn primary wide" type="submit" disabled={!connectUser.trim() || !connectPass || busy !== null}>
          {#if busy === 'connect'}<span class="spinner on-accent"></span>{:else}<Icon name="globe" size={16} /> {t('onboarding.servers.connect.submit')}{/if}
        </button>
        <p class="hint">{t('onboarding.servers.connect.hint')}</p>
      </form>
    {/if}
  </section>
{/snippet}

{#if section}
  <div class="embed" bind:this={embedEl}>
    {#if section === 'lan'}
      {@render nearby()}
      {@render methods()}
    {:else if section === 'vpn'}
      <VpnPanel disabled={busy !== null} onpick={(a, k) => addAndSelect(a, k)} {onbyaddress} />
    {:else}
      {@render methods()}
    {/if}
  </div>
{:else}

<div class="setup">
  <div class="stage">
    <section class="card" in:fly={{ y: 24, duration: 640 * tempo(), easing: cubicOut }}>
      <header class="intro">
        <span class="appicon"><Logo size={40} /></span>
        {#if signedIn}
          <h1>{t('onboarding.servers.yours.title')}</h1>
          <p>{t('onboarding.servers.yours.body')}</p>
          <button class="btn done" onclick={() => navigate('/home')}>{t('common.actions.done')}</button>
        {:else}
          <h1>{t('onboarding.servers.welcome.title')}</h1>
          <p>{t('onboarding.servers.welcome.body')}</p>
        {/if}
      </header>

      {#if unreachable}
        <div class="banner" role="alert" transition:fly={{ y: -8, duration: 240 * tempo(), easing: cubicOut }}>
          <span class="banner-icon"><Icon name="wifiOff" size={18} /></span>
          <div class="banner-body">
            <strong>{t('onboarding.servers.unreachable.title', { name: unreachable.name })}</strong>
            <span>{t('onboarding.servers.unreachable.body')}</span>
            <div class="banner-actions">
              <button class="btn" onclick={() => unreachable && wake(unreachable)}><Icon name="power" size={15} /> {t('onboarding.servers.unreachable.wake')}</button>
              <button class="btn ghost" onclick={() => unreachable && select(unreachable)}><Icon name="refresh" size={15} /> {t('common.actions.retry')}</button>
              <button class="btn ghost" onclick={() => navigate('/downloads')}><Icon name="download" size={15} /> {t('common.status.offline')}</button>
            </div>
            <div class="banner-vpn">
              <VpnPanel
                compact
                disabled={busy !== null}
                onpick={(a, k) => addAndSelect(a, k)}
                onconnected={() => unreachable && select(unreachable)}
              />
            </div>
          </div>
        </div>
      {/if}

      {#if saved.length > 0}
        <section class="group">
          <h2 class="group-title">{t('onboarding.servers.yours.title')}</h2>
          <ul class="inset">
            {#each saved as server, i (server.id)}
              {@const on = stateOf(server.id)?.status === 'signed-in'}
              <li class="reveal" style:--i={Math.min(i, 12)}>
                <button class="row" onclick={() => select(server)} disabled={busy !== null}>
                  <span class="tile"><Icon name="server" size={17} /></span>
                  <span class="meta">
                    <span class="name">{server.name}</span>
                    <span class="sub">{kindLabel(server.kind)} · {vpnLabel(server)}{status(server)}</span>
                  </span>
                  {#if busy === server.id || stateOf(server.id)?.status === 'connecting'}
                    <span class="spinner"></span>
                  {:else if on}
                    <span class="go"><Icon name="check" size={16} stroke={2} /></span>
                  {:else}
                    <span class="go"><Icon name="chevronRight" size={16} stroke={2} /></span>
                  {/if}
                </button>
                {#if on}
                  <button class="remove signout" onclick={(e) => signOut(server, e)} aria-label={t('onboarding.servers.row.signOutAria', { name: server.name })} title={t('onboarding.servers.row.signOut')}>
                    <Icon name="logout" size={16} />
                  </button>
                {/if}
                <button class="remove" onclick={(e) => remove(server, e)} aria-label={t('onboarding.servers.row.removeAria', { name: server.name })} title={t('common.actions.remove')}>
                  <Icon name="trash" size={16} />
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {@render nearby()}

      {#if !unreachable}
        <section class="group">
          <h2 class="group-title">{t('onboarding.servers.remote.title')}</h2>
          <VpnPanel disabled={busy !== null} onpick={(a, k) => addAndSelect(a, k)} />
        </section>
      {/if}

      {@render methods()}

      <section class="group">
        <h2 class="group-title">{t('files.sources')}</h2>
        <button class="btn files-add" onclick={() => (addingFiles = true)}><Icon name="folderOpen" size={16} /> {t('files.add.open')}</button>
      </section>
    </section>

    <FileSourceSheet open={addingFiles} onclose={() => (addingFiles = false)} />

    <p class="footer">{t('onboarding.servers.footer')}</p>
  </div>
</div>
{/if}

<style>
  .files-add {
    align-self: flex-start;
    gap: 8px;
  }
  .embed {
    display: flex;
    flex-direction: column;
    gap: 22px;
  }
  .caution {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 4px;
    font-size: var(--fs-footnote);
    color: var(--warning);
  }
  .setup {
    view-transition-name: page;
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .stage {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: calc(var(--titlebar) + 24px) 24px 32px;
  }
  .card {
    margin: auto 0 0;
    width: min(580px, 100%);
    display: flex;
    flex-direction: column;
    gap: 28px;
    padding: 40px 40px 36px;
    border-radius: var(--r-xl);
    background: var(--material);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      inset 0 1px 0 rgb(255 255 255 / 0.05),
      var(--shadow-3);
  }
  .footer {
    margin: 22px 0 auto;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    text-align: center;
  }

  .intro {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .appicon {
    display: grid;
    place-items: center;
    width: 68px;
    height: 68px;
    margin-bottom: 20px;
    border-radius: 18px;
    color: var(--label);
    background: var(--bg-elevated-2);
    box-shadow:
      inset 0 0 0 0.5px var(--hairline),
      var(--shadow-1);
  }
  h1 {
    margin: 0;
    font-size: var(--fs-large-title);
    font-weight: 700;
    letter-spacing: -0.028em;
    line-height: 1.1;
  }
  .intro p {
    margin: 10px 0 0;
    max-width: 40ch;
    font-size: var(--fs-headline);
    line-height: 1.45;
    color: var(--label-2);
  }

  .banner {
    display: flex;
    gap: 14px;
    padding: 16px;
    border-radius: var(--r-md);
    background: var(--fill-1);
    box-shadow: inset 0 0 0 0.5px var(--separator);
  }
  .banner-icon {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    flex: none;
    border-radius: 50%;
    background: var(--fill-2);
    color: var(--label-2);
  }
  .banner-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--fs-callout);
  }
  .banner-body strong {
    font-size: var(--fs-headline);
    font-weight: 600;
  }
  .banner-body > span {
    color: var(--label-2);
  }
  .banner-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }
  .banner-actions .btn {
    height: 32px;
    padding: 0 14px;
  }
  .banner-vpn:not(:empty) {
    margin-top: 12px;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .group-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .group-title {
    margin: 0;
    padding-left: 4px;
    font-size: var(--fs-footnote);
    font-weight: 600;
    color: var(--label-2);
  }
  .rescan {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: var(--fs-footnote);
    font-weight: 560;
    color: var(--label-2);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      transform var(--t-med) var(--spring);
  }
  .rescan:hover,
  .rescan:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  .rescan:active {
    transform: scale(0.94);
  }
  .rescan:disabled {
    color: var(--label-3);
    background: none;
  }

  /* Inset grouped list, like iOS / macOS settings. */
  .inset {
    list-style: none;
    margin: 0;
    padding: 0;
    border-radius: var(--r-md);
    background: var(--fill-1);
    box-shadow: inset 0 0 0 0.5px var(--separator);
    overflow: hidden;
  }
  .inset li {
    position: relative;
  }
  .inset li + li::before {
    content: '';
    position: absolute;
    top: 0;
    left: 64px;
    right: 0;
    height: 1px;
    background: var(--separator);
  }
  .reveal {
    animation: rise var(--t-slow) var(--ease-out) both;
    animation-delay: calc(var(--i) * 40ms * var(--tempo));
  }
  .row {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    min-height: 62px;
    padding: 10px 16px 10px 12px;
    text-align: left;
    transition: background-color var(--t-fast) var(--ease);
  }
  .row:hover {
    background: var(--fill-1);
  }
  .row:active {
    background: var(--fill-2);
  }
  .row:focus-visible {
    border-radius: var(--r-md);
    background: var(--fill-2);
  }
  .row:disabled {
    cursor: progress;
  }
  li:has(.remove) .row {
    padding-right: 56px;
  }
  li:has(.signout) .row {
    padding-right: 96px;
  }
  .tile {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    flex: none;
    border-radius: 10px;
    color: var(--label-2);
    background: var(--fill-2);
  }
  .row:hover .tile {
    color: var(--label);
  }
  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .name {
    font-size: var(--fs-headline);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .sub {
    font-size: var(--fs-footnote);
    color: var(--label-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub .mono {
    font-size: 11.5px;
  }
  .go {
    display: grid;
    color: var(--label-3);
    transition:
      transform var(--t-med) var(--spring),
      opacity var(--t-fast) var(--ease);
  }
  .row:hover .go {
    transform: translateX(3px);
  }
  .add {
    padding: 4px 12px;
    border-radius: 999px;
    background: var(--fill-2);
    font-size: var(--fs-footnote);
    font-weight: 600;
    color: var(--label);
  }
  .remove {
    position: absolute;
    top: 50%;
    right: 10px;
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: var(--label-3);
    opacity: 0;
    transform: translateY(-50%) scale(0.8);
    transition:
      opacity var(--t-fast) var(--ease),
      transform var(--t-med) var(--spring),
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  li:hover .remove,
  .remove:focus-visible {
    opacity: 1;
    transform: translateY(-50%);
  }
  li:hover .go {
    opacity: 0;
  }
  .remove:hover {
    background: color-mix(in srgb, var(--danger) 16%, transparent);
    color: var(--danger);
  }
  .remove.signout {
    right: 48px;
  }
  .remove.signout:hover {
    background: var(--fill-2);
    color: var(--label);
  }
  .done {
    margin-top: 16px;
  }

  .searching,
  .empty {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 62px;
    padding: 12px 16px 12px 12px;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .empty {
    justify-content: center;
    text-align: center;
    color: var(--label-3);
  }
  .beacon {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    flex: none;
    border-radius: 10px;
    background: var(--fill-2);
    color: var(--label-2);
  }

  /* Segmented control with a sliding thumb. */
  .segmented {
    position: relative;
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 3px;
    border-radius: var(--r-sm);
    background: var(--fill-2);
  }
  .thumb {
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: 3px;
    width: calc(50% - 3px);
    border-radius: 8px;
    background: var(--fill-4);
    box-shadow:
      0 1px 3px rgb(0 0 0 / 0.3),
      inset 0 0.5px 0 rgb(255 255 255 / 0.1);
    transition: transform var(--t-med) var(--spring);
  }
  .thumb.right {
    transform: translateX(100%);
  }
  .segmented button {
    position: relative;
    height: 30px;
    border-radius: 8px;
    font-size: var(--fs-callout);
    font-weight: 560;
    color: var(--label-2);
    transition: color var(--t-fast) var(--ease);
  }
  .segmented button.on {
    color: var(--label);
  }
  .segmented button:hover {
    color: var(--label);
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 6px;
  }
  .inline {
    display: flex;
    gap: 8px;
  }
  .inline .btn {
    height: 40px;
    min-width: 112px;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .btn.wide {
    height: 42px;
  }
  .hint {
    margin: 2px 4px 0;
    font-size: var(--fs-footnote);
    line-height: 1.5;
    color: var(--label-3);
  }
  .hint .mono {
    font-size: 11.5px;
    color: var(--label-2);
  }

  .spinner {
    width: 18px;
    height: 18px;
    flex: none;
    border-radius: 50%;
    background: conic-gradient(from 90deg, transparent 10%, var(--label-2));
    mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2px));
    animation: spin calc(0.8s * var(--tempo)) linear infinite;
  }
  .spinner.small {
    width: 13px;
    height: 13px;
  }
  .spinner.on-accent {
    background: conic-gradient(from 90deg, transparent 10%, var(--accent-fg));
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-height: 760px) {
    .card {
      padding-top: 28px;
      gap: 22px;
    }
    .appicon {
      width: 52px;
      height: 52px;
      border-radius: 14px;
      margin-bottom: 14px;
    }
    .appicon :global(.logo) {
      width: 32px;
      height: 32px;
    }
  }
</style>
