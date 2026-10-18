<script lang="ts">
  import { cubicOut } from 'svelte/easing';
  import { fly } from 'svelte/transition';
  import { w } from '../lib/bridge';
  import { appUpdate, dismissUpdate } from '../lib/app-update.svelte';
  import { t } from '../lib/i18n.svelte';
  import Icon from './Icon.svelte';
  import { dur } from '../lib/motion';

  // A newer Wicaby on GitHub Releases (main/features/app-updates.ts): a quiet card under the title bar, like the
  // toasts, until "Later" (remembered for that version) or a download.
  const update = $derived(appUpdate.value?.dismissed ? null : appUpdate.value?.update);
</script>

{#if update}
  <section class="notice" role="status" aria-label={t('shell.update.label')} in:fly={{ y: -16, duration: dur('med'), easing: cubicOut }}>
    <span class="glyph"><Icon name="download" size={15} stroke={2.1} /></span>
    <div class="body">
      <p class="msg">{t('shell.update.available', { version: update.version })}</p>
      <div class="actions">
        <button class="btn primary" onclick={() => w.updates.open('download')}>{t('shell.update.download')}</button>
        <button class="btn" onclick={() => w.updates.open('notes')}>{t('shell.update.notes')}</button>
        <button class="btn ghost" onclick={() => void dismissUpdate()}>{t('shell.update.later')}</button>
      </div>
    </div>
  </section>
{/if}

<style>
  .notice {
    position: fixed;
    top: calc(var(--titlebar) + 10px);
    right: 16px;
    z-index: 990;
    display: flex;
    gap: 12px;
    width: min(380px, calc(100vw - 32px));
    padding: 12px 14px 12px 12px;
    border-radius: var(--r-md);
    background: var(--material-thick);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    box-shadow:
      0 0 0 0.5px var(--hairline),
      var(--shadow-2);
  }
  .glyph {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    flex: none;
    border-radius: 50%;
    background: var(--fill-2);
    color: var(--label);
  }
  .body {
    min-width: 0;
    flex: 1;
  }
  .msg {
    margin: 4px 0 10px;
    font-size: var(--fs-callout);
    font-weight: 560;
    color: var(--label);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .actions .btn {
    height: 30px;
    padding: 0 12px;
  }
</style>
