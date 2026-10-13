import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { VpnConnectResult, VpnKind, VpnState, VpnStatus } from '../../shared/contract';
import { logger } from '../core/log';
import { t } from '../i18n';
import type { PeerInfo, VpnProvider } from './index';

const log = logger.scope('vpn');

const STATUS_TTL_MS = 5000;
const STATUS_TIMEOUT_MS = 5000;
// `up` blocks until the browser login finishes; let it wait that long, then give up.
const UP_TIMEOUT_MS = 5 * 60_000;
// Resolve connect() once the client is clearly not going to print a login URL.
const UP_SETTLE_MS = 20_000;

export const DOWNLOAD_URLS: Record<'tailscale' | 'netbird', string> = {
  tailscale: 'https://tailscale.com/download/windows',
  netbird: 'https://netbird.io/download',
};

// ---- Address classification ----

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// 100.64.0.0/10, the CGNAT range both Tailscale and NetBird allocate from.
export function isCgnat(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return n !== null && n >>> 22 === (100 << 2) + 1;
}

// Overlay IPs seen in the last status calls, so a 100.x address can be told
// apart between Tailscale and NetBird (they share the range).
const knownIps = new Map<string, VpnKind>();
// DNS suffixes seen in status (MagicDNS name, NetBird's configurable peer domain).
const knownSuffixes = new Map<string, VpnKind>();
let lastInstalled: { tailscale: boolean; netbird: boolean } = { tailscale: false, netbird: false };

export function classifyAddress(host: string): VpnKind | undefined {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h.endsWith('.ts.net') || /^fd7a:115c:a1e0:/.test(h)) return 'tailscale';
  for (const [suffix, kind] of knownSuffixes) if (h.endsWith(`.${suffix}`)) return kind === 'embedded' ? 'tailscale' : kind;
  if (h.endsWith('.netbird.cloud') || h.endsWith('.netbird.selfhosted')) return 'netbird';
  if (!isCgnat(h)) return undefined;
  const seen = knownIps.get(h);
  if (seen) return seen === 'embedded' ? 'tailscale' : seen;
  return lastInstalled.netbird && !lastInstalled.tailscale ? 'netbird' : 'tailscale';
}

const bareIp = (s: string) => s.replace(/\/\d+$/, '');
const stripDot = (s: string | undefined) => (s ? s.replace(/\.$/, '') : undefined);

// ---- Parsers (pure, exercised by tools/checks/vpn-selfcheck) ----

export interface Snapshot {
  status: VpnStatus;
  peers: PeerInfo[];
}

interface TsNode {
  HostName?: string;
  DNSName?: string;
  OS?: string;
  UserID?: number;
  TailscaleIPs?: string[] | null;
  Online?: boolean;
  Addrs?: string[] | null;
  CurAddr?: string;
}

interface TsStatus {
  BackendState?: string;
  AuthURL?: string;
  TailscaleIPs?: string[] | null;
  Self?: TsNode;
  MagicDNSSuffix?: string;
  CurrentTailnet?: { Name?: string; MagicDNSSuffix?: string } | null;
  Health?: string[] | null;
  Peer?: Record<string, TsNode> | null;
  User?: Record<string, { LoginName?: string; DisplayName?: string }> | null;
}

const TS_STATES: Record<string, VpnState> = {
  Running: 'connected',
  NeedsLogin: 'needs-login',
  NeedsMachineAuth: 'needs-login',
  Starting: 'connecting',
  Stopped: 'stopped',
  NoState: 'stopped',
};

