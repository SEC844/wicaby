<script lang="ts">
  // The sidebar's status dot and its popover: every connection the app holds (media servers, the VPN,
  // qBittorrent), live from the pushed session, VPN and torrents state. Opens on hover and on focus.
  import { onMount, type Snippet } from 'svelte';
  import type { ServerSession, VpnStatus } from '../../shared/contract';
  import ConnectionList, { listedServers, serverLevel, shownVpn, torrentsLevel, torrentsShown, vpnLevel, type Level } from './ConnectionList.svelte';
  import { w } from '../lib/bridge';
  import { t } from '../lib/i18n.svelte';
  import { navigate, router } from '../lib/router.svelte';
  import { session } from '../lib/stores.svelte';
  import { initTorrents } from '../lib/torrents.svelte';

  // The sidebar's text gets the dot's level, so its sub-line never says "connected" next to an orange dot.
  let { children }: { children: Snippet<[Level]> } = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement>();
  let pos = $state({ left: 0, bottom: 0, maxHeight: 0 });
  let vpn = $state<VpnStatus[]>([]);
  let latency = $state<Record<string, number>>({});
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  // Whether the popover asked qBittorrent for live numbers (the Torrents tab drives that itself).
  let watching = false;

  const servers = $derived(listedServers());
  const vpnShown = $derived(shownVpn(vpn));
  const tor = $derived(torrentsShown());

  // Red: the current server is offline. Orange: anything else degraded. Green otherwise.
  const level = $derived<Level>(
    session.value.status === 'offline' || session.value.sessions[0]?.status === 'offline'
      ? 'bad'
      : [...servers.map(serverLevel), ...vpnShown.map(vpnLevel), torrentsLevel()].some((l) => l !== 'ok')
        ? 'warn'
        : 'ok',
  );

  async function loadVpn(): Promise<void> {
    vpn = await w.vpn.status().catch(() => vpn);
  }

  onMount(() => {
    initTorrents();
    void loadVpn();
    // The embedded node pushes its changes; installed clients are asked again each time the popover opens.
    const off = w.vpn.embedded.onChange((st) => {
      vpn = [...vpn.filter((v) => v.kind !== 'embedded'), st];
    });
    return () => {
      off();
      clearTimeout(closeTimer);
      if (watching) void w.torrents.watch('off');
    };
  });

  // One request per signed-in server each time the popover opens: its round trip is the latency shown.
  async function measure(s: ServerSession): Promise<void> {
    const t0 = performance.now();
    try {
      await w.api.get('/System/Info/Public', undefined, s.server.id);
      latency[s.server.id] = Math.round(performance.now() - t0);
    } catch {
      delete latency[s.server.id];
    }
  }

  function show(): void {
    clearTimeout(closeTimer);
    if (open || !root) return;
    const r = root.getBoundingClientRect();
    // Bottom-left of the window: the popover grows up and to the right, inside the window.
    pos = { left: Math.max(8, r.left), bottom: innerHeight - r.top + 6, maxHeight: Math.max(160, r.top - 14) };
    open = true;
    void loadVpn();
    for (const s of servers) if (s.status === 'signed-in') void measure(s);
    if (tor && router.route.name !== 'downloads') {
      watching = true;
      void w.torrents.watch('bg');
    }
  }

  function hide(): void {
    clearTimeout(closeTimer);
    open = false;
    if (watching && router.route.name !== 'downloads') void w.torrents.watch('off');
    watching = false;
  }

  // A short grace period lets the pointer cross the gap between the dot and the popover.
  const hideSoon = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(hide, 180);
  };

  function go(path: string): void {
    hide();
    navigate(path);
  }

  function focusOut(e: FocusEvent): void {
    if (!root?.contains(e.relatedTarget as Node | null)) hide();
  }

  $effect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      hide();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (hover only mirrors what focus does on the button) -->
<div class="server" bind:this={root} onmouseenter={show} onmouseleave={hideSoon} onfocusin={show} onfocusout={focusOut}>
  <button
    type="button"
    class="trigger"
    aria-expanded={open}
    aria-controls="connection-status"
    aria-describedby="connection-status-summary"
    onclick={() => (open ? hide() : show())}
  >
    <span class="status {level}"></span>
    {@render children(level)}
  </button>
  <span id="connection-status-summary" hidden>{t(`shell.status.level.${level}`)}</span>

  {#if open}
    <div
      id="connection-status"
      class="pop"
      role="group"
      aria-label={t('shell.status.title')}
      style:left="{pos.left}px"
      style:bottom="{pos.bottom}px"
      style:max-height="{pos.maxHeight}px"
    >
      <ConnectionList {vpn} {latency} onnavigate={go} />
    </div>
  {/if}
</div>

<style>
  .server {
    flex: none;
    margin: 0 12px 14px;
  }
  .trigger {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 8px 4px;
    border-radius: var(--r-sm);
    text-align: left;
    white-space: nowrap;
  }
  .trigger:is(:hover, :focus-visible, [aria-expanded='true']) {
    background: var(--fill-1);
  }
  .status {
    width: 40px;
    flex: none;
    display: grid;
    place-items: center;
  }
  .status::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--success);
  }
  .warn::before {
    background: var(--warning);
  }
  .bad::before {
    background: var(--danger);
  }

  .pop {
    position: fixed;
    z-index: 40;
    width: 320px;
    max-width: calc(100vw - 16px);
    overflow-y: auto;
    padding: 6px;
    border-radius: var(--r-md);
    background: var(--material-thick);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    box-shadow: var(--shadow-2), inset 0 0 0 1px var(--hairline);
    transform-origin: bottom left;
    animation: pop var(--t-med) var(--spring) both;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.94) translate3d(0, 4px, 0);
    }
  }
</style>
