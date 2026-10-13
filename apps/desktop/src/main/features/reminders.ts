// Live TV reminders (livetv-spec-final.md §9.6, LT-19) and the wicaby://live deep link (§3.1, LT-24, F3).
// Reminders are kept on this device per server and user. One timer aims at the next due reminder, at
// most a minute ahead, so a sleep, a clock change or a time-zone change is caught within a minute;
// resume re-arms at once. Due: a notification ("Regarder", or a click, tunes) and an in-app toast; with
// live.reminderAutoTune while a channel plays, a 10 s countdown in the OSD that "Rester ici" cancels.
// Never auto-tune during VOD.
// Programme times are server times: each reminder carries the renderer's clock skew (§21.4) from when it
// was set, and fires on the client clock shifted by it.
import { powerMonitor } from 'electron';
import { Channels, type LiveReminder, type PlaybackState, type PlayRequest, type ReminderCountdown } from '../../shared/contract';
import type { ConnectionManager } from '../connection/connection-manager';
import { JsonStore } from '../core/json-store';
import { logger } from '../core/log';
import type { SettingsService } from '../core/settings';
import { language, t } from '../i18n';
import type { WindowManager } from '../windows/window-manager';
import { cleanReminder, clientDueAt, matchChannel, takeDue, type ChannelDto } from '../../shared/livetv/reminders';
import type { Notifier } from './notify';

const log = logger.scope('reminders');

const MAX_WAIT_MS = 60_000;
const COUNTDOWN_MS = 10_000;
const MAX_REMINDERS = 200;
// Deep link cold start (F3): the servers may still be connecting.
const LINK_TRIES = 5;
const LINK_RETRY_MS = 2_000;

interface Stored extends LiveReminder {
  user: string;
  leadMin: number;
  autoTune: boolean;
}

export interface ReminderDeps {
  connection: ConnectionManager;
  settings: SettingsService;
  windows: WindowManager;
  notifier: Notifier;
  playback: { getState(): PlaybackState; play(req: PlayRequest): Promise<void> };
}

export class Reminders {
  private readonly store: JsonStore<{ items: Stored[] }>;
  private timer: NodeJS.Timeout | null = null;
  private countdown: { timer: NodeJS.Timeout; r: Stored } | null = null;

  constructor(
    file: string,
    private readonly deps: ReminderDeps,
  ) {
    this.store = new JsonStore(file, { items: [] });
    if (!Array.isArray(this.store.value.items)) this.store.set({ items: [] });
    powerMonitor.on('resume', () => this.arm());
    this.arm();
  }

  private user(serverId: string): string {
    return this.deps.connection.clientOf(serverId)?.userId ?? '';
  }

  list(): LiveReminder[] {
    return this.store.value.items
      .filter((r) => r.user === this.user(r.serverId))
      .map(({ serverId, programId, channelId, start, title, channelName }) => ({ serverId, programId, channelId, start, title, channelName }));
  }

  toggle(v: unknown): boolean {
    const r = cleanReminder(v);
    if (!r) throw new Error(t('errors.ipc.invalidId'));
    const user = this.user(r.serverId);
    const items = this.store.value.items;
    const same = (x: Stored) => x.serverId === r.serverId && x.programId === r.programId && x.user === user;
    const on = !items.some(same);
    const live = this.deps.settings.live;
    const next = on ? [...items, { ...r, user, leadMin: live.reminderLeadMin, autoTune: live.reminderAutoTune }].slice(-MAX_REMINDERS) : items.filter((x) => !same(x));
    this.store.set({ items: next });
    this.arm();
    return on;
  }

  stay(): void {
    if (!this.countdown) return;
    clearTimeout(this.countdown.timer);
    this.countdown = null;
    this.deps.windows.broadcast(Channels.remindersCountdown, null);
  }

  flush(): void {
    this.store.flush();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const now = Date.now();
    const items = this.store.value.items;
    const { fire, keep } = takeDue(items, now);
    if (keep.length !== items.length) this.store.set({ items: keep });
    for (const r of fire) this.fire(r);
    const next = Math.min(...keep.map(clientDueAt));
    this.timer = Number.isFinite(next) ? setTimeout(() => this.arm(), Math.max(0, Math.min(MAX_WAIT_MS, next - now))) : null;
  }

  private fire(r: Stored): void {
    const time = new Date(r.start).toLocaleTimeString(language(), { hour: '2-digit', minute: '2-digit' });
    const title = t('main.notify.reminderTitle', { title: r.title });
    const body = t('main.notify.reminderBody', { channel: r.channelName, time });
    log.info(`reminder: ${r.title} on ${r.channelName}`);
    const watch = () => void this.watch(r.channelId, r.serverId);
    const action = { text: t('main.notify.reminderAction'), run: () => (this.deps.windows.focusMain(), watch()) };
    this.deps.notifier.show({ title, body, actions: [action], onClick: watch });
    this.deps.windows.broadcast(Channels.toast, { kind: 'info', message: `${title} · ${body}` });
    const s = this.deps.playback.getState();
    // Auto-tune only over a channel already playing, never over VOD.
    if (!r.autoTune || !s.active || !s.live || s.live.channel.id === r.channelId) return;
    if (this.countdown) clearTimeout(this.countdown.timer);
    const c: ReminderCountdown = { title: r.title, channelName: r.channelName, at: Date.now() + COUNTDOWN_MS };
    this.countdown = {
      r,
      timer: setTimeout(() => {
        this.countdown = null;
        this.deps.windows.broadcast(Channels.remindersCountdown, null);
        if (this.deps.playback.getState().live) void this.watch(r.channelId, r.serverId);
      }, COUNTDOWN_MS),
    };
    this.deps.windows.broadcast(Channels.remindersCountdown, c);
  }

  // "Regarder", the countdown and the deep link: tune the channel (by id, number or name). Retries 5 × 2 s
  // while the server is not signed in yet or its channel list fails (cold start, F3).
  async watch(channel: string, serverId?: string): Promise<boolean> {
    const { connection, playback, windows } = this.deps;
    for (let i = 0; i < LINK_TRIES; i++) {
      if (i) await new Promise((r) => setTimeout(r, LINK_RETRY_MS));
      const sid = serverId ?? connection.primaryId;
      const api = connection.onlineApi(sid);
      if (!sid || !api?.userId) continue;
      const res = await api
        .get<{ Items?: ChannelDto[] }>('/LiveTv/Channels', { UserId: api.userId, EnableImages: false, EnableUserData: false, Limit: 5000 })
        .catch((err: unknown) => (log.warn('channel list failed', err), null));
      if (!res) continue;
      const hit = matchChannel(res.Items ?? [], channel);
      if (!hit) break;
      log.info(`tuning ${hit.Name ?? hit.Id}`);
      await playback.play({ itemIds: [hit.Id], serverId: sid }).catch((err: unknown) => log.warn('tune failed', err));
      return true;
    }
    log.warn(`no channel "${channel}"`);
    windows.broadcast(Channels.toast, { kind: 'error', message: t('main.notify.channelNotFound', { channel }) });
    return false;
  }
}
