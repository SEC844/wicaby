// SSDP discovery of DLNA MediaRenderers (cast-spec CA-07): an M-SEARCH from an ephemeral port on each LAN interface
// (never 1900, which the Windows SSDP service holds), twice, 500 ms apart, then 3 s of replies. Only LOCATIONs on
// the replying host itself, and on the LAN, come back (a forged reply cannot point the sender elsewhere).
import dgram from 'node:dgram';
import { app } from 'electron';
import { logger } from '../core/log';
import { isLanAddress, lanInterfaces } from './lan';

const log = logger.scope('ssdp');

const ST = 'urn:schemas-upnp-org:device:MediaRenderer:1';
const M_SEARCH = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${ST}\r\n\r\n`);

export function parseSsdpReply(text: string): { location: string; usn: string } | null {
  if (!/^HTTP\/1\.[01] 200\b/i.test(text)) return null;
  const header = (name: string) => new RegExp(`^${name}:[ \\t]*(.*?)[ \\t]*$`, 'im').exec(text)?.[1] ?? '';
  const location = header('LOCATION');
  return location ? { location, usn: header('USN') } : null;
}

// The LOCATION a reply from `from` may lead to: plain http on that same host, on the LAN; null otherwise.
// loopback: the dev seed only.
export function acceptLocation(location: string, from: string, loopback = false): string | null {
  try {
    const u = new URL(location);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (u.protocol !== 'http:' || u.username || u.password || host !== from.replace(/^::ffff:/i, '') || !isLanAddress(host, { loopback })) return null;
    return u.href;
  } catch {
    return null;
  }
}

// WICABY_DLNA_SEED=<url,…>: renderers added without SSDP, in development builds only (the checks' mock renderers).
export function seedLocations(env = process.env.WICABY_DLNA_SEED, packaged = app.isPackaged): string[] {
  if (packaged || !env) return [];
  return env
    .split(',')
    .map((s) => s.trim())
    .map((s) => {
      try {
        return acceptLocation(s, new URL(s).hostname.replace(/^\[|\]$/g, ''), true);
      } catch {
        return null;
      }
    })
    .filter((s): s is string => s !== null);
}

// Calls onFound(location) once per LOCATION; resolves after timeoutMs. failed: no interface could send (a firewall
// or no LAN at all). ips: the interfaces to search on (the checks pass none: they never multicast on a real LAN).
export function discover(onFound: (location: string) => void, timeoutMs = 3000, ips = lanInterfaces()): Promise<{ failed: boolean }> {
  const seen = new Set<string>();
  const found = (loc: string | null) => {
    if (loc && !seen.has(loc)) {
      seen.add(loc);
      onFound(loc);
    }
  };
  seedLocations().forEach(found);
  let sent = 0;
  const sockets = ips.map((ip) => {
    const s = dgram.createSocket({ type: 'udp4' });
    s.on('error', (err) => log.debug(`M-SEARCH on ${ip}: ${err.message}`));
    s.on('message', (msg, from) => {
      const r = parseSsdpReply(msg.subarray(0, 2048).toString('latin1'));
      const loc = r && acceptLocation(r.location, from.address);
      if (r && !loc) log.warn(`SSDP reply from ${from.address} with LOCATION on another host ignored`);
      found(loc);
    });
    const send = () => s.send(M_SEARCH, 1900, '239.255.255.250', (err) => (err ? log.debug(`M-SEARCH on ${ip}: ${err.message}`) : sent++));
    s.bind(0, ip, () => {
      try {
        s.setMulticastInterface(ip);
        send();
        setTimeout(send, 500).unref();
      } catch (err) {
        log.debug(`M-SEARCH on ${ip}: ${String(err)}`);
      }
    });
    return s;
  });
  return new Promise((resolve) =>
    setTimeout(() => {
      for (const s of sockets) s.close();
      resolve({ failed: ips.length > 0 && sent === 0 });
    }, timeoutMs),
  );
}
