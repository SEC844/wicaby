<script lang="ts">
  // Server logs. List: Emby GET /System/Logs/Query -> { Items } (older servers: /System/Logs -> []),
  // Jellyfin GET /System/Logs -> []. Content (plain text): Emby GET /System/Logs/{name},
  // Jellyfin GET /System/Logs/Log?name=. The viewer is windowed (only the visible lines
  // are in the DOM), filters by level and text, and can follow the current log.
  import { onDestroy, onMount, tick } from 'svelte';
  import type { ServerKind } from '../../shared/contract';
  import Icon from '../components/Icon.svelte';
  import Segmented from '../components/Segmented.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { fmt, t } from '../lib/i18n.svelte';
  import { adminApi, adminError, copyText, saveTextFile, serverKind } from './server/serverAdmin.svelte';

  let { serverId, kind: kindProp }: { serverId: string; kind?: ServerKind } = $props();
  const kind = $derived(serverKind(serverId, kindProp));
  const api = $derived(adminApi(serverId));

  interface LogFile {
    Name: string;
    Size?: number;
    DateCreated?: string;
    DateModified?: string;
  }
  type Level = 'debug' | 'info' | 'warn' | 'error';
  type LevelFilter = 'all' | Level;
  interface Line {
    n: number;
    text: string;
    level: Level;
  }

  let loading = $state(true);
  let error = $state('');
  let files = $state<LogFile[]>([]);
  let open = $state<LogFile | null>(null);
  let text = $state('');
  let viewLoading = $state(false);
  let viewError = $state('');
  let query = $state('');
  let level = $state<LevelFilter>('all');
  let follow = $state(false);

  // ---- List ----

  async function loadFiles(): Promise<void> {
    loading = true;
    error = '';
    try {
      let list: LogFile[];
      if (kind === 'jellyfin') list = (await api.get<LogFile[]>('/System/Logs')) ?? [];
      else {
        const res = await api.get<{ Items?: LogFile[] }>('/System/Logs/Query').catch(() => api.get<LogFile[]>('/System/Logs'));
        list = Array.isArray(res) ? res : (res?.Items ?? []);
      }
      files = [...list].sort((a, b) => (b.DateModified ?? '').localeCompare(a.DateModified ?? ''));
    } catch (err) {
      error = adminError(err);
    } finally {
      loading = false;
    }
  }

  // The live server log: the newest one that is not a per-transcode ffmpeg log.
  const current = $derived((files.find((f) => !/^ffmpeg/i.test(f.Name)) ?? files[0])?.Name);

  // ---- Content ----

  async function fetchText(name: string): Promise<string> {
    const res = kind === 'jellyfin' ? await api.get<unknown>('/System/Logs/Log', { name }) : await api.get<unknown>(`/System/Logs/${encodeURIComponent(name)}`);
    return typeof res === 'string' ? res : res == null ? '' : JSON.stringify(res, null, 2);
  }

  // The latest show() wins: a slow earlier file never lands under the one opened after it.
  let showSeq = 0;
  async function show(f: LogFile): Promise<void> {
    const seq = ++showSeq;
    open = f;
    text = '';
    query = '';
    level = 'all';
    follow = f.Name === current;
    viewError = '';
    viewLoading = true;
    try {
      const got = await fetchText(f.Name);
      if (seq !== showSeq || open?.Name !== f.Name) return;
      text = got;
      await tick();
      toBottom();
    } catch (err) {
      if (seq === showSeq && open?.Name === f.Name) viewError = adminError(err);
    } finally {
      if (seq === showSeq) viewLoading = false;
    }
  }

  // Emby:     "2026-10-11 15:01:02.123 Info App: …"
  // Jellyfin: "[2026-10-11 15:01:02.123 +02:00] [INF] [12] Emby.Server…: …"
  const EMBY_LEVEL = /^\d{4}-\d\d-\d\d[ T][\d:.,]+\s+(Debug|Info|Warn|Error|Fatal)\b/;
  const JF_LEVEL = /^\[[^\]]*\]\s*\[(VRB|DBG|INF|WRN|ERR|FTL)\]/;
  const LEVELS: Record<string, Level> = {
    Debug: 'debug',
    VRB: 'debug',
    DBG: 'debug',
    Info: 'info',
    INF: 'info',
    Warn: 'warn',
    WRN: 'warn',
    Error: 'error',
    Fatal: 'error',
    ERR: 'error',
    FTL: 'error',
  };

  // Continuation lines (stack traces) keep the level of the entry they belong to.
  const lines = $derived.by(() => {
    const out: Line[] = [];
    let cur: Level = 'info';
    const raw = text.split(/\r?\n/);
    if (raw.length && raw[raw.length - 1] === '') raw.pop();
    raw.forEach((s, i) => {
      const m = EMBY_LEVEL.exec(s) ?? JF_LEVEL.exec(s);
      if (m) cur = LEVELS[m[1]] ?? 'info';
      out.push({ n: i + 1, text: s, level: cur });
    });
    return out;
  });
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q && level === 'all') return lines;
    return lines.filter((l) => (level === 'all' || l.level === level) && (!q || l.text.toLowerCase().includes(q)));
  });

  const levelOptions = $derived([
    { value: 'all' as LevelFilter, label: t('adminServer.logs.levels.all') },
    { value: 'error' as LevelFilter, label: t('adminServer.logs.levels.error') },
    { value: 'warn' as LevelFilter, label: t('adminServer.logs.levels.warn') },
    { value: 'info' as LevelFilter, label: t('adminServer.logs.levels.info') },
    { value: 'debug' as LevelFilter, label: t('adminServer.logs.levels.debug') },
  ]);

  // ---- Windowing ----

  const LINE = 18;
  const OVERSCAN = 30;
  let scroller = $state<HTMLDivElement>();
  let scrollTop = $state(0);
  let viewH = $state(480);
  const first = $derived(Math.max(0, Math.floor(scrollTop / LINE) - OVERSCAN));
  const last = $derived(Math.min(shown.length, Math.ceil((scrollTop + viewH) / LINE) + OVERSCAN));
  const slice = $derived(shown.slice(first, last));
  const gutter = $derived(String(lines.length).length);

  function atBottom(): boolean {
    return !!scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < LINE * 2;
  }
  function toBottom(): void {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  // Text matches split for highlighting.
  function parts(s: string): { text: string; hit: boolean }[] {
    const q = query.trim();
    if (!q) return [{ text: s, hit: false }];
    const out: { text: string; hit: boolean }[] = [];
    const lower = s.toLowerCase();
    const ql = q.toLowerCase();
    let i = 0;
    for (let j = lower.indexOf(ql); j >= 0; j = lower.indexOf(ql, i)) {
      if (j > i) out.push({ text: s.slice(i, j), hit: false });
      out.push({ text: s.slice(j, j + q.length), hit: true });
      i = j + q.length;
    }
    if (i < s.length) out.push({ text: s.slice(i), hit: false });
    return out;
  }

  // ---- Follow (current log only) ----

  let timer: ReturnType<typeof setInterval> | undefined;
  $effect(() => {
    if (!follow || !open) return;
    const name = open.Name;
    // One download at a time: on a slow link the ticks wait instead of stacking.
    let busy = false;
    timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      const stick = atBottom();
      try {
        const next = await fetchText(name);
        if (open?.Name !== name || next === text) return;
        text = next;
        await tick();
        if (stick) toBottom();
      } catch {
        /* keep the last text; the next tick retries */
      } finally {
        busy = false;
      }
    }, 4000);
    return () => clearInterval(timer);
  });

  function filteredText(): string {
    return shown.map((l) => l.text).join('\n');
  }

  onMount(() => void loadFiles());
  onDestroy(() => clearInterval(timer));
