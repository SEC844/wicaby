<script lang="ts">
  // Android TV TrackPanel (PlayerActivity.kt): a card along the bottom with the audio tracks, the subtitles ("Off"
  // first), and the quick subtitle look (size, position, the Settings values). It keeps the focus (data-focus-trap)
  // and opens on the selected audio track; each column scrolls with the focus.
  import { onMount } from 'svelte';
  import type { MediaStream } from '$shared/models';
  import { focusable, focusFirst } from '../../lib/focus';
  import { t } from '../../lib/i18n.svelte';
  import { edgeDelta } from '../../lib/scroll';
  import { settings } from '../../lib/settings.svelte';
  import Icon from '../Icon.svelte';

  let {
    audio,
    subtitles,
    audioIndex,
    subtitleIndex,
    onaudio,
    onsubtitle,
  }: {
    audio: MediaStream[];
    subtitles: MediaStream[];
    audioIndex: number | null;
    subtitleIndex: number;
    onaudio: (index: number) => void;
    onsubtitle: (index: number) => void;
  } = $props();

  const label = (s: MediaStream) => s.DisplayTitle || s.Title || s.Language || t('track_unknown', s.Index);
  const columns = $derived([
    { key: 'a', title: t('audio'), weight: 1.3, rows: audio.map((s) => ({ id: s.Index, text: label(s) })), selected: audioIndex ?? audio.find((s) => s.IsDefault)?.Index, pick: onaudio },
    {
      key: 's', title: t('subtitles'), weight: 1.3,
      rows: [{ id: -1, text: t('subtitles_off') }, ...subtitles.map((s) => ({ id: s.Index, text: label(s) }))], selected: subtitleIndex, pick: onsubtitle,
    },
    {
      key: 'z', title: t('subtitle_size'), weight: 1,
      rows: ['size_small', 'size_normal', 'size_large', 'size_xlarge'].map((k, i) => ({ id: i, text: t(k) })),
      selected: settings.subtitleSize.value, pick: (i: number) => (settings.subtitleSize.value = i),
    },
    {
      key: 'p', title: t('subtitle_position'), weight: 1,
      rows: ['sub_pos_bottom', 'sub_pos_slightly_raised', 'sub_pos_raised'].map((k, i) => ({ id: i, text: t(k) })),
      selected: settings.subtitlePosition.value, pick: (i: number) => (settings.subtitlePosition.value = i),
    },
  ]);

  let card: HTMLDivElement;
  onMount(() => requestAnimationFrame(() => focusFirst(card)));

  function scroll(e: CustomEvent): void {
    const list = (e.target as HTMLElement).closest('.rows') as HTMLElement | null;
    if (!list) return;
    const r = (e.target as HTMLElement).getBoundingClientRect();
    list.scrollTop += edgeDelta(r.top - list.getBoundingClientRect().top, r.height, list.clientHeight, 0);
  }
</script>

<div class="scrim" data-focus-trap>
  <div class="card" bind:this={card} ontvfocus={scroll}>
    {#each columns as c, ci (c.key)}
      <div class="column" style="flex:{c.weight}" data-focus-group>
        <p class="t-eyebrow title">{c.title.toUpperCase()}</p>
        <div class="rows">
          {#each c.rows as r (r.id)}
            <button
              class="row t-body"
              use:focusable={ci === 0 ? r.id === c.selected : false}
              data-focus-default={r.id === c.selected ? '' : undefined}
              onclick={() => c.pick(r.id)}
            >
              <span class="mark">{#if r.id === c.selected}<Icon name="Check" size={18} />{/if}</span>
              <span class="ellipsis">{r.text}</span>
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.35);
  }
  .card {
    position: absolute;
    left: 32rem;
    right: 32rem;
    bottom: 32rem;
    height: 280rem;
    display: flex;
    padding: 24rem;
    border-radius: var(--r-xl);
    background: var(--elevated);
    animation: up 220ms var(--ease-out) both;
  }
  @keyframes up {
    from {
      opacity: 0;
      transform: translateY(24rem);
    }
  }
  .column {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .column + .column {
    margin-left: 24rem;
  }
  .title {
    margin: 0 0 10rem 14rem;
    color: var(--label-3);
  }
  .rows {
    flex: 1;
    overflow: hidden;
  }
  .row {
    display: flex;
    align-items: center;
    width: 100%;
    margin-bottom: 4rem;
    padding: 10rem 14rem;
    border-radius: var(--r-sm);
    color: var(--label);
    text-align: left;
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .row:global(.focused) {
    background: #fff;
    color: #000;
    transform: scale(1.02);
  }
  .mark {
    flex-shrink: 0;
    width: 26rem;
    color: var(--accent);
  }
  .row:global(.focused) .mark {
    color: #000;
  }
</style>
