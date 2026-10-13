import dgram from 'node:dgram';
import os from 'node:os';
import type { DiscoveredServer, ServerKind } from '../../shared/contract';
import { logger } from '../core/log';
import { t } from '../i18n';

const log = logger.scope('discovery');
const PORT = 7359;
const MAX_REPLIES = 64;

// A reply is an unauthenticated UDP datagram anyone on the LAN can send: a hint
// for the server list, nothing more. Its Id is a claim (adding the address
// probes it again, and a stored token only goes where the user signed in, see
// ConnectionManager); its address must be a plain http(s) URL.
export function parseReply(raw: string, kind: ServerKind): DiscoveredServer | null {
  let reply: { Id?: unknown; Name?: unknown; Address?: unknown };
  try {
    reply = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!reply || typeof reply.Id !== 'string' || typeof reply.Address !== 'string') return null;
  if (!reply.Id || reply.Id.length > 128) return null;
  const address = hintAddress(reply.Address);
  if (!address) return null;
  const name = typeof reply.Name === 'string' && reply.Name.trim() ? reply.Name.trim().slice(0, 128) : new URL(address).host;
  return { id: reply.Id, name, address, kind };
}

// A server address from an unauthenticated source (discovery reply, LocalAddress/WanAddress
// of /System/Info/Public, Emby Connect listing): a plain http(s) URL with a host and no
// user info, kept as origin + path (no query, no fragment). Null for anything else.
export function hintAddress(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 512) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

// Broadcast address of every IPv4 interface, plus the limited broadcast.
// Emby Theater did the same; we also query Jellyfin, which answers a different probe.
function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const e of entries ?? []) {
      if (e.family !== 'IPv4' || e.internal) continue;
      const ip = e.address.split('.').map(Number);
      const mask = e.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

function probe(kind: ServerKind, timeoutMs: number): Promise<DiscoveredServer[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredServer>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const message = Buffer.from(kind === 'emby' ? 'who is EmbyServer? | emby' : 'who is JellyfinServer?');
    const finish = () => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve([...found.values()]);
    };

    socket.on('error', (err) => {
      log.warn(`${kind} probe failed`, err);
      finish();
    });
    socket.on('message', (buf) => {
      if (found.size >= MAX_REPLIES) return;
      const hint = parseReply(buf.toString('utf8'), kind);
      // First reply per Id wins: a later one claiming the same Id is ignored, not swapped in.
      if (hint && !found.has(hint.id)) found.set(hint.id, hint);
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      for (const addr of broadcastAddresses()) {
        socket.send(message, PORT, addr, (err) => err && log.debug(`send to ${addr} failed: ${err.message}`));
      }
      setTimeout(finish, timeoutMs);
    });
  });
}

export async function discoverServers(timeoutMs = 2500): Promise<DiscoveredServer[]> {
  const [emby, jellyfin] = await Promise.all([probe('emby', timeoutMs), probe('jellyfin', timeoutMs)]);
  const merged = new Map<string, DiscoveredServer>();
  for (const s of [...emby, ...jellyfin]) if (!merged.has(s.id)) merged.set(s.id, s);
  log.info(`found ${merged.size} server(s)`);
  return [...merged.values()];
}

export function sendWakeOnLan(mac: string, port = 9, broadcast = '255.255.255.255'): Promise<void> {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) return Promise.reject(new Error(t('errors.connection.invalidMac', { mac })));
  const macBytes = Buffer.from(hex, 'hex');
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.bind(0, () => {
      socket.setBroadcast(true);
      socket.send(packet, port, broadcast, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}
