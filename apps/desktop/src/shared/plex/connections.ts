// Choosing how to reach a Plex server (plex-spec §5.3, PX-05): the connections plex.tv lists for it are ranked
// into three waves (local, then remote, then the bandwidth-capped relay), https before http inside a wave; each
// wave starts probing with a head start, but rank, not speed, picks the winner. Candidates that cannot work are
// dropped first: plain http when the server requires secure connections (Plezy #929), and a "local" private IPv4
// address outside every subnet of this machine (a Docker bridge, Plezy #811). Pure: tools/checks/
// plex-connections-check.mjs runs the vectors in tools/checks/fixtures/plex/connections.json, which the Android
// twin will replay.

export interface PlexConnection {
  uri: string;
  protocol?: string;
  address?: string;
  port?: number;
  local?: boolean;
  relay?: boolean;
  IPv6?: boolean;
}

export interface RankOptions {
  httpsRequired?: boolean;
  // This machine's IPv4 networks as 'a.b.c.d/len' (os.networkInterfaces()).
  subnets?: string[];
  // Where the server answered last time: first of its wave (a remote or relay one never jumps ahead of local).
  lastGood?: string;
}

export interface Ranked {
  // Wave 1 local, wave 2 remote, wave 3 relay; lastGood first of its wave, then https, then http.
  waves: [string[], string[], string[]];
  dropped: { uri: string; why: 'http-refused' | 'other-subnet' }[];
}

// Head start of each wave over the next, in ms (the VPN_CANDIDATE_DELAY_MS pattern).
export const WAVE_DELAYS_MS = [0, 600, 1500] as const;

const ipv4 = (s: string | undefined): number | null => {
  const p = (s ?? '').split('.');
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return null;
  return p.reduce((n, x) => n * 256 + Number(x), 0);
};

export function inSubnet(ip: string, cidr: string): boolean {
  const [net, len] = cidr.split('/');
  const a = ipv4(ip);
  const b = ipv4(net);
  const bits = Number(len);
  if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
  return Math.floor(a / 2 ** (32 - bits)) === Math.floor(b / 2 ** (32 - bits));
}

const isPrivate4 = (n: number): boolean => {
  const a = Math.floor(n / 2 ** 24);
  const b = Math.floor(n / 2 ** 16) % 256;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
};

const secure = (c: PlexConnection): boolean => (c.protocol ?? c.uri.split(':')[0]).toLowerCase() === 'https';

export function rankConnections(conns: readonly PlexConnection[], opts: RankOptions = {}): Ranked {
  const dropped: Ranked['dropped'] = [];
  const kept: PlexConnection[] = [];
  const seen = new Set<string>();
  for (const c of conns) {
    if (!c?.uri || seen.has(c.uri) || !/^https?:\/\//i.test(c.uri)) continue;
    seen.add(c.uri);
    if (opts.httpsRequired && !secure(c)) {
      dropped.push({ uri: c.uri, why: 'http-refused' });
      continue;
    }
    // Loopback always answers here; another private network only when this machine is on it.
    const ip = c.IPv6 ? null : ipv4(c.address);
    if (c.local && !c.relay && ip !== null && isPrivate4(ip) && opts.subnets && !opts.subnets.some((s) => inSubnet(c.address!, s))) {
      dropped.push({ uri: c.uri, why: 'other-subnet' });
      continue;
    }
    kept.push(c);
  }
  const first = (c: PlexConnection) => (c.uri === opts.lastGood ? 0 : secure(c) ? 1 : 2);
  const order = (list: PlexConnection[]) => list.sort((a, b) => first(a) - first(b)).map((c) => c.uri);
  return { waves: [order(kept.filter((c) => c.local && !c.relay)), order(kept.filter((c) => !c.local && !c.relay)), order(kept.filter((c) => c.relay))], dropped };
}

// Races the waves: each starts probing after its delay, or at once when every probe started so far has failed, but
// rank decides, not speed. An answer wins only once every better-ranked candidate, in its wave and in every earlier
// wave, has failed: lastGood, then https, beat a faster plain http (which would ask for D-3 confirmation), and a
// local address that is still pending holds back remote and relay answers (§1.3: a user at home is never sent
// over the capped relay or the Plex Pass remote rule). The wait is bounded by the probe's own timeout; later waves
// start early so their answer is ready when it ends. Rejects when all fail. Pure (timers only): the check drives
// it with a fake probe.
export function raceWaves<T>(waves: readonly string[][], probe: (uri: string) => Promise<T>, delays: readonly number[] = WAVE_DELAYS_MS): Promise<{ uri: string; value: T }> {
  return new Promise((resolve, reject) => {
    const flat = waves.flat();
    if (!flat.length) return reject(new Error('no candidate'));
    const timers: ReturnType<typeof setTimeout>[] = [];
    const answered = new Map<number, T>();
    const failedAt = new Set<number>();
    let done = false;
    let started = 0;
    let next = 0;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      fn();
    };
    const settle = () => {
      if (failedAt.size === flat.length) return finish(() => reject(new Error('unreachable')));
      // The best-ranked candidate started that has not failed: the winner once it answered; until then nothing wins.
      let best = 0;
      while (best < started && failedAt.has(best)) best++;
      if (best < started) return answered.has(best) ? finish(() => resolve({ uri: flat[best], value: answered.get(best)! })) : undefined;
      // Everything started so far failed: the next wave starts now (an empty wave has nothing to fail).
      if (next < waves.length) start(next);
    };
    const start = (i: number) => {
      if (done || i < next) return;
      for (; next <= i; next++) {
        for (const uri of waves[next]) {
          const k = started++;
          probe(uri).then(
            (value) => (answered.set(k, value), settle()),
            () => (failedAt.add(k), settle()),
          );
        }
      }
      settle();
    };
    waves.forEach((_, i) => timers.push(setTimeout(() => start(i), delays[i] ?? delays[delays.length - 1] ?? 0)));
  });
}