</script>

{#if open}
  <div class="bar">
    <button type="button" class="a-push ghost back" onclick={() => ((open = null), (follow = false), (text = ''))}>
      <Icon name="chevronLeft" size={15} />{t('adminServer.logs.back')}
    </button>
    <span class="fname mono">{open.Name}</span>
    {#if open.Name === current}
      <label class="follow">
        <span>{t('adminServer.logs.follow')}</span>
        <Toggle label={t('adminServer.logs.follow')} checked={follow} onchange={(v) => (follow = v)} />
      </label>
    {/if}
  </div>
  <div class="tools">
    <span class="search">
      <Icon name="search" size={14} />
      <input type="search" spellcheck="false" placeholder={t('adminServer.logs.search')} aria-label={t('adminServer.logs.search')} bind:value={query} oninput={() => scroller && (scroller.scrollTop = 0)} />
    </span>
    <Segmented label={t('adminServer.logs.levelLabel')} value={level} options={levelOptions} onchange={(v) => ((level = v), scroller && (scroller.scrollTop = 0))} />
    <button type="button" class="a-push icon ghost" title={t('adminServer.logs.reload')} aria-label={t('adminServer.logs.reload')} onclick={() => open && show(open)}>
      <Icon name="refresh" size={15} />
    </button>
    <button type="button" class="a-push ghost" disabled={!shown.length} onclick={() => copyText(filteredText())}>{t('common.actions.copy')}</button>
    <button type="button" class="a-push ghost" disabled={!text} onclick={() => open && saveTextFile(open.Name, text)}>
      <Icon name="download" size={14} />{t('common.actions.download')}
    </button>
  </div>

  {#if viewLoading}
    <div class="skeleton viewer"></div>
  {:else if viewError}
    <div class="a-group"><div class="a-empty">{viewError}</div></div>
  {:else}
    <!-- Focusable so the keyboard can scroll the log (a scrollable region needs a tab stop). -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="viewer mono"
      role="log"
      tabindex="0"
      aria-label={open.Name}
      bind:this={scroller}
      bind:clientHeight={viewH}
      onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
    >
      {#if !shown.length}
        <div class="a-empty">{lines.length ? t('adminServer.logs.noMatch') : t('adminServer.logs.empty')}</div>
      {:else}
        <div class="spacer" style:height="{shown.length * LINE}px">
          <div class="win" style:transform="translateY({first * LINE}px)" style:--g="{gutter}ch">
            {#each slice as l (l.n)}
              <div class="ln {l.level}"><span class="no">{l.n}</span><span class="tx">{#each parts(l.text) as p, i (i)}{#if p.hit}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}</span></div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
    <p class="a-foot tabular">
      {shown.length === lines.length
        ? t('adminServer.logs.lineCount', { n: lines.length })
        : t('adminServer.logs.filteredCount', { n: shown.length, total: fmt.number(lines.length) })}
      {#if open.Size}· {fmt.bytes(open.Size)}{/if}
    </p>
  {/if}
{:else if loading}
  <div class="skeleton sk"></div>
{:else if error}
  <div class="a-group">
    <div class="a-empty">
      {error}
      <div class="retry"><button type="button" class="a-push" onclick={loadFiles}>{t('common.actions.retry')}</button></div>
    </div>
  </div>
{:else if !files.length}
  <div class="a-group"><div class="a-empty">{t('adminServer.logs.none')}</div></div>
{:else}
  <div class="a-group">
    {#each files as f (f.Name)}
      <button type="button" class="a-row link" onclick={() => show(f)}>
        <span class="ic"><Icon name="file" size={17} /></span>
        <span class="a-txt">
          <span class="a-lbl"><span class="ell mono-name">{f.Name}</span>{#if f.Name === current}<span class="tag">{t('adminServer.logs.current')}</span>{/if}</span>
          <span class="a-desc">
            {[f.DateModified ? t('adminServer.logs.modified', { when: fmt.relative(f.DateModified) }) : '', f.Size !== undefined ? fmt.bytes(f.Size) : ''].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span class="chev"><Icon name="chevronRight" size={16} /></span>
      </button>
    {/each}
  </div>
  <p class="a-foot">{t('adminServer.logs.foot')}</p>
{/if}

<style>
  .sk {
    height: 300px;
    border-radius: var(--r-sm);
  }
  .retry {
    margin-top: 12px;
  }
  .link {
    width: 100%;
    text-align: left;
    color: var(--label);
  }
  .link:hover,
  .link:focus-visible {
    background: var(--fill-1);
  }
  .ic,
  .chev {
    flex: none;
    display: grid;
    color: var(--label-3);
  }
  .ell {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mono-name {
    font-family: var(--font-mono);
    font-size: var(--fs-callout);
    font-weight: 450;
  }
  .tag {
    flex: none;
    font-size: var(--fs-caption);
    font-weight: 500;
    color: var(--label-2);
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--fill-2);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  .back {
    padding-left: 6px;
  }
  .fname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-callout);
    color: var(--label);
  }
  .follow {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .search {
    flex: 1;
    min-width: 160px;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 10px;
    border-radius: var(--r-xs);
    background: var(--fill-1);
    box-shadow: inset 0 0 0 1px var(--separator);
    color: var(--label-3);
  }
  .search:focus-within {
    background: var(--fill-2);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    outline: none;
    font: inherit;
    font-size: var(--fs-callout);
    color: var(--label);
  }

  .viewer {
    position: relative;
    height: max(320px, calc(100vh - 330px));
    overflow: auto;
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
    font-size: 12px;
    outline: none;
    contain: strict;
  }
  .spacer {
    position: relative;
    min-width: 100%;
    width: max-content;
  }
  .win {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    padding: 0 14px 0 0;
    will-change: transform;
  }
  .ln {
    display: flex;
    height: 18px;
    line-height: 18px;
    white-space: pre;
    color: var(--label-2);
  }
  .no {
    flex: none;
    width: calc(var(--g) + 26px);
    padding-right: 12px;
    text-align: right;
    color: var(--label-4);
    user-select: none;
  }
  .tx {
    user-select: text;
  }
  /* Restrained level cues: a coloured line number and a tick, the text stays neutral. */
  .ln.debug {
    color: var(--label-3);
  }
  .ln.warn,
  .ln.error {
    color: var(--label);
  }
  .ln.warn .no {
    color: var(--warning);
    box-shadow: inset 2px 0 var(--warning);
  }
  .ln.error .no {
    color: var(--danger);
    box-shadow: inset 2px 0 var(--danger);
  }
  mark {
    border-radius: 3px;
    background: var(--fill-4);
    color: var(--label);
  }
</style>
