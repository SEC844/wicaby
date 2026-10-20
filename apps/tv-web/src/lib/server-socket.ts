// The server's realtime channel (Android core ServerSocket, desktop main/connection/server-socket.ts): its
// LibraryChanged and UserDataChanged messages, and SyncPlay's group updates and commands (onSocket). The capabilities
// go first: Emby only delivers LibraryChanged to a session whose capabilities arrived before its socket connected.
// Reconnects with a backoff while open.
import type { Api } from './api';
import { canSetVolume } from '../platform/index';
import { deviceId } from './identity';
import { supportedCommands } from './remote-control';
import { settings } from './settings.svelte';

type Listener = (type: string, data: unknown) => void;
const listeners = new Set<Listener>();

// Every message of the signed-in session's socket (Core.socketMessages), while one is open.
export function onSocket(cb: Listener): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

// Makes this session a remote-control target ("Play on", X-06) as Settings > "Control from other devices" says; off,
// messages only. Posted before every connect, and again when the setting changes.
export function postCapabilities(api: Api): Promise<void> {
  const control = settings.remoteControl.value;
  return api.post('/Sessions/Capabilities/Full', {
    PlayableMediaTypes: ['Audio', 'Video'],
    SupportedCommands: supportedCommands(canSetVolume()),
    SupportsMediaControl: control,
    SupportsPersistentIdentifier: true,
  });
}

export class ServerSocket {
  private ws: WebSocket | null = null;
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private closed = false;

  constructor(
    private readonly api: Api,
    private readonly onMessage: (type: string) => void,
  ) {}

  open(): void {
    this.closed = false;
    void this.connect();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    clearInterval(this.keepAlive);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private async connect(): Promise<void> {
    await postCapabilities(this.api).catch(() => {});
    if (this.closed || !this.api.token) return;
    // Jellyfin 12 rejects the legacy api_key parameter by default; ApiKey is accepted by 10.x too.
    const path = this.api.isEmby ? `/embywebsocket?api_key=` : `/socket?ApiKey=`;
    const url = `${this.api.base.replace(/^http/i, 'ws')}${path}${encodeURIComponent(this.api.token)}&deviceId=${encodeURIComponent(deviceId)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return this.reconnect();
    }
    this.ws = ws;
    ws.onopen = () => (this.attempts = 0);
    ws.onmessage = (ev) => {
      let msg: { MessageType?: string; Data?: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.MessageType === 'ForceKeepAlive') this.startKeepAlive(Number(msg.Data) || 60);
      else if (msg.MessageType && msg.MessageType !== 'KeepAlive') {
        this.onMessage(msg.MessageType);
        for (const cb of listeners) cb(msg.MessageType, msg.Data);
      }
    };
    ws.onclose = () => {
      clearInterval(this.keepAlive);
      if (this.ws === ws) this.reconnect();
    };
  }

  private startKeepAlive(timeoutSeconds: number): void {
    clearInterval(this.keepAlive);
    const send = () => this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ MessageType: 'KeepAlive' }));
    this.keepAlive = setInterval(send, Math.max(5, timeoutSeconds * 0.5) * 1000);
    send();
  }

  // 2, 4, 8… s, at most a minute apart.
  private reconnect(): void {
    if (this.closed) return;
    this.ws = null;
    const delay = Math.min(60_000, 2000 * 2 ** this.attempts++);
    this.retry = setTimeout(() => void this.connect(), delay);
  }
}
