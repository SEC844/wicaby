// The user's server-side configuration (Settings.kt ServerConfig): audio and subtitle languages and the subtitle
// mode, from which Emby and Jellyfin pick the default streams, so every client follows the same preference. A save
// that fails puts the old value back and says so.
import type { Api } from './api';

export class ServerConfig {
  config = $state<Record<string, unknown> | null>(null);
  failed = $state(false);

  constructor(private readonly api: Api) {
    api.userConfiguration().then(
      (c) => (this.config = c),
      () => {},
    );
  }

  str(key: string): string {
    return String(this.config?.[key] ?? '');
  }

  async set(key: string, value: string): Promise<void> {
    const old = this.config;
    if (!old) return;
    this.config = { ...old, [key]: value };
    try {
      await this.api.setUserConfiguration(this.config);
      this.failed = false;
    } catch {
      this.failed = true;
      this.config = old;
    }
  }
}
