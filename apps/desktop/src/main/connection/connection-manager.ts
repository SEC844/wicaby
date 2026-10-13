import { EventEmitter } from 'node:events';
import type { PublicUser, ServerInfo, ServerKind, ServerSession, SessionState, SessionStatus, VpnKind } from '../../shared/contract';
import type { AuthenticationResult, UserDto } from '../../shared/models';
import { JsonStore } from '../core/json-store';
import { logger } from '../core/log';
import { t } from '../i18n';
import type { CredentialVault, StoredCredential } from '../core/vault';
import type { VpnService } from '../vpn';
import { addressCandidates, ApiClient, ApiError, credentialOrigin, probeFirst, routed, tokenAllowed, type ClientIdentity, type ProbeResult } from './api-client';
import { hintAddress, sendWakeOnLan } from './discovery';
import { connectAuthenticate, connectExchange, connectServers } from './emby-connect';
import { ServerSocket, type SocketMessage } from './server-socket';

const log = logger.scope('connection');

interface WakeInfo {
  mac: string;
  port: number;
  broadcast?: string;
}

interface StoredServer {
  id: string;
  name: string;
  kind: ServerKind;
  version: string;
  manualAddress?: string;
  localAddress?: string;
  remoteAddress?: string;
  lastAddress?: string;
  // Addresses offered by untrusted sources (discovery, a probe answered at an
  // origin the token is not bound to, add() of a known server): raced, never trusted.
  extraAddresses?: string[];
  lastConnected?: number;
  wol?: WakeInfo[];
  vpn?: VpnKind;
}

// The vault entry of a server, bound to where it was obtained.
interface BoundCredential extends StoredCredential {
  // Origins where the user signed in (or that proved to be this server, below): the only ones the token goes to.
  origins?: string[];
  // https origins a trusted origin reported as its own (LocalAddress/WanAddress) or that Emby Connect
  // listed: trusted once their /System/Info/Public answers with this server's Id over validated TLS.
  vouched?: string[];
}

const MAX_EXTRA_ADDRESSES = 6;

// Server credentials live in the shared vault under their own namespace, so a
// server whose public Id is another subsystem's key can't read or clobber it.
const VAULT_PREFIX = 'server:';
// Keys other subsystems keep in the vault (vpn/embedded-mesh.ts, torrents/torrent-service.ts):
// before namespacing, server credentials sat right beside them.
const RESERVED_IDS = new Set(['mesh-auth-key', 'torrents:qbittorrent']);
// ServersDoc.tokenBinding once credentials are namespaced and bound to origins.
const TOKEN_BINDING = 1;

// A server Id is whatever an unauthenticated /System/Info/Public says: accept
// plain identifiers only (Emby and Jellyfin use hex GUIDs).
export function isServerId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !RESERVED_IDS.has(id.toLowerCase());
}

const isCredential = (c: unknown): c is BoundCredential =>
  typeof c === 'object' && c !== null && typeof (c as StoredCredential).token === 'string' && typeof (c as StoredCredential).userId === 'string';

