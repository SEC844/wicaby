<script lang="ts">
  // TV en direct without a server tuner: live TV comes from a tuner or an M3U list set up on the media server, so
  // this page links each signed-in server's own Live TV settings (in the browser) and points to IPTV, which needs
  // no server. Admin routes: Emby #!/livetvsetup, Jellyfin #/dashboard/livetv, Plex's server settings on app.plex.tv
  // (each server's web app may move them; the link still lands in its dashboard).
  import type { ServerSession } from '../../../shared/contract';
  import { kindLabel } from '../../../shared/server-caps';
  import Icon from '../../components/Icon.svelte';
  import { w } from '../../lib/bridge';
  import { t } from '../../lib/i18n.svelte';
  import { navigate } from '../../lib/router.svelte';
  import { errorMessage, iptvSessions, onlineSessions, toast } from '../../lib/stores.svelte';

  // Per kind, from the server's web address (Plex: from its machine id, on app.plex.tv). Other kinds have none.
  const ADMIN: Partial<Record<string, (base: string, id: string) => string>> = {
    emby: (b) => `${b}/web/index.html#!/livetvsetup`,
    jellyfin: (b) => `${b}/web/#/dashboard/livetv`,
    plex: (_b, id) => `https://app.plex.tv/desktop/#!/settings/server/${encodeURIComponent(id)}/settings`,
  };
  function adminUrl(s: ServerSession): string | null {
    const make = ADMIN[s.server.kind];
    const base = (s.address ?? '').replace(/\/+$/, '');
    if (!make || (s.server.kind !== 'plex' && !/^https?:\/\//i.test(base))) return null;
    return make(base, s.server.id);
  }

  const servers = $derived(onlineSessions().map((s) => ({ s, url: adminUrl(s) })).filter((x) => x.url));
  const hasIptv = $derived(iptvSessions().length > 0);

  function open(url: string): void {
    w.app.openExternal(url).catch((err) => toast('error', errorMessage(err)));
  }
</script>

<section class="setup" aria-labelledby="live-setup-title">
  <Icon name="live" size={36} />
  <h2 id="live-setup-title" class="title-2">{t('livetv.setup.title')}</h2>
  <p class="lead">{t('livetv.setup.body')}</p>

  {#if servers.length}
    <ul class="list">
      {#each servers as { s, url } (s.server.id)}
        <li>
          <button class="row" onclick={() => open(url!)}>
            <span class="meta">
              <span class="name">{s.server.name}</span>
              <span class="sub">{t('livetv.setup.openAdmin', { kind: kindLabel(s.server.kind) })}</span>
            </span>
            <Icon name="externalLink" size={16} />
          </button>
        </li>
      {/each}
    </ul>
    <p class="hint">{t('livetv.setup.adminOnly')}</p>
  {:else}
    <p class="hint">{t('livetv.setup.noServer')}</p>
  {/if}

  <div class="iptv">
    <p>{t('livetv.setup.iptv')}</p>
    <button class="btn" onclick={() => navigate(hasIptv ? '/iptv?tab=now' : '/iptv')}>{t(hasIptv ? 'livetv.setup.openIptv' : 'livetv.setup.addIptv')}</button>
  </div>
</section>

<style>
  .setup {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    max-width: 560px;
    padding: 24px 0 48px;
    color: var(--label-2);
  }
  .setup > :global(.wi-icon) {
    color: var(--label-3);
  }
  .title-2 {
    margin: 4px 0 0;
    color: var(--label);
  }
  .lead {
    margin: 0;
    font-size: var(--fs-callout);
    line-height: 1.5;
  }
  .list {
    list-style: none;
    align-self: stretch;
    margin: 8px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 52px;
    padding: 8px 12px;
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--label-2);
  }
  .row:hover {
    background: var(--fill-1);
  }
  .row:focus-visible {
    background: var(--fill-3);
    color: var(--label);
  }
  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .name {
    color: var(--label);
    font-weight: 560;
  }
  .sub,
  .hint {
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .hint {
    margin: 0;
  }
  .iptv {
    align-self: stretch;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--separator);
  }
  .iptv p {
    margin: 0;
    font-size: var(--fs-callout);
  }
</style>
