<script lang="ts">
  // Settings > Library > "Sources de photos" (photos spec PH-12): connect an Immich server with an API key. The key
  // goes to main once (vault) and never comes back; Test checks the version (2.0 or later) and which permissions
  // the key lacks, each one hiding its feature.
  import type { ImmichTestResult } from '../../shared/contract';
  import { w } from '../lib/bridge';
  import { t } from '../lib/i18n.svelte';
  import { immich, watchImmichSources } from '../lib/photos/immich.svelte';
  import { errorMessage, toast } from '../lib/stores.svelte';

  watchImmichSources();
  let url = $state('');
  let key = $state('');
  let busy = $state(false);
  let result = $state<ImmichTestResult | null>(null);

  async function run(add: boolean): Promise<void> {
    busy = true;
    try {
      const r = add ? await w.photos.immich.add(url, key) : await w.photos.immich.test(url, key);
      result = r;
      if (add && r.ok) {
        key = '';
        url = '';
        toast('success', t('photos.sources.added'));
      }
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = false;
    }
  }

  const message = (r: ImmichTestResult) =>
    r.ok
      ? t('photos.sources.ok', { version: r.version ?? '' })
      : r.error === 'version'
        ? t('photos.sources.versionTooOld', { version: r.version ?? '' })
        : t(`photos.sources.error.${r.error ?? 'server'}`);
</script>

<h3 class="gh">{t('photos.sources.title')}</h3>
<div class="group">
  {#each immich.sources as s (s.id)}
    <div class="row">
      <div class="txt">
        <div class="lbl">{s.name}</div>
        <div class="desc">{s.url}</div>
      </div>
      <button type="button" class="btn sm" onclick={() => void w.photos.immich.remove(s.id).catch((err) => toast('error', errorMessage(err)))}>{t('photos.sources.remove')}</button>
    </div>
  {/each}
  <label class="row field-row">
    <span class="lbl">{t('photos.sources.url')}</span>
    <input class="field" type="url" spellcheck="false" autocomplete="off" placeholder="http://photos.local:2283" bind:value={url} />
  </label>
  <label class="row field-row">
    <span class="lbl">{t('photos.sources.key')}</span>
    <input class="field" type="password" autocomplete="off" bind:value={key} />
  </label>
  <div class="row">
    <div class="txt"><div class="desc">{t('photos.sources.keyHint')}</div></div>
    <button type="button" class="btn sm" disabled={busy || !url.trim() || !key.trim()} onclick={() => run(false)}>{t('photos.sources.test')}</button>
    <button type="button" class="btn sm primary" disabled={busy || !url.trim() || !key.trim()} onclick={() => run(true)}>{t('photos.sources.add')}</button>
  </div>
  {#if result}
    <div class="row compact" role="status">
      <div class="txt">
        <div class="desc" class:bad={!result.ok}>{message(result)}</div>
        {#if result.missing.length > 0}<div class="desc">{t('photos.sources.scopesMissing', { scopes: result.missing.join(', ') })}</div>{/if}
      </div>
    </div>
  {/if}
</div>
<p class="foot">{t('photos.sources.foot')}</p>

<style>
  /* Same look as the rows of routes/Settings.svelte. */
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
    gap: 12px;
    min-height: 58px;
    padding: 12px 18px;
  }
  .row.compact {
    min-height: 46px;
    padding-block: 8px;
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
  .field-row {
    min-height: 52px;
    padding-block: 8px;
  }
  .field-row .lbl {
    flex: none;
    width: 120px;
  }
  .field-row .field {
    flex: 1;
    height: 34px;
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
    overflow-wrap: anywhere;
  }
  .desc.bad {
    color: var(--label-2);
  }
  .foot {
    margin: 10px 2px 0;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.5;
  }
  .btn.sm {
    height: 30px;
    padding: 0 12px;
    font-size: var(--fs-footnote);
  }
</style>
