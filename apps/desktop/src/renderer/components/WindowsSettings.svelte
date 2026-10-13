<script lang="ts">
  import type { Settings } from '../../shared/contract';
  import Toggle from './Toggle.svelte';
  import { t } from '../lib/i18n.svelte';
  import { linux } from '../lib/platform';
  import { errorMessage, onlineSessions, settings, toast, updateSettings } from '../lib/stores.svelte';

  // "Windows" pane of the settings: tray, startup and notifications.
  // Self-contained (no props); reads and writes settings.windows.
  const win = $derived(settings.value?.windows);
  // Admin alerts only concern servers where this user is an administrator.
  const admin = $derived(onlineSessions().some((s) => s.user?.isAdmin));

  async function set(patch: Partial<Settings['windows']>): Promise<void> {
    try {
      await updateSettings({ windows: patch });
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }
</script>

{#if win}
  <h3 class="gh first">{t('settings.windows.window')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t(linux ? 'settings.windows.closeToTray.labelLinux' : 'settings.windows.closeToTray.label')}</div>
        <div class="desc">{t(linux ? 'settings.windows.closeToTray.descLinux' : 'settings.windows.closeToTray.desc')}</div>
      </div>
      <Toggle label={t(linux ? 'settings.windows.closeToTray.labelLinux' : 'settings.windows.closeToTray.label')} checked={win.closeToTray} onchange={(v) => set({ closeToTray: v })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t(linux ? 'settings.windows.launchAtStartup.labelLinux' : 'settings.windows.launchAtStartup.label')}</div>
        <div class="desc">{t(linux ? 'settings.windows.launchAtStartup.descLinux' : 'settings.windows.launchAtStartup.desc')}</div>
      </div>
      <Toggle label={t(linux ? 'settings.windows.launchAtStartup.labelLinux' : 'settings.windows.launchAtStartup.label')} checked={win.launchAtStartup} onchange={(v) => set({ launchAtStartup: v })} />
    </div>
  </div>

  <h3 class="gh">{t('settings.windows.notifications')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.windows.notifyDownloads.label')}</div>
        <div class="desc">{t('settings.windows.notifyDownloads.desc')}</div>
      </div>
      <Toggle label={t('settings.windows.notifyDownloads.label')} checked={win.notifyDownloads} onchange={(v) => set({ notifyDownloads: v })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.windows.notifyNewEpisodes.label')}</div>
        <div class="desc">{t('settings.windows.notifyNewEpisodes.desc')}</div>
      </div>
      <Toggle label={t('settings.windows.notifyNewEpisodes.label')} checked={win.notifyNewEpisodes} onchange={(v) => set({ notifyNewEpisodes: v })} />
    </div>
    {#if admin}
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.windows.notifyAdmin.label')}</div>
          <div class="desc">{t('settings.windows.notifyAdmin.desc')}</div>
        </div>
        <Toggle label={t('settings.windows.notifyAdmin.label')} checked={win.notifyAdmin} onchange={(v) => set({ notifyAdmin: v })} />
      </div>
    {/if}
  </div>
  <p class="foot">{t('settings.windows.foot')}</p>
{/if}

<style>
  /* Same look as the rows of routes/Settings.svelte. */
  .gh {
    margin: 30px 0 8px 2px;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
  }
  .gh.first {
    margin-top: 0;
  }
  .group {
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
    overflow: hidden;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 16px;
    min-height: 58px;
    padding: 12px 18px;
  }
  .row + .row::before {
    content: '';
    position: absolute;
    top: 0;
    left: 18px;
    right: 0;
    height: 1px;
    background: var(--separator);
  }
  .txt {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .lbl {
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--label);
  }
  .desc {
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.45;
  }
  .foot {
    margin: 10px 2px 0;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.5;
  }
</style>
