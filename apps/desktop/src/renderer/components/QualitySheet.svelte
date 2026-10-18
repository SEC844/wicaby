<script lang="ts" module>
  import { QUALITY_PRESETS } from '../../shared/quality-presets';
  import { fmt, t } from '../lib/i18n.svelte';

  const mbps = (bitrate: number) => fmt.bitrate(bitrate / 1e6, bitrate % 1e6 === 0 ? 0 : bitrate % 1e5 === 0 ? 1 : 2);

  // "720p · 2 Mb/s"; "Originale" for 0 / null.
  export function qualityLabel(bitrate: number | null | undefined): string {
    const p = QUALITY_PRESETS.find((q) => q.bitrate === bitrate);
    return p ? t('player.quality.preset', { height: p.height, bitrate: mbps(p.bitrate) }) : t('player.quality.original');
  }
</script>

<script lang="ts">
  import type { PlaybackCommand, PlaybackState } from '../../shared/contract';
  import type { QualityRow } from '../../shared/quality-presets';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  // X-02 quality sheet: Version (2 or more sources) and Quality (Original, then the presets main kept
  // by coversSource). A pick reloads in place in main; the row spins until the new stream is there.
  let { open, state: s, onclose, oncommand }: { open: boolean; state: PlaybackState | null; onclose: () => void; oncommand: (c: PlaybackCommand) => void } = $props();

  const opts = $derived(s?.qualityOptions);
  const cur = $derived(s?.currentQuality);
  const switching = $derived(Boolean(cur?.switching));
  const methodTag = $derived(s?.playMethod === 'Transcode' ? t('player.quality.transcode') : t('player.quality.direct'));

  // The pick in flight: closes the sheet once main reports it, stays open (with main's notice) on failure.
  let pending = $state<string | null>(null);
  let seen = false;
  $effect(() => {
    const busy = switching;
    if (!pending) return;
    if (busy) {
      seen = true;
      return;
    }
    if (!seen) return;
    seen = false;
    const ok = pending === `v:${cur?.mediaSourceId}` || pending === `q:${cur?.maxBitrate}`;
    pending = null;
    if (ok) onclose();
  });
  $effect(() => {
    if (!open) pending = null;
  });

  function pickVersion(id: string): void {
    if (switching || id === cur?.mediaSourceId) return;
    pending = `v:${id}`;
    oncommand({ type: 'quality', maxBitrate: cur?.maxBitrate ?? null, mediaSourceId: id });
  }

  function pickQuality(r: QualityRow): void {
    if (switching || r.maxBitrate === (cur?.maxBitrate ?? null)) return;
    pending = `q:${r.maxBitrate}`;
    oncommand({ type: 'quality', maxBitrate: r.maxBitrate, mediaSourceId: cur?.mediaSourceId });
  }

  function rowLabel(r: QualityRow): string {
    if (r.maxBitrate !== null) return qualityLabel(r.maxBitrate);
    const detail = [r.height ? `${r.height}p` : '', r.bitrate ? mbps(r.bitrate) : ''].filter(Boolean).join(' · ');
    return detail ? `${t('player.quality.original')} · ${detail}` : t('player.quality.original');
  }

  const sizeText = (size?: number, percent?: number) =>
    size ? (percent !== undefined ? t('player.quality.size', { size: fmt.bytes(size), percent }) : fmt.bytes(size)) : '';
</script>

<Sheet {open} {onclose} label={t('player.quality.title')} width={opts?.versions.length ? 640 : 400}>
  <div class="body">
    <h2 class="title-3">{t('player.quality.title')}</h2>
    <div class="cols" class:two={Boolean(opts?.versions.length)}>
      {#if opts?.versions.length}
        <section aria-label={t('player.quality.version')}>
          <h3 class="col-h">{t('player.quality.version')}</h3>
          <ul class="rows">
            {#each opts.versions as v, i (v.id)}
              {@const on = v.id === cur?.mediaSourceId}
              <li>
                <button role="menuitemradio" aria-checked={on} aria-busy={pending === `v:${v.id}`} data-autofocus={i === 0 || undefined} disabled={switching && pending !== `v:${v.id}`} onclick={() => pickVersion(v.id)}>
                  <span class="check">
                    {#if pending === `v:${v.id}`}<span class="spin" aria-hidden="true"></span>{:else if on}<Icon name="check" size={14} stroke={2.4} />{/if}
                  </span>
                  <span class="lbl">{v.label}</span>
                  {#if on}<span class="tag">{methodTag}</span>{/if}
                  {#if v.size}<span class="size mono">{fmt.bytes(v.size)}</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
      <section aria-label={t('player.quality.quality')}>
        {#if opts?.versions.length}<h3 class="col-h">{t('player.quality.quality')}</h3>{/if}
        <ul class="rows">
          {#each opts?.rows ?? [] as r, i (r.maxBitrate)}
            {@const on = r.maxBitrate === (cur?.maxBitrate ?? null)}
            <li>
              <button role="menuitemradio" aria-checked={on} aria-busy={pending === `q:${r.maxBitrate}`} data-autofocus={(!opts?.versions.length && i === 0) || undefined} disabled={switching && pending !== `q:${r.maxBitrate}`} onclick={() => pickQuality(r)}>
                <span class="check">
                  {#if pending === `q:${r.maxBitrate}`}<span class="spin" aria-hidden="true"></span>{:else if on}<Icon name="check" size={14} stroke={2.4} />{/if}
                </span>
                <span class="lbl">{rowLabel(r)}</span>
                {#if on}<span class="tag">{methodTag}</span>{/if}
                {#if r.size}<span class="size mono">{sizeText(r.size, r.percent)}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      </section>
    </div>
  </div>
</Sheet>

<style>
  .body {
    padding: 24px 24px 20px;
  }
  h2 {
    margin: 0;
    padding-right: 40px;
  }
  .cols {
    display: grid;
    gap: 16px;
    margin-top: 14px;
  }
  .cols.two {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
  }
  .col-h {
    margin: 0 0 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--label-2);
  }
  .rows {
    list-style: none;
    margin: 0 -8px;
    padding: 0;
    max-height: min(60vh, 460px);
    overflow-y: auto;
  }
  .rows button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    text-align: left;
  }
  .rows button:hover:not(:disabled),
  .rows button:focus-visible {
    background: var(--fill-2);
  }
  .rows button:disabled {
    opacity: 0.45;
  }
  .check {
    width: 16px;
    flex: none;
    display: grid;
    place-items: center;
  }
  .lbl {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag {
    flex: none;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
    border: 1px solid var(--separator);
    color: var(--label-2);
  }
  .size {
    flex: none;
    font-size: 12px;
    color: var(--label-2);
    font-variant-numeric: tabular-nums;
  }
  .spin {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid var(--label-3);
    border-top-color: var(--label);
    animation: spin var(--t-spin) linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
