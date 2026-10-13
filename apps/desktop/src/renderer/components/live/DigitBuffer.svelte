<script lang="ts">
  import type { ZapEntry } from '../../../shared/contract';
  import type { DigitPreview } from '../../../shared/livetv/zap';
  import { t } from '../../lib/i18n.svelte';
  import { imageUrl } from '../../lib/images';

  // Number entry (livetv-spec-final.md §8.4, §11): the buffer as "1 0 _", top right, title-1 mono, and
  // the preview: the exact match (with duplicates, "{count} chaînes" and the picked one), else the
  // first channel the buffer starts, else "Aucune chaîne".
  let { buf, preview, entry, serverId }: { buf: string; preview: DigitPreview | null; entry: (id: string) => ZapEntry | undefined; serverId: string } = $props();

  const id = $derived(!preview || preview.kind === 'none' ? null : preview.kind === 'exact' ? preview.ids[preview.pick] : preview.id);
  const hit = $derived(id ? entry(id) : undefined);
  const dupes = $derived(preview?.kind === 'exact' && preview.ids.length > 1 ? preview.ids.length : 0);
  const logo = $derived(hit?.logoTag ? imageUrl(hit.id, 'Primary', { tag: hit.logoTag, maxHeight: 32, server: serverId }) : '');
</script>

<div class="digits" aria-hidden="true">
  <div class="buf mono">{[...buf, '_'].join(' ')}</div>
  <div class="preview" class:weak={preview?.kind === 'prefix'} data-kind={preview?.kind}>
    {#if hit}
      {#if logo}<img src={logo} alt="" decoding="async" />{/if}
      <span class="nm"><span class="mono">{hit.number}</span> {hit.name}</span>
      {#if dupes}<span class="dupes">{t('player.live.duplicates', { count: dupes })}</span>{/if}
    {:else}
      <span class="none">{t('player.live.noMatch')}</span>
    {/if}
  </div>
</div>

<style>
  .digits {
    position: absolute;
    top: 72px;
    right: 48px;
    z-index: 5;
    min-width: 200px;
    padding: 12px 18px 14px;
    border-radius: var(--r-lg);
    /* Opaque enough for a 7:1 contrast over any picture (§12). */
    background: var(--bg-elevated-2);
    box-shadow:
      inset 0 0 0 0.5px var(--hairline),
      var(--shadow-2);
    color: var(--label);
    text-align: right;
    animation: digits-in var(--t-fast) var(--ease-out) both;
  }
  @keyframes digits-in {
    from {
      opacity: 0;
      transform: translate3d(0, -6px, 0);
    }
  }
  .buf {
    font-size: var(--fs-title-1);
    font-weight: 600;
    letter-spacing: 0.04em;
    font-variant-numeric: tabular-nums;
    white-space: pre;
  }
  .preview {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
    font-size: var(--fs-callout);
  }
  .preview.weak {
    color: var(--label-2);
  }
  .preview img {
    max-width: 48px;
    max-height: 24px;
    object-fit: contain;
  }
  .nm {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 260px;
  }
  .dupes {
    color: var(--label-2);
  }
  .none {
    color: var(--label-3);
  }
</style>
