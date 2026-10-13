<script lang="ts">
  import { kindLabel } from '../../../shared/server-caps';
  // Settings > Remote access (onboarding spec 3): the VPN this PC is on, its devices and the servers they
  // host, routed networks, the self-hosted server, and redacted diagnostics. Signed out, sign-in stays in
  // VpnPanel. A connected Tailscale or NetBird app is shown read-only: that app manages it.
  import { onMount } from 'svelte';
  import type { MeshProvider, VpnPeer, VpnStatus } from '../../../shared/contract';
  import { vpnStateLabel } from '../../components/ConnectionList.svelte';
  import Icon from '../../components/Icon.svelte';
  import Sheet from '../../components/Sheet.svelte';
  import VpnPanel from '../../components/VpnPanel.svelte';
  import { w } from '../../lib/bridge';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { navigate } from '../../lib/router.svelte';
  import { errorMessage, session, toast } from '../../lib/stores.svelte';
  import { copy } from './shared.svelte';

  const NAMES: Record<MeshProvider, string> = { tailscale: 'Tailscale', netbird: 'NetBird' };

  let statuses = $state<VpnStatus[]>([]);
  let loaded = $state(false);
  let peers = $state<VpnPeer[] | null>(null);
  let peersFor = '';
  let finding = $state(false);
  let busy = $state(false);
  let switching = $state(false);
  let editing = $state(false);
  let url = $state('');
  let key = $state('');

  const providerOf = (s: VpnStatus): MeshProvider => (s.kind === 'embedded' ? (s.provider ?? 'tailscale') : s.kind);
  const embedded = $derived(statuses.find((s) => s.kind === 'embedded' && s.state !== 'not-installed'));
  // The network in use: a connected app first (Wicaby uses it as is), else Wicaby's own node unless it is off.
  const active = $derived(statuses.find((s) => s.kind !== 'embedded' && s.state === 'connected') ?? (embedded?.state !== 'stopped' ? embedded : undefined));
  const viaApp = $derived(active !== undefined && active.kind !== 'embedded');
  const other = $derived<MeshProvider>(active && providerOf(active) === 'tailscale' ? 'netbird' : 'tailscale');
  const LEVELS: Record<string, string> = { connected: 'ok', 'needs-login': 'warn', connecting: 'warn', error: 'bad' };
  const level = (s: VpnStatus) => LEVELS[s.state] ?? 'idle';
  const lastError = $derived(active?.lastError ?? embedded?.lastError);
  const hostOf = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };
  const saved = (id: string) => session.value.sessions.some((s) => s.server.id === id);

  async function load(): Promise<void> {
    try {
      statuses = await w.vpn.status();
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      loaded = true;
    }
  }

  // Devices first (fast); their servers only on "Find Servers", which asks each one on 8096 and 8920.
  async function loadPeers(withServers: boolean): Promise<void> {
    if (!active) return;
    const kind = active.kind;
    finding = withServers;
    try {
      const list = await w.vpn.peers(kind, withServers);
      // Online first, then by name.
      if (active?.kind === kind) peers = list.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      finding = false;
    }
  }

  $effect(() => {
    const ready = active?.state === 'connected' ? active.kind : '';
    if (ready === peersFor) return;
    peersFor = ready;
    peers = null;
    if (ready) void loadPeers(false);
  });

  async function run(action: () => Promise<unknown>): Promise<void> {
    busy = true;
    try {
      await action();
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = false;
      await load();
    }
  }

  const connect = (provider: MeshProvider, extra: { managementUrl?: string; authKey?: string } = {}) => run(() => w.vpn.connect('embedded', { provider, ...extra }));

  function signIn(s: VpnStatus): void {
    if (s.authUrl) void w.app.openExternal(s.authUrl);
    else void connect(providerOf(s));
  }

  // Leaving one mesh for the other: sign out (the node key goes), then sign in to the other.
  function doSwitch(): void {
    switching = false;
    const to = other;
    void run(async () => {
      await w.vpn.embedded.logout();
      await w.vpn.connect('embedded', { provider: to });
    });
  }

  function openEdit(): void {
    url = active?.managementUrl ?? '';
    key = '';
    editing = true;
  }

  function saveEdit(): void {
    if (!active) return;
    editing = false;
    // A new server halts the node and signs in afresh (embedded-mesh.ts connect()).
    void connect(providerOf(active), { managementUrl: url.trim(), authKey: key.trim() || undefined });
    key = '';
  }

  // The same path as VpnPanel's pick on the server page: add, select, then sign in.
  async function add(address: string): Promise<void> {
    busy = true;
    try {
      const info = await w.servers.add(address);
      const state = await w.servers.select(info.id);
      const s = state.sessions.find((x) => x.server.id === info.id);
      navigate(s?.status === 'signed-in' ? '/home' : `/login/${info.id}`);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = false;
    }
  }

  async function copyDiagnostics(): Promise<void> {
    try {
      await navigator.clipboard.writeText(await w.vpn.diagnostics());
      toast('info', t('settings.remote.diag.copied'));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  onMount(() => {
    void load();
    const off = w.vpn.embedded.onChange((st) => {
      statuses = [...statuses.filter((v) => v.kind !== 'embedded'), st];
    });
    // Back from the browser sign-in or the VPN app.
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      off();
      window.removeEventListener('focus', onFocus);
    };
  });
</script>

{#snippet value(label: string, text: string, mono = true)}
  <button type="button" class="row link-row" onclick={() => copy(text)} title={t('common.actions.copy')}>
    <span class="txt"><span class="lbl">{label}</span></span>
    <span class="val" class:mono>{text}</span>
  </button>
{/snippet}

{#if loaded}
  <div class="remote-pane" data-state={active?.state ?? 'stopped'}>
    <h3 class="gh first">{t('settings.remote.status.title')}</h3>
    <div class="group">
      {#if active}
        <div class="row">
          <span class="dot {level(active)}"></span>
          <div class="txt">
            <div class="lbl">{NAMES[providerOf(active)]} · {viaApp ? t('shell.status.vpn.app') : t('shell.status.vpn.embedded')}</div>
            <div class="desc">
              {#if viaApp}{t('settings.remote.managedByApp', { name: NAMES[providerOf(active)] })}{:else}{active.managementUrl ? hostOf(active.managementUrl) : t('settings.remote.advanced.hosted')}{/if}
            </div>
            {#if active.state === 'error' && active.error}<div class="desc err">{active.error}</div>{/if}
          </div>
          <span class="state {level(active)}" data-label>{vpnStateLabel(active)}</span>
        </div>
        {#if !viaApp}
          <div class="row actions">
            {#if active.state === 'needs-login'}
              <button type="button" class="push" data-action="sign-in" disabled={busy} onclick={() => signIn(active)}>
                {active.authUrl ? t('vpn.actions.reopen') : t('common.actions.signIn')}
              </button>
            {:else if active.state === 'error'}
              <button type="button" class="push" data-action="retry" disabled={busy} onclick={() => connect(providerOf(active))}>{t('common.actions.retry')}</button>
            {/if}
            {#if active.state !== 'needs-login'}
              <button type="button" class="push" data-action="turn-off" disabled={busy} onclick={() => run(() => w.vpn.embedded.turnOff())}>{t('settings.remote.actions.turnOff')}</button>
            {/if}
            <button type="button" class="push" data-action="sign-out" disabled={busy} onclick={() => run(() => w.vpn.embedded.logout())}>{t('settings.remote.actions.signOut')}</button>
            <button type="button" class="push ghost" data-action="switch" disabled={busy} onclick={() => (switching = true)}>{t('settings.remote.actions.switch', { name: NAMES[other] })}</button>
          </div>
        {/if}
      {:else}
        <div class="row">
          <span class="dot idle"></span>
          <div class="txt">
            <div class="lbl">{embedded ? `${NAMES[providerOf(embedded)]} · ${t('shell.status.vpn.embedded')}` : t('settings.panes.remote.label')}</div>
            <div class="desc">{t('settings.panes.remote.blurb')}</div>
          </div>
          <span class="state" data-label>{t('shell.status.vpn.off')}</span>
        </div>
        <div class="panel"><VpnPanel disabled={busy} onpick={(a) => add(a)} onconnected={() => void load()} /></div>
      {/if}
    </div>

    {#if active?.state === 'connected'}
      <h3 class="gh">{t('settings.remote.device.title')}</h3>
      <div class="group">
        {@render value(t('settings.remote.device.name'), active.selfDnsName ?? active.selfName ?? '–')}
        {#if active.ips[0]}{@render value(t('settings.remote.device.address'), active.ips[0])}{/if}
      </div>

      <div class="gh-row">
        <h3 class="gh">{t('settings.remote.peers.title', { count: peers?.length ?? 0 })}</h3>
        <button type="button" class="push ghost small" data-action="find-servers" disabled={finding || peers === null} onclick={() => loadPeers(true)}>
          {#if finding}<span class="spinner"></span>{/if}
          {t('settings.remote.peers.find')}
        </button>
      </div>
      <div class="group peers">
        {#if peers === null}
          <div class="row"><span class="desc">{t('vpn.peers.searching')}</span></div>
        {:else if peers.length === 0}
          <div class="row"><span class="desc">{t('vpn.peers.none')}</span></div>
        {:else}
          {#each peers as peer (peer.name + (peer.ips[0] ?? ''))}
            {@const server = peer.servers[0]}
            <div class="row peer" data-peer={peer.name} data-online={peer.online}>
              <button type="button" class="peer-main" onclick={() => peer.ips[0] && copy(peer.ips[0])} title={t('common.actions.copy')}>
                <span class="dot" class:ok={peer.online} class:idle={!peer.online}></span>
                <span class="txt">
                  <span class="lbl">{peer.name}</span>
                  <span class="desc"><span class="mono">{peer.ips[0] ?? ''}</span>{peer.os ? ` · ${peer.os}` : ''}{peer.online ? '' : ` · ${t('common.status.offline')}`}</span>
                </span>
                {#if server}<span class="badge" data-server>{t('settings.remote.peers.server', { kind: kindLabel(server.kind), name: server.name })}</span>{/if}
              </button>
              {#if server && !saved(server.id)}
                <button type="button" class="push" data-action="add" disabled={busy} onclick={() => add(server.address)}>{t('common.actions.add')}</button>
              {/if}
            </div>
          {/each}
        {/if}
      </div>

      {#if active.routes?.length}
        <h3 class="gh">{t('settings.remote.routes.title')}</h3>
        <div class="group" data-routes>
          {#each active.routes as route (route)}
            <div class="row"><span class="mono val">{route}</span></div>
          {/each}
        </div>
      {/if}
    {/if}

    {#if active && !viaApp}
      <h3 class="gh">{t('settings.remote.advanced.title')}</h3>
      <div class="group">
        <div class="row">
          <div class="txt">
            <div class="lbl">{t('settings.remote.advanced.management')}</div>
            <div class="desc mono">{active.managementUrl ? hostOf(active.managementUrl) : t('settings.remote.advanced.hosted')}</div>
          </div>
          <button type="button" class="push" data-action="change" disabled={busy} onclick={openEdit}>{t('settings.remote.advanced.change')}</button>
        </div>
      </div>
    {/if}

    <h3 class="gh">{t('settings.remote.diag.title')}</h3>
    <div class="group">
      <div class="row">
        <div class="txt">
          <div class="lbl">{lastError ? t('settings.remote.diag.lastError', { message: lastError.message }) : t('settings.remote.diag.none')}</div>
          {#if lastError}<div class="desc">{fmt.date(lastError.at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>{/if}
        </div>
      </div>
      <div class="row actions">
        <button type="button" class="push" data-action="copy-diagnostics" onclick={copyDiagnostics}>{t('settings.remote.diag.copy')}</button>
        <button type="button" class="push ghost" onclick={() => w.app.openPath('logs')}>{t('settings.remote.diag.logs')}</button>
      </div>
    </div>
  </div>
{/if}

<Sheet open={switching} onclose={() => (switching = false)} label={t('settings.remote.actions.switch', { name: NAMES[other] })} width={440}>
  <div class="sheet-body">
    <h2>{t('settings.remote.actions.switch', { name: NAMES[other] })}</h2>
    <p>{t('settings.remote.switch.body', { name: active ? NAMES[providerOf(active)] : '' })}</p>
    <div class="sheet-actions">
      <button type="button" class="btn ghost" onclick={() => (switching = false)}>{t('common.actions.cancel')}</button>
      <button type="button" class="btn primary" data-autofocus onclick={doSwitch}>{t('common.actions.confirm')}</button>
    </div>
  </div>
</Sheet>

<Sheet open={editing} onclose={() => (editing = false)} label={t('settings.remote.advanced.management')} width={480}>
  <form
    class="sheet-body"
    onsubmit={(e) => {
      e.preventDefault();
      saveEdit();
    }}
  >
    <h2>{t('settings.remote.advanced.management')}</h2>
    <input class="field" placeholder={t('vpn.advanced.urlPlaceholder')} bind:value={url} spellcheck="false" autocomplete="off" aria-label={t('vpn.advanced.urlAria')} />
    <input class="field" type="password" placeholder={t('vpn.advanced.keyPlaceholder')} bind:value={key} spellcheck="false" autocomplete="off" aria-label={t('vpn.advanced.keyAria')} />
    <p class="hint">{t('vpn.advanced.hint')}</p>
    <div class="sheet-actions">
      <button type="button" class="btn ghost" onclick={() => (editing = false)}>{t('common.actions.cancel')}</button>
      <button type="submit" class="btn primary">{t('common.actions.save')}</button>
    </div>
  </form>
</Sheet>

<style>
  .gh {
    margin: 30px 0 8px 2px;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
  }
  .gh.first {
    margin-top: 0;
  }
  .gh-row {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
  }
  .gh-row .push {
    margin-bottom: 4px;
  }
  .group {
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
    overflow: hidden;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 52px;
    padding: 10px 18px;
  }
  .row + .row::before,
  .panel::before {
    content: '';
    position: absolute;
    top: 0;
    left: 18px;
    right: 0;
    height: 1px;
    background: var(--separator);
  }
  .link-row {
    width: 100%;
    text-align: left;
  }
  .link-row:is(:hover, :focus-visible),
  .peer-main:is(:hover, :focus-visible) {
    background: var(--fill-1);
  }
  .actions {
    flex-wrap: wrap;
    gap: 8px;
    min-height: 0;
    padding-block: 10px 14px;
  }
  .actions::before {
    display: none;
  }
  .panel {
    position: relative;
    padding: 14px 18px 16px;
  }
  .txt {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .lbl {
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--label);
  }
  .desc {
    display: block;
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.45;
  }
  .desc.err {
    color: var(--danger);
  }
  .val {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-callout);
    color: var(--label-2);
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
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--label-3);
  }
  .dot.ok {
    background: var(--success);
  }
  .dot.warn {
    background: var(--warning);
  }
  .dot.bad {
    background: var(--danger);
  }
  .peer {
    padding: 0 12px 0 0;
  }
  .peer-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 52px;
    padding: 8px 6px 8px 18px;
    text-align: left;
  }
  .badge {
    flex: none;
    padding: 3px 10px;
    border-radius: 999px;
    background: var(--fill-2);
    font-size: var(--fs-footnote);
    color: var(--label);
  }
  .push {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 12px;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    font-size: var(--fs-callout);
    font-weight: 500;
    color: var(--label);
    white-space: nowrap;
    transition: background-color var(--t-fast) var(--ease);
  }
  .push:hover,
  .push:focus-visible {
    background: var(--fill-3);
  }
  .push.ghost {
    background: transparent;
    color: var(--label-2);
  }
  .push.ghost:hover,
  .push.ghost:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  .push.small {
    height: 24px;
    font-size: var(--fs-footnote);
  }
  .push:disabled {
    color: var(--label-4);
    pointer-events: none;
  }
  .spinner {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: conic-gradient(from 90deg, transparent 10%, var(--label-2));
    mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px));
    animation: spin calc(0.8s * var(--tempo)) linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .sheet-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 28px 28px 22px;
  }
  .sheet-body h2 {
    margin: 0;
    font-size: var(--fs-title-3, 20px);
    font-weight: 650;
  }
  .sheet-body p {
    margin: 0;
    font-size: var(--fs-callout);
    line-height: 1.5;
    color: var(--label-2);
  }
  .sheet-body .hint {
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .sheet-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 6px;
  }
  /* Settings search: hairlines only between rows that are still shown. */
  :global(.searching) .row::before {
    display: none;
  }
  :global(.searching) .row:not([hidden]) ~ .row:not([hidden])::before {
    display: block;
  }
</style>
