<script lang="ts" module>
  // Every connection the app holds (media servers, the VPN, qBittorrent), live from the pushed session, VPN and
  // torrents state: the sidebar status popover (ConnectionStatus) and the first-run setup's last step list it.
  import type { ServerSession, VpnStatus } from '../../shared/contract';
  import { isLocalSource } from '../../shared/server-caps';
  import { t } from '../lib/i18n.svelte';
  import { session, settings } from '../lib/stores.svelte';
  import { torrents } from '../lib/torrents.svelte';

  export type Level = 'ok' | 'warn' | 'bad';

  const MESH = { tailscale: 'Tailscale', netbird: 'NetBird' } as const;

  // File and IPTV sources are listed with the sources, not as connections.
  export const listedServers = () => session.value.sessions.filter((s) => s.status !== 'server-selected' && !isLocalSource(s.server.kind));
  export const serverLevel = (s: ServerSession): Level =>
    s.status === 'offline' ? 'bad' : s.status === 'connecting' || s.socket === 'down' ? 'warn' : 'ok';
  // The embedded node when it is on, and installed clients that were found.
  export const shownVpn = (vpn: VpnStatus[]) => vpn.filter((v) => v.state !== 'not-installed' && (v.kind !== 'embedded' || v.state !== 'stopped'));
  export const vpnLevel = (v: VpnStatus): Level => (v.state === 'connected' || v.state === 'stopped' ? 'ok' : 'warn');
  export const vpnName = (v: VpnStatus) =>
    v.kind === 'embedded' ? `${MESH[v.provider ?? 'tailscale']} · ${t('shell.status.vpn.embedded')}` : `${MESH[v.kind]} · ${t('shell.status.vpn.app')}`;
  export const vpnStateLabel = (v: VpnStatus) => t(`shell.status.vpn.${v.state === 'needs-login' ? 'needsLogin' : v.state === 'stopped' ? 'off' : v.state}`);
  export const torrentsShown = () => (settings.value?.torrents.url && torrents.value?.status !== 'unconfigured' ? torrents.value : null);
  export const torrentsLevel = (): Level => {
    const tor = torrentsShown();
    return !tor || tor.status === 'online' || tor.status === 'connecting' ? 'ok' : 'warn';
  };
</script>

<script lang="ts">
  import { kindLabel } from '../../shared/server-caps';
  import type { Snippet } from 'svelte';
  import { fmt } from '../lib/i18n.svelte';
  import { speed } from '../lib/torrents.svelte';

  let {
    vpn,
    latency = {},
    interactive = true,
    onnavigate,
  }: {
    vpn: VpnStatus[];
    latency?: Record<string, number>;
    // false: plain rows that link nowhere (the setup's summary).
    interactive?: boolean;
    onnavigate?: (path: string) => void;
  } = $props();

  const servers = $derived(listedServers());
  const vpnShown = $derived(shownVpn(vpn));
  const tor = $derived(torrentsShown());
  const torLevel = $derived(torrentsLevel());

  const serverState = (s: ServerSession) => t(`shell.status.server.${{ ok: 'connected', warn: 'reconnecting', bad: 'offline' }[serverLevel(s)]}`);
  const host = (a: string) => a.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  const ms = (id: string) =>
    latency[id] === undefined ? '' : fmt.number(latency[id], { style: 'unit', unit: 'millisecond', unitDisplay: 'short' });
  const where = (s: ServerSession) =>
    [host(s.address ?? ''), s.route && t(`shell.status.route.${s.route}`), s.status === 'signed-in' && ms(s.server.id)].filter(Boolean).join(' · ');
  const go = (path: string) => onnavigate?.(path);
</script>

