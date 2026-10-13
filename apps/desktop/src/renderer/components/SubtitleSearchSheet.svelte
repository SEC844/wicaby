<script lang="ts" module>
  import type { PlaybackState } from '../../shared/contract';
  import { canDownloadSubtitles } from '../../shared/subtitles';
  import { w } from '../lib/bridge';
  import { sessionFor } from '../lib/stores.svelte';
  import { caps } from '../../shared/server-caps';

  const SUBTITLED = ['Movie', 'Episode', 'Video', 'MusicVideo'];
  const policies = new Map<string, Promise<boolean>>();

  // Hidden up front only when the user's policy is known to forbid it; a 403 is still mapped in the sheet.
  export function subtitleSearchAllowed(serverId: string | undefined): Promise<boolean> {
    const s = sessionFor(serverId);
    // File sources: sidecar subtitles only (server-caps.ts subtitleSearch).
    if (!caps(s?.server.kind).subtitleSearch) return Promise.resolve(false);
    const key = `${s?.server.id}:${s?.user?.id}`;
    if (!s?.user || s.user.isAdmin) return Promise.resolve(true);
    if (!policies.has(key))
      policies.set(
        key,
        w.api.get<{ Policy?: Record<string, unknown> }>(`/Users/${s.user.id}`, undefined, s.server.id).then(
          (u) => canDownloadSubtitles(u.Policy, s.server.kind === 'jellyfin'),
          () => true,
        ),
      );
    return policies.get(key)!;
  }

  // VOD video from a server: no live channel, trailer or local file.
  export const subtitleSearchable = (s: PlaybackState | null): boolean =>
    Boolean(s?.active && s.item && SUBTITLED.includes(s.item.type) && !s.live && !s.offline && !s.trailer);
</script>

