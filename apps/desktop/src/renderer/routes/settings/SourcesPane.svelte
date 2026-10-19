<script lang="ts">
  import FileSourcesSettings from '../../components/FileSourcesSettings.svelte';
  import ImmichSettings from '../../components/ImmichSettings.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { web } from '../../lib/platform';
  import { settings } from '../../lib/stores.svelte';
  import { set } from './shared.svelte';

  const s = $derived(settings.value);

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
  <FileSourcesSettings />
  <ImmichSettings />

  <!-- The photo map is a desktop feature; the web TV app (lib/platform.ts) has no setting for it. -->
  {#if !web}
    <h3 class="gh">{t('settings.sources.map')}</h3>
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
