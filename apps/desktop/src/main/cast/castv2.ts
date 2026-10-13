// A CASTV2 sender channel (cast-spec CA-09), written clean-room from Chromium's BSD-licensed cast_channel.proto and
// the public behaviour of open senders, never from the Cast SDK. Sender only: it never claims to be a receiver.
// TLS with rejectUnauthorized:false: devices present Google device-CA certificates and sender-side device
// authentication is skipped (a fake Chromecast on the LAN is accepted; cast-spec §6, docs/features.md Privacy).
// CONNECT to receiver-0, PING every 5 s, and the channel is lost after 3 PINGs without an answer (or on a close).
import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import { logger } from '../core/log';
import { encodeFrame, frameReader, type CastMessage } from './castv2-codec';

const log = logger.scope('castv2');

export const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
  connectsdk: 'urn:x-cast:com.connectsdk',
};
export const RECEIVER = 'receiver-0';

export type Payload = Record<string, unknown> & { type?: string; requestId?: number };

export class CastError extends Error {
  constructor(readonly reply: string) {
    super(`Cast: ${reply}`);
  }
}

// Events: 'message' (namespace, payload, source), 'lost' (once, the channel is gone).
export class CastChannel extends EventEmitter {
  static pingMs = 5000;
  static missLimit = 3;
  static requestMs = 5000;
  static connectMs = 5000;

  readonly source = `sender-${Math.floor(Math.random() * 1e9)}`;
  private socket: tls.TLSSocket | null = null;
  private nextId = 1;
  private missed = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;
  private pending = new Map<number, { resolve: (p: Payload) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  async connect(host: string, port: number): Promise<void> {
    const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ host, port, rejectUnauthorized: false });
      const timer = setTimeout(() => (s.destroy(), reject(new Error('Cast: connect timed out'))), CastChannel.connectMs);
      s.once('secureConnect', () => (clearTimeout(timer), resolve(s)));
      s.once('error', (err) => (clearTimeout(timer), reject(err)));
    });
    this.socket = socket;
    const read = frameReader((m) => this.onMessage(m));
    socket.on('data', (chunk: Buffer) => {
      try {
        read(chunk);
      } catch (err) {
        log.warn(`bad frame from ${host}: ${String(err)}`);
        this.lose();
      }
    });
    socket.on('error', (err) => log.debug(`socket: ${err.message}`));
    socket.on('close', () => this.lose());
    this.send(NS.connection, RECEIVER, { type: 'CONNECT' });
    this.heartbeat = setInterval(() => {
      if (this.missed >= CastChannel.missLimit) return this.lose();
      this.missed++;
      this.send(NS.heartbeat, RECEIVER, { type: 'PING' });
    }, CastChannel.pingMs);
  }

  send(namespace: string, destination: string, payload: Payload): void {
    if (!this.socket || this.closed) return;
    this.socket.write(encodeFrame({ source: this.source, destination, namespace, data: JSON.stringify(payload) }));
  }

  // Sends with a requestId and resolves with the reply that carries it (an error type rejects).
  request(namespace: string, destination: string, payload: Payload): Promise<Payload> {
    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new CastError('CLOSED'));
      const timer = setTimeout(() => (this.pending.delete(requestId), reject(new CastError('TIMEOUT'))), CastChannel.requestMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send(namespace, destination, { ...payload, requestId });
    });
  }

  private onMessage(m: CastMessage): void {
    let p: Payload;
    try {
      p = JSON.parse(m.data) as Payload;
    } catch {
      return log.debug(`non-JSON message on ${m.namespace}`);
    }
    if (!p || typeof p !== 'object') return;
    if (m.namespace === NS.heartbeat) {
      if (p.type === 'PING') this.send(NS.heartbeat, m.source, { type: 'PONG' });
      this.missed = 0;
      return;
    }
    const waiting = typeof p.requestId === 'number' && p.requestId > 0 ? this.pending.get(p.requestId) : undefined;
    if (waiting) {
      this.pending.delete(p.requestId!);
      clearTimeout(waiting.timer);
      if (/ERROR|FAILED|INVALID/.test(String(p.type))) waiting.reject(new CastError(String(p.type)));
      else waiting.resolve(p);
    }
    this.emit('message', m.namespace, p, m.source);
  }

  private lose(): void {
    if (this.closed) return;
    this.shutdown();
    this.emit('lost');
  }

  // Closes without a 'lost' event (the sender ended the cast itself).
  close(): void {
    if (this.closed) return;
    this.send(NS.connection, RECEIVER, { type: 'CLOSE' });
    this.shutdown();
  }

  private shutdown(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const [, w] of this.pending) (clearTimeout(w.timer), w.reject(new CastError('CLOSED')));
    this.pending.clear();
    // end() lets a last CLOSE out; destroy() follows in case the device never answers the FIN.
    const s = this.socket;
    s?.end();
    if (s) setTimeout(() => s.destroy(), 1000).unref();
  }
}