export function parseTailscale(json: string): Snapshot {
  const s = JSON.parse(json) as TsStatus;
  const self = s.Self ?? {};
  const state = TS_STATES[s.BackendState ?? ''] ?? 'stopped';
  const status: VpnStatus = {
    kind: 'tailscale',
    state,
    selfName: self.HostName || stripDot(self.DNSName)?.split('.')[0],
    selfDnsName: stripDot(self.DNSName),
    ips: s.TailscaleIPs ?? self.TailscaleIPs ?? [],
    dnsSuffix: stripDot(s.CurrentTailnet?.MagicDNSSuffix ?? s.MagicDNSSuffix) || undefined,
    authUrl: s.AuthURL || undefined,
    error: s.BackendState === 'NeedsMachineAuth' ? t('errors.vpn.awaitingApproval') : undefined,
  };
  const peers = Object.values(s.Peer ?? {})
    // Mullvad exit nodes show up as peers; they never host a media server.
    .filter((p) => !/\.mullvad\.ts\.net\.?$/i.test(p.DNSName ?? ''))
    .map((p) => ({
      kind: 'tailscale' as const,
      name: p.HostName || stripDot(p.DNSName)?.split('.')[0] || '?',
      dnsName: stripDot(p.DNSName),
      ips: p.TailscaleIPs ?? [],
      online: Boolean(p.Online),
      os: p.OS || undefined,
      servers: [],
      endpoints: [...(p.Addrs ?? []), p.CurAddr ?? ''].filter(Boolean).map((a) => a.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')),
    }));
  return { status, peers };
}

interface NbPeer {
  fqdn?: string;
  netbirdIp?: string;
  netbirdIpv6?: string;
  status?: string;
  iceCandidateEndpoint?: { local?: string; remote?: string };
}

interface NbStatus {
  daemonStatus?: string;
  management?: { url?: string; connected?: boolean; error?: string };
  signal?: { connected?: boolean };
  netbirdIp?: string;
  netbirdIpv6?: string;
  fqdn?: string;
  lazyConnectionEnabled?: boolean;
  peers?: { total?: number; connected?: number; details?: NbPeer[] | null };
}

const NB_STATES: Record<string, VpnState> = {
  Connected: 'connected',
  Connecting: 'connecting',
  NeedsLogin: 'needs-login',
  LoginFailed: 'needs-login',
  SessionExpired: 'needs-login',
  Idle: 'stopped',
  Disconnected: 'stopped',
};

export function parseNetbird(json: string): Snapshot {
  const s = JSON.parse(json) as NbStatus;
  let state: VpnState = NB_STATES[s.daemonStatus ?? ''] ?? (s.management?.connected ? 'connected' : 'stopped');
  if (state === 'connected' && s.management && !s.management.connected) state = 'connecting';
  const fqdn = stripDot(s.fqdn);
  const status: VpnStatus = {
    kind: 'netbird',
    state,
    selfName: fqdn?.split('.')[0],
    selfDnsName: fqdn,
    ips: [s.netbirdIp, s.netbirdIpv6].filter(Boolean).map((ip) => bareIp(ip!)),
    dnsSuffix: fqdn?.includes('.') ? fqdn.slice(fqdn.indexOf('.') + 1) : undefined,
    error: s.management?.error || undefined,
  };
  const peers = (s.peers?.details ?? []).map((p) => {
    const dnsName = stripDot(p.fqdn);
    return {
      kind: 'netbird' as const,
      name: dnsName?.split('.')[0] || bareIp(p.netbirdIp ?? '?'),
      dnsName,
      ips: [p.netbirdIp, p.netbirdIpv6].filter(Boolean).map((ip) => bareIp(ip!)),
      // With lazy connections an idle peer is still reachable on first packet.
      online: p.status === 'Connected' || (Boolean(s.lazyConnectionEnabled) && p.status === 'Idle'),
      servers: [],
      endpoints: p.iceCandidateEndpoint?.remote ? [p.iceCandidateEndpoint.remote.replace(/:\d+$/, '')] : [],
    };
  });
  return { status, peers };
}

// First https URL in CLI output: Tailscale prints "To authenticate, visit:"
// on stderr, NetBird its SSO verification link.
export function findLoginUrl(text: string): string | undefined {
  return /https:\/\/[^\s"'<>]+/.exec(text)?.[0];
}

// ---- Installed CLI driver ----

// Windows: <name>.exe under Program Files and LocalAppData/Programs, then PATH. Elsewhere: PATH, then
// the usual install folders (a desktop launcher's PATH can be minimal).
export function locate(name: string, dirs: string[], platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  if (platform !== 'win32') {
    const bins = [...(env.PATH ?? '').split(':').filter(Boolean), '/usr/local/bin', '/usr/bin'];
    return bins.map((d) => path.posix.join(d, name)).find((c) => fs.existsSync(c)) ?? null;
  }
  const exe = `${name}.exe`;
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean) as string[];
  const candidates = [...roots.flatMap((r) => dirs.map((d) => path.join(r, d, exe))), ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe))];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function run(file: string, args: string[], timeout = STATUS_TIMEOUT_MS): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

abstract class InstalledClient implements VpnProvider {
  abstract readonly kind: 'tailscale' | 'netbird';
  protected abstract readonly exe: string;
  protected abstract readonly dirs: string[];
  protected abstract readonly parse: (json: string) => Snapshot;
  protected abstract readonly upArgs: () => string[];

  private exePath: string | null | undefined;
  private cache: { at: number; value: Promise<Snapshot> } | null = null;
  private pendingUp: Promise<VpnConnectResult> | null = null;

  private locateExe(): string | null {
    // Re-check while missing, so installing the client mid-session is picked up.
    if (!this.exePath) this.exePath = locate(this.exe, this.dirs);
    lastInstalled = { ...lastInstalled, [this.kind]: Boolean(this.exePath) };
    return this.exePath;
  }

  private notInstalled(): Snapshot {
    return { status: { kind: this.kind, state: 'not-installed', ips: [], downloadUrl: DOWNLOAD_URLS[this.kind] }, peers: [] };
  }

