// "Find on this network" in the Add sheet (file-sources-spec D12, §6.2): one DNS-SD query for _webdav._tcp,
// _webdavs._tcp and _smb._tcp, sent with the QU bit from an ephemeral port (5353 is never bound: Windows' DNS
// client may hold it), answers kept for 2.5 s, at most 64, from a local subnet only. A reply only fills the
// form: nothing connects until the user presses Test. The parser is pure; vectors in
// tools/checks/fixtures/files/mdns/*.bin (tools/checks/files-mdns-check.mjs).
import dgram from 'node:dgram';
import os from 'node:os';
import type { FileDiscovered } from '../../shared/contract';
import { logger } from '../core/log';

const log = logger.scope('files');

export const MDNS_ADDRESS = '224.0.0.251';
export const MDNS_PORT = 5353;
export const SERVICE_TYPES = ['_webdav._tcp.local', '_webdavs._tcp.local', '_smb._tcp.local'];
const WAIT_MS = 2500;
const MAX_REPLIES = 64;
const T_A = 1;
const T_PTR = 12;
const T_TXT = 16;
const T_SRV = 33;

export interface DnsRecord {
  name: string;
  type: number;
  // PTR: the target name; SRV: { target, port }; TXT: key=value strings; A: the address.
  data: string | { target: string; port: number } | string[];
}

// The query: three PTR questions, class IN with the unicast-response (QU) bit.
export function buildQuery(types = SERVICE_TYPES): Buffer {
  const parts: Buffer[] = [Buffer.from([0, 0, 0, 0, 0, types.length, 0, 0, 0, 0, 0, 0])];
  for (const t of types) parts.push(encodeName(t), Buffer.from([0, T_PTR, 0x80, 0x01]));
  return Buffer.concat(parts);
}

export function encodeName(name: string): Buffer {
  const labels = name.split('.').filter(Boolean).map((l) => Buffer.from(l, 'utf8'));
  return Buffer.concat([...labels.flatMap((l) => [Buffer.from([Math.min(l.length, 63)]), l.subarray(0, 63)]), Buffer.from([0])]);
}

// A name at offset, following compression pointers backwards only (no loop can be built), at most 255 bytes.
function readName(buf: Buffer, offset: number): { name: string; next: number } | null {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  let total = 0;
  for (let hops = 0; hops < 32; hops++) {
    if (pos >= buf.length) return null;
    const len = buf[pos];
    if (len === 0) return { name: labels.join('.'), next: next < 0 ? pos + 1 : next };
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) return null;
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (ptr >= pos) return null;
      if (next < 0) next = pos + 2;
      pos = ptr;
      continue;
    }
    if (len > 63 || pos + 1 + len > buf.length) return null;
    total += len + 1;
    if (total > 255) return null;
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
    hops--;
  }
  return null;
}

// Answers and additional records of one reply; null for anything malformed (truncated, a pointer loop…).
export function parsePacket(buf: Buffer): DnsRecord[] | null {
  if (buf.length < 12) return null;
  const qd = buf.readUInt16BE(4);
  const count = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  if ((buf.readUInt16BE(2) & 0x8000) === 0) return null;
  let pos = 12;
  for (let i = 0; i < qd; i++) {
    const n = readName(buf, pos);
    if (!n || n.next + 4 > buf.length) return null;
    pos = n.next + 4;
  }
  const out: DnsRecord[] = [];
  for (let i = 0; i < count && i < 256; i++) {
    const n = readName(buf, pos);
    if (!n || n.next + 10 > buf.length) return null;
    const type = buf.readUInt16BE(n.next);
    const len = buf.readUInt16BE(n.next + 8);
    const start = n.next + 10;
    if (start + len > buf.length) return null;
    pos = start + len;
    if (type === T_PTR) {
      const target = readName(buf, start);
      if (!target) return null;
      out.push({ name: n.name, type, data: target.name });
    } else if (type === T_SRV) {
      const target = len >= 7 ? readName(buf, start + 6) : null;
      if (!target) return null;
      out.push({ name: n.name, type, data: { target: target.name, port: buf.readUInt16BE(start + 4) } });
    } else if (type === T_TXT) {
      const txt: string[] = [];
      for (let p = start; p < start + len; ) {
        const l = buf[p];
        if (p + 1 + l > start + len) return null;
        if (l) txt.push(buf.toString('utf8', p + 1, p + 1 + l));
        p += 1 + l;
      }
      out.push({ name: n.name, type, data: txt });
    } else if (type === T_A && len === 4) {
      out.push({ name: n.name, type, data: [...buf.subarray(start, start + 4)].join('.') });
    }
  }
  return out;
}

