import type { ServerKind, VpnConnectOptions, VpnConnectResult, VpnKind, VpnPeer, VpnStatus } from '../../shared/contract';
import { probeFirst } from '../connection/api-client';
import { logger } from '../core/log';
import { t } from '../i18n';
import { redactDiagnostics } from './diagnostics';
import type { VpnFixture } from './fixture';
import { classifyAddress, NetbirdClient, TailscaleClient } from './vpn-clients';

const log = logger.scope('vpn');

// A peer plus its underlay endpoints (LAN/WAN IPs), used to match a server
// known by its LAN address to the same machine on the overlay. Never sent to the UI.
export type PeerInfo = VpnPeer & { endpoints?: string[] };

// One overlay network Wicaby can see or drive. The installed Tailscale and
// NetBird clients implement it in vpn-clients.ts; the embedded userspace
// mesh node (embedded-mesh.ts, Tailscale or NetBird) plugs in through VpnService.setEmbedded().
export interface VpnProvider {
  readonly kind: VpnKind;
  // Cheap to call repeatedly: providers cache their own status for a few seconds.
  status(): Promise<VpnStatus>;
  // Brings the network up. Resolves as soon as it is running or an interactive
  // login URL is known (the facade opens it in the browser). Options matter to
  // the embedded node only; installed clients ignore them (their own settings rule).
  connect(options?: VpnConnectOptions): Promise<VpnConnectResult>;
  // Peers as reported by the client, `servers` left empty (the facade probes them).
  peers(): Promise<PeerInfo[]>;
  // The embedded node's recent helper log lines, for diagnostics.
  logTail?(): string[];
  dispose?(): void;
}

export interface ServerHints {
  name: string;
  addresses: string[];
  // Addresses the stored token is bound to: a peer that carries one of their hosts is this server's machine.
  trusted?: string[];
}

// trusted: the peer was matched by a host of a bound address (its overlay IP, MagicDNS name or a LAN endpoint),
// not only by a name, which whoever owns the peer picks.
export interface VpnCandidate {
  address: string;
  trusted: boolean;
}

const PEER_PROBE_MS = 2500;
const SERVER_PORTS = [8096, 8920];

