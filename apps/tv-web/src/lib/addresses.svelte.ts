// B09: a server's local and remote addresses (core net/Addresses.kt AddressSwitch): learned from what the server
// announces (/System/Info/Public) or typed in Settings > Accounts. Every URL keeps the server's stored address as its
// identity; requests go to whichever of its addresses answered last as that same server (raced at sign-in, again
// after a connection failure, at most every 15 s). A learned plain-HTTP address never stands in for an HTTPS one: the
// token never leaves TLS unless the user typed that address.
import { load, save } from './storage';

export interface KnownAddresses {
  local?: string;
  remote?: string;
  // Typed in Settings: never overwritten by what the server announces.
  edited?: boolean;
}

const KEY = 'server_addresses';
const known = $state<Record<string, KnownAddresses>>(load<Record<string, KnownAddresses>>(KEY, {}));
// Server id → the address its requests go to now (absent: the stored one).
const chosen = $state<Record<string, string>>({});
const lastPick = new Map<string, number>();
const picking = new Set<string>();

const clean = (a?: string | null): string | undefined => {
  const v = a?.trim().replace(/\/+$/, '');
  return v && /^https?:\/\/[^/\s]+/i.test(v) ? v : undefined;
};

// A host on the local network: plain HTTP is acceptable there (core LocalNetwork.isLanAddress).
export function isLanHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:')) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function knownAddresses(serverId: string): KnownAddresses {
  return known[serverId] ?? {};
}

// What a pick races, the stored address first. A learned plain-HTTP address is left out when the stored one is HTTPS.
export function candidates(address: string, k: KnownAddresses): string[] {
  const stored = clean(address) ?? address;
  const https = /^https:/i.test(stored);
  // An address stands in only if its path ends with the stored one's ("https://h/jf" for "http://lan:8096/jf").
  const path = (a: string) => new URL(a).pathname.replace(/\/+$/, '');
  const fits = (a: string) => path(a).endsWith(path(stored));
  const alts = [k.local, k.remote].map(clean).filter((a): a is string => !!a && fits(a) && (k.edited || !https || /^https:/i.test(a)));
  const out: string[] = [];
  for (const a of [stored, ...alts]) if (!out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
  return out;
}

// What the server announces, kept: an HTTPS remote address, or a plain-HTTP one on the LAN only. The user's own
// addresses are never overwritten.
export function learned(old: KnownAddresses, info: { LocalAddress?: string; WanAddress?: string }): KnownAddresses {
  if (old.edited) return old;
  const local = clean(info.LocalAddress);
  const wan = clean(info.WanAddress);
  const remote = wan && (/^https:/i.test(wan) || isLanHost(new URL(wan).hostname)) ? wan : undefined;
  return { local: local ?? old.local, remote: remote ?? old.remote };
}

// The address [serverId]'s requests go to now.
export function addressInUse(serverId: string | undefined, stored: string): string {
  return (serverId && chosen[serverId]) || stored;
}

async function probe(address: string, emby: boolean, ms = 6000): Promise<{ Id?: string; LocalAddress?: string; WanAddress?: string } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      fetch(`${address}${emby ? '/emby' : ''}/System/Info/Public`, { headers: { Accept: 'application/json' } }),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms))),
    ]);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Races the server's addresses and sends its requests to the first that answers as that server.
export async function repick(serverId: string, stored: string, emby: boolean): Promise<void> {
  if (picking.has(serverId)) return;
  picking.add(serverId);
  lastPick.set(serverId, Date.now());
  try {
    const list = candidates(stored, knownAddresses(serverId));
    const found = await new Promise<{ address: string; info: { Id?: string; LocalAddress?: string; WanAddress?: string } } | null>((resolve) => {
      let left = list.length;
      if (!left) resolve(null);
      for (const a of list)
        void probe(a, emby).then((info) => {
          if (info?.Id === serverId) resolve({ address: a, info });
          else if (--left === 0) resolve(null);
        });
    });
    if (!found) return;
    if (found.address.toLowerCase() === (clean(stored) ?? stored).toLowerCase()) delete chosen[serverId];
    else chosen[serverId] = found.address;
    const k = knownAddresses(serverId);
    const next = learned(k, found.info);
    if (next.local !== k.local || next.remote !== k.remote) {
      known[serverId] = next;
      save(KEY, $state.snapshot(known));
    }
  } finally {
    picking.delete(serverId);
  }
}

// A request to that server could not connect: pick again, at most every 15 s.
export function addressFailed(serverId: string | undefined, stored: string, emby: boolean): void {
  if (!serverId || Date.now() - (lastPick.get(serverId) ?? 0) < 15_000) return;
  void repick(serverId, stored, emby);
}

// Settings: the user's local and remote addresses (blank: none; both blank: back to what the server announces).
// False when one is not an http(s) URL.
export function editAddresses(serverId: string, stored: string, emby: boolean, local: string, remote: string): boolean {
  const l = local.trim();
  const r = remote.trim();
  if ((l && !clean(l)) || (r && !clean(r))) return false;
  if (!l && !r) delete known[serverId];
  else known[serverId] = { local: clean(l), remote: clean(r), edited: true };
  save(KEY, $state.snapshot(known));
  lastPick.delete(serverId);
  void repick(serverId, stored, emby);
  return true;
}
