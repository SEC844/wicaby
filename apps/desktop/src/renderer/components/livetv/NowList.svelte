<script lang="ts">
  import type { ChannelRow } from '../../../shared/livetv/model';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { legacyChannel, legacyProgram, openProgram, playChannel } from '../../lib/livetv.svelte';
  import type { LiveTvStore } from '../../lib/livetv.svelte';
  import { channelLogoUrl, logoPlate } from '../Guide.svelte';

  // "Toutes les chaînes" (§3.1): a compact virtualized list, never a wall of tiles. Now and next come
  // from the guide cache; rows on screen ask for the "now" slab in one batched request.
  let { store, rows }: { store: LiveTvStore; rows: readonly ChannelRow[] } = $props();

  const ROW = 56;
  const OVERSCAN = 6;
  let box = $state<HTMLDivElement>();
  let top = $state(0);
  let height = $state(600);

  const first = $derived(Math.max(0, Math.floor(top / ROW) - OVERSCAN));
  const last = $derived(Math.min(rows.length, Math.ceil((top + height) / ROW) + OVERSCAN));
  const items = $derived.by(() => {
    const out = [];
    for (let i = first; i < last; i++) {
      const r = rows[i];
      const [now, next] = store.nowNext(r.id, store.clock);
      if (!now && !next) store.demandNow(r.id);
      out.push({ r, i, now, next });
    }
    return out;
  });

  $effect(() => {
    if (!box) return;
    const ro = new ResizeObserver(() => (height = box?.clientHeight ?? height));
    ro.observe(box);
    return () => ro.disconnect();
  });
</script>

<div class="list" bind:this={box} onscroll={() => (top = box?.scrollTop ?? 0)} style:height="min(70vh, {Math.max(1, rows.length) * ROW}px)">
  <ul style:height="{rows.length * ROW}px">
    {#each items as { r, i, now, next } (r.id)}
      <li style:transform="translate3d(0, {i * ROW}px, 0)">
        <button class="row" onclick={() => playChannel(r.id, store.serverId)} oncontextmenu={(e) => (e.preventDefault(), now && openProgram(legacyProgram(now, store), legacyChannel(r, store)))} aria-label={[r.number, r.name, now?.title].filter(Boolean).join(', ')}>
          <span class="num mono">{r.number}</span>
          <span class="logo-box">{#if r.logoTag}<img class="logo" src={channelLogoUrl(r, 32)} alt="" crossorigin="anonymous" loading="lazy" decoding="async" use:logoPlate />{/if}</span>
          <span class="name">{r.name}</span>
          <span class="now">
            <span class="title">{now?.title ?? t('livetv.guide.noInfo')}</span>
            {#if now}
              <span class="bar" aria-hidden="true"><span style:transform="scaleX({Math.min(1, Math.max(0, (store.clock - now.start) / (now.end - now.start)))})"></span></span>
            {/if}
          </span>
          <span class="next caption">{#if next}<span class="mono">{fmt.time(next.start)}</span> {next.title}{/if}</span>
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .list {
    overflow-y: auto;
    overscroll-behavior: contain;
    border-radius: var(--r-lg);
    background: var(--bg-elevated);
  }
  ul {
    position: relative;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 56px;
  }
  .row {
    width: 100%;
    height: 100%;
    display: grid;
    grid-template-columns: 44px 72px minmax(120px, 1fr) minmax(160px, 2fr) minmax(120px, 1.4fr);
    align-items: center;
    gap: 12px;
    padding: 0 16px;
    text-align: left;
    color: var(--label-2);
    box-shadow: inset 0 -1px 0 var(--separator);
  }
  .row:is(:hover, :focus-visible) {
    background: var(--fill-4);
    color: var(--label);
  }
  .num {
    color: var(--label-3);
    font-size: var(--fs-footnote);
  }
  .logo-box {
    height: 32px;
  }
  .logo {
    width: 64px;
    height: 32px;
    object-fit: contain;
    object-position: left center;
    border-radius: var(--r-xs);
  }
  .logo:global([data-plate]) {
    padding: 2px 4px;
    background: color-mix(in srgb, var(--label) 85%, transparent);
  }
  .name,
  .title,
  .next {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name {
    font-weight: 560;
    color: var(--label);
  }
  .now {
    min-width: 0;
    display: grid;
    gap: 5px;
  }
  .bar {
    height: 2px;
    border-radius: 1px;
    background: var(--fill-2);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--label);
    opacity: 0.6;
    transform-origin: left;
  }
</style>
