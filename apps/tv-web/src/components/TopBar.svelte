<script lang="ts">
  // Android TV TopBar / TabPill (Chrome.kt): a floating translucent pill of text tabs and pinned icon tabs (Search,
  // Settings), a white indicator that slides to the selected tab, the clock and the avatar on the right. Focusing a
  // tab selects it. The pill is centred when it fits, slides left otherwise, and its text tabs scroll with the focus
  // behind faded edges. Left/Right follow the tab order: geometric search would jump from a half-hidden tab to the
  // pinned icons.
  import { getContext, onMount, tick } from 'svelte';
  import { focusable, setFocus } from '../lib/focus';
  import { locale, t } from '../lib/i18n.svelte';
  import { music, musicActive } from '../lib/music.svelte';
  import { nav, SCREEN, stack } from '../lib/nav.svelte';
  import { dp } from '../lib/screen';
  import { clamp } from '../lib/scroll';
  import type { TopTab } from '../lib/tabs';
  import Icon from './Icon.svelte';

  let {
    tabs,
    selected,
    visible = true,
    showClock = true,
    userName,
    userImage,
    onselect,
    onavatar,
  }: {
    tabs: TopTab[];
    selected: string;
    visible?: boolean;
    showClock?: boolean;
    userName: string;
    userImage?: string;
    onselect: (key: string) => void;
    onavatar: () => void;
  } = $props();

  const textTabs = $derived(tabs.filter((t) => !t.icon));
  const iconTabs = $derived(tabs.filter((t) => t.icon));
  const order = $derived([...textTabs, ...iconTabs].map((t) => t.key));

  let bar: HTMLDivElement;
  let pill: HTMLDivElement;
  let right: HTMLDivElement;
  const screen = getContext<number>(SCREEN);
  const onTop = (): boolean => stack[stack.length - 1]?.key === screen;
  let viewport: HTMLDivElement;
  let track: HTMLDivElement;
  let left = $state(0);
  let maxPill = $state(0);
  let scroll = $state(0);
  let canScroll = $state({ start: false, end: false });
  let viewWidth = $state(0);
  // Faded edges in px: calc() inside gradient stops is not safe on the oldest engines.
  const mask = $derived.by(() => {
    const e = dp(28);
    const w = viewWidth;
    if (!canScroll.start && !canScroll.end) return '';
    const a = canScroll.start ? `transparent 0px, #000 ${e}px` : '#000 0px';
    const b = canScroll.end ? `#000 ${w - e}px, transparent ${w}px` : `#000 ${w}px`;
    return `-webkit-mask-image:linear-gradient(90deg, ${a}, ${b})`;
  });
  let barFocused = $state(false);
  let indicator = $state<{ group: number; x: number; w: number } | null>(null);
  let animate = $state(false);

  function tabEl(key: string): HTMLElement | null {
    return bar?.querySelector(`[data-tab="${CSS.escape ? CSS.escape(key) : key}"]`) ?? null;
  }

  // Chrome.kt's Layout: the pill centred on the screen, unless it would run into the clock and avatar.
  function layout(): void {
    if (!bar) return;
    const width = bar.clientWidth;
    const margin = dp(40);
    const gap = dp(24);
    maxPill = Math.max(0, width - right.offsetWidth - margin * 2 - gap);
    const w = Math.min(pill.scrollWidth, maxPill);
    left = clamp((width - w) / 2, margin, width - margin - right.offsetWidth - gap - w);
  }

  // The text tabs scroll so the selected one stays 28 dp inside the faded edges.
  function reveal(key: string): void {
    const el = tabEl(key);
    if (!el || !track.contains(el)) return;
    const view = viewport.clientWidth;
    const edge = dp(28);
    const max = Math.max(0, track.scrollWidth - view);
    if (el.offsetLeft < scroll + edge) scroll = clamp(el.offsetLeft - edge, 0, max);
    else if (el.offsetLeft + el.offsetWidth > scroll + view - edge) scroll = clamp(el.offsetLeft + el.offsetWidth - view + edge, 0, max);
    canScroll = { start: scroll > 0, end: scroll < max };
    viewWidth = view;
  }

  function place(): void {
    const el = tabEl(selected);
    if (!el) return;
    indicator = { group: track.contains(el) ? 0 : 1, x: el.offsetLeft, w: el.offsetWidth };
    reveal(selected);
  }

  $effect(() => {
    void tabs;
    void locale.current;
    // The now-playing button widens the right side; measured once the screen is back on top (hidden, it has no size).
    void musicActive();
    if (!onTop()) return;
    void tick().then(() => {
      layout();
      place();
    });
  });

  $effect(() => {
    void selected;
    void tick().then(place);
  });

  // Bar focus: the indicator turns white and the selected label black (TabPill pillFocused). Tracked on the document:
  // leaving the bar for the content must turn it off too.
  function onanyfocus(e: Event): void {
    const el = e.target as HTMLElement;
    barFocused = !!bar && bar.contains(el) && el.hasAttribute('data-tab');
  }

  onMount(() => {
    document.addEventListener('tvfocus', onanyfocus);
    window.addEventListener('resize', layout);
    // No slide on the first placement.
    requestAnimationFrame(() => (animate = true));
    return () => {
      document.removeEventListener('tvfocus', onanyfocus);
      window.removeEventListener('resize', layout);
    };
  });

  function onmove(e: CustomEvent<'up' | 'down' | 'left' | 'right'>): void {
    const key = (e.target as HTMLElement).getAttribute('data-tab');
    if (!key || (e.detail !== 'left' && e.detail !== 'right')) return;
    const i = order.indexOf(key) + (e.detail === 'left' ? -1 : 1);
    e.preventDefault();
    if (i >= 0 && i < order.length) setFocus(tabEl(order[i]));
  }


  // Clock: minute-aligned refresh, the locale's 12/24 h format.
  let now = $state(new Date());
  onMount(() => {
    let timer = 0;
    const next = () => {
      now = new Date();
      timer = window.setTimeout(next, 60_000 - (Date.now() % 60_000) + 50);
    };
    next();
    return () => clearTimeout(timer);
  });
  const clock = $derived(now.toLocaleTimeString(locale.current, { hour: 'numeric', minute: '2-digit' }));
