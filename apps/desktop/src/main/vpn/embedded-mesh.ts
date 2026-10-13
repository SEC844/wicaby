import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { MeshPath, MeshProvider, VpnConnectOptions, VpnConnectResult, VpnPeer, VpnStatus } from '../../shared/contract';
import { setAddressRoute } from '../connection/api-client';
import { JsonStore } from '../core/json-store';
import { logger } from '../core/log';
import type { CredentialVault } from '../core/vault';
import { t } from '../i18n';
import type { VpnProvider } from './index';

const log = logger.scope('mesh');

const VAULT_KEY = 'mesh-auth-key';
const RESTART_DELAYS_S = [1, 2, 5, 10, 30, 60];

// What wicaby-mesh (packages/mesh) reports on stdout.
interface HelperPeer {
  name: string;
  dnsName?: string;
  ips: string[];
  online: boolean;
  os?: string;
}
interface HelperStatus {
  state: 'connecting' | 'needs-login' | 'connected' | 'error';
  authUrl?: string;
  userCode?: string;
  selfName?: string;
  selfDnsName?: string;
  ips: string[];
  dnsSuffix?: string;
  error?: string;
  peers: HelperPeer[];
  // CIDRs routed through a peer (NetBird network routes).
  routes?: string[];
}

interface Prefs {
  enabled: boolean;
  provider: MeshProvider;
  managementUrl?: string;
}

// Packaged: resources/vpn-helper. Development: vendor/vpn-helper at the repo root (appRoot is apps/desktop).
export function locateMeshHelper(resourcesPath: string, appRoot: string, platform: NodeJS.Platform = process.platform): string | null {
  for (const dir of [path.join(resourcesPath, 'vpn-helper'), path.join(appRoot, '..', '..', 'vendor', 'vpn-helper')]) {
    const exe = path.join(dir, platform === 'win32' ? 'wicaby-mesh.exe' : 'wicaby-mesh');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

// Whether host:port takes a TCP connection directly (no mesh) within 1.5 s.
function reachable(h: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: h, port, timeout: 1500 });
    const done = (ok: boolean) => (sock.destroy(), resolve(ok));
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

const NETBIRD_HOSTED ='https://api.netbird.io:443';

// NetBird's config.json holds the peer key, registered with the management server named next to it. embed
// takes a new ManagementURL over the saved one (profilemanager apply()) but then presents that key to the new
// server, which never registered it: a config saved for another server is dropped, so the node signs in afresh.
export function dropForeignNetbirdConfig(dir: string, managementUrl: string | undefined): boolean {
  let saved: { Scheme?: string; Host?: string } | undefined;
  try {
    saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).ManagementURL;
  } catch {
    return false;
  }
  if (!saved?.Host) return false;
  try {
    // origin drops the default port: https://api.netbird.io:443 and https://api.netbird.io are the same server.
    if (new URL(`${saved.Scheme || 'https'}://${saved.Host}`).origin ===new URL(managementUrl || NETBIRD_HOSTED).origin) return false;
  } catch {
    return false;
  }
  try {
    for (const f of ['config.json', 'state.json']) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    // Locked: the helper then meets the old key and falls back to the browser sign-in.
    return false;
  }
  return true;
}

const host = (h: string) => h.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