  private async load(): Promise<Snapshot> {
    const exe = this.locateExe();
    if (!exe) return this.notInstalled();
    const { stdout, stderr, code } = await run(exe, ['status', '--json']);
    try {
      const snap = this.parse(stdout);
      for (const ip of [...snap.status.ips, ...snap.peers.flatMap((p) => p.ips)]) knownIps.set(ip, this.kind);
      if (snap.status.dnsSuffix) knownSuffixes.set(snap.status.dnsSuffix.toLowerCase(), this.kind);
      return snap;
    } catch {
      // No JSON: the background service is not running or refused us.
      const detail = (stderr || stdout).trim().split(/\r?\n/)[0]?.slice(0, 200);
      if (code !== 0 && detail) log.info(`${this.kind} status: ${detail}`);
      // The Tailscale service serves one Windows user at a time.
      if (/already in use by/i.test(detail ?? '')) return { status: { kind: this.kind, state: 'error', ips: [], error: t('errors.vpn.otherSession') }, peers: [] };
      return { status: { kind: this.kind, state: 'stopped', ips: [] }, peers: [] };
    }
  }

  snapshot(): Promise<Snapshot> {
    if (!this.cache || Date.now() - this.cache.at > STATUS_TTL_MS) this.cache = { at: Date.now(), value: this.load() };
    return this.cache.value;
  }

  async status(): Promise<VpnStatus> {
    return (await this.snapshot()).status;
  }

  async peers(): Promise<PeerInfo[]> {
    // Copies, since the facade fills `servers` in place.
    return (await this.snapshot()).peers.map((p) => ({ ...p, servers: [] }));
  }

  connect(): Promise<VpnConnectResult> {
    this.pendingUp ??= this.up().finally(() => (this.pendingUp = null));
    return this.pendingUp;
  }

  private async up(): Promise<VpnConnectResult> {
    const exe = this.locateExe();
    if (!exe) return { status: this.notInstalled().status };
    const before = await this.status();
    if (before.state === 'connected') return { status: before };
    if (before.authUrl) return { status: before, authUrl: before.authUrl };

    log.info(`${this.kind}: up`);
    const outcome = await new Promise<{ authUrl?: string; error?: string }>((resolve) => {
      let output = '';
      let done = false;
      const finish = (r: { authUrl?: string; error?: string }) => {
        if (done) return;
        done = true;
        clearTimeout(settle);
        resolve(r);
      };
      // Left running after we resolve: it exits by itself once the browser login completes.
      const child = spawn(exe, this.upArgs(), { windowsHide: true, timeout: UP_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        const url = findLoginUrl(output);
        if (url) finish({ authUrl: url });
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (err) => finish({ error: err.message }));
      child.on('exit', (code) => {
        this.cache = null;
        if (code === 0) finish({});
        else finish({ error: upError(output, this.kind) });
      });
      const settle = setTimeout(() => finish({}), UP_SETTLE_MS);
    });
    this.cache = null;
    const status = await this.status();
    if (outcome.error && status.state !== 'connected') {
      log.warn(`${this.kind} up failed: ${outcome.error}`);
      throw new Error(outcome.error);
    }
    return { status, authUrl: outcome.authUrl };
  }
}

export function upError(output: string, kind: 'tailscale' | 'netbird', platform: NodeJS.Platform = process.platform): string {
  // Tailscale refuses a bare `up` that would silently reset settings made elsewhere.
  if (/non-default|--reset/i.test(output)) return t('errors.vpn.tailscaleReset');
  if (/already in use by/i.test(output)) return t('errors.vpn.tailscaleBusy');
  // Linux: the daemon only takes `up` from root, or from the user set once with --operator.
  if (platform !== 'win32' && /access denied|permission denied|--operator|must be root/i.test(output)) return t(kind === 'tailscale' ? 'errors.vpn.needsOperator' : 'errors.vpn.needsRoot');
  if (/access is denied|accès refusé|permission|administrator|elevat/i.test(output)) return t('errors.vpn.needsAdmin');
  if (/is tailscale running|daemon.*(not running|unavailable)|failed to connect to daemon/i.test(output)) return t('errors.vpn.serviceStopped');
  const line = output.trim().split(/\r?\n/).find(Boolean);
  return line ? t('errors.vpn.upFailedDetail', { detail: line.slice(0, 160) }) : t('errors.vpn.upFailed');
}

export class TailscaleClient extends InstalledClient {
  readonly kind = 'tailscale' as const;
  protected readonly exe = 'tailscale';
  protected readonly dirs = ['Tailscale'];
  protected readonly parse = parseTailscale;
  // A "simple up" (only --json/--timeout) flips WantRunning without touching
  // the preferences the user chose in the Tailscale app. Never add other flags.
  protected readonly upArgs = () => ['up', '--json', `--timeout=${UP_TIMEOUT_MS / 1000}s`];
}

export class NetbirdClient extends InstalledClient {
  readonly kind = 'netbird' as const;
  protected readonly exe = 'netbird';
  protected readonly dirs = ['Netbird', 'NetBird'];
  protected readonly parse = parseNetbird;
  // We open the SSO link ourselves through shell.openExternal.
  protected readonly upArgs = () => ['up', '--no-browser'];
}