</script>

<div class="topbar" class:hidden={!visible} bind:this={bar} data-focus-group ontvmove={onmove}>
  <div class="scrim"></div>
  <div class="pill" class:focused-bar={barFocused} bind:this={pill} style="left:{left}px;max-width:{maxPill}px">
    <div class="viewport" style={mask} bind:this={viewport}>
      <div class="track" class:animate bind:this={track} style="transform:translate3d({-scroll}px,0,0)">
        {#if indicator?.group === 0}<span class="indicator" class:animate style="transform:translate3d({indicator.x}px,0,0);width:{indicator.w}px"></span>{/if}
        {#each textTabs as tab (tab.key)}
          <button class="tab t-headline" class:selected={tab.key === selected} data-tab={tab.key} use:focusable ontvfocus={() => onselect(tab.key)} onclick={() => onselect(tab.key)}>
            {tab.label}
          </button>
        {/each}
      </div>
    </div>
    <div class="icons">
      {#if indicator?.group === 1}<span class="indicator" class:animate style="transform:translate3d({indicator.x}px,0,0);width:{indicator.w}px"></span>{/if}
      {#each iconTabs as tab (tab.key)}
        <button class="tab icon" class:selected={tab.key === selected} aria-label={tab.label} data-tab={tab.key} use:focusable ontvfocus={() => onselect(tab.key)} onclick={() => onselect(tab.key)}>
          <Icon name={tab.icon!} size={18} />
        </button>
      {/each}
    </div>
  </div>
  <div class="right" bind:this={right}>
    <!-- Music playing: back to its screen (a TV app has no system "Now playing" card, unlike Google TV). -->
    {#if musicActive()}
      <button class="music" class:playing={music.session?.playing} aria-label={t('music_now_playing')} use:focusable onclick={() => nav.push({ name: 'nowPlaying' })}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z" fill="currentColor" /></svg>
      </button>
    {/if}
    {#if showClock}<span class="clock t-headline">{clock}</span>{/if}
    <button class="avatar" aria-label={userName} use:focusable onclick={onavatar}>
      {#if userImage}<img src={userImage} alt="" />{:else}<span class="t-headline">{userName.slice(0, 1).toUpperCase()}</span>{/if}
    </button>
  </div>
</div>

<style>
  .topbar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 104rem;
    z-index: 10;
    transition: opacity 260ms var(--ease-out), transform 260ms var(--ease-out);
  }
  .topbar.hidden {
    opacity: 0;
    transform: translate3d(0, -18rem, 0);
    transition-duration: 200ms;
  }
  .scrim {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 150rem;
    background: linear-gradient(rgba(0, 0, 0, 0.62), rgba(0, 0, 0, 0.22) 55%, transparent);
    pointer-events: none;
  }
  .pill {
    position: absolute;
    top: 22rem;
    display: flex;
    align-items: center;
    padding: 5rem;
    border-radius: 999rem;
    background: rgba(28, 28, 31, 0.72);
  }
  .viewport {
    position: relative;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
  }
  .track,
  .icons {
    position: relative;
    display: flex;
    align-items: center;
    white-space: nowrap;
  }
  .track.animate {
    transition: transform var(--t-med) var(--ease);
  }
  .indicator {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    border-radius: 999rem;
    background: rgba(255, 255, 255, 0.16);
    transition: background-color var(--t-fast);
  }
  .indicator.animate {
    transition: transform 380ms cubic-bezier(0.25, 1.2, 0.5, 1), width 380ms cubic-bezier(0.25, 1.2, 0.5, 1), background-color var(--t-fast);
  }
  .focused-bar .indicator {
    background: rgba(255, 255, 255, 0.96);
  }
  .tab {
    position: relative;
    display: flex;
    align-items: center;
    padding: 8rem 14rem;
    border-radius: 999rem;
    font-size: 15rem;
    line-height: 19rem;
    color: var(--label-2);
    transition: transform var(--t-fast) var(--ease-out), color var(--t-fast);
  }
  .tab.icon {
    padding: 8rem 12rem;
  }
  .tab.selected {
    color: var(--label);
  }
  .focused-bar .tab.selected {
    color: #000;
  }
  .tab:global(.focused) {
    transform: scale(1.06);
  }
  .right {
    position: absolute;
    top: 22rem;
    right: 40rem;
    display: flex;
    align-items: center;
    height: 47rem;
  }
  .music {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40rem;
    height: 40rem;
    margin-right: 18rem;
    border-radius: 50%;
    background: var(--raised);
    color: var(--label-2);
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  .music.playing {
    color: var(--accent);
  }
  .music svg {
    width: 20rem;
    height: 20rem;
  }
  .music:global(.focused) {
    background: #fff;
    color: #000;
    transform: scale(1.16);
  }
  .clock {
    margin-right: 18rem;
    font-size: 17rem;
  }
  .avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40rem;
    height: 40rem;
    border-radius: 50%;
    overflow: hidden;
    background: var(--raised);
    transition: transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow var(--t-med);
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .avatar:global(.focused) {
    transform: scale(1.16);
    box-shadow: 0 12rem 24rem rgba(0, 0, 0, 0.5);
  }
</style>
