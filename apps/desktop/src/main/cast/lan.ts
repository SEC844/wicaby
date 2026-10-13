// Which addresses and interfaces direct casting may use (cast-spec CA-07 §Security, §6): RFC 1918, 169.254/16 and
// fc00::/7 only. Never the mesh or a VPN (100.64/10, Tailscale's fd7a:115c:a1e0::/48, their adapters), never the
// internet, and loopback only for the dev seed (the checks' mock renderers). Pure, so cast-dlna-check runs it.
import dns from 'node:dns/promises';
import os from 'node:os';
import type { ApiClient } from '../connection/api-client';

function v4(ip: string): number[] | null {
  const p = ip.split('.');
  return p.length === 4 && p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255) ? p.map(Number) : null;
}

// An IP literal (no host name: some TVs do not resolve them, and a name could point anywhere).
export function isLanAddress(ip: string, opts: { loopback?: boolean } = {}): boolean {
  const host = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
  const a = v4(mapped ?? host);
  if (a) return a[0] === 10 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168) || (a[0] === 169 && a[1] === 254) || (a[0] === 127 && Boolean(opts.loopback));
  if (!host.includes(':') || !/^[0-9a-f:]+$/.test(host)) return false;
  if (host === '::1') return Boolean(opts.loopback);
  return /^f[cd][0-9a-f]{2}:/.test(host) && !host.startsWith('fd7a:115c:a1e0:');
}

// Adapters the VPN clients (main/vpn) create: their addresses are CGNAT already, the names catch a private range.
const VPN_ADAPTER = /tailscale|netbird|wireguard|zerotier|^wt\d|^utun|^tun\d/i;

export function isLanInterface(name: string, info: Pick<os.NetworkInterfaceInfo, 'family' | 'address' | 'internal'>): boolean {
  return info.family === 'IPv4' && !info.internal && !VPN_ADAPTER.test(name) && isLanAddress(info.address);
}

// The IPv4 addresses SSDP goes out on.
export function lanInterfaces(ifaces = os.networkInterfaces()): string[] {
  return Object.entries(ifaces).flatMap(([name, list]) => (list ?? []).filter((i) => isLanInterface(name, i)).map((i) => i.address));
}

const toInt = (a: number[]) => ((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0;

// This computer's address on the renderer's subnet (the relay binds there), or null when none shares it.
export function localAddressFor(remote: string, ifaces = os.networkInterfaces()): string | null {
  const r = v4(remote.replace(/^::ffff:/i, ''));
  if (!r) return null;
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      const a = v4(i.address);
      const m = v4(i.netmask);
      if (i.family !== 'IPv4' || !a || !m || VPN_ADAPTER.test(name)) continue;
      if ((toInt(a) & toInt(m)) >>> 0 === (toInt(r) & toInt(m)) >>> 0) return i.address;
    }
  }
  return null;
}

// The server's base URL on the LAN as a device can fetch it: plain http, an IP literal (a host name is resolved here,
// some TVs do not resolve names), never the mesh forwarder. Null otherwise (cast.error.lanOnly). loopback: dev seed.
// shortcut: an https-only LAN server is refused (a receiver would not accept its certificate on an IP); revisit if asked.
export async function lanServerBase(api: Pick<ApiClient, 'address' | 'prefix' | 'url'>, loopback = false): Promise<string | null> {
  const u = new URL(api.address);
  if (u.protocol !== 'http:' || api.url('') !== `${api.address}${api.prefix}`) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ip = /^[\d.]+$|:/.test(host) ? host : (await dns.lookup(host, { family: 4 }).catch(() => null))?.address;
  if (!ip || !isLanAddress(ip, { loopback })) return null;
  return `http://${ip.includes(':') ? `[${ip}]` : ip}${u.port ? `:${u.port}` : ''}${u.pathname.replace(/\/+$/, '')}`;
}
