<script lang="ts">
  import Picker from '../../components/Picker.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { invalidateApiCache } from '../../lib/api';
  import { w } from '../../lib/bridge';
  import { bytes } from '../../lib/format';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { dataVersion, errorMessage, settings, toast } from '../../lib/stores.svelte';
  import { set, type SettingsData } from './shared.svelte';

  let { data }: { data: SettingsData } = $props();

  const COMIC_CAPS = $derived([0.5, 1, 2, 5, 10].map((v) => ({ value: v, label: t('settings.units.gigabytes', { size: fmt.number(v) }) })));

  const s = $derived(settings.value);

  // ---- Storage ----
  const storage = $derived(data.storage);
  async function clearStorage(kind: 'http' | 'logs'): Promise<void> {
    try {
      data.storage = await w.app.clearStorage(kind);
      toast('success', kind === 'http' ? t('settings.privacy.imageCache.cleared') : t('settings.privacy.logs.cleared'));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  function clearApiCache(): void {
    invalidateApiCache();
    // Pages already open refetch on the next data version.
    dataVersion.library++;
    dataVersion.userData++;
    toast('success', t('settings.privacy.apiCache.cleared'));
  }

  // ---- Photo map (photos spec PH-09): off by default; the tile host sees the areas viewed ----
  let tileDraft = $state<string | null>(null);
  let tileRefused = $state(false);
  const host = (u: string) => {
    try {
      return new URL(u.replace(/\{[zxy]\}/g, '0')).host;
    } catch {
      return u;
    }
  };
  async function saveTiles(): Promise<void> {
    const draft = tileDraft?.trim();
    if (draft === undefined || draft === s?.photos.map.tileUrl) return void (tileDraft = null);
    await set({ photos: { map: { tileUrl: draft } } });
    // Main keeps only an http(s) template with {z} {x} {y}; anything else falls back to the default.
    tileRefused = settings.value?.photos.map.tileUrl !== draft;
    tileDraft = null;
  }
  let attrDraft = $state<string | null>(null);
  function saveAttribution(): void {
    if (attrDraft !== null && attrDraft.trim() && attrDraft !== s?.photos.map.attribution) void set({ photos: { map: { attribution: attrDraft } } });
    attrDraft = null;
  }
</script>

{#if s}
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.privacy.imageCache.label')}</div>
        <div class="desc">{storage ? t('settings.privacy.imageCache.descSize', { size: bytes(storage.http) }) : t('settings.privacy.imageCache.desc')}</div>
      </div>
      <button type="button" class="push" onclick={() => clearStorage('http')}>{t('settings.privacy.clear')}</button>
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.privacy.apiCache.label')}</div>
        <div class="desc">{t('settings.privacy.apiCache.desc')}</div>
      </div>
      <button type="button" class="push" onclick={clearApiCache}>{t('settings.privacy.clear')}</button>
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.privacy.comicCache.label')}</div>
        <div class="desc">{storage ? t('settings.privacy.comicCache.descSize', { size: bytes(storage.comics) }) : t('settings.privacy.comicCache.desc')}</div>
      </div>
      <Picker label={t('settings.privacy.comicCache.aria')} value={s.system.comicCacheGb} options={COMIC_CAPS} onchange={(v) => set({ system: { comicCacheGb: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.privacy.logs.label')}</div>
        <div class="desc">{storage ? t('settings.privacy.logs.descSize', { size: bytes(storage.logs) }) : t('settings.privacy.logs.desc')}</div>
      </div>
      <div class="actions">
        <button type="button" class="push ghost" onclick={() => w.app.openPath('logs')}>{t('common.actions.open')}</button>
        <button type="button" class="push" onclick={() => clearStorage('logs')}>{t('common.actions.delete')}</button>
      </div>
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.privacy.dataFolder.label')}</div>
        <div class="desc">{t('settings.privacy.dataFolder.desc')}</div>
      </div>
      <button type="button" class="push" onclick={() => w.app.openPath('data')}>{t('common.actions.open')}</button>
    </div>
    {#if data.info?.vaultPlainText}
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.privacy.plainTextVault.label')}</div>
          <div class="desc">{t('settings.privacy.plainTextVault.desc')}</div>
        </div>
        <Toggle label={t('settings.privacy.plainTextVault.label')} checked={s.system.plainTextVault} onchange={(v) => set({ system: { plainTextVault: v } })} />
      </div>
    {/if}
  </div>
  <p class="foot">{t('settings.privacy.foot')}</p>

  <div class="group map">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('photos.map.enableTitle')}</div>
        <div class="desc">{t('photos.map.enableBody', { host: host(s.photos.map.tileUrl) })}</div>
      </div>
      <Toggle label={t('photos.map.enable')} checked={s.photos.map.enabled} onchange={(v) => set({ photos: { map: { enabled: v } } })} />
    </div>
    {#if s.photos.map.enabled}
      <div class="row stack">
        <div class="txt">
          <div class="lbl">{t('photos.map.tileUrl')}</div>
          <div class="desc">{t('photos.map.tileUrlHint')}</div>
        </div>
        <input
          class="field mono"
          type="text"
          spellcheck="false"
          autocomplete="off"
          aria-label={t('photos.map.tileUrl')}
          value={tileDraft ?? s.photos.map.tileUrl}
          oninput={(e) => ((tileDraft = e.currentTarget.value), (tileRefused = false))}
          onblur={saveTiles}
          onkeydown={(e) => {
            if (e.key === 'Enter') void saveTiles();
          }}
        />
        {#if tileRefused}<div class="desc warn">{t('photos.map.tileUrlInvalid')}</div>{/if}
        <input
          class="field"
          type="text"
          spellcheck="false"
          autocomplete="off"
          aria-label={t('photos.map.attribution')}
          placeholder={t('photos.map.attribution')}
          value={attrDraft ?? s.photos.map.attribution}
          oninput={(e) => (attrDraft = e.currentTarget.value)}
          onblur={saveAttribution}
          onkeydown={(e) => {
            if (e.key === 'Enter') saveAttribution();
          }}
        />
      </div>
    {/if}
  </div>
{/if}

<style>
  .foot {
    margin: 10px 2px 0;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.5;
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
  .group.map {
    margin-top: 22px;
  }
  .row.stack {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .field {
    width: 100%;
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--r-xs);
    background: var(--fill-1);
    box-shadow: inset 0 0 0 1px var(--separator);
    font-size: var(--fs-footnote);
    color: var(--label);
    outline: none;
  }
  .field:focus {
    background: var(--fill-2);
  }
  .desc.warn {
    color: var(--warning);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
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
  .actions .push.ghost:has(:global(svg)) {
    width: 28px;
    padding: 0;
    display: grid;
    place-items: center;
  }

  /* Compact density tightens these rows as well. */
  :global(html[data-density='compact']) .row {
    min-height: 50px;
    padding-block: 9px;
  }
</style>
