<script lang="ts">
  import Toggle from '../../components/Toggle.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { web } from '../../lib/platform';
  import { settings } from '../../lib/stores.svelte';
  import { set } from './shared.svelte';

  const s = $derived(settings.value);
</script>

{#if s}
  <!-- Casting runs in the desktop's main process; the web TV app (lib/platform.ts) only keeps "Play on". -->
  {#if !web}
    <h3 class="gh">{t('settings.cast.toTv')}</h3>
    <div class="group">
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.cast.discovery')}</div>
        </div>
        <Toggle label={t('settings.cast.discovery')} checked={s.cast.discovery} onchange={(v) => set({ cast: { discovery: v } })} />
      </div>
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.cast.relay')}</div>
          <div class="desc">{t('settings.cast.relayHint')}</div>
        </div>
        <Toggle label={t('settings.cast.relay')} checked={s.cast.relay} onchange={(v) => set({ cast: { relay: v } })} />
      </div>
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.cast.allowHevc')}</div>
          <div class="desc">{t('settings.cast.allowHevcHint')}</div>
        </div>
        <Toggle label={t('settings.cast.allowHevc')} checked={s.cast.allowHevc} onchange={(v) => set({ cast: { allowHevc: v } })} />
      </div>
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.cast.dolby')}</div>
        </div>
        <Toggle label={t('settings.cast.dolby')} checked={s.cast.dolby} onchange={(v) => set({ cast: { dolby: v } })} />
      </div>
    </div>
  {/if}

  <h3 class="gh">{t('settings.cast.controlTitle')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.remoteControl')}</div>
        <div class="desc">{t('settings.playback.remoteControlHint')}</div>
      </div>
      <Toggle label={t('settings.playback.remoteControl')} checked={s.remote.allowControl} onchange={(v) => set({ remote: { allowControl: v } })} />
    </div>
  </div>
{/if}

<style>
  .gh {
    margin: 30px 0 8px 2px;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
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
  /* Hairlines only between rows that are still shown. */
  :global(.searching) .row::before {
    display: none;
  }
  :global(.searching) .row:not([hidden]) ~ .row:not([hidden])::before {
    display: block;
  }

  /* Compact density tightens these rows as well. */
  :global(html[data-density='compact']) .row {
    min-height: 50px;
    padding-block: 9px;
  }
</style>