{#snippet row(level: Level, path: string, idle: boolean, body: Snippet)}
  {#if interactive}
    <button type="button" class="row" onclick={() => go(path)}><span class="dot {level}" class:idle></span><span class="main">{@render body()}</span></button>
  {:else}
    <div class="row"><span class="dot {level}" class:idle></span><span class="main">{@render body()}</span></div>
  {/if}
{/snippet}

{#if servers.length}
  <div class="section">{t('shell.status.servers')}</div>
  {#each servers as s (s.server.id)}
    {@const l = serverLevel(s)}
    {#snippet body()}
      <span class="head">
        <span class="name">{s.server.name}<span class="kind">{kindLabel(s.server.kind)}</span></span>
        <span class="state {l}">{serverState(s)}</span>
      </span>
      {#if s.address}<span class="sub tabular">{where(s)}</span>{/if}
      {#if s.socket}<span class="sub">{t(`shell.status.socket.${s.socket}`)}</span>{/if}
    {/snippet}
    {@render row(l, '/settings?pane=server', false, body)}
  {/each}
{/if}

{#if vpnShown.length}
  <div class="section">{t('shell.status.vpnTitle')}</div>
  {#each vpnShown as v (v.kind)}
    {@const l = vpnLevel(v)}
    {#snippet body()}
      <span class="head">
        <span class="name">{vpnName(v)}</span>
        <span class="state {l}">{vpnStateLabel(v)}</span>
      </span>
      {#if v.state === 'connected' && (v.ips.length || v.selfName)}
        <span class="sub tabular">{[v.ips[0], v.selfDnsName ?? v.selfName].filter(Boolean).join(' · ')}</span>
      {/if}
      {#if v.routes?.length}<span class="sub tabular">{t('shell.status.vpn.routes', { routes: v.routes.join(', ') })}</span>{/if}
      {#if v.state === 'error' && v.error}<span class="sub">{v.error}</span>{/if}
    {/snippet}
    {@render row(l, '/settings?pane=remote', v.state === 'stopped', body)}
  {/each}
{/if}

{#if tor}
  <div class="section">qBittorrent</div>
  {#snippet body()}
    <span class="head">
      <span class="name">qBittorrent{#if tor.version}<span class="kind">{tor.version}</span>{/if}</span>
      <span class="state {torLevel}">{t(`shell.status.torrents.${tor.status}`)}</span>
    </span>
    {#if tor.status === 'online'}
      <span class="sub tabular">↓ {speed(tor.transfer.dlSpeed)} · ↑ {speed(tor.transfer.upSpeed)}</span>
    {/if}
  {/snippet}
  {@render row(torLevel, '/settings?pane=torrents', false, body)}
{/if}

<!-- The Remote access page stays reachable with the VPN off. -->
{#if interactive && !vpnShown.length}
  <button type="button" class="foot" onclick={() => go('/settings?pane=remote')}>{t('shell.status.remoteLink')}</button>
{/if}

<style>
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--success);
    transition: background-color var(--t-med) var(--ease);
  }
  .dot.warn {
    background: var(--warning);
  }
  .dot.bad {
    background: var(--danger);
  }
  .dot.idle {
    background: var(--label-3);
  }
  .section {
    padding: 8px 10px 4px;
    font-size: var(--fs-caption);
    font-weight: 600;
    color: var(--label-3);
  }
  .section:not(:first-child) {
    margin-top: 4px;
    border-top: 1px solid var(--separator);
    padding-top: 10px;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    padding: 7px 10px;
    border-radius: var(--r-xs);
    text-align: left;
    color: var(--label);
  }
  button.row:is(:hover, :focus-visible) {
    background: var(--fill-2);
  }
  .row .dot {
    flex: none;
    margin-top: 6px;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-callout);
    font-weight: 560;
  }
  .kind {
    margin-left: 6px;
    font-weight: 400;
    color: var(--label-3);
  }
  .state {
    flex: none;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .state.warn {
    color: var(--warning);
  }
  .state.bad {
    color: var(--danger);
  }
  .sub {
    font-size: var(--fs-footnote);
    color: var(--label-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .foot {
    display: block;
    width: 100%;
    margin-top: 4px;
    padding: 9px 10px 7px;
    border-top: 1px solid var(--separator);
    border-radius: 0 0 var(--r-xs) var(--r-xs);
    text-align: left;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .foot:is(:hover, :focus-visible) {
    color: var(--label);
    background: var(--fill-2);
  }
</style>
