<script lang="ts">
  // Android TV NowTab ChannelCard / ProgramCard: a 16:9 tile of 232 dp. A channel shows its logo, what is on and how
  // far it went; an airing programme its art (else its channel's logo), its channel and when it ends. OK tunes.
  import type { ChannelRow, ProgramLite } from '$shared/livetv/model';
  import { focusable } from '../../lib/focus';
  import { locale, t } from '../../lib/i18n.svelte';
  import { dpPx } from '../../lib/images';
  import { progressOf, timeText, type LiveTv } from '../../lib/livetv.svelte';
  import ChannelLogo from './ChannelLogo.svelte';

  let {
    repo,
    row,
    program,
    image,
    airingCard = false,
    now,
    onclick,
  }: {
    repo: LiveTv;
    row?: ChannelRow;
    program?: ProgramLite | null;
    image?: { id: string; tag: string };
    // An airing programme's card (title, its channel and when it ends) rather than a channel's.
    airingCard?: boolean;
    now: number;
    onclick: () => void;
  } = $props();

  const W = 232;
  const art = $derived(image ? repo.api.image(image.id, 'Primary', image.tag, { maxWidth: dpPx(W) }) : undefined);
  let loaded = $state(false);
  let failed = $state(false);
  const airing = $derived(program && program.start <= now && program.end > now ? program : null);
  const title = $derived(airingCard ? (program?.title ?? '') : (airing?.title ?? row?.name ?? ''));
  const line = $derived(
    airingCard
      ? [row?.name, program ? t('livetv_now_until', timeText(program.end, locale.current)) : undefined].filter(Boolean).join(' · ')
      : `${row?.number ?? ''}  ${row?.name ?? ''}`.trim(),
  );
</script>

<div class="card" style="width:{W}rem">
  <button class="art" use:focusable {onclick} aria-label={title}>
    {#if art && !failed}
      <img src={art} alt="" class:loaded onload={() => (loaded = true)} onerror={() => (failed = true)} />
    {:else if row}
      <span class="logo"><ChannelLogo {repo} {row} height={52} /></span>
    {/if}
    {#if airing}
      <span class="progress"><span style="transform:scaleX({progressOf(airing, now)})"></span></span>
    {/if}
    <span class="sheen"></span>
  </button>
  <p class="t-callout ellipsis title">{title}</p>
  <p class="t-footnote ellipsis line">{line}</p>
</div>

<style>
  .card {
    flex-shrink: 0;
  }
  .art {
    position: relative;
    display: block;
    width: 100%;
    height: 0;
    padding-bottom: 56.25%;
    overflow: hidden;
    border-radius: var(--r-md);
    background: var(--elevated-2);
    transition: transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow var(--t-med) var(--ease-out);
  }
  img {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity var(--t-med) var(--ease-out);
  }
  img.loaded {
    opacity: 1;
  }
  .logo {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .progress {
    position: absolute;
    left: 12rem;
    right: 12rem;
    bottom: 10rem;
    height: 4rem;
    border-radius: 2rem;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.28);
  }
  .progress span {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
  }
  .sheen {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.22), rgba(255, 255, 255, 0.04) 45%, transparent 70%);
    opacity: 0;
    transition: opacity var(--t-med);
  }
  p {
    margin: 0;
  }
  .title {
    margin: 12rem 2rem 0;
    color: var(--label-2);
  }
  .line {
    margin: 2rem 2rem 0;
    color: var(--label-3);
  }
  .art:global(.focused) {
    transform: scale(1.06);
    box-shadow: 0 16rem 32rem rgba(0, 0, 0, 0.5);
  }
  .art:global(.focused) .sheen {
    opacity: 1;
  }
  .art:global(.focused) ~ .title {
    color: var(--label);
  }
  :global(:root[data-lite]) .art:global(.focused) {
    box-shadow: none;
  }
</style>
