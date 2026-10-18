<script lang="ts">
  import { kindLabel } from '../../shared/server-caps';
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import type { MeshProvider, VpnKind, VpnPeer, VpnStatus } from '../../shared/contract';
  import Icon from './Icon.svelte';
  import { w } from '../lib/bridge';
  import { fmt, t } from '../lib/i18n.svelte';
  import { errorMessage, toast } from '../lib/stores.svelte';
  import { pendingMatches } from '../lib/vpn';
  import { dur } from '../lib/motion';

  let {
    compact = false,
    disabled = false,
    onpick,
    onconnected,
    onbyaddress,
  }: {
    // Banner mode: rows instead of the two big choices, no advanced fields.
    compact?: boolean;
    disabled?: boolean;
    onpick: (address: string, key: string) => void;
    onconnected?: () => void;
    // Shown when the network has no other device: the first-run setup switches to its address field.
    onbyaddress?: () => void;
  } = $props();

  const NAMES: Record<MeshProvider, string> = { tailscale: 'Tailscale', netbird: 'NetBird' };
  const caption = (p: MeshProvider) => t(`vpn.caption.${p}`);

  // One lane per mesh. Wicaby's own node does the work; an installed app that
  // is already connected is simply used as is.
  interface Lane {
    provider: MeshProvider;
    // Which facade kind drives this lane (connect / peers).
    kind: VpnKind;
    via: 'app' | 'embedded' | 'none';
    status?: VpnStatus;
  }

  let statuses = $state<VpnStatus[]>([]);
  let loaded = $state(false);
  let busy = $state<MeshProvider | null>(null);
  let open = $state<MeshProvider | null>(null);
  let peers = $state<VpnPeer[] | null>(null);
  let advanced = $state(false);
  let nbUrl = $state('');
  let nbKey = $state('');
  let poll: ReturnType<typeof setInterval> | undefined;


  function lane(provider: MeshProvider): Lane {
    const app = statuses.find((s) => s.kind === provider);
    const emb = statuses.find((s) => s.kind === 'embedded' && s.state !== 'not-installed');
    const embHere = emb && (emb.provider ?? 'tailscale') === provider ? emb : undefined;
    if (app?.state === 'connected') return { provider, kind: provider, via: 'app', status: app };
    if (embHere && embHere.state !== 'stopped') return { provider, kind: 'embedded', via: 'embedded', status: embHere };
    if (emb) return { provider, kind: 'embedded', via: 'embedded' };
    if (app && app.state !== 'not-installed') return { provider, kind: provider, via: 'app', status: app };
    return { provider, kind: provider, via: 'none', status: app };
  }

  const lanes = $derived(loaded ? (['tailscale', 'netbird'] as const).map(lane) : []);
  const connected = (l: Lane) => l.status?.state === 'connected';
  const pending = (l: Lane) => l.status?.state === 'needs-login' || l.status?.state === 'connecting';
  // The embedded NetBird node's pending sign-in is for the server and key now in the fields (else connect anew).
  const current = (l: Lane) => l.provider !== 'netbird' || l.kind !== 'embedded' || pendingMatches(l.status, nbUrl, nbKey);
  // In the banner, only lanes that can do something without a detour.
  const shown = $derived(compact ? lanes.filter((l) => l.via !== 'none') : lanes);
  // Installed Tailscale / NetBird apps: listed under Advanced, since a connected one is used without asking.
  const apps = $derived(statuses.filter((s) => s.kind !== 'embedded' && s.state !== 'not-installed'));
  const nbFields = $derived(lanes.some((l) => l.provider === 'netbird' && l.kind === 'embedded' && !connected(l)));
  const appState = (s: VpnStatus) => t(`shell.status.vpn.${s.state === 'needs-login' ? 'needsLogin' : s.state === 'stopped' ? 'off' : s.state}`);

  async function refresh(): Promise<void> {
    try {
      const wasUp = lanes.some(connected);
      statuses = await w.vpn.status();
      // The saved self-hosted server, shown in its field when the panel opens.
      if (!loaded && !nbUrl) nbUrl = statuses.find((s) => s.kind === 'embedded' && s.provider === 'netbird')?.managementUrl ?? '';
      loaded = true;
      // Only after a sign-in started here, so opening the page never triggers a retry.
      if (poll && !wasUp && lanes.some(connected)) onconnected?.();
      if (poll && !lanes.some(pending)) {
        clearInterval(poll);
        poll = undefined;
      }
    } catch {
      loaded = true;
    }
  }

  function sub(l: Lane): string {
    const s = l.status;
    if (l.via === 'none') return t('vpn.status.notAvailable', { name: NAMES[l.provider] });
    if (!s) return caption(l.provider);
    switch (s.state) {
      case 'connected': {
        const device = s.selfName ?? s.selfDnsName ?? s.ips[0] ?? t('vpn.status.thisPc');
        return l.via === 'app' ? t('vpn.status.connectedApp', { device, name: NAMES[l.provider] }) : t('vpn.status.connected', { device });
      }
      case 'needs-login':
        return s.error ?? (s.authUrl ? t('vpn.status.finishInBrowser') : t('vpn.status.loginRequired'));
      case 'connecting':
        return t('vpn.status.connecting');
      case 'error':
        return s.error ?? t('vpn.status.unavailable');
      default:
        return l.via === 'app' ? t('vpn.status.appDisconnected', { name: NAMES[l.provider] }) : caption(l.provider);
    }
  }

  async function connect(l: Lane): Promise<void> {
    if (l.via === 'none') {
      if (l.status?.downloadUrl) void w.app.openExternal(l.status.downloadUrl);
      return;
    }
    if (l.status?.authUrl && pending(l) && current(l)) {
      void w.app.openExternal(l.status.authUrl);
      return;
    }
    busy = l.provider;
    try {
      const options =
        l.kind === 'embedded'
          ? {
              provider: l.provider,
              // '' = NetBird's hosted service.
              managementUrl: l.provider === 'netbird' ? nbUrl.trim() : undefined,
              authKey: l.provider === 'netbird' && nbKey.trim() ? nbKey.trim() : undefined,
            }
          : undefined;
      // Armed before connecting, so a login finished meanwhile still counts.
      poll ??= setInterval(() => void refresh(), 3000);
      const r = await w.vpn.connect(l.kind, options);
      nbKey = '';
      if (r.authUrl) toast('info', t('vpn.toast.finishInBrowser', { name: NAMES[l.provider] }));
      await refresh();
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = null;
    }
  }

  async function signOut(l: Lane): Promise<void> {
    busy = l.provider;
    try {
      await w.vpn.embedded.logout();
      if (open === l.provider) open = null;
      await refresh();
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = null;
    }
  }

  async function togglePeers(l: Lane): Promise<void> {
    if (open === l.provider) {
      open = null;
      return;
    }
    open = l.provider;
    peers = null;
    try {
      const list = await w.vpn.peers(l.kind);
      if (open === l.provider) peers = list;
    } catch (err) {
      toast('error', errorMessage(err));
      open = null;
    }
  }

  onMount(() => {
    void refresh();
    // Back from the browser login or the VPN app.
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    const off = w.vpn.embedded?.onChange?.(() => void refresh());
    return () => {
      window.removeEventListener('focus', onFocus);
      off?.();
      if (poll) clearInterval(poll);
    };
  });
