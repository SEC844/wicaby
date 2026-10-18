// The video player the platform provides: AVPlay on Tizen (hardware pipeline, HDR10/HDR10+), a <video> element on
// webOS and in a browser. Times are in milliseconds.
export interface Track {
  index: number;
  language: string;
  label: string;
}

export interface PlayerEvents {
  time: (positionMs: number) => void;
  buffering: (on: boolean) => void;
  ended: () => void;
  error: (message: string) => void;
}

export interface VideoPlayer {
  open(url: string, startMs?: number): Promise<void>;
  play(): void;
  pause(): void;
  seek(ms: number): void;
  stop(): void;
  readonly durationMs: number;
  readonly positionMs: number;
  readonly paused: boolean;
  audioTracks(): Track[];
  textTracks(): Track[];
  selectAudio(index: number): void;
  selectText(index: number | null): void;
  on<E extends keyof PlayerEvents>(event: E, cb: PlayerEvents[E]): () => void;
}

// Shared listener bookkeeping for the implementations.
export class Emitter {
  private readonly listeners = new Map<keyof PlayerEvents, Set<(...a: never[]) => void>>();

  on<E extends keyof PlayerEvents>(event: E, cb: PlayerEvents[E]): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  protected emit<E extends keyof PlayerEvents>(event: E, ...args: Parameters<PlayerEvents[E]>): void {
    this.listeners.get(event)?.forEach((cb) => (cb as (...a: Parameters<PlayerEvents[E]>) => void)(...args));
  }
}
