<script lang="ts">
  // Android TV NowTab (livetv/NowTab.kt, spec §3.1): "Reprendre" the last channel (a static card), favourites,
  // recents, what is on now (the server's airing programmes with their art), then "Toutes les chaînes" as the compact
  // list: number, logo, name, the airing title with its progress and what comes next. Never a wall of tiles. The list
  // mounts only the rows around the focus (a lineup can hold hundreds of channels).
  import type { ChannelRow } from '$shared/livetv/model';
  import HScroll from '../HScroll.svelte';
  import Icon from '../Icon.svelte';
  import Pill from '../Pill.svelte';
  import { focusable } from '../../lib/focus';
  import { locale, t } from '../../lib/i18n.svelte';
  import { useLoad } from '../../lib/load.svelte';
  import { progressOf, timeText, type LiveTv, type Program } from '../../lib/livetv.svelte';
  import { normalizeProgram } from '$shared/livetv/model';
  import ChannelLogo from './ChannelLogo.svelte';
  import LiveCard from './LiveCard.svelte';

  let { repo, now, tune, onguide }: { repo: LiveTv; now: number; tune: (id: string, list?: ChannelRow[]) => void; onguide: () => void } = $props();

  const ROW = 64;
  const GAP = 6;
  const AROUND = 12;

  const resume = $derived(repo.recentRows()[0]);
  const favorites = $derived(repo.favorites());
  const recents = $derived(repo.recentRows().slice(0, 20));
  const onNow = useLoad(
    () => `livetv-onnow-${repo.api.address}`,
    () => repo.onNow(),
  );
  const airing = $derived((onNow.value ?? []).map((p: Program) => ({ dto: p, p: normalizeProgram(p as never, { kind: repo.api.kind }) })).filter((x) => x.p));

  // The compact list's mounted window.
  let focusIndex = $state(0);
  const all = $derived(repo.channels);
  const from = $derived(Math.max(0, focusIndex - AROUND));
  const mounted = $derived(all.slice(from, focusIndex + AROUND + 1));
  $effect(() => {
    const ids = [...new Set([...favorites, ...recents, ...mounted].map((c) => c.id))];
    if (ids.length) void repo.ensure(ids, now, now + 3 * 3_600_000);
  });
  function onListFocus(e: CustomEvent): void {
    const i = Number((e.target as HTMLElement).getAttribute('data-index'));
    if (i >= 0) focusIndex = i;
  }
  const cur = (id: string) => {
    void repo.rev;
    return repo.nowNext(id, now);
  };
</script>

