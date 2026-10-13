import { EventEmitter } from 'node:events';
import type { PlaybackState } from '../../shared/contract';
import { lastPlayed } from '../../shared/history';
import type { BaseItem, ItemsResult } from '../../shared/models';
import type { ConnectionManager } from '../connection/connection-manager';
import type { SocketMessage } from '../connection/server-socket';
import { userResume } from '../connection/user-routes';
import { logger } from '../core/log';
import type { PlaybackService } from '../playback/playback-service';

const log = logger.scope('continue');

// A jump list or tray entry: opens the item through the --wicaby-nav route.
export interface ContinueEntry {
  title: string;
  route: string;
}

const MAX = 5;
// Several triggers arrive together (a stop, then UserDataChanged): one fetch for all.
const DEBOUNCE_MS = 3_000;

// The top "Continue watching" items across every signed-in server, for the taskbar
// jump list and the tray menu. Refreshed when resume data can have changed: sign-in,
// a server's UserDataChanged, the end of a playback.
export class ContinueWatching extends EventEmitter {
  entries: ContinueEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private online = '';
  private wasPlaying = false;

  constructor(
    private readonly connection: ConnectionManager,
    playback: PlaybackService,
  ) {
    super();
    connection.on('session', () => {
      const ids = connection.onlineIds().join(',');
      if (ids !== this.online) this.schedule();
      this.online = ids;
    });
    connection.on('server-message', (msg: SocketMessage) => {
      if (msg.MessageType === 'UserDataChanged') this.schedule();
    });
    playback.on('state', (s: PlaybackState) => {
      if (this.wasPlaying && !s.active) this.schedule();
      this.wasPlaying = s.active;
    });
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, DEBOUNCE_MS);
  }

  private async refresh(): Promise<void> {
    const { connection } = this;
    const lists = await Promise.all(
      connection.onlineIds().map(async (serverId) => {
        try {
          const res = await userResume<ItemsResult>(connection.apiFor(serverId), connection.userIdFor(serverId), {
            Limit: MAX,
            MediaTypes: 'Video',
            EnableImages: false,
          });
          return (res.Items ?? []).map((i): BaseItem => ({ ...i, ServerId: serverId }));
        } catch (err) {
          // A server down or without the route simply contributes nothing.
          log.debug(`resume on ${serverId}: ${String(err)}`);
          return [];
        }
      }),
    );
    // Servers already order by last play; across servers the most recent wins (stable for ties).
    const next = lists
      .flat()
      .sort((a, b) => lastPlayed(b) - lastPlayed(a))
      .filter((i) => /^[A-Za-z0-9-]{1,64}$/.test(i.Id) && /^[A-Za-z0-9-]{1,64}$/.test(i.ServerId ?? ''))
      .slice(0, MAX)
      .map((i) => {
        const title = i.SeriesName ? `${i.SeriesName} · ${i.Name}` : i.Name;
        return { title: title.length > 60 ? `${title.slice(0, 59)}…` : title, route: `/item/${i.ServerId}/${i.Id}` };
      });
    if (JSON.stringify(next) === JSON.stringify(this.entries)) return;
    this.entries = next;
    this.emit('change', next);
  }
}
