// Pure address rules for the server form (no IPC, no runes): tools/checks/desktop-hardening-check.mjs tests them.

// A typed http:// address whose host is on the Internet, not on this network or a VPN: the setup warns that the
// connection is not encrypted (it stays allowed). Addresses without a scheme get https:// when added.
export function plainHttpToPublic(address: string): boolean {
  const value = address.trim();
  if (!/^http:\/\//i.test(value)) return false;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (!host) return false;
  // Single-label names, mDNS and private DNS suffixes.
  if (!host.includes('.') && !host.includes(':')) return false;
  if (/\.(local|lan|home|internal|home\.arpa|ts\.net)$/.test(host)) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    // Loopback, private, link-local, and 100.64/10 (Tailscale and NetBird addresses).
    return !(a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127));
  }
  // IPv6 loopback, unique local (fc00::/7) and link-local (fe80::/10).
  if (host.includes(':')) return !(host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host));
  return true;
}
