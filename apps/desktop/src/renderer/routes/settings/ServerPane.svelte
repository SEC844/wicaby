<script lang="ts">
  import { kindLabel } from '../../../shared/server-caps';
  import { w } from '../../lib/bridge';
  import { t } from '../../lib/i18n.svelte';
  import { vaultNoteKey } from '../../lib/vault.svelte';
  import { navigate } from '../../lib/router.svelte';
  import { errorMessage, multiServer, session, settings, toast } from '../../lib/stores.svelte';

  const s = $derived(settings.value);

  async function logout(serverId?: string): Promise<void> {
    try {
      await w.session.logout(serverId);
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  async function switchServer(): Promise<void> {
    try {
      await w.session.disconnect();
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }
</script>

{#if s}
  <!-- One group per server this session holds, primary first. -->
  {#each session.value.sessions.filter((x) => x.server.kind !== 'files') as ss (ss.server.id)}
    {@const srv = ss.server}
    {@const st = ss.status}
    <div class="group srv">
      <div class="row">
        <div class="txt">
          <div class="lbl">{srv.name}</div>
          <div class="desc">{kindLabel(srv.kind, t('files.kind'))} {srv.version}{ss.address ? ` · ${ss.address}` : ''}</div>
        </div>
        <span class="status" class:ok={st === 'signed-in'} class:bad={st === 'offline'}>
          {st === 'signed-in'
            ? t('settings.server.status.signedIn')
            : st === 'offline'
              ? t('common.status.offline')
              : st === 'server-selected'
                ? t('settings.server.status.notSignedIn')
                : t('settings.server.status.connecting')}
        </span>
      </div>
      {#if ss.user}
        <div class="row">
          <span class="avatar">{ss.user.name.slice(0, 1).toUpperCase()}</span>
          <div class="txt">
            <div class="lbl">{ss.user.name}</div>
            <div class="desc">{ss.user.isAdmin ? t('settings.general.account.admin') : t('settings.general.account.user')}</div>
          </div>
          {#if ss.user.isAdmin && st === 'signed-in'}
            <button type="button" class="push ghost" onclick={() => navigate(`/admin/${encodeURIComponent(srv.id)}/dashboard`)}>{t('admin.title')}</button>
          {/if}
          <button type="button" class="push" onclick={() => logout(srv.id)}>{t('settings.server.signOut')}</button>
        </div>
      {/if}
    </div>
  {/each}
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.server.add.label')}</div>
        <div class="desc">{t('settings.server.add.desc')}</div>
      </div>
      <button type="button" class="push" onclick={() => navigate('/servers')}>{t('settings.server.add.button')}</button>
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.panes.remote.label')}</div>
        <div class="desc">{t('settings.panes.remote.blurb')}</div>
      </div>
      <button type="button" class="push" onclick={() => navigate('/settings?pane=remote')}>{t('common.actions.open')}</button>
    </div>
    {#if !multiServer()}
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.server.switch.label')}</div>
          <div class="desc">{t('settings.server.switch.desc')}</div>
        </div>
        <button type="button" class="push" onclick={switchServer}>{t('settings.server.switch.button')}</button>
      </div>
    {/if}
  </div>
  <p class="foot">{t(vaultNoteKey('settings.server.foot', 'settings.server.footLinux'))}</p>
{/if}

<style>
  .foot {
    margin: 10px 2px 0;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.5;
  }
  .srv + .group {
    margin-top: 12px;
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
  /* Hairline between rows, inset to the text edge. */
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
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--label);
  }
  .desc {
    display: block;
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.45;
  }

  /* Push button: small, neutral. */
  .push {
    flex: none;
    height: 28px;
    padding: 0 12px;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    font-size: var(--fs-callout);
    font-weight: 500;
    color: var(--label);
    white-space: nowrap;
    transition: background-color var(--t-fast) var(--ease);
  }
  .push:hover,
  .push:focus-visible {
    background: var(--fill-3);
  }
  .push.ghost {
    background: transparent;
    color: var(--label-2);
  }
  .push.ghost:hover,
  .push.ghost:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    flex: none;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .status::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--label-3);
  }
  .status.ok::before {
    background: var(--success);
  }
  .status.bad::before {
    background: var(--warning);
  }

  /* Neutral monogram, no gradient. */
  .avatar {
    flex: none;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: var(--fs-body);
    font-weight: 600;
    color: var(--label);
    background: var(--fill-3);
  }
  :global(.searching) .foot {
    display: none;
  }
  /* Hairlines only between rows that are still shown. */
  :global(.searching) .row::before {
    display: none;
  }
  :global(.searching) .row:not([hidden]) ~ .row:not([hidden])::before {
    display: block;
  }
  .push:disabled {
    color: var(--label-4);
    pointer-events: none;
  }

  /* Compact density tightens these rows as well. */
  :global(html[data-density='compact']) .row {
    min-height: 50px;
    padding-block: 9px;
  }
</style>