<div class="now">
  {#if resume}
    {@const [c] = cur(resume.id)}
    <button class="resume" use:focusable onclick={() => tune(resume.id)}>
      <ChannelLogo {repo} row={resume} height={48} />
      <span class="resume-text">
        <span class="t-headline ellipsis">{t('livetv_now_resume', resume.name)}</span>
        {#if c}
          <span class="t-footnote ellipsis sub">{c.title}</span>
          <span class="bar"><span style="transform:scaleX({progressOf(c, now)})"></span></span>
        {/if}
      </span>
      <Icon name="Play" size={22} />
    </button>
  {/if}

  {#if favorites.length}
    <section>
      <h2 class="t-title3">{t('livetv_now_rows_favorites')}</h2>
      <HScroll spacing={22} padding={[12, 48, 12, 48]}>
        {#each favorites as row (row.id)}
          <div data-row-item><LiveCard {repo} {row} program={cur(row.id)[0]} {now} onclick={() => tune(row.id, favorites)} /></div>
        {/each}
      </HScroll>
    </section>
  {/if}

  {#if recents.length}
    <section>
      <h2 class="t-title3">{t('livetv_now_rows_recents')}</h2>
      <HScroll spacing={22} padding={[12, 48, 12, 48]}>
        {#each recents as row (row.id)}
          <div data-row-item><LiveCard {repo} {row} program={cur(row.id)[0]} {now} onclick={() => tune(row.id)} /></div>
        {/each}
      </HScroll>
    </section>
  {/if}

  {#if airing.length}
    <section>
      <h2 class="t-title3">{t('livetv_now_rows_on_now')}</h2>
      <HScroll spacing={22} padding={[12, 48, 12, 48]}>
        {#each airing as a (a.p!.id)}
          {@const tag = a.dto.ImageTags?.Primary ?? a.dto.ImageTags?.Thumb}
          <div data-row-item>
            <LiveCard
              {repo}
              row={repo.channel(a.p!.channelId)}
              program={a.p}
              image={tag ? { id: a.dto.Id, tag } : undefined}
              airingCard
              {now}
              onclick={() => tune(a.p!.channelId)}
            />
          </div>
        {/each}
      </HScroll>
    </section>
  {/if}

  {#if repo.loaded && !all.length}
    <div class="empty">
      <p class="t-body label-3">{t('livetv_now_empty')}</p>
      <Pill text={t('livetv_now_open_guide')} onclick={onguide} />
    </div>
  {:else if all.length}
    <h2 class="t-title3 all">{t('livetv_now_rows_all_channels')}</h2>
    <div class="list" style="height:{all.length * (ROW + GAP)}rem" data-focus-group ontvfocus={onListFocus}>
      {#each mounted as row, k (row.id)}
        {@const [c, n] = cur(row.id)}
        <button class="row" style="transform:translate3d(0,{(from + k) * (ROW + GAP)}rem,0)" use:focusable data-index={from + k} onclick={() => tune(row.id)}>
          <span class="mono num">{row.number}</span>
          <ChannelLogo {repo} {row} height={30} width={68} plate />
          <span class="name t-headline ellipsis">{row.name}</span>
          <span class="airing">
            {#if c}
              <span class="t-callout ellipsis">{c.title}</span>
              <span class="bar"><span style="transform:scaleX({progressOf(c, now)})"></span></span>
            {:else}
              <span class="t-callout label-3">{t('livetv_guide_no_info')}</span>
            {/if}
          </span>
          <span class="next t-footnote ellipsis">{n ? `${timeText(n.start, locale.current)}  ${n.title}` : ''}</span>
          {#if c && repo.overlay.has(c.id)}<span class="rec"></span>{/if}
          {#if row.favorite}<Icon name="Heart" size={16} />{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .now {
    padding-bottom: 56rem;
  }
  section {
    padding-top: 14rem;
  }
  h2 {
    margin: 0 0 2rem 48rem;
  }
  .all {
    margin: 28rem 0 14rem 48rem;
  }
  p {
    margin: 0;
  }
  .resume {
    display: flex;
    align-items: center;
    width: 560rem;
    margin: 0 0 8rem 48rem;
    padding: 16rem 20rem;
    border-radius: var(--r-lg);
    background: var(--elevated);
    color: var(--label);
    text-align: left;
    transition: transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1), background-color var(--t-fast);
  }
  .resume > :global(* + *) {
    margin-left: 18rem;
  }
  .resume:global(.focused) {
    transform: scale(1.06);
    background: #fff;
    color: #000;
  }
  .resume-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .sub {
    color: var(--label-2);
  }
  .resume:global(.focused) .sub {
    color: rgba(0, 0, 0, 0.6);
  }
  .bar {
    position: relative;
    display: block;
    height: 4rem;
    margin-top: 6rem;
    border-radius: 2rem;
    overflow: hidden;
    background: var(--fill-2);
  }
  .bar > span {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 48rem 0;
  }
  .empty > :global(* + *) {
    margin-top: 14rem;
  }
  .list {
    position: relative;
    margin: 0 48rem;
  }
  .row {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    height: 64rem;
    padding: 0 16rem;
    border-radius: var(--r-md);
    background: var(--fill-1);
    color: var(--label);
    text-align: left;
    transition: background-color var(--t-fast), color var(--t-fast);
  }
  .row > :global(* + *) {
    margin-left: 14rem;
  }
  .row:global(.focused) {
    background: #fff;
    color: #000;
  }
  .num {
    width: 40rem;
    flex-shrink: 0;
    font-family: 'Geist Mono', monospace;
    font-size: 15rem;
    color: var(--label-2);
  }
  .name {
    width: 190rem;
    flex-shrink: 0;
  }
  .airing {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .airing .bar {
    width: 60%;
    height: 3rem;
    margin-top: 5rem;
  }
  .next {
    width: 220rem;
    flex-shrink: 0;
    color: var(--label-3);
  }
  .row:global(.focused) .num,
  .row:global(.focused) .next {
    color: rgba(0, 0, 0, 0.6);
  }
  .row:global(.focused) .bar {
    background: rgba(0, 0, 0, 0.15);
  }
  .rec {
    width: 10rem;
    height: 10rem;
    flex-shrink: 0;
    border-radius: 50%;
    background: #ff453a;
  }
</style>