const union = (a: readonly string[] | undefined, b: readonly (string | null | undefined)[]): string[] => [
  ...new Set([...(a ?? []), ...(b.filter(Boolean) as string[])]),
];
const isHttps = (origin: string | null): origin is string => Boolean(origin?.startsWith('https://'));
// LAN, link-local, loopback, CGNAT/overlay and mDNS hosts: who answers there depends on the network the PC is on.
const privateHost = (host: string): boolean =>
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.)/.test(host) ||
  /^\[?(::1|f[cd][0-9a-f]{2}:|fe80:)/i.test(host) ||
  host === 'localhost' ||
  host.endsWith('.local') ||
  !/[.:]/.test(host);

// Head start for the known addresses over VPN ones, so a server reachable on
// both is used over the LAN (full speed, no WireGuard hop).
const VPN_CANDIDATE_DELAY_MS = 600;

interface ServersDoc {
  servers: StoredServer[];
  // Primary server: answers calls that name no server.
  activeId?: string;
  // Every server with a session to resume at startup (absent in single-server files: activeId).
  activeIds?: string[];
  // Credential layout version (TOKEN_BINDING); absent in files written before token binding.
  tokenBinding?: number;
}

// Where a probe got an answer; overlay: through a peer of a connected VPN network (see probeServer()).
interface Reached {
  probe: ProbeResult;
  overlay: boolean;
}

// One server's connection. Several live side by side, keyed by server id.
interface Conn {
  client: ApiClient | null;
  socket: ServerSocket | null;
  state: ServerSession;
}

// cast-spec §2.7.3. Jellyfin binds the names to its GeneralCommandType enum (spelled PlayState, and
// without SetPlaybackRate: an unknown name may reject the whole body); Emby keeps its own spelling.
export function supportedCommands(kind: ServerKind): string[] {
  return [
    'Play',
    kind === 'jellyfin' ? 'PlayState' : 'Playstate',
    'PlayNext',
    'PlayMediaSource',
    'SetAudioStreamIndex',
    'SetSubtitleStreamIndex',
    'SetVolume',
    'VolumeUp',
    'VolumeDown',
    'Mute',
    'Unmute',
    'ToggleMute',
    'DisplayMessage',
    'GoHome',
    'DisplayContent',
    'ToggleFullscreen',
    'GoToSettings',
    ...(kind === 'emby' ? ['SetPlaybackRate'] : []),
  ];
}

export class ConnectionManager extends EventEmitter {
  private store: JsonStore<ServersDoc>;
  private conns = new Map<string, Conn>();
  private state: SessionState = { status: 'no-server', sessions: [] };
  // Settings "Autoriser le contrôle à distance" (remote.allowControl), posted as SupportsMediaControl.
  private allowControl = true;
  // recheck() in flight, per server.
  private rechecks = new Map<string, Promise<boolean>>();

  constructor(
    file: string,
    private readonly vault: CredentialVault,
    private readonly identity: ClientIdentity,
    private readonly vpn?: VpnService,
  ) {
    super();
    // A new file starts in the current layout; one without the field predates token binding.
    this.store = new JsonStore<ServersDoc>(file, { servers: [], tokenBinding: TOKEN_BINDING });
    this.migrateCredentials();
  }

  // Once, for files written before token binding: each server's credential moves
  // from the bare server Id to its namespaced key, bound to where the server was
  // last reached and its manual address, so nobody is signed out by the update.
  // Never again afterwards: a credential without origins stays bound to none.
  private migrateCredentials(): void {
    if (this.store.value.tokenBinding === TOKEN_BINDING) return;
    this.store.update((doc) => {
      // A stored server whose Id is not a plain identifier (another subsystem's vault key, say) is dropped.
      const dropped = doc.servers.filter((s) => !isServerId(s.id)).map((s) => s.id);
      if (dropped.length) log.warn(`dropping ${dropped.length} stored server(s) with an invalid Id`);
      doc.servers = doc.servers.filter((s) => isServerId(s.id));
      doc.activeIds = doc.activeIds?.filter((id) => isServerId(id));
      if (doc.activeId && !isServerId(doc.activeId)) doc.activeId = doc.activeIds?.[0];
      for (const s of doc.servers) {
        if (this.cred(s.id)) continue;
        const legacy: unknown = this.vault.get(s.id);
        if (!isCredential(legacy)) continue;
        this.saveCred(s.id, { ...legacy, origins: legacy.origins ?? union([], [credentialOrigin(s.lastAddress), credentialOrigin(s.manualAddress)]) });
        void this.vault.delete(s.id);
      }
      doc.tokenBinding = TOKEN_BINDING;
    });
  }

  private cred(serverId: string): BoundCredential | undefined {
    const c: unknown = isServerId(serverId) ? this.vault.get(VAULT_PREFIX + serverId) : undefined;
    return isCredential(c) ? c : undefined;
  }

  // The vault keeps the whole entry; its type only knows the base fields.
  // Both apply in memory at once (cred() sees them); the vault queues the write
  // in call order and its promise never rejects, so it is not awaited here.
  private saveCred(serverId: string, credential: BoundCredential): void {
    if (!isServerId(serverId)) throw new Error(t('errors.connection.notAServer'));
    void this.vault.set(VAULT_PREFIX + serverId, credential);
  }

  private dropCred(serverId: string): void {
    if (isServerId(serverId)) void this.vault.delete(VAULT_PREFIX + serverId);
  }

  // Whether the token may go to this address of the server, which just answered there with verifiedId:
  // - an origin the credential is bound to;
  // - an overlay address of an online peer of a VPN network the user is connected to (the
  //   overlay authenticates the peer): used for this connection, not bound;
  // - a vouched https origin (TLS validated: net.fetch rejects bad certificates), bound from now on.
  private admit(serverId: string, address: string, verifiedId: string, overlay = false): boolean {
    const cred = this.cred(serverId);
    if (!cred?.token || verifiedId !== serverId) return false;
    if (tokenAllowed(address, cred.origins)) return true;
    if (overlay) {
      log.info(`${address} is a VPN peer answering as server ${serverId}: token used over the overlay`);
      return true;
    }
    const origin = credentialOrigin(address);
    if (!isHttps(origin) || !cred.vouched?.includes(origin)) return false;
    this.saveCred(serverId, { ...cred, origins: union(cred.origins, [origin]) });
    log.info(`${origin} proved to be server ${serverId} over https, token bound to it`);
    return true;
  }

  // Candidates the stored token may be tried against before any sign-in.
  private eligible(serverId: string, address: string): boolean {
    const cred = this.cred(serverId);
    if (!cred?.token) return true;
    const origin = credentialOrigin(address);
    return tokenAllowed(address, cred.origins) || (isHttps(origin) && Boolean(cred.vouched?.includes(origin)));
  }

  // Binds a freshly obtained token to the origin where it was obtained.
  private bindCredential(serverId: string, credential: StoredCredential, address: string, vouched: (string | undefined)[] = []): void {
    const prev = this.cred(serverId);
    this.saveCred(serverId, {
      ...credential,
      origins: union(prev?.origins, [credentialOrigin(address)]),
      vouched: union(prev?.vouched, vouched.map(credentialOrigin).filter(isHttps)),
    });
  }

  // Aggregate state; server/user/address are the primary server's.
  get session(): SessionState {
    return this.state;
  }

  get primaryId(): string | undefined {
    return this.state.server?.id;
  }

  private conn(serverId?: string): Conn | undefined {
    const id = serverId ?? this.primaryId;
    return id ? this.conns.get(id) : undefined;
  }

  hasSession(serverId: string): boolean {
    return this.conns.has(serverId);
  }

  sessionFor(serverId?: string): ServerSession | undefined {
    return this.conn(serverId)?.state;
  }

  isOnline(serverId?: string): boolean {
    return this.conn(serverId)?.state.status === 'signed-in';
  }

  // The server's client (primary when absent), signed in or not.
  apiFor(serverId?: string): ApiClient {
    const client = this.conn(serverId)?.client;
    if (!client) throw new ApiError(t('errors.connection.noServerConnected'), 0);
    return client;
  }

  clientOf(serverId?: string): ApiClient | null {
    return this.conn(serverId)?.client ?? null;
  }

  // Only while that server is signed in.
  onlineApi(serverId?: string): ApiClient | null {
    const c = this.conn(serverId);
    return c?.state.status === 'signed-in' ? c.client : null;
  }

  userIdFor(serverId?: string): string {
    const id = this.conn(serverId)?.client?.userId;
    if (!id) throw new ApiError(t('errors.connection.notSignedIn'), 401);
    return id;
  }

  // Ids of the servers currently signed in (file sources are not servers: see putLocal).
  onlineIds(): string[] {
    return [...this.conns].filter(([, c]) => c.state.status === 'signed-in' && c.state.server.kind !== 'files').map(([id]) => id);
  }

  // A file source (files/sources.ts): a session of its own, always signed in as the local user, never
  // probed, woken or given a socket. Listed after the servers, and never the primary while a server exists.
  putLocal(info: ServerInfo, client: ApiClient, status: 'signed-in' | 'offline'): void {
    const user = { id: 'local', name: '', isAdmin: false };
    const prev = this.conns.get(info.id);
    if (prev) Object.assign(prev, { client, state: { status, server: info, user } });
    else this.conns.set(info.id, { client, socket: null, state: { status, server: info, user } });
    this.publish();
  }

  dropLocal(id: string): void {
    if (this.conns.get(id)?.state.server.kind !== 'files') return;
    this.conns.delete(id);
    this.publish();
  }

  private toInfo(s: StoredServer): ServerInfo {
    const cred = this.cred(s.id);
    const { wol: _wol, extraAddresses: _extra, ...rest } = s;
    const vpn = s.vpn ?? this.addressesOf(s).map((a) => this.vpn?.networkOf(a)).find(Boolean);
    return { ...rest, userId: cred?.userId, userName: cred?.userName, hasToken: Boolean(cred?.token), vpn };
  }

  private addressesOf(s: StoredServer): string[] {
    return [...new Set([s.lastAddress, s.manualAddress, s.localAddress, s.remoteAddress, ...(s.extraAddresses ?? [])].filter(Boolean) as string[])];
  }

  // Races the known addresses; meanwhile asks the VPN clients for a matching
  // online peer and races its overlay addresses too (verified to be this server).
  // With a stored token, the addresses it may be sent to (bound origins, vouched
  // https ones, overlay peers) race first; the others only when none of those
  // answers, and then a sign-in is asked there.
  private async probeServer(server: StoredServer): Promise<Reached> {
    const known = this.addressesOf(server);
    const overlay: Promise<string[]> = this.vpn ? this.vpn.candidatesFor({ name: server.name, addresses: known }).catch(() => []) : Promise.resolve([]);
    const ok = (a: string) => this.eligible(server.id, a);
    const direct = known.filter(ok);
    try {
      return await this.race(
        server,
        direct,
        overlay.then((o) => o.filter((a) => !direct.includes(a))),
      );
    } catch (err) {
      const peers = await overlay;
      const rest = known.filter((a) => !ok(a) && !peers.includes(a));
      if (rest.length === 0) throw err;
      log.info(`${server.name}: no address bound to the stored token answered, trying the others without it`);
      return { probe: await probeFirst(rest), overlay: false };
    }
  }

  private race(server: StoredServer, direct: string[], extra: Promise<string[]>): Promise<Reached> {
    const first = probeFirst(direct).then((probe) => ({ probe, overlay: false }));
    const viaVpn = extra.then(async (more) => {
      if (more.length === 0) throw new Error('no VPN address');
      log.info(`${server.name}: trying VPN address(es) ${more.join(', ')}`);
      await new Promise((r) => setTimeout(r, VPN_CANDIDATE_DELAY_MS));
      const probe = await probeFirst(more);
      if (probe.info.Id !== server.id) throw new Error('another server answered');
      return { probe, overlay: true };
    });
    return Promise.any([first, viaVpn]).catch(() => (direct.length ? first : viaVpn));
  }

  list(): ServerInfo[] {
    return [...this.store.value.servers].sort((a, b) => (b.lastConnected ?? 0) - (a.lastConnected ?? 0)).map((s) => this.toInfo(s));
  }

  // Records what a probe found. An answer at an origin the stored token is bound
  // to (or for a server with no token yet) updates the server's addresses and
  // details; any other answer only adds candidate addresses, so it can't repoint
  // where the token goes nor push a trusted address out. trusted: the caller just
  // admitted the token at probe.address (see admit()).
  private upsert(probe: ProbeResult, manual = false, trusted = false): StoredServer {
    const id = probe.info.Id;
    if (!isServerId(id)) throw new Error(t('errors.connection.notAServer'));
    const cred = this.cred(id);
    const authoritative = !cred?.token || trusted || tokenAllowed(probe.address, cred.origins);
    // Reported by whoever answered: plain http(s) URLs only.
    const local = hintAddress(probe.info.LocalAddress) ?? undefined;
    const wan = hintAddress(probe.info.WanAddress) ?? undefined;
    // An untrusted answer can't add a path of its choosing under an origin the token goes to.
    const foreign = (a: string) => {
      const origin = credentialOrigin(a);
      return !tokenAllowed(a, cred?.origins) && !(origin && cred?.vouched?.includes(origin));
    };
    let server: StoredServer | undefined;
    this.store.update((doc) => {
      server = doc.servers.find((s) => s.id === id);
      if (!server) {
        server = { id, name: probe.info.ServerName, kind: probe.kind, version: probe.info.Version };
        doc.servers.push(server);
      }
      if (!authoritative) {
        const known = this.addressesOf(server);
        const fresh = [probe.address, local, wan].filter((a): a is string => Boolean(a) && !known.includes(a!) && foreign(a!));
        if (fresh.length) server.extraAddresses = [...(server.extraAddresses ?? []), ...fresh].slice(-MAX_EXTRA_ADDRESSES);
        return;
      }
      server.name = probe.info.ServerName || server.name;
      server.kind = probe.kind;
      server.version = probe.info.Version;
      if (manual) server.manualAddress = probe.address;
      if (local) server.localAddress = local;
      if (wan) server.remoteAddress = wan;
      server.lastAddress = probe.address;
      const vpn = this.vpn?.networkOf(probe.address);
      if (vpn) server.vpn = vpn;
    });
    // A trusted origin vouches for its own https addresses (see admit()).
    if (authoritative && cred?.token) {
      const vouched = [local, wan].map(credentialOrigin).filter((o): o is string => isHttps(o) && !cred.vouched?.includes(o));
      if (vouched.length) this.saveCred(id, { ...cred, vouched: union(cred.vouched, vouched) });
    }
    return server!;
  }

  async add(input: string): Promise<ServerInfo> {
    const candidates = addressCandidates(input);
    if (candidates.length === 0) throw new Error(t('errors.connection.emptyAddress'));
    const probe = await probeFirst(candidates);
    const cred = this.cred(probe.info.Id);
    if (cred?.token && !tokenAllowed(probe.address, cred.origins)) {
      // Same public Id as a server already signed in to: a candidate only, its token stays where it was obtained.
      log.info(`${probe.address} answers as known server ${probe.info.ServerName}: added as a candidate, sign-in required to use it`);
    } else log.info(`added ${probe.kind} server ${probe.info.ServerName} at ${probe.address}`);
    return this.toInfo(this.upsert(probe, true));
  }

  // Signs in to Emby Connect, then registers every linked server and trades
  // each server's access key for a local user token. Returns the servers.
  async embyConnect(username: string, password: string): Promise<ServerInfo[]> {
    const account = await connectAuthenticate(username, password, this.identity.version);
    const linked = await connectServers(account, this.identity.version);
    log.info(`Emby Connect: ${linked.length} linked server(s)`);
    const results: ServerInfo[] = [];
    await Promise.all(
      linked.map(async (cs) => {
        if (!isServerId(cs.SystemId)) {
          log.warn(`Emby Connect server ${cs.Name} skipped: invalid Id`);
          return;
        }
        const id = this.store.value.servers.find((s) => s.id.toLowerCase() === cs.SystemId.toLowerCase())?.id ?? cs.SystemId;
        const remote = hintAddress(cs.Url);
        const local = hintAddress(cs.LocalAddress);
        const addresses = [local, remote].filter((a): a is string => Boolean(a));
        // The access key only goes where this is a sign-in at the server: see exchangeTrusted().
        const exchangeAt = addresses.filter((a) => this.exchangeTrusted(id, a, remote));
        let stored: StoredServer;
        try {
          if (exchangeAt.length < addresses.length) log.info(`Emby Connect server ${cs.Name}: not exchanging over http at a LAN address not signed in at`);
          const probe = await probeFirst(exchangeAt, 5000);
          // Another server at a listed address must not get this server's access key.
          if (probe.info.Id.toLowerCase() !== cs.SystemId.toLowerCase()) throw new Error(t('errors.connection.wrongServer'));
          const authorization = new ApiClient(probe.address, 'emby', this.identity).authHeaders()['X-Emby-Authorization'];
          const exchanged = await connectExchange(probe.address, account.userId, cs.AccessKey, authorization);
          // A sign-in at probe.address; the https addresses Connect lists are vouched for.
          this.bindCredential(probe.info.Id, { userId: exchanged.LocalUserId, userName: account.userName, token: exchanged.AccessToken }, probe.address, addresses);
          stored = this.upsert(probe);
        } catch (err) {
          log.warn(`Emby Connect server ${cs.Name} not reachable or exchange failed`, err);
          // Keep it in the list so it can be selected once reachable.
          this.store.update((doc) => {
            let s = doc.servers.find((x) => x.id === id);
            if (!s) {
              s = { id, name: cs.Name, kind: 'emby', version: '' };
              doc.servers.push(s);
            }
            if (local) s.localAddress = local;
            if (remote) s.remoteAddress = remote;
          });
          stored = this.store.value.servers.find((x) => x.id === id)!;
        }
        results.push(this.toInfo(stored));
      }),
    );
    return results;
  }

  // Where a Connect access key may be exchanged (and the token obtained there bound):
  // - an https address (TLS validated);
  // - the remote URL the server registered with Emby Connect (listed to us over TLS by Connect);
  // - an origin this server's credential is already bound to;
  // - the address where the user is signing in to this server right now (its login page is open there).
  // Not an http LAN address otherwise: on another network that private IP may be anyone's.
  private exchangeTrusted(serverId: string, address: string, remote: string | null): boolean {
    const origin = credentialOrigin(address);
    if (!origin) return false;
    if (isHttps(origin) || tokenAllowed(address, this.cred(serverId)?.origins)) return true;
    if (address === remote && !privateHost(new URL(origin).hostname)) return true;
    const live = this.conns.get(serverId);
    return live?.state.status === 'server-selected' && credentialOrigin(live.client?.address) === origin;
  }

  // Connects one more server; the other sessions stay up.
  async select(id: string): Promise<SessionState> {
    const server = this.store.value.servers.find((s) => s.id === id);
    if (!server || !isServerId(id)) throw new Error(t('errors.connection.unknownServer'));
    if (this.conns.get(id)?.state.status === 'signed-in') return this.state;
    this.close(id);
    const conn: Conn = { client: null, socket: null, state: { status: 'connecting', server: this.toInfo(server) } };
    this.conns.set(id, conn);
    this.store.update((doc) => {
      doc.activeIds = [...new Set([...(doc.activeIds ?? (doc.activeId ? [doc.activeId] : [])), id])];
      // Adding a server keeps the primary; it only moves when there is none.
      if (!doc.activeId || !doc.activeIds.includes(doc.activeId)) doc.activeId = id;
    });
    this.publish();
    // select() again, disconnect() or remove() while probing replaced this connection.
    const stale = () => this.conns.get(id) !== conn;

    let probe: ProbeResult;
    let overlay: boolean;
    try {
      ({ probe, overlay } = await this.probeServer(server));
    } catch (err) {
      log.warn(`server ${server.name} unreachable`, err);
      if (!stale()) this.setConn(conn, { status: 'offline', server: this.toInfo(server) });
      return this.state;
    }
    if (stale()) return this.state;
    if (probe.info.Id !== server.id) {
      this.disconnect(id);
      throw new Error(t('errors.connection.wrongServer'));
    }
    // The token goes only to an origin it is bound to (or one that just proved itself, see admit());
    // anywhere else the server is used signed out, and signing in there binds it.
    const useToken = this.admit(id, probe.address, probe.info.Id, overlay);
    const cred = useToken ? this.cred(id) : undefined;
    if (!useToken && this.cred(id)?.token) log.info(`${server.name}: answered at ${probe.address}, where the stored sign-in was not made; sign-in required`);
    const stored = this.upsert(probe, false, useToken);
    this.store.update((doc) => {
      const s = doc.servers.find((x) => x.id === id);
      if (s) s.lastConnected = Date.now();
    });

    conn.client = new ApiClient(probe.address, probe.kind, this.identity, cred?.token, cred?.userId);

    if (cred?.token) {
      try {
        const user = await conn.client.get<UserDto>(`/Users/${cred.userId}`);
        if (stale()) return this.state;
        await this.onSignedIn(conn, stored, user);
        return this.state;
      } catch (err) {
        if (stale()) return this.state;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          log.info(`${server.name}: stored token rejected, sign-in required`);
          this.dropCred(id);
          conn.client.token = undefined;
          conn.client.userId = undefined;
        } else {
          this.setConn(conn, { status: 'offline', server: this.toInfo(stored) });
          throw err;
        }
      }
    }
    this.setConn(conn, { status: 'server-selected', server: this.toInfo(stored), address: probe.address });
    return this.state;
  }

  // Every saved session, in parallel: a server that is down goes offline without holding up the others.
  async resumeLastSession(): Promise<void> {
    const doc = this.store.value;
    const ids = (doc.activeIds ?? (doc.activeId ? [doc.activeId] : [])).filter((id) => doc.servers.some((s) => s.id === id));
    await Promise.all(ids.map((id) => this.select(id).catch((err) => log.warn(`could not resume session ${id}`, err))));
  }

  async publicUsers(serverId?: string): Promise<PublicUser[]> {
    const users = await this.apiFor(serverId).get<UserDto[]>('/Users/Public').catch(() => [] as UserDto[]);
    return users.map((u) => ({
      id: u.Id,
      name: u.Name,
      hasPassword: Boolean(u.HasPassword ?? u.HasConfiguredPassword),
      imageTag: u.PrimaryImageTag,
    }));
  }

  async login(username: string, password: string, serverId?: string): Promise<SessionState> {
    // Without a server named, the one waiting for a sign-in (single-server flow).
    const id = serverId ?? [...this.conns].find(([, c]) => c.state.status === 'server-selected')?.[0] ?? this.primaryId;
    const conn = id ? this.conns.get(id) : undefined;
    const client = conn?.client;
    const server = this.store.value.servers.find((s) => s.id === id);
    if (!conn || !client || !server) throw new Error(t('errors.connection.noServerSelected'));
    let result: AuthenticationResult;
    try {
      result = await client.post<AuthenticationResult>('/Users/AuthenticateByName', undefined, { Username: username, Pw: password });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw new Error(t('errors.connection.wrongCredentials'));
      throw err;
    }
    client.token = result.AccessToken;
    client.userId = result.User.Id;
    // Signing in here binds the token to this origin (alongside the ones already trusted).
    this.bindCredential(server.id, { userId: result.User.Id, userName: result.User.Name, token: result.AccessToken }, client.address);
    this.store.update((doc) => {
      const s = doc.servers.find((x) => x.id === server.id);
      if (s) s.lastAddress = client.address;
    });
    await this.onSignedIn(conn, server, { Id: result.User.Id, Name: result.User.Name, PrimaryImageTag: result.User.PrimaryImageTag, Policy: result.User.Policy });
    return this.state;
  }

  private async onSignedIn(conn: Conn, server: StoredServer, user: UserDto): Promise<void> {
    const client = conn.client!;
    this.setConn(conn, {
      status: 'signed-in',
      server: this.toInfo(server),
      address: client.address,
      user: { id: user.Id, name: user.Name, isAdmin: Boolean(user.Policy?.IsAdministrator), imageTag: user.PrimaryImageTag },
    });
    log.info(`signed in as ${user.Name} on ${server.name}`);

    // Posted before each socket connect (ServerSocket beforeConnect), or alone without a socket.
    const capabilities = () => this.postCapabilities(client);
    if (!client.token) capabilities().catch((err) => log.warn('capabilities report failed', err));

    // Emby, and Jellyfin up to 10.10; Jellyfin 10.11 removed the route (404).
    client
      .get<{ MacAddress: string; Port: number; BroadcastAddress?: string }[]>('/System/WakeOnLanInfo')
      .then((infos) => {
        if (!Array.isArray(infos) || infos.length === 0) return;
        this.store.update((doc) => {
          const s = doc.servers.find((x) => x.id === server.id);
          if (s) s.wol = infos.map((i) => ({ mac: i.MacAddress, port: i.Port || 9, broadcast: i.BroadcastAddress }));
        });
      })
      .catch((err) => {
        if (!(err instanceof ApiError && err.status === 404)) log.debug(`wake-on-LAN info unavailable: ${String(err)}`);
      });

    if (client.token) {
      conn.socket?.close();
      conn.socket = new ServerSocket(client.address, client.kind, client.token, this.identity.deviceId, capabilities);
      conn.socket.on('message', (msg: SocketMessage) => this.emit('server-message', msg, server.id));
      conn.socket.on('down', () => {
        this.publish();
        // Then another of its addresses, should this one be gone (left the LAN, VPN down).
        void this.reportFailure(server.id).then(() => this.recheck(server.id));
      });
      // The socket reconnecting is the sign a dropped server is back.
      conn.socket.on('open', () => {
        if (this.conns.get(server.id) === conn && conn.state.status === 'offline') this.setConn(conn, { ...conn.state, status: 'signed-in' });
        else this.publish();
      });
      conn.socket.open();
    }
  }

  private postCapabilities(client: ApiClient): Promise<unknown> {
    return client.post('/Sessions/Capabilities/Full', undefined, {
      PlayableMediaTypes: ['Audio', 'Video'],
      SupportedCommands: supportedCommands(client.kind),
      SupportsMediaControl: this.allowControl,
      SupportsPersistentIdentifier: true,
    });
  }

  // Changing the setting posts the capabilities again on every signed-in server.
  setAllowControl(on: boolean): void {
    if (on === this.allowControl) return;
    this.allowControl = on;
    for (const conn of this.conns.values()) {
      if (conn.client?.token && (conn.state.status === 'signed-in' || conn.state.status === 'offline'))
        this.postCapabilities(conn.client).catch((err) => log.warn('capabilities report failed', err));
    }
  }

  // A message on the server's socket (cast mirror: SessionsStart / SessionsStop). Dropped while it is not open.
  socketSend(serverId: string, type: string, data?: unknown): void {
    this.conns.get(serverId)?.socket?.send(type, data);
  }

  // A server that stops answering drops out of the merged views while another one is
  // up (alone, it stays signed in, as before). Its socket coming back restores it.
  async reportFailure(serverId: string): Promise<void> {
    const conn = this.conns.get(serverId);
    if (conn?.state.status !== 'signed-in' || !conn.client || conn.state.server.kind === 'files' || this.onlineIds().length < 2) return;
    if (await probeFirst([conn.client.address], 4000).then(() => true, () => false)) return;
    if (this.conns.get(serverId) !== conn || conn.state.status !== 'signed-in') return;
    log.warn(`${conn.state.server.name} stopped answering`);
    this.setConn(conn, { ...conn.state, status: 'offline' });
  }

  // Reconnection (plezy-triage WP5/WP9): whether the server answers, after re-picking its address.
  // The address in use is probed; when it no longer answers, or after a network change (moved), the
  // stored addresses (LAN, remote, manual, VPN peers) race again, and the session moves to the winner
  // the token may go to (admit()). A server that was unreachable at startup is selected again once it
  // answers. Never signs anyone out: a server that stays silent keeps its state.
  recheck(serverId: string, moved = false): Promise<boolean> {
    const running = this.rechecks.get(serverId);
    if (running) return running;
    const run = this.runRecheck(serverId, moved)
      .catch((err) => {
        log.warn(`recheck of ${serverId} failed`, err);
        return false;
      })
      .finally(() => this.rechecks.delete(serverId));
    this.rechecks.set(serverId, run);
    return run;
  }

  // Wake from sleep, a network change (moved), or the periodic pass for servers that dropped.
  async recheckAll(moved = false): Promise<void> {
    const ids = [...this.conns].filter(([, c]) => moved || c.state.status === 'offline' || c.socket?.state === 'down').map(([id]) => id);
    await Promise.all(ids.map((id) => this.recheck(id, moved)));
  }

  private async runRecheck(serverId: string, moved: boolean): Promise<boolean> {
    const conn = this.conns.get(serverId);
    const server = this.store.value.servers.find((s) => s.id === serverId);
    if (!conn || !server || conn.state.status === 'connecting' || conn.state.status === 'server-selected') return false;
    const stale = () => this.conns.get(serverId) !== conn;
    // Never signed in this run (unreachable, or failed, at startup): select() again once it answers.
    if (!conn.client || !conn.socket) {
      if (!(await this.probeServer(server).then(() => true, () => false)) || stale()) return false;
      await this.select(serverId).catch((err) => log.warn(`could not reconnect ${server.name}`, err));
      return this.isOnline(serverId);
    }
    const address = conn.client.address;
    const here = await probeFirst([address], 4000).then((p) => p.info.Id === serverId, () => false);
    if (stale()) return false;
    if (!here || moved) {
      const reached = await this.probeServer(server).catch(() => null);
      if (stale()) return false;
      if (reached && reached.probe.address !== address && (await this.moveTo(conn, server, reached))) return true;
      if (!here && !(reached?.probe.address === address)) return false;
    }
    // Back where it was: after a network change a dropped socket reconnects now (otherwise its own backoff
    // runs: a socket the server keeps closing must not loop through here), and a server marked offline is up.
    if (moved) conn.socket.reconnectNow();
    if (conn.state.status === 'offline') this.setConn(conn, { ...conn.state, status: 'signed-in' });
    return true;
  }

  // The session continues at another address of the server, with its token (only where admit() allows it).
  private async moveTo(conn: Conn, server: StoredServer, { probe, overlay }: Reached): Promise<boolean> {
    if (probe.info.Id !== server.id || !this.admit(server.id, probe.address, probe.info.Id, overlay)) return false;
    const cred = this.cred(server.id);
    if (!cred?.token) return false;
    const client = new ApiClient(probe.address, probe.kind, this.identity, cred.token, cred.userId);
    const user = await client.get<UserDto>(`/Users/${cred.userId}`).catch(() => null);
    if (!user || this.conns.get(server.id) !== conn) return false;
    const stored = this.upsert(probe, false, true);
    log.info(`${server.name}: moved from ${conn.client?.address} to ${probe.address}`);
    conn.client = client;
    await this.onSignedIn(conn, stored, user);
    return true;
  }

  async logout(serverId?: string): Promise<SessionState> {
    const id = serverId ?? this.primaryId;
    const conn = id ? this.conns.get(id) : undefined;
    if (!id || !conn) return this.state;
    if (conn.client?.token) await conn.client.post('/Sessions/Logout').catch(() => undefined);
    this.dropCred(id);
    // With other servers still signed in, this one simply leaves; alone, it waits for a new sign-in.
    if (this.onlineIds().some((x) => x !== id)) return this.disconnect(id);
    conn.socket?.close();
    conn.socket = null;
    if (conn.client) {
      conn.client.token = undefined;
      conn.client.userId = undefined;
    }
    const server = { ...conn.state.server, hasToken: false, userId: undefined, userName: undefined };
    this.setConn(conn, { status: 'server-selected', server, address: conn.client?.address });
    return this.state;
  }

  // One server (its session closes, the others stay), or all of them.
  disconnect(serverId?: string): SessionState {
    // "Every session" means the servers: file sources stay.
    const ids = serverId ? [serverId] : [...this.conns].filter(([, c]) => c.state.server.kind !== 'files').map(([id]) => id);
    for (const id of ids) this.close(id);
    this.store.update((doc) => {
      doc.activeIds = serverId ? (doc.activeIds ?? (doc.activeId ? [doc.activeId] : [])).filter((x) => x !== serverId) : [];
      if (!doc.activeId || !doc.activeIds.includes(doc.activeId)) doc.activeId = doc.activeIds[0];
    });
    this.publish();
    return this.state;
  }

  remove(id: string): void {
    if (this.conns.has(id)) this.disconnect(id);
    this.dropCred(id);
    this.store.update((doc) => {
      doc.servers = doc.servers.filter((s) => s.id !== id);
    });
  }

  async wake(id: string): Promise<boolean> {
    const server = this.store.value.servers.find((s) => s.id === id);
    if (!server?.wol?.length) return false;
    await Promise.all(server.wol.map((w) => sendWakeOnLan(w.mac, w.port, w.broadcast)));
    return true;
  }

  private close(id: string): void {
    const conn = this.conns.get(id);
    if (!conn) return;
    conn.socket?.close();
    this.conns.delete(id);
  }

  private setConn(conn: Conn, next: ServerSession): void {
    conn.state = next;
    this.publish();
  }

  // Folds the sessions into the aggregate state: signed in as soon as one server
  // is, else the furthest any of them got. The primary is the chosen server when
  // it has that status, else the first one that does.
  private publish(): void {
    const order = this.store.value.servers.map((s) => s.id);
    // File sources (absent from the store) after every server.
    const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
    const all = [...this.conns.values()].map((c) => this.live(c)).sort((a, b) => rank(a.server.id) - rank(b.server.id));
    // The aggregate follows the servers; file sources alone count only when there is no server session.
    const servers = all.filter((s) => s.server.kind !== 'files');
    const basis = servers.length ? servers : all;
    const reached = (st: SessionStatus) => basis.some((s) => s.status === st);
    const status: SessionStatus =
      basis.length === 0 ? 'no-server' : reached('signed-in') ? 'signed-in' : reached('connecting') ? 'connecting' : reached('server-selected') ? 'server-selected' : 'offline';
    const activeId = this.store.value.activeId;
    const primary = basis.find((s) => s.status === status && s.server.id === activeId) ?? basis.find((s) => s.status === status);
    const sessions = primary ? [primary, ...all.filter((s) => s !== primary)] : [];
    this.state = primary ? { status, server: primary.server, user: primary.user, address: primary.address, sessions } : { status: 'no-server', sessions: [] };
    this.emit('session', this.state);
  }

  // The session plus what the status popover shows: socket state and the route of the address in use.
  private live(c: Conn): ServerSession {
    const a = c.state.address;
    const host = a ? new URL(a).hostname.replace(/^\[|\]$/g, '') : '';
    const route = !a ? undefined : routed(a) !== a || this.vpn?.networkOf(a) ? 'mesh' : privateHost(host) ? 'local' : 'remote';
    return { ...c.state, socket: c.socket?.state, route };
  }

  flush(): void {
    this.store.flush();
  }
}