function originOf(address: string): string | null {
  try {
    const u = new URL(address);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

export interface EmbeddedMeshOptions {
  exe: string | null;
  dataDir: string; // <userData>/mesh, one state dir per provider below it
  vault: CredentialVault;
  deviceName: string;
}

// Wicaby's own node on the user's Tailscale or NetBird network, run by the
// wicaby-mesh helper in userspace (no driver, service or admin rights). Servers
// on the mesh are reached through loopback forwarders the helper opens per
// server; api-client rewrites their URLs, so net.fetch, wicaby-media://, mpv and
// the WebSocket need no proxy and nothing else can leave through the helper.
export class EmbeddedMesh extends EventEmitter implements VpnProvider {
  readonly kind = 'embedded' as const;
  private readonly prefs: JsonStore<Prefs>;
  private proc: ChildProcess | null = null;
  private helper: HelperStatus | null = null;
  private last: VpnStatus;
  // origin -> loopback base; `wanted` survives helper restarts and is reopened.
  private routes = new Map<string, string>();
  private readonly wanted = new Set<string>();
  private pending = new Map<number, (r: { base?: string; error?: string }) => void>();
  private logoutWaiter: ((error: string) => void) | null = null;
  private nextId = 1;
  private crashes = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  // Diagnostics (vpn.diagnostics): the last 40 helper log lines and the last error, this run only.
  private readonly tail: string[] = [];
  private lastError: VpnStatus['lastError'];

  constructor(private readonly opts: EmbeddedMeshOptions) {
    super();
    fs.mkdirSync(opts.dataDir, { recursive: true });
    this.prefs = new JsonStore<Prefs>(path.join(opts.dataDir, 'wicaby.json'), { enabled: false, provider: 'tailscale' }, 0);
    this.last = this.computeStatus();
    setAddressRoute({ ensure: (a) => this.ensureRoute(a), rewrite: (u) => this.rewrite(u) });
  }

  private get hostname(): string {
    const base = this.opts.deviceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `wicaby-${base || 'pc'}`.slice(0, 63).replace(/-+$/, '');
  }

  // ---- VpnProvider ----

  async status(): Promise<VpnStatus> {
    return this.last;
  }

  async peers(): Promise<VpnPeer[]> {
    return (this.helper?.peers ?? []).map((p) => ({ kind: 'embedded' as const, name: p.name, dnsName: p.dnsName, ips: p.ips, online: p.online, os: p.os, servers: [] }));
  }

  // Signs in (or switches mesh). Resolves once connected or as soon as a
  // sign-in URL is known; the facade opens it.
  async connect(options: VpnConnectOptions = {}): Promise<VpnConnectResult> {
    if (!this.opts.exe) throw new Error(t('errors.vpn.embeddedMissing'));
    const prev = this.prefs.value;
    const provider = options.provider ?? prev.provider;
    // '' = the hosted service.
    const managementUrl = (options.managementUrl ?? (provider === prev.provider ? prev.managementUrl : undefined)) || undefined;
    const changed = provider !== prev.provider || managementUrl !== prev.managementUrl;
    this.prefs.set({ enabled: true, provider, managementUrl });
    if (options.authKey) await this.opts.vault.set(VAULT_KEY, { userId: provider, userName: VAULT_KEY, token: options.authKey });
    if (changed || options.authKey || this.helper?.state === 'error') this.halt();
    if (!this.proc) this.launch();
    const s = await this.settle(25_000, (st) => st.state === 'connected' || st.state === 'error' || Boolean(st.authUrl));
    if (s.state === 'error') throw new Error(s.error || t('errors.vpn.connectFailed'));
    return { status: s, authUrl: s.authUrl };
  }

  dispose(): void {
    this.halt();
  }

  logTail(): string[] {
    return [...this.tail];
  }

  // ---- Commands ----

  // Relaunches the node at startup when the user left it signed in. Settles once
  // it is connected, needs the user, or after 10 s.
  async resume(): Promise<void> {
    if (!this.prefs.value.enabled || !this.opts.exe) return;
    this.launch();
    await this.settle(10_000, (st) => st.state !== 'connecting');
  }

  // Signs this node out of the mesh (key expired / peer removed) and turns it off.
  async logout(): Promise<VpnStatus> {
    if (this.proc) {
      const done = new Promise<string>((resolve) => {
        this.logoutWaiter = resolve;
        setTimeout(() => resolve('timed out'), 25_000);
      });
      this.send({ cmd: 'logout' });
      const error = await done;
      this.logoutWaiter = null;
      if (error) log.warn(`logout: ${error}`);
    }
    if (this.opts.vault.get(VAULT_KEY)) await this.opts.vault.delete(VAULT_KEY);
    this.prefs.set({ ...this.prefs.value, enabled: false });
    this.halt();
    this.publish();
    return this.last;
  }

  // Stops the node and keeps its sign-in: the next connect() starts it again without the browser.
  turnOff(): VpnStatus {
    this.prefs.set({ ...this.prefs.value, enabled: false });
    this.halt();
    this.publish();
    return this.last;
  }

  private settle(ms: number, done: (s: VpnStatus) => boolean): Promise<VpnStatus> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.off('change', check);
        resolve(this.last);
      };
      const check = (s: VpnStatus) => done(s) && finish();
      const timer = setTimeout(finish, ms);
      this.on('change', check);
      if (done(this.last)) finish();
    });
  }

  // ---- Helper process ----

  private send(cmd: Record<string, unknown>): void {
    this.proc?.stdin?.write(JSON.stringify(cmd) + '\n');
  }

  private launch(): void {
    if (this.proc || !this.opts.exe) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const { provider, managementUrl } = this.prefs.value;
    const dir = path.join(this.opts.dataDir, provider);
    if (provider === 'netbird' && dropForeignNetbirdConfig(dir, managementUrl)) log.info('netbird: management server changed, signing in afresh');
    const args = ['--provider', provider, '--dir', dir, '--hostname', this.hostname];
    if (managementUrl) args.push('--control-url', managementUrl);
    log.info(`starting ${provider} node ${this.hostname}${managementUrl ? ` (${managementUrl})` : ''}`);
    const startedAt = Date.now();
    const proc = spawn(this.opts.exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    this.helper = null;
    this.routes.clear();
    proc.stdin?.on('error', () => undefined);
    createInterface({ input: proc.stdout! }).on('line', (line) => this.onLine(line));
    createInterface({ input: proc.stderr! }).on('line', (line) => {
      // Sign-in links and codes stay out of the log.
      const clean = line.replace(/https?:\/\/\S+/g, '<url>').replace(/user_code=\S+/g, '');
      this.tail.push(clean.slice(0, 400));
      if (this.tail.length > 40) this.tail.shift();
      if (/panic|fatal|level=error|\berror\b/i.test(clean)) log.warn(clean);
      else log.debug(clean);
    });
    proc.on('error', (err) => log.error('wicaby-mesh failed to start', err));
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.helper = null;
      this.routes.clear();
      for (const reply of this.pending.values()) reply({ error: 'node stopped' });
      this.pending.clear();
      if (this.prefs.value.enabled) {
        if (Date.now() - startedAt > 60_000) this.crashes = 0;
        const delay = RESTART_DELAYS_S[Math.min(this.crashes++, RESTART_DELAYS_S.length - 1)];
        log.warn(`wicaby-mesh exited (${code ?? signal}), restarting in ${delay}s`);
        this.restartTimer = setTimeout(() => this.launch(), delay * 1000);
      }
      this.publish();
    });
    // The key travels on stdin only; tsnet and NetBird ignore it once registered.
    this.send({ cmd: 'start', authKey: this.opts.vault.get(VAULT_KEY)?.token ?? '' });
    this.publish();
  }

  // Closing stdin lets the helper leave cleanly; the kill is the backstop.
  private halt(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const proc = this.proc;
    this.proc = null;
    this.helper = null;
    this.routes.clear();
    if (!proc) return;
    proc.stdin?.end();
    const timer = setTimeout(() => proc.exitCode === null && proc.kill(), 3000);
    timer.unref();
  }

  private onLine(line: string): void {
    let msg: { type?: string; id?: number; base?: string; error?: string } & Partial<HelperStatus>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'status') {
      const wasConnected = this.helper?.state === 'connected';
      this.helper = msg as unknown as HelperStatus;
      if (this.helper.error && this.helper.error !== this.lastError?.message) this.lastError = { message: this.helper.error, at: Date.now() };
      if (this.helper.state === 'connected' && !wasConnected) {
        this.crashes = 0;
        // Registered: the node key is the credential from now on. Dropped in memory at once;
        // the write is queued in the vault and never rejects.
        if (this.opts.vault.get(VAULT_KEY)) void this.opts.vault.delete(VAULT_KEY);
        for (const origin of this.wanted) void this.ensureRoute(origin);
      }
      this.publish();
    } else if (msg.type === 'forward' && typeof msg.id === 'number') {
      this.pending.get(msg.id)?.({ base: msg.base, error: msg.error });
      this.pending.delete(msg.id);
    } else if (msg.type === 'logout') {
      this.logoutWaiter?.(msg.error ?? '');
    }
  }

  // ---- Routing (used by api-client) ----

  private isMeshHost(h: string): boolean {
    const st = this.helper;
    if (st?.state !== 'connected') return false;
    const want = host(h);
    return st.peers.some((p) => p.ips.some((ip) => host(ip) === want) || (p.dnsName && host(p.dnsName) === want));
  }

  // In a network a peer routes (NetBird network route), e.g. the home LAN behind a routing peer.
  private inRoutedNet(h: string): boolean {
    const st = this.helper;
    const ip = host(h);
    const family = net.isIP(ip);
    if (st?.state !== 'connected' || !family || !st.routes?.length) return false;
    const list = new net.BlockList();
    for (const r of st.routes) {
      const [base, bits] = r.split('/');
      const f = net.isIP(base);
      // Never a default route (exit node): that would send every address through the mesh.
      if (f && Number(bits) > 0) list.addSubnet(base, Number(bits), f === 6 ? 'ipv6' : 'ipv4');
    }
    return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
  }

  private async ensureRoute(address: string): Promise<MeshPath> {
    const origin = originOf(address);
    if (!origin) return 'outside';
    if (this.routes.has(origin)) return 'mesh';
    if (this.helper?.state !== 'connected') return 'off';
    const { hostname, port, protocol } = new URL(origin);
    if (!this.isMeshHost(hostname)) {
      if (!this.inRoutedNet(hostname)) return 'outside';
      // A routed network is often the LAN itself (at home): direct first, the mesh only when it does not answer.
      if (await reachable(host(hostname), Number(port) || (protocol === 'https:' ? 443 : 80))) return 'direct';
    }
    const id = this.nextId++;
    const reply = await new Promise<{ base?: string; error?: string }>((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.delete(id)) resolve({ error: 'timed out' });
      }, 5000);
      this.send({ cmd: 'forward', id, upstream: origin });
    });
    if (reply.base && /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+$/.test(reply.base)) {
      this.routes.set(origin, reply.base);
      this.wanted.add(origin);
      log.info(`route ${origin} via mesh`);
      return 'mesh';
    }
    log.warn(`no route to ${origin}: ${reply.error ?? 'invalid reply'}`);
    return 'failed';
  }

  private rewrite(url: string): string {
    if (this.routes.size === 0) return url;
    const origin = originOf(url);
    const base = origin && this.routes.get(origin);
    const head = /^https?:\/\/[^/?#]*/i.exec(url);
    if (!base || !head) return url;
    // Path and query are passed on byte for byte; only scheme://host:port changes.
    const rest = url.slice(head[0].length);
    return base + (rest === '' || rest.startsWith('/') ? rest : `/${rest}`);
  }

  // ---- Status ----

  private computeStatus(): VpnStatus {
    const { enabled, provider, managementUrl } = this.prefs.value;
    const lastError = this.lastError;
    if (!this.opts.exe) return { kind: 'embedded', provider, state: 'not-installed', ips: [] };
    if (!enabled) return { kind: 'embedded', provider, managementUrl, state: 'stopped', ips: [], lastError };
    const h = this.helper;
    if (!this.proc || !h) return { kind: 'embedded', provider, managementUrl, state: 'connecting', selfName: this.hostname, ips: [], lastError };
    return {
      kind: 'embedded',
      provider,
      managementUrl,
      state: h.state,
      // Before sign-in Tailscale reports the PC name, not the node name we asked for.
      selfName: h.state === 'connected' ? h.selfDnsName?.split('.')[0] || h.selfName || this.hostname : this.hostname,
      selfDnsName: h.selfDnsName || undefined,
      ips: h.ips ?? [],
      dnsSuffix: h.dnsSuffix || undefined,
      authUrl: h.state === 'needs-login' && /^https:\/\//i.test(h.authUrl ?? '') ? h.authUrl : undefined,
      error: h.error || undefined,
      routes: h.routes?.length ? h.routes : undefined,
      lastError,
    };
  }

  private publish(): void {
    const next = this.computeStatus();
    if (JSON.stringify(next) === JSON.stringify(this.last)) return;
    if (next.state !== this.last.state) log.info(`${next.provider}: ${this.last.state} -> ${next.state}`);
    this.last = next;
    this.emit('change', next);
  }
}
