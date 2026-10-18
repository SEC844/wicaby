<script lang="ts">
  import { t } from '../lib/i18n.svelte';
  import { imageUrl } from '../lib/images';
  import { airing, channelNumber, now, openProgram, playChannel, span, type Channel } from '../lib/livetv.svelte';
  import { reveal } from '../lib/motion';
  import Icon from './Icon.svelte';

  let { channel }: { channel: Channel } = $props();

  const prog = $derived(channel.CurrentProgram);
  const pct = $derived(airing(prog, now.value));
  const logo = $derived(channel.ImageTags?.Primary ? imageUrl(channel.Id, 'Primary', { tag: channel.ImageTags.Primary, maxWidth: 220, server: channel.ServerId }) : null);
</script>

<div class="tile">
  <div class="lift">
    <button class="cover" onclick={() => openProgram(prog, channel)} aria-label={[channel.Name, prog?.Name].filter(Boolean).join(', ')}>
      {#if logo}
        <img class="reveal" use:reveal src={logo} alt="" loading="lazy" decoding="async" draggable="false" />
      {:else}
        <span class="name">{channel.Name}</span>
      {/if}
      {#if channelNumber(channel)}<span class="num">{channelNumber(channel)}</span>{/if}
      {#if pct > 0}<span class="progress" aria-hidden="true"><span style:transform="scaleX({pct})"></span></span>{/if}
    </button>
    <button class="play" onclick={() => playChannel(channel.Id, channel.ServerId)} aria-label={t('livetv.channels.watch', { name: channel.Name ?? '' })} tabindex="-1">
      <Icon name="play" size={16} fill stroke={0} />
    </button>
  </div>
  <div class="text">
    <div class="title">{prog?.Name ?? channel.Name}</div>
    <div class="sub">{[channel.Name, prog ? span(prog) : ''].filter(Boolean).join(' · ')}</div>
  </div>
</div>

<style>
  .tile {
    position: relative;
    width: 100%;
    min-width: 0;
  }
  .lift {
    position: relative;
    isolation: isolate;
    aspect-ratio: 16 / 9;
    border-radius: var(--r-md);
    transition: transform var(--t-slow) var(--spring);
  }
  .lift::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    box-shadow: var(--shadow-3);
    opacity: 0;
    transition: opacity var(--t-med) var(--ease);
    pointer-events: none;
  }
  .cover {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    overflow: hidden;
    border-radius: var(--r-md);
    background: linear-gradient(160deg, var(--bg-elevated-2), var(--bg-elevated));
    box-shadow: inset 0 0 0 1px var(--fill-1);
  }
  img {
    width: 46%;
    height: 46%;
    object-fit: contain;
  }
  .name {
    padding: 12px;
    font-weight: 650;
    font-size: var(--fs-headline);
    color: var(--label-2);
    text-align: center;
  }
  .num {
    position: absolute;
    top: 8px;
    left: 10px;
    font-size: var(--fs-caption);
    font-weight: 600;
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
  }
  .progress {
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 10px;
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
    background: rgb(255 255 255 / 0.18);
  }
  .progress span {
    display: block;
    height: 100%;
    background: var(--label);
    transform-origin: left;
  }
  .play {
    position: absolute;
    right: 10px;
    top: 10px;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--label);
    background: rgb(0 0 0 / 0.5);
    opacity: 0;
    transform: scale(0.85);
    transition:
      opacity var(--t-fast) var(--ease), transform var(--t-med) var(--spring);
  }
  .play :global(svg) {
    margin-left: 2px;
  }
  .play:hover {
    background: var(--label);
    color: #000;
  }
  .text {
    padding: 10px 2px 0;
    transition: transform var(--t-slow) var(--spring);
  }
  .title {
    font-weight: 560;
    font-size: var(--fs-callout);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    margin-top: 1px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .tile:hover,
  .tile:focus-within {
    z-index: 1;
  }
  .tile:hover .lift,
  .tile:focus-within .lift {
    will-change: transform;
    transform: scale(1.05);
  }
  .tile:hover .lift::after,
  .tile:focus-within .lift::after {
    opacity: 1;
  }
  .tile:hover .play,
  .tile:focus-within .play {
    opacity: 1;
    transform: scale(1);
  }
  .tile:hover .text,
  .tile:focus-within .text {
    transform: translate3d(0, 6px, 0);
  }
  .tile:active .lift {
    transform: scale(1.02);
  }
</style>