const lower = (s: string) => s.toLowerCase();

// The services the records describe: an instance needs its PTR and SRV; TXT path= and u= are optional.
export function servicesOf(records: DnsRecord[]): FileDiscovered[] {
  const out: FileDiscovered[] = [];
  for (const ptr of records.filter((r) => r.type === T_PTR && SERVICE_TYPES.includes(lower(r.name)))) {
    const instance = ptr.data as string;
    const srv = records.find((r) => r.type === T_SRV && lower(r.name) === lower(instance))?.data as { target: string; port: number } | undefined;
    if (!srv?.target || !srv.port) continue;
    const txt = new Map(((records.find((r) => r.type === T_TXT && lower(r.name) === lower(instance))?.data as string[] | undefined) ?? []).map((kv) => [lower(kv.split('=')[0]), kv.slice(kv.indexOf('=') + 1)]));
    const host = srv.target.replace(/\.$/, '');
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) continue;
    const name = instance.slice(0, instance.length - ptr.name.length - 1).slice(0, 120) || host;
    const type = lower(ptr.name);
    if (type.startsWith('_smb')) {
      out.push({ protocol: 'smb', name, url: `\\\\${host}\\` });
      continue;
    }
    const raw = txt.get('path') ?? '/';
    const path = (raw.startsWith('/') ? raw : `/${raw}`).replace(/[^\w\-./~%]/g, '').slice(0, 300);
    const secure = type.startsWith('_webdavs');
    const port = (secure && srv.port === 443) || (!secure && srv.port === 80) ? '' : `:${srv.port}`;
    const user = txt.get('u')?.slice(0, 256);
    out.push({ protocol: 'webdav', name, url: `${secure ? 'https' : 'http'}://${host}${port}${path}`, ...(user ? { user } : {}) });
  }
  return out;
}

// Loopback or an address in the subnet of one of this machine's IPv4 interfaces.
function isLocal(address: string): boolean {
  if (address.startsWith('127.')) return true;
  const ip = address.split('.').map(Number);
  if (ip.length !== 4) return false;
  return Object.values(os.networkInterfaces()).some((list) =>
    (list ?? []).some((e) => {
      if (e.family !== 'IPv4') return false;
      const mine = e.address.split('.').map(Number);
      const mask = e.netmask.split('.').map(Number);
      return mask.every((m, i) => (mine[i] & m) === (ip[i] & m));
    }),
  );
}

// target: the checks answer their own query on 127.0.0.1.
export function discover(target: { address: string; port: number } = { address: MDNS_ADDRESS, port: MDNS_PORT }, waitMs = WAIT_MS): Promise<FileDiscovered[]> {
  return new Promise((resolve) => {
    const found = new Map<string, FileDiscovered>();
    let replies = 0;
    const socket = dgram.createSocket({ type: 'udp4' });
    const finish = () => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, waitMs);
    socket.on('error', (err) => {
      log.warn('mdns query failed', err);
      finish();
    });
    socket.on('message', (msg, rinfo) => {
      if (++replies > MAX_REPLIES || !isLocal(rinfo.address)) return;
      for (const s of servicesOf(parsePacket(msg) ?? [])) if (found.size < MAX_REPLIES) found.set(s.url, s);
    });
    socket.bind(0, () => {
      try {
        if (target.address === MDNS_ADDRESS) socket.setMulticastTTL(255);
      } catch {
        // Not fatal: the default TTL still reaches the local link.
      }
      socket.send(buildQuery(), target.port, target.address, (err) => err && log.warn('mdns send failed', err));
    });
  });
}