function hostOf(address: string): string | null {
  try {
    return new URL(address).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

function portOf(address: string): number | null {
  try {
    const u = new URL(address);
    return u.port ? Number(u.port) : null;
  } catch {
    return null;
  }
}

const label = (s: string | undefined) => (s ?? '').toLowerCase().replace(/\.$/, '').split('.')[0];
const urlHost = (h: string) => (h.includes(':') ? `[${h}]` : h);

export class VpnService {
  private readonly installed: VpnProvider[] = [new TailscaleClient(), new NetbirdClient()];
  private embedded: VpnProvider | null = null;

  // fixture: dev builds only (fixture.ts), null otherwise.
  constructor(
    private readonly openExternal: (url: string) => void,
    private readonly fixture: (() => VpnFixture) | null = null,
  ) {}

  setEmbedded(provider: VpnProvider | null): void {
    this.embedded?.dispose?.();
    this.embedded = provider;
  }

  get embeddedProvider(): VpnProvider | null {
    return this.embedded;
  }

  private get providers(): VpnProvider[] {
    return this.embedded ? [...this.installed, this.embedded] : this.installed;
  }

  private provider(kind: VpnKind): VpnProvider {
    const p = this.providers.find((x) => x.kind === kind);
    if (!p) throw new Error(t('errors.vpn.unavailable'));
    return p;
  }

  status(): Promise<VpnStatus[]> {
    if (this.fixture) return Promise.resolve(this.fixture().status);
    return Promise.all(
      this.providers.map((p) => p.status().catch((err): VpnStatus => ({ kind: p.kind, state: 'error', ips: [], error: String(err?.message ?? err) }))),
    );
  }

  async connect(kind: VpnKind, options?: VpnConnectOptions): Promise<VpnConnectResult> {
    const result = await this.provider(kind).connect(options);
    if (result.authUrl && /^https:\/\//i.test(result.authUrl)) {
      log.info(`${kind}: opening login page`);
      this.openExternal(result.authUrl);
    }
    return result;
  }

  private async rawPeers(kind: VpnKind): Promise<PeerInfo[]> {
    return this.fixture ? (this.fixture().peers?.[kind] ?? []) : this.provider(kind).peers();
  }

  // Online peers, each probed on 8096/8920 so the UI can offer one-click add (unless withServers is false).
  async peers(kind: VpnKind, withServers = true): Promise<VpnPeer[]> {
    const peers: VpnPeer[] = (await this.rawPeers(kind)).map(({ endpoints: _e, ...p }) => ({ ...p, servers: [] }));
    if (!withServers) return peers.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    await Promise.all(
      peers
        .filter((p) => p.online)
        .map(async (peer) => {
          const hosts = [...peer.ips.filter((ip) => !ip.includes(':')), peer.dnsName].filter(Boolean) as string[];
          const urls = hosts.flatMap((h) => SERVER_PORTS.map((port) => `${port === 8920 ? 'https' : 'http'}://${urlHost(h)}:${port}`));
          try {
            const probe = await probeFirst(urls, PEER_PROBE_MS);
            peer.servers = [{ address: probe.address, name: probe.info.ServerName, kind: probe.kind as ServerKind, id: probe.info.Id }];
          } catch {
            // Not a media server, or a firewall drops the ports.
          }
        }),
    );
    return peers.sort((a, b) => Number(b.servers.length > 0) - Number(a.servers.length > 0) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  // Which overlay network an address belongs to, from its shape alone.
  networkOf(address: string | undefined): VpnKind | undefined {
    const host = address ? hostOf(address) : null;
    return host ? classifyAddress(host) : undefined;
  }

  // Extra addresses for a server that may only be reachable over a connected
  // VPN: an online peer whose host name matches the server name or one of its
  // known hosts, or whose endpoints include the server's LAN IP.
  async candidatesFor(server: ServerHints): Promise<VpnCandidate[]> {
    const known = server.addresses.map(hostOf).filter(Boolean) as string[];
    const bound = (server.trusted ?? []).map(hostOf).filter(Boolean) as string[];
    const names = new Set([label(server.name), ...known.filter((h) => !/^[\d.:]+$/.test(h)).map(label)].filter(Boolean));
    const port = server.addresses.map(portOf).find((p) => p !== null) ?? 8096;
    const out = new Map<string, boolean>();
    for (const status of await this.status()) {
      if (status.state !== 'connected') continue;
      const peers = await this.rawPeers(status.kind).catch(() => [] as PeerInfo[]);
      for (const peer of peers) {
        if (!peer.online) continue;
        const hosts = [...peer.ips, peer.dnsName?.replace(/\.$/, '')].filter(Boolean) as string[];
        const carried = [...hosts, ...(peer.endpoints ?? [])].map((h) => h.toLowerCase());
        const match = carried.some((h) => known.includes(h)) || names.has(label(peer.name)) || names.has(label(peer.dnsName));
        if (!match) continue;
        const trusted = carried.some((h) => bound.includes(h));
        for (const h of hosts) if (!h.includes(':')) out.set(`http://${h}:${port}`, (out.get(`http://${h}:${port}`) ?? false) || trusted);
      }
    }
    return [...out].map(([address, trusted]) => ({ address, trusted }));
  }

  // Plain text for a support request, redacted (diagnostics.ts): every network Wicaby sees, its peers counted
  // (never probed), the last error and the embedded node's recent log.
  async diagnostics(version: string, platform: string): Promise<string> {
    const now = (ms = Date.now()) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
    const lines = [`Wicaby ${version} (desktop, ${platform}) · ${now()}`];
    const names: string[] = [];
    for (const s of await this.status()) {
      if (s.state === 'not-installed') continue;
      const provider = s.kind === 'embedded' ? `${s.provider ?? 'tailscale'} (embedded)` : `${s.kind} (app)`;
      lines.push('', `provider: ${provider} · state: ${s.state}${s.kind === 'embedded' ? ` · management: ${s.managementUrl || 'hosted'}` : ''}`);
      const peers = s.state === 'connected' ? await this.rawPeers(s.kind).catch(() => [] as PeerInfo[]) : [];
      names.push(...[s.selfName, s.selfDnsName, ...peers.flatMap((p) => [p.name, p.dnsName])].filter((n): n is string => Boolean(n)));
      lines.push(`self: ${[s.selfDnsName ?? s.selfName ?? '-', ...s.ips].join(' ')} · peers: ${peers.length} (${peers.filter((p) => p.online).length} online)`);
      if (s.routes?.length) lines.push(`routes: ${s.routes.join(', ')}`);
      if (s.lastError) lines.push(`last error (${now(s.lastError.at)}): ${s.lastError.message}`);
      else if (s.error) lines.push(`error: ${s.error}`);
    }
    const tail = this.fixture ? (this.fixture().log ?? []) : (this.embedded?.logTail?.() ?? []);
    if (tail.length) lines.push('', `log (last ${tail.length} mesh lines):`, ...tail);
    return redactDiagnostics(lines.join('\n'), names);
  }

  dispose(): void {
    for (const p of this.providers) p.dispose?.();
  }
}
