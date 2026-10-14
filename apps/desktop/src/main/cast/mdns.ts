// Chromecast discovery (cast-spec CA-09): an RFC 6762 §6.7 one-shot "legacy unicast" PTR query for
// _googlecast._tcp.local, sent to 224.0.0.251:5353 from an ephemeral port on each LAN interface (never 5353, which
// the Windows DNS client holds); responders answer by unicast. If nobody answers within the window, one more try
// from 5353 itself (reuseAddr), logged: legacy-unicast replies are unverified on real devices.
// Replies are parsed by hand (PTR, SRV, A, TXT fn/md/id/ca, name compression), capped at 9000 bytes, and a device is
// kept only on the replying host itself, on the LAN (a forged reply cannot point the sender elsewhere).
import dgram from 'node:dgram';
import { app } from 'electron';
import { logger } from '../core/log';
import { isLanAddress, lanInterfaces } from './lan';

const log = logger.scope('mdns');

export const SERVICE = '_googlecast._tcp.local';
export const MAX_PACKET = 9000;
const T_A = 1;
const T_PTR = 12;
const T_TXT = 16;
const T_SRV = 33;
// A speaker group: TXT ca bit 5 (CastDevice.CAPABILITY_MULTIZONE_GROUP = 32), or the model pychromecast reports.
const GROUP_MODEL = /^google cast group$/i;
const CA_GROUP = 32;

export interface CastDevice {
  // The TXT id (or the instance name): the picker key is "c:<id>".
  id: string;
  name: string;
  // The TXT md: the model (castProfile picks 4K and codec rules from it).
  model: string;
  ip: string;
  port: number;
  // TXT ca bit 0: the device has a video output (a Nest Mini has none).
  video: boolean;
  // A multi-room speaker group: its own port (not 8009), answered by the group's elected leader.
  group?: boolean;
}

function encodeName(name: string): Buffer {
  return Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])]);
}

// The query: one PTR question, class IN, no QU bit (the source port already asks for a unicast answer).
export function mdnsQuery(id = 0): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(1, 4);
  return Buffer.concat([head, encodeName(SERVICE), Buffer.from([0, T_PTR, 0, 1])]);
}

interface Rec {
  name: string;
  type: number;
  data: Buffer;
  // Offset of data in the packet (names inside rdata may point back into it).
  at: number;
}

// A (possibly compressed) name at `i`. Throws on a loop, an overrun or a name over 255 bytes.
function readName(buf: Buffer, i: number): { name: string; next: number } {
  const labels: string[] = [];
  let next = -1;
  let size = 0;
  for (let jumps = 0; ; ) {
    if (i >= buf.length) throw new RangeError('mDNS: name overrun');
    const len = buf[i];
    if (len === 0) {
      if (next < 0) next = i + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (i + 1 >= buf.length || ++jumps > 16) throw new RangeError('mDNS: bad pointer');
      if (next < 0) next = i + 2;
      i = ((len & 0x3f) << 8) | buf[i + 1];
      continue;
    }
    if (len & 0xc0 || i + 1 + len > buf.length) throw new RangeError('mDNS: bad label');
    size += len + 1;
    if (size > 255) throw new RangeError('mDNS: name too long');
    labels.push(buf.toString('utf8', i + 1, i + 1 + len));
    i += 1 + len;
  }
  return { name: labels.join('.'), next };
}

// Every resource record of a reply (answers, authority, additional). Throws on a malformed or oversize packet.
export function parseMdns(buf: Buffer): Rec[] {
  if (buf.length > MAX_PACKET || buf.length < 12) throw new RangeError(`mDNS: packet of ${buf.length} bytes`);
  if (!(buf[2] & 0x80)) return []; // a query, not a response
  const qd = buf.readUInt16BE(4);
  const rr = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let i = 12;
  for (let q = 0; q < qd; q++) i = readName(buf, i).next + 4;
  const out: Rec[] = [];
  for (let r = 0; r < rr; r++) {
    const { name, next } = readName(buf, i);
    if (next + 10 > buf.length) throw new RangeError('mDNS: record overrun');
    const type = buf.readUInt16BE(next);
    const len = buf.readUInt16BE(next + 8);
    const at = next + 10;
    if (at + len > buf.length) throw new RangeError('mDNS: rdata overrun');
    out.push({ name: name.toLowerCase(), type, data: buf.subarray(at, at + len), at });
    i = at + len;
  }
  return out;
}

function txt(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < data.length; ) {
    const s = data.toString('utf8', i + 1, i + 1 + data[i]);
    i += 1 + data[i];
    const eq = s.indexOf('=');
    if (eq > 0) out[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1);
  }
  return out;
}

