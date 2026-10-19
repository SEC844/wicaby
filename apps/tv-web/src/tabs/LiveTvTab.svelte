<script lang="ts">
  // Android TV LiveTvScreen (livetv/LiveTvScreen.kt, spec §3.1, TV-1): the Live TV library's tab. Its title and the
  // tabs En direct · Guide · Programmés · Enregistrements (Programmés only with the DVR right or timers), then the tab.
  // The guide fills the screen once it holds the focus: the page slides up and the top bar hides. A channel opens the
  // live player, with the list it was picked in as its zap order.
  import type { ChannelRow } from '$shared/livetv/model';
  import GuideTab from '../components/livetv/GuideTab.svelte';
  import NowTab from '../components/livetv/NowTab.svelte';
  import RecordingsTab from '../components/livetv/RecordingsTab.svelte';
  import ScheduledTab from '../components/livetv/ScheduledTab.svelte';
  import Pill from '../components/Pill.svelte';
  import Spinner from '../components/Spinner.svelte';
  import type { Api } from '../lib/api';
  import { t } from '../lib/i18n.svelte';
  import { liveTv } from '../lib/livetv.svelte';
  import { nav } from '../lib/nav.svelte';
  import { dp } from '../lib/screen';
  import { clamp, edgeDelta } from '../lib/scroll';
  import { load, save } from '../lib/storage';

  let { api, title, top = 104, onscrolled }: { api: Api; title: string; top?: number; onscrolled?: (s: boolean) => void } = $props();

  type Tab = 'now' | 'guide' | 'scheduled' | 'recordings';
  // svelte-ignore state_referenced_locally
  const repo = liveTv(api);
  let tab = $state<Tab>(load<Tab>('livetv.tab', 'now'));
  $effect(() => save('livetv.tab', tab));

  let now = $state(Date.now());
  $effect(() => {
    if (!repo.loaded) void repo.loadChannels();
    void repo.loadTimers();
    const id = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(id);
  });

  const tabs = $derived(
    (['now', 'guide', 'scheduled', 'recordings'] as Tab[]).filter((x) => x !== 'scheduled' || repo.canRecord || repo.timers.length),
  );
  const LABEL: Record<Tab, string> = { now: 'livetv_tabs_now', guide: 'livetv_tabs_guide', scheduled: 'livetv_tabs_scheduled', recordings: 'livetv_tabs_recordings' };

  function tune(id: string, list?: ChannelRow[]): void {
    nav.push({ name: 'live', id, list: list?.map((c) => c.id) });
  }

  // --- Vertical scroll: rows by their edges; the guide snaps to the top of the screen ---
  let page = $state<HTMLDivElement>();
  let content = $state<HTMLDivElement>();
  let guideBox = $state<HTMLDivElement>();
  let y = $state(0);
  let viewH = $state(540);
  $effect(() => {
    const measure = () => (viewH = window.innerHeight / dp(1));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });
  function onfocus(e: CustomEvent): void {
    if (!page || !content) return;
    const el = e.target as HTMLElement;
    if (guideBox?.contains(el)) {
      y = guideBox.offsetTop;
      return onscrolled?.(true);
    }
    const band = (el.closest('section, .head, .list > *, .row') as HTMLElement | null) ?? el;
    const at = band.getBoundingClientRect().top - content.getBoundingClientRect().top;
    const max = Math.max(0, content.offsetHeight - page.clientHeight);
    y = clamp(y + edgeDelta(at - y, band.offsetHeight, page.clientHeight, dp(56)), 0, max);
    onscrolled?.(y > 60);
  }
  $effect(() => {
    void tab;
    y = 0;
    onscrolled?.(false);
  });
</script>

<div class="livetv" bind:this={page} ontvfocus={onfocus}>
  <div class="content" bind:this={content} style="padding-top:{top}rem;transform:translate3d(0,{-y}px,0)">
    <div class="head">
      <h1 class="t-large-title ellipsis">{title}</h1>
      <div class="tabs" data-focus-group>
        {#each tabs as x (x)}
          <Pill text={t(LABEL[x])} selected={tab === x} onclick={() => (tab = x)} />
        {/each}
      </div>
    </div>
    {#if !repo.loaded}
      <div class="center"><Spinner size={40} /></div>
    {:else if repo.failed}
      <div class="center">
        <p class="t-title3 label-2">{t('load_error')}</p>
        <Pill text={t('retry')} icon="Refresh" onclick={() => repo.loadChannels()} />
      </div>
    {:else if tab === 'now'}
      <NowTab {repo} {now} {tune} onguide={() => (tab = 'guide')} />
    {:else if tab === 'guide'}
      <div bind:this={guideBox} class="guide-box">
        <GuideTab {repo} {now} height={viewH - 20} {tune} />
      </div>
    {:else if tab === 'scheduled'}
      <ScheduledTab {repo} {now} />
    {:else}
      <RecordingsTab {repo} />
    {/if}
  </div>
</div>

<style>
  .livetv {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
  }
  .content {
    transition: transform var(--t-med) var(--ease);
    will-change: transform;
  }
  .head {
    display: flex;
    align-items: center;
    padding: 0 48rem 10rem;
  }
  h1 {
    flex: 1;
    min-width: 0;
    margin: 0;
  }
  .tabs {
    display: flex;
  }
  .tabs > :global(* + *) {
    margin-left: 10rem;
  }
  /* The tab shown is filled and full white, the others unfilled and dimmed (no accent, §11). */
  .tabs > :global(.pill:not(.selected):not(.focused)) {
    background: transparent;
    color: var(--label-2);
  }
  .tabs > :global(.pill.selected:not(.focused)) {
    background: var(--fill-3);
    color: var(--label);
  }
  .guide-box {
    padding-top: 20rem;
  }
  .center {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 64rem 0;
  }
  .center > :global(* + *) {
    margin-top: 16rem;
  }
  p {
    margin: 0;
  }
</style>