</script>

{#snippet action(l: Lane)}
  {#if connected(l)}
    <button class="pill" class:on={open === l.provider} onclick={() => togglePeers(l)} {disabled} aria-expanded={open === l.provider} title={t('vpn.actions.pickDeviceTitle')}>
      {t('vpn.actions.pickDevice')}
    </button>
  {:else if busy === l.provider || (pending(l) && !l.status?.authUrl && current(l))}
    <span class="pill quiet"><span class="spinner"></span></span>
  {:else if pending(l) && current(l)}
    <button class="pill" onclick={() => connect(l)} {disabled}>{t('vpn.actions.reopen')} <Icon name="externalLink" size={13} /></button>
  {:else if l.via === 'none'}
    {#if l.status?.downloadUrl}
      <button class="pill" onclick={() => connect(l)}>{t('vpn.actions.install')} <Icon name="externalLink" size={13} /></button>
    {/if}
  {:else}
    <button class="pill strong" onclick={() => connect(l)} disabled={disabled || busy !== null}>
      {compact || l.via === 'app' ? t('vpn.actions.connect') : t('common.actions.signIn')}
    </button>
  {/if}
{/snippet}

{#snippet peerList(l: Lane)}
  <div class="peers" transition:slide={{ duration: dur('med'), easing: cubicOut }}>
    {#if peers === null}
      <p class="note"><span class="spinner"></span> {t('vpn.peers.searching')}</p>
    {:else if peers.length === 0}
      <p class="note">{t('vpn.peers.none')}</p>
      {#if onbyaddress}<button class="link" onclick={onbyaddress}>{t('welcome.where.vpn.byAddress')}</button>{/if}
    {:else}
      {#each peers as peer (peer.name + (peer.ips[0] ?? ''))}
        {@const server = peer.servers[0]}
        <button class="peer" disabled={!server || disabled} onclick={() => server && onpick(server.address, `vpn:${server.id}`)} title={server?.address}>
          <span class="meta">
            <span class="peer-name">{peer.name}</span>
            <span class="sub">
              {#if server}
                {kindLabel(server.kind)} · {server.name}
              {:else if !peer.online}
                {t('common.status.offline')}
              {:else}
                {t('vpn.peers.noServer', { ports: fmt.list(['8096', '8920']) })}
              {/if}
            </span>
          </span>
          {#if server}<span class="add">{t('common.actions.add')}</span>{/if}
        </button>
      {/each}
    {/if}
    {#if l.kind === 'embedded' && !compact}
      <button class="link" onclick={() => signOut(l)} disabled={disabled || busy !== null}>{t('vpn.actions.signOutOf', { name: NAMES[l.provider] })}</button>
    {/if}
  </div>
{/snippet}

{#if compact}
  {#if shown.length > 0}
    <ul class="rows">
      {#each shown as l (l.provider)}
        <li>
          <div class="row">
            <span class="glyph"><Icon name="network" size={16} /></span>
            <span class="meta">
              <span class="name">{NAMES[l.provider]}</span>
              <span class="sub wrap">{sub(l)}</span>
            </span>
            {@render action(l)}
          </div>
          {#if open === l.provider}{@render peerList(l)}{/if}
        </li>
      {/each}
    </ul>
  {/if}
{:else if loaded}
  <div class="remote">
    <div class="choices">
      {#each shown as l (l.provider)}
        {@const idle = !connected(l) && !pending(l) && busy !== l.provider && l.via !== 'none'}
        {#if idle}
          <button class="tile choice" onclick={() => connect(l)} disabled={disabled || busy !== null}>
            <span class="glyph"><Icon name="network" size={20} /></span>
            <span class="title">{t('vpn.actions.signInWith', { name: NAMES[l.provider] })}</span>
            <span class="sub wrap">{sub(l)}</span>
          </button>
        {:else}
          <div class="tile" class:active={open === l.provider}>
            <span class="glyph"><Icon name="network" size={20} /></span>
            <span class="title">{NAMES[l.provider]}</span>
            <span class="sub wrap">{sub(l)}</span>
            <span class="tile-action">{@render action(l)}</span>
          </div>
        {/if}
      {/each}
    </div>

    {#each shown as l (l.provider)}
      {#if open === l.provider}<div class="inset">{@render peerList(l)}</div>{/if}
    {/each}

    {#if nbFields || apps.length}
      <button class="link" onclick={() => (advanced = !advanced)} aria-expanded={advanced}>
        {apps.length ? t('vpn.advanced.more') : t('vpn.advanced.toggle')}
        <span class="chev" class:up={advanced}><Icon name="chevronDown" size={13} /></span>
      </button>
      {#if advanced}
        <div class="advanced" transition:slide={{ duration: dur('med'), easing: cubicOut }}>
          {#if nbFields}
            <input class="field" placeholder={t('vpn.advanced.urlPlaceholder')} bind:value={nbUrl} spellcheck="false" autocomplete="off" aria-label={t('vpn.advanced.urlAria')} />
            <input class="field" type="password" placeholder={t('vpn.advanced.keyPlaceholder')} bind:value={nbKey} spellcheck="false" autocomplete="off" aria-label={t('vpn.advanced.keyAria')} />
            <p class="hint">{t('vpn.advanced.hint')}</p>
          {/if}
          {#if apps.length}
            <ul class="rows apps">
              {#each apps as a (a.kind)}
                <li class="row">
                  <span class="glyph"><Icon name="network" size={16} /></span>
                  <span class="meta">
                    <span class="name">{t('vpn.advanced.app', { name: NAMES[a.kind as MeshProvider] })}</span>
                    <span class="sub">{appState(a)}</span>
                  </span>
                </li>
              {/each}
            </ul>
            <p class="hint">{t('vpn.advanced.appsHint')}</p>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .remote {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .choices {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .tile {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    min-height: 116px;
    padding: 14px 14px 12px;
    border-radius: var(--r-md);
    background: var(--fill-1);
    box-shadow: inset 0 0 0 0.5px var(--separator);
    text-align: left;
  }
  .tile.active {
    background: var(--fill-2);
  }
  .choice {
    transition:
      transform var(--t-med) var(--spring);
  }
  .choice:hover,
  .choice:focus-visible {
    background: var(--fill-2);
  }
  .choice:active {
    transform: scale(0.98);
  }
  .choice:disabled {
    opacity: 0.5;
    pointer-events: none;
  }
  .tile .glyph {
    margin-bottom: 8px;
    color: var(--label-2);
  }
  .choice:hover .glyph {
    color: var(--label);
  }
  .title {
    font-size: var(--fs-headline);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .tile-action {
    margin-top: auto;
    padding-top: 10px;
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    border-radius: var(--r-md);
    background: var(--fill-1);
    box-shadow: inset 0 0 0 0.5px var(--separator);
    overflow: hidden;
  }
  .rows li + li {
    border-top: 1px solid var(--separator);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 46px;
    padding: 6px 8px 6px 10px;
  }
  .row .glyph {
    display: grid;
    place-items: center;
    width: 22px;
    flex: none;
    color: var(--label-2);
  }
  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .name {
    font-size: var(--fs-callout);
    font-weight: 600;
  }
  .sub {
    font-size: var(--fs-footnote);
    color: var(--label-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .sub.wrap {
    white-space: normal;
    line-height: 1.4;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: none;
    height: 28px;
    padding: 0 12px;
    border-radius: 999px;
    background: var(--fill-2);
    font-size: var(--fs-footnote);
    font-weight: 600;
    color: var(--label);
    transition:
      transform var(--t-med) var(--spring);
  }
  .pill:hover,
  .pill:focus-visible,
  .pill.on {
    background: var(--fill-3);
  }
  .pill.strong {
    background: var(--fill-3);
  }
  .pill.strong:hover {
    background: var(--fill-4);
  }
  .pill.quiet {
    background: none;
  }
  .pill:active {
    transform: scale(0.96);
  }
  .pill:disabled {
    opacity: 0.4;
    pointer-events: none;
  }
  .pill :global(.wi-icon) {
    color: var(--label-2);
  }

  .inset {
    border-radius: var(--r-md);
    background: var(--fill-1);
    box-shadow: inset 0 0 0 0.5px var(--separator);
    overflow: hidden;
  }
  .peers {
    display: flex;
    flex-direction: column;
    padding: 6px;
  }
  .rows .peers {
    padding: 0 6px 6px;
  }
  .note {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    padding: 10px 12px;
    font-size: var(--fs-callout);
    color: var(--label-3);
  }
  .peer {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 48px;
    padding: 6px 10px 6px 12px;
    border-radius: var(--r-sm);
    text-align: left;
  }
  .rows .peer {
    padding-left: 38px;
  }
  .peer:not(:disabled):hover,
  .peer:focus-visible {
    background: var(--fill-2);
  }
  .peer:disabled {
    cursor: default;
  }
  .peer:disabled .peer-name {
    color: var(--label-3);
  }
  .peer-name {
    font-size: var(--fs-callout);
    font-weight: 600;
  }
  .add {
    padding: 4px 12px;
    border-radius: 999px;
    background: var(--fill-2);
    font-size: var(--fs-footnote);
    font-weight: 600;
    color: var(--label);
  }

  .link {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: 4px;
    margin: 2px 4px 0;
    padding: 4px 0;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .link:hover,
  .link:focus-visible {
    color: var(--label);
  }
  .peers .link {
    margin: 4px 12px 2px;
  }
  .chev {
    display: grid;
    transition: transform var(--t-med) var(--ease);
  }
  .chev.up {
    transform: rotate(180deg);
  }
  .advanced {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .hint {
    margin: 0 4px;
    font-size: var(--fs-footnote);
    line-height: 1.5;
    color: var(--label-3);
  }

  .spinner {
    width: 14px;
    height: 14px;
    flex: none;
    border-radius: 50%;
    background: conic-gradient(from 90deg, transparent 10%, var(--label-2));
    mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px));
    animation: spin var(--t-spin) linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 520px) {
    .choices {
      grid-template-columns: 1fr;
    }
  }
</style>