// The Cast devices a reply from `from` describes. Only ones on that host, on the LAN; loopback: the checks only.
export function castDevices(buf: Buffer, from: string, loopback = false): CastDevice[] {
  const ip = from.replace(/^::ffff:/i, '');
  if (!isLanAddress(ip, { loopback })) return [];
  const recs = parseMdns(buf);
  const out: CastDevice[] = [];
  for (const p of recs.filter((r) => r.type === T_PTR && r.name === SERVICE)) {
    const instance = readName(buf, p.at).name;
    const key = instance.toLowerCase();
    const srv = recs.find((r) => r.type === T_SRV && r.name === key && r.data.length >= 7);
    const t = txt(recs.find((r) => r.type === T_TXT && r.name === key)?.data ?? Buffer.alloc(0));
    const target = srv ? readName(buf, srv.at + 6).name.toLowerCase() : '';
    const a = recs.filter((r) => r.type === T_A && r.data.length === 4 && r.name === target).map((r) => [...r.data].join('.'));
    if (a.length && !a.includes(ip)) {
      log.warn(`mDNS reply from ${ip} names another host (${a.join(', ')}): ignored`);
      continue;
    }
    const label = instance.slice(0, instance.length - SERVICE.length - 1);
    const id = /^[\w-]{1,64}$/.test(t.id ?? '') ? t.id : label.replace(/[^\w-]/g, '-').slice(0, 64);
    const ca = Number(t.ca);
    out.push({
      id,
      name: (t.fn || label).slice(0, 128),
      model: (t.md ?? '').slice(0, 128),
      ip,
      port: srv ? srv.data.readUInt16BE(4) : 8009,
      video: !Number.isInteger(ca) || (ca & 1) === 1,
      // Groups are audio-only: a screen with that bit (the recorded Nest Hub) stays a screen.
      ...(GROUP_MODEL.test(t.md ?? '') || (Number.isInteger(ca) && (ca & CA_GROUP) !== 0 && (ca & 1) === 0) ? { group: true } : {}),
    });
  }
  return out;
}

// WICABY_CAST_SEED=<ip:port[/speaker|/group],…>: devices added without mDNS, in development builds only (the checks'
// mock-cast; /speaker and /group stand for the TXT a Nest Mini or a speaker group would send).
export function castSeeds(env = process.env.WICABY_CAST_SEED, packaged = app.isPackaged): CastDevice[] {
  if (packaged || !env) return [];
  return env
    .split(',')
    .map((s) => /^\s*(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})(?:\/(speaker|group))?\s*$/.exec(s))
    .filter((m): m is RegExpExecArray => m !== null && isLanAddress(m[1], { loopback: true }) && Number(m[2]) > 0 && Number(m[2]) < 65536)
    .map((m) => ({
      id: `seed-${m[1].replace(/\./g, '-')}-${m[2]}`,
      name: `${m[3] === 'group' ? 'Speaker group' : m[3] === 'speaker' ? 'Speaker' : 'Chromecast'} ${m[1]}:${m[2]}`,
      model: m[3] === 'group' ? 'Google Cast Group' : m[3] === 'speaker' ? 'Google Nest Mini' : '',
      ip: m[1],
      port: Number(m[2]),
      video: !m[3],
      ...(m[3] === 'group' ? { group: true } : {}),
    }));
}

// Calls onFound once per device; resolves after timeoutMs (plus the 5353 retry when nobody answered). ips: the
// interfaces to ask on (the checks pass none: they never multicast on a real LAN).
export async function discoverCast(onFound: (d: CastDevice) => void, timeoutMs = 3000, ips = lanInterfaces()): Promise<void> {
  const seen = new Set<string>();
  let replies = 0;
  const found = (d: CastDevice) => {
    if (!seen.has(d.id)) {
      seen.add(d.id);
      onFound(d);
    }
  };
  castSeeds().forEach(found);
  if (ips.length === 0) return;
  const onMessage = (msg: Buffer, from: dgram.RemoteInfo) => {
    try {
      const list = castDevices(msg, from.address);
      if (list.length) replies++;
      list.forEach(found);
    } catch (err) {
      log.debug(`mDNS reply from ${from.address}: ${String(err)}`);
    }
  };
  const query = mdnsQuery(Math.floor(Math.random() * 0xffff) + 1);
  const ask = (bind: (s: dgram.Socket, ip: string, sent: () => void) => void, reuseAddr: boolean, ms: number) =>
    new Promise<void>((resolve) => {
      const sockets = ips.map((ip) => {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr });
        s.on('error', (err) => log.debug(`mDNS on ${ip}: ${err.message}`));
        s.on('message', onMessage);
        bind(s, ip, () => s.send(query, 5353, '224.0.0.251', (err) => err && log.debug(`mDNS query on ${ip}: ${err.message}`)));
        return s;
      });
      setTimeout(() => {
        for (const s of sockets) s.close();
        resolve();
      }, ms).unref();
    });
  await ask(
    (s, ip, send) =>
      s.bind(0, ip, () => {
        try {
          s.setMulticastInterface(ip);
          send();
        } catch (err) {
          log.debug(`mDNS on ${ip}: ${String(err)}`);
        }
      }),
    false,
    timeoutMs,
  );
  if (replies > 0) return;
  log.info('mDNS: no legacy-unicast reply; one more query from port 5353 (reuseAddr)');
  await ask(
    (s, ip, send) =>
      s.bind(5353, () => {
        try {
          s.addMembership('224.0.0.251', ip);
          s.setMulticastInterface(ip);
          send();
        } catch (err) {
          log.debug(`mDNS on ${ip}:5353: ${String(err)}`);
        }
      }),
    true,
    2000,
  );
}
