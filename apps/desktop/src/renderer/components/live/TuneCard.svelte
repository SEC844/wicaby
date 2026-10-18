<script lang="ts">
  import type { ZapEntry } from '../../../shared/contract';
  import { t } from '../../lib/i18n.svelte';
  import { imageUrl } from '../../lib/images';

  // Full-screen channel card on black (livetv-spec-final.md §8.1 tune card, §21.2 F6 radio screen):
  // while a new stream demuxes, and for the whole time a radio channel plays (no video surface).
  let { entry, serverId, now = '', next = '', radio = false }: { entry: ZapEntry; serverId: string; now?: string; next?: string; radio?: boolean } = $props();

  const logo = $derived(entry.logoTag ? imageUrl(entry.id, 'Primary', { tag: entry.logoTag, maxHeight: radio ? 200 : 120, server: serverId }) : '');
</script>

<div class="card on-media" class:radio aria-hidden="true">
  <div class="mid">
    {#if logo}
      <img src={logo} alt="" decoding="async" />
    {:else}
      <div class="num mono">{entry.number}</div>
      <div class="name">{entry.name}</div>
    {/if}
    {#if radio && logo}<div class="name">{entry.name}</div>{/if}
    {#if radio}<div class="next">{t('player.live.radio')}</div>{/if}
    {#if now}<div class="now">{now}</div>{/if}
    {#if radio && next}<div class="next">{next}</div>{/if}
  </div>
</div>

<style>
  .card {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: grid;
    place-items: center;
    background: #000;
    color: var(--label);
    pointer-events: none;
    animation: card-in var(--t-fast) var(--ease-out) both;
  }
  @keyframes card-in {
    from {
      opacity: 0;
    }
  }
  .mid {
    display: grid;
    justify-items: center;
    gap: 10px;
    /* Above the OSD's centre spinner. */
    transform: translateY(-12vh);
  }
  img {
    max-width: 280px;
    max-height: 120px;
    object-fit: contain;
  }
  .radio img {
    max-width: 360px;
    max-height: 200px;
  }
  .num {
    font-size: var(--fs-title-1);
    color: var(--label-2);
  }
  .name {
    font-size: var(--fs-title-3, 19px);
    font-weight: 600;
  }
  .now {
    font-size: var(--fs-headline);
    color: var(--label-2);
  }
  .next {
    font-size: var(--fs-callout);
    color: var(--label-3);
  }
</style>
