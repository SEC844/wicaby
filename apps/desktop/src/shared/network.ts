// Tells a LAN server address from a remote one, for the "Réseau local" / "Distant"
// quality caps. Private IPv4 ranges, link-local, loopback, IPv6 ULA and bare or .local
// host names count as local; anything else (public IPs, domains, VPN CGNAT) is remote.
export function isLanAddress(address?: string): boolean {
  if (!address) return false;
  let host: string;
  try {
    host = new URL(address).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return true;
  const v4 = host.split('.');
  if (v4.length === 4 && v4.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
    const [a, b] = v4.map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (host.includes(':')) return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:');
  // A single-label name (NAS, MEDIASERVER) only resolves on the local network.
  return !host.includes('.');
}