<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { searchLanguage, subtitleFailure, subtitleFlags, type RemoteSubtitle, type SubtitleFailure } from '../../shared/subtitles';
  import type { PlaybackCommand } from '../../shared/contract';
  import { fmt, t } from '../lib/i18n.svelte';
  import { settings, updateSettings } from '../lib/stores.svelte';
  import { downloadSubtitle, searchSubtitles } from '../lib/subtitles';
  import { cultures, type Culture } from '../admin/item/metadata';
  import Icon from './Icon.svelte';
  import Picker from './Picker.svelte';
  import Sheet from './Sheet.svelte';

  // X-03 subtitle search (feature-specs.md §3): language, optional title filter, results. A pick
  // downloads on the server (the row spins), then main refreshes PlaybackInfo and selects the new track.
  let { open, state: s, onclose, oncommand }: { open: boolean; state: PlaybackState | null; onclose: () => void; oncommand: (c: PlaybackCommand) => void } = $props();

  let langs = $state<Culture[]>([]);
  let language = $state('');
  let results = $state<RemoteSubtitle[] | null>(null);
  let failure = $state<SubtitleFailure | null>(null);
  let busy = $state('');
  let titleText = $state('');
  let query = $state('');
  let body = $state<HTMLDivElement>();
  let searchSeq = 0;

  const item = $derived(s?.item);
  const itemKey = $derived(item ? `${item.serverId}:${item.id}` : '');
  const langOptions = $derived.by(() => {
    const opts = langs
      .filter((c) => c.ThreeLetterISOLanguageName)
      .map((c) => ({ value: c.ThreeLetterISOLanguageName!, label: c.DisplayName }))
      .sort((a, b) => fmt.compare(a.label, b.label));
    return opts.some((o) => o.value === language) ? opts : [{ value: language, label: fmt.language(language) }, ...opts];
  });
  const fold = (x: string) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const shown = $derived(results && query ? results.filter((r) => fold(`${r.Name ?? ''} ${r.ProviderName ?? ''}`).includes(fold(query))) : results);

  $effect(() => {
    if (!open || !itemKey) return;
    untrack(() => {
      const pb = settings.value?.playback;
      language = searchLanguage(pb?.subtitleSearchLanguage, pb?.preferredSubtitleLanguage, settings.value?.ui.language);
      titleText = query = '';
      busy = '';
      void cultures(item?.serverId).then((c) => (langs = c));
      void search();
    });
  });

  // The title filter applies 500 ms after the last keystroke.
  $effect(() => {
    const text = titleText.trim();
    const timer = setTimeout(() => (query = text), 500);
    return () => clearTimeout(timer);
  });

  async function search(): Promise<void> {
    const it = item;
    if (!it || !language) return;
    const seq = ++searchSeq;
    results = null;
    failure = null;
    try {
      const found = await searchSubtitles({ Id: it.id, ServerId: it.serverId }, language, s?.currentQuality?.mediaSourceId ? { Id: s.currentQuality.mediaSourceId } : undefined);
      if (seq !== searchSeq) return;
      results = found ?? [];
      // The first result takes focus, for the D-pad.
      await tick();
      body?.querySelector<HTMLElement>('.res button:not([disabled])')?.focus({ preventScroll: true });
    } catch (err) {
      if (seq !== searchSeq) return;
      failure = subtitleFailure(err);
      results = [];
    }
  }

  function pickLanguage(v: string): void {
    language = v;
    void updateSettings({ playback: { subtitleSearchLanguage: v } });
    void search();
  }

  async function pick(r: RemoteSubtitle): Promise<void> {
    const it = item;
    if (busy || !it) return;
    busy = r.Id;
    failure = null;
    try {
      await downloadSubtitle({ Id: it.id, ServerId: it.serverId }, r, s?.currentQuality?.mediaSourceId ? { Id: s.currentQuality.mediaSourceId } : undefined);
      oncommand({ type: 'subtitles-refresh', selectNew: true });
      onclose();
    } catch (err) {
      failure = subtitleFailure(err);
    } finally {
      busy = '';
    }
  }

  // The player turns spatial navigation off: ↑/↓ walk the sheet's controls in order.
  function onkeydown(e: KeyboardEvent): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = [...(body?.closest('[role="dialog"]')?.querySelectorAll<HTMLElement>('button:not([disabled]), input') ?? [])].filter((el) => !el.classList.contains('close'));
    const i = all.indexOf(document.activeElement as HTMLElement);
    const next = all[i < 0 ? 0 : Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  }

  const meta = (r: RemoteSubtitle) =>
    [
      r.ProviderName,
      r.Format?.toUpperCase(),
      r.CommunityRating ? `★ ${fmt.number(r.CommunityRating, { maximumFractionDigits: 1 })}` : '',
      r.DownloadCount ? t('player.subSearch.downloads', { count: r.DownloadCount }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
</script>

<Sheet {open} {onclose} label={t('player.subSearch.title')} width={600}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="body" bind:this={body} {onkeydown}>
    <h2 class="title-3">{t('player.subSearch.title')}</h2>
    <div class="bar">
      <Picker label={t('player.subSearch.language')} value={language} options={langOptions} onchange={pickLanguage} />
      <input class="field" type="search" bind:value={titleText} placeholder={t('player.subSearch.titleOverride')} aria-label={t('player.subSearch.titleOverride')} />
    </div>

    {#if failure}
      <p class="msg" role="status">{t(`player.subSearch.${failure}`)}</p>
    {:else if !results}
      <div class="sk skeleton" aria-busy="true"></div>
    {:else if !shown?.length}
      <p class="msg" role="status">{t('player.subSearch.empty')}</p>
    {/if}
    {#if shown?.length}
      <ul class="res">
        {#each shown as r (r.Id)}
          {@const f = subtitleFlags(r)}
          <li>
            <button aria-busy={busy === r.Id} disabled={busy !== '' && busy !== r.Id} onclick={() => pick(r)}>
              <span class="txt">
                <span class="nm">{r.Name ?? r.Id}</span>
                <span class="meta">{meta(r)}</span>
              </span>
              {#if r.IsHashMatch}<span class="tag">{t('player.subSearch.perfectMatch')}</span>{/if}
              {#if f.forced}<span class="tag">{t('player.subSearch.forced')}</span>{/if}
              {#if f.sdh}<span class="tag">{t('player.subSearch.sdh')}</span>{/if}
              {#if f.machine}<span class="tag">{t('player.subSearch.machineTranslated')}</span>{/if}
              <span class="act">
                {#if busy === r.Id}<span class="spin" aria-hidden="true"></span>{:else}<Icon name="download" size={14} />{/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
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
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-top: 14px;
  }
  .bar .field {
    flex: 1;
    min-width: 180px;
  }
  .msg {
    margin: 18px 0 4px;
    color: var(--label-2);
  }
  .sk {
    height: 180px;
    margin-top: 16px;
    border-radius: var(--r-md);
  }
  .res {
    list-style: none;
    margin: 12px -8px 0;
    padding: 0;
    max-height: min(56vh, 440px);
    overflow-y: auto;
  }
  .res button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 48px;
    padding: 6px 10px;
    border-radius: var(--r-sm);
    text-align: left;
    transition: background-color var(--t-fast) var(--ease);
  }
  .res button:hover:not(:disabled),
  .res button:focus-visible {
    background: var(--fill-2);
  }
  .res button:disabled {
    opacity: 0.45;
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 2px;
  }
  .nm,
  .meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    font-size: 12px;
    color: var(--label-2);
  }
  .tag {
    flex: none;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
    border: 1px solid var(--separator);
    color: var(--label-2);
  }
  .act {
    width: 16px;
    flex: none;
    display: grid;
    place-items: center;
    color: var(--label-2);
  }
  .spin {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid var(--label-3);
    border-top-color: var(--label);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation-duration: 2.4s;
    }
  }
</style>
