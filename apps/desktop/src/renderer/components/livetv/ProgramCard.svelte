<script lang="ts">
  import { fmt, t } from '../../lib/i18n.svelte';
  import { imageUrl } from '../../lib/images';
  import { airing, now, openProgram, playChannel } from '../../lib/livetv.svelte';
  import type { Channel, Program } from '../../lib/livetv.svelte';
  import Icon from '../Icon.svelte';

  // A programme on air (LT-11): art, title, channel, "jusqu’à {time}" and the airing progress. The
  // card opens the programme sheet; its play button tunes the channel.
  let { program, channel = null }: { program: Program; channel?: Channel | null } = $props();

  const art = $derived.by(() => {
    const tags = program.ImageTags;
    const server = program.ServerId;
    if (program.Id && tags?.Thumb) return imageUrl(program.Id, 'Thumb', { tag: tags.Thumb, maxWidth: 360, server });
    if (program.Id && tags?.Primary) return imageUrl(program.Id, 'Primary', { tag: tags.Primary, maxWidth: 360, server });
    return '';
  });
  const pct = $derived(airing(program, now.value));
  const channelName = $derived(channel?.Name ?? program.ChannelName ?? '');
</script>

<div class="card">
  <button class="cover" onclick={() => openProgram(program, channel)} aria-label={[program.Name, channelName].filter(Boolean).join(', ')}>
    {#if art}<img src={art} alt="" loading="lazy" decoding="async" draggable="false" />{:else}<span class="ph">{channelName}</span>{/if}
    {#if pct > 0}<span class="progress" aria-hidden="true"><span style:transform="scaleX({pct})"></span></span>{/if}
  </button>
  <button class="play" onclick={() => playChannel(program.ChannelId, program.ServerId)} aria-label={t('livetv.channels.watch', { name: channelName })} tabindex="-1">
    <Icon name="play" size={14} fill stroke={0} />
  </button>
  <div class="text">
    <span class="title">{program.Name}</span>
    <span class="sub footnote">{[channelName, program.EndDate ? t('livetv.now.until', { time: fmt.time(program.EndDate) }) : ''].filter(Boolean).join(' · ')}</span>
  </div>
</div>

<style>
  .card {
    position: relative;
    display: grid;
    gap: 8px;
  }
  .cover {
    position: relative;
    aspect-ratio: 16 / 9;
    border-radius: var(--r-md);
    background: var(--fill-1);
    overflow: hidden;
    transition: transform var(--t-med) var(--spring);
  }
  .cover:is(:hover, :focus-visible) {
    transform: scale(1.04);
    box-shadow: var(--shadow-3);
  }
  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .ph {
    display: grid;
    place-items: center;
    height: 100%;
    padding: 0 12px;
    font-weight: 600;
    color: var(--label-2);
  }
  .progress {
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 8px;
    height: 3px;
    border-radius: 2px;
    background: rgb(255 255 255 / 0.2);
    overflow: hidden;
  }
  .progress span {
    display: block;
    height: 100%;
    background: var(--label);
    opacity: 0.85;
    transform-origin: left;
  }
  .play {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .card:hover .play,
  .play:focus-visible {
    opacity: 1;
  }
  .text {
    display: grid;
    min-width: 0;
  }
  .title,
  .sub {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .title {
    font-weight: 560;
  }
</style>
