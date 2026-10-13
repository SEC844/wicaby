import { EventEmitter } from 'node:events';
import type { ServerKind } from '../../shared/contract';
import { logger } from '../core/log';
import { routed } from './api-client';

const log = logger.scope('socket');

export interface SocketMessage {
  MessageType: string;
  Data?: unknown;
}

// Realtime channel to the server (remote control, library and user data
// changes). Emby Theater relied on WNS natively and left this to the JS app;
// Wicaby keeps it in main so it survives renderer reloads.
export class ServerSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private attempts = 0;
  private closed = false;
  private gen = 0;
  // 'down' once it dropped, until it is back (the first connect is not a drop).
  state: 'connecting' | 'open' | 'down' = 'connecting';
  // How long a connect waits for beforeConnect (X-01: the capabilities POST).
  static beforeConnectTimeoutMs = 5000;

  constructor(
    private readonly address: string,
    private readonly kind: ServerKind,
    private readonly token: string,
    private readonly deviceId: string,
    // Runs before every connect, reconnects included: Emby only delivers LibraryChanged to a session whose
    // capabilities arrived before its socket connected. A failure or a timeout still connects.
    private readonly beforeConnect?: () => Promise<unknown>,
  ) {
    super();
  }

  open(): void {
    this.closed = false;
    void this.connect(++this.gen);
  }

  private async connect(gen: number): Promise<void> {
    if (this.beforeConnect) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), ServerSocket.beforeConnectTimeoutMs);
      });
      await Promise.race([this.beforeConnect(), timeout])
        .catch((err) => log.warn('capabilities report failed', err))
        .finally(() => clearTimeout(timer));
    }
    // Closed, or opened again, while waiting.
    if (this.closed || gen !== this.gen) return;
    const base = routed(this.address).replace(/^http/i, 'ws');
    // Plex (plex-spec §2): its notifications socket, the token as a header (Node's WebSocket takes headers).
    if (this.kind === 'plex') {
      try {
        const init = { headers: { 'X-Plex-Token': this.token, 'X-Plex-Client-Identifier': this.deviceId } };
        this.ws = new WebSocket(`${base}/:/websockets/notifications`, init as unknown as string[]);
      } catch (err) {
        log.warn('WebSocket constructor failed', err);
        this.scheduleReconnect();
        return;
      }
      this.listen();
      return;
    }
    const path = this.kind === 'emby' ? '/embywebsocket' : '/socket';
    // Jellyfin 12 rejects the legacy api_key query parameter by default; ApiKey is accepted by 10.x too.
    const tokenParam = this.kind === 'emby' ? 'api_key' : 'ApiKey';
    const url = `${base}${path}?${tokenParam}=${encodeURIComponent(this.token)}&deviceId=${encodeURIComponent(this.deviceId)}`;
    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      log.warn('WebSocket constructor failed', err);
      this.scheduleReconnect();
      return;
    }
    this.listen();
  }

  private listen(): void {
    if (!this.ws) return;
    this.ws.addEventListener('open', () => {
      this.attempts = 0;
      this.state = 'open';
      log.info('connected');
      this.emit('open');
    });
    this.ws.addEventListener('message', (ev) => {
      try {
        if (this.kind === 'plex') return this.plexEvent(JSON.parse(String(ev.data)));
        const msg = JSON.parse(String(ev.data)) as SocketMessage;
        if (msg.MessageType === 'ForceKeepAlive') this.startKeepAlive(Number(msg.Data) || 60);
        else if (msg.MessageType !== 'KeepAlive') this.emit('message', msg);
      } catch {
        // Ignore malformed frames.
      }
    });
    this.ws.addEventListener('close', () => {
      this.stopKeepAlive();
      if (this.closed) return;
      this.state = 'down';
      this.emit('down');
      this.scheduleReconnect();
    });
    this.ws.addEventListener('error', () => {
      // 'close' follows and handles reconnection.
    });
  }

  // PMS notifications as the Emby messages the app already reacts to: a timeline entry (an item changed, watched
  // state included) drops the cached lists; a 'playing' one that stopped this client's session becomes
  // PlexSessionEnded (plex-spec §6.5: the server ended it); nothing else is forwarded (Plex sends no remote commands).
  private plexEvent(n: { NotificationContainer?: { type?: string; PlaySessionStateNotification?: { state?: string; clientIdentifier?: string; ratingKey?: string | number }[] } }): void {
    const type = n?.NotificationContainer?.type;
    if (type === 'playing') {
      for (const s of n.NotificationContainer?.PlaySessionStateNotification ?? []) {
        if (s.state === 'stopped' && s.clientIdentifier === this.deviceId && s.ratingKey !== undefined) this.emit('message', { MessageType: 'PlexSessionEnded', Data: { ItemId: String(s.ratingKey) } } satisfies SocketMessage);
      }
      return;
    }
    if (type !== 'timeline') return;
    this.emit('message', { MessageType: 'UserDataChanged' } satisfies SocketMessage);
    this.emit('message', { MessageType: 'LibraryChanged' } satisfies SocketMessage);
  }

  private startKeepAlive(timeoutSeconds: number): void {
    this.stopKeepAlive();
    const every = Math.max(5, timeoutSeconds * 0.5) * 1000;
    this.keepAlive = setInterval(() => this.send('KeepAlive'), every);
    this.send('KeepAlive');
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retry) return;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.attempts++, 6));
    log.debug(`reconnecting in ${delay} ms`);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.open();
    }, delay);
  }

  // The server answers again (network change, wake, a recheck): a dropped socket connects now
  // instead of at the end of its backoff.
  reconnectNow(): void {
    if (this.closed || this.state !== 'down' || !this.retry) return;
    clearTimeout(this.retry);
    this.retry = null;
    this.attempts = 0;
    this.open();
  }

  send(type: string, data?: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(data === undefined ? { MessageType: type } : { MessageType: type, Data: data }));
  }

  close(): void {
    this.closed = true;
    this.gen++;
    this.stopKeepAlive();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.ws?.close();
    this.ws = null;
  }
}
