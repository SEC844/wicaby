import { adminAlerts, type AlertSystemInfo, type AlertTask } from '../../shared/admin-alerts';
import { caps } from '../../shared/server-caps';
import type { ConnectionManager } from '../connection/connection-manager';
import { JsonStore } from '../core/json-store';
import { logger } from '../core/log';
import type { SettingsService } from '../core/settings';
import { t } from '../i18n';
import type { WindowManager } from '../windows/window-manager';
import type { Notifier } from './notify';

const log = logger.scope('admin-alerts');

// Light polling: two small GETs per administered server.
const POLL_MS = 15 * 60_000;
const FIRST_POLL_MS = 60_000;

// Background tray notifications for administrators: a failed scheduled task, a server
// restart required, a server update available. Same routes on Emby and Jellyfin; a route
// the server refuses or lacks just yields no alert.
export class AdminAlerts {
  private readonly store: JsonStore<{ seen: string[] }>;
  private busy = false;

  constructor(
    private readonly deps: { connection: ConnectionManager; settings: SettingsService; windows: WindowManager; notifier: Notifier },
    file: string,
  ) {
    this.store = new JsonStore(file, { seen: [] });
    setTimeout(() => void this.poll(), FIRST_POLL_MS).unref();
    setInterval(() => void this.poll(), POLL_MS).unref();
  }

  private async poll(): Promise<void> {
    const { connection, settings, windows, notifier } = this.deps;
    if (this.busy || !settings.value.windows.notifyAdmin) return;
    // In use and in front, the window's admin pages show the same thing: no toast, no request.
    const main = windows.main;
    if (main && !main.isDestroyed() && main.isVisible() && main.isFocused()) return;
    this.busy = true;
    try {
      for (const serverId of connection.onlineIds()) {
        const s = connection.sessionFor(serverId);
        // caps.admin: a Plex owner has no Emby admin API to poll.
        if (!s?.user?.isAdmin || !caps(s.server.kind).admin) continue;
        const api = connection.apiFor(serverId);
        const quiet = (what: string) => (err: unknown) => (log.debug(`${what} on ${s.server.name}: ${String(err)}`), null);
        const [info, tasks] = await Promise.all([
          api.get<AlertSystemInfo>('/System/Info').catch(quiet('system info')),
          api.get<AlertTask[]>('/ScheduledTasks', { IsHidden: false }).catch(quiet('scheduled tasks')),
        ]);
        const result = adminAlerts(serverId, info, tasks, this.store.value.seen);
        this.store.set({ seen: result.seen });
        const server = s.server.name;
        for (const a of result.alerts) {
          if (a.kind === 'task') notifier.show({ title: t('main.notify.admin.taskFailed'), body: `${a.name} · ${server}`, route: `/admin/${serverId}/tasks` });
          else if (a.kind === 'restart') notifier.show({ title: t('main.notify.admin.restartTitle'), body: t('main.notify.admin.restartBody', { server }), route: `/admin/${serverId}/dashboard` });
          else notifier.show({ title: t('main.notify.admin.updateTitle'), body: t('main.notify.admin.updateBody', { server }), route: `/admin/${serverId}/dashboard` });
        }
      }
    } finally {
      this.busy = false;
    }
  }

  flush(): void {
    this.store.flush();
  }
}
