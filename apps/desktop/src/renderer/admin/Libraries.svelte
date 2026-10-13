<script lang="ts">
  // Library administration for one server: the virtual folders with their
  // folders, counts and scan state; add, edit, remove; scans. Paths are on the
  // SERVER's disks. Emby/Jellyfin differences live in libraries/libraryAdmin.ts.
  import { untrack } from 'svelte';
  import type { ServerKind } from '../../shared/contract';
  import Icon, { type IconName } from '../components/Icon.svelte';
  import Sheet from '../components/Sheet.svelte';
  import { invalidateApiCache } from '../lib/api';
  import { w } from '../lib/bridge';
  import { fmt, t } from '../lib/i18n.svelte';
  import { dataVersion, errorMessage, serverName, toast } from '../lib/stores.svelte';
  import AddLibrary from './libraries/AddLibrary.svelte';
  import LibraryEditor from './libraries/LibraryEditor.svelte';
  import {
    contentType,
    libraryAdmin,
    type Country,
    type Culture,
    type ServerPaths,
    type TaskInfo,
    type VirtualFolder,
  } from './libraries/libraryAdmin';
  import { live } from './live';

  let { serverId, kind: kindProp }: { serverId: string; kind?: ServerKind } = $props();

  const admin = $derived(libraryAdmin(serverId, kindProp));
  const kind = $derived<ServerKind>(kindProp ?? admin.kind());
  const server = $derived(serverName(serverId));

  let folders = $state<VirtualFolder[] | null>(null);
  let error = $state('');
  let task = $state<TaskInfo | undefined>();
  let counts = $state<Record<string, number | null>>({});
  // Per-library scan progress (0–100) from RefreshProgress events or the folder list.
  let progress = $state<Record<string, number>>({});
  // Scans started here, shown until the server reports them (or 20 s pass).
  let requested = $state<Record<string, number>>({});
  let paths = $state<ServerPaths | null>(null);
  let languages = $state<{ value: string; label: string }[]>([]);
  let countries = $state<{ value: string; label: string }[]>([]);
  let subtitleLanguages = $state<{ value: string; label: string }[]>([]);

  let adding = $state(false);
  let editing = $state<VirtualFolder | null>(null);
  let removing = $state<VirtualFolder | null>(null);
  let confirmName = $state('');
  let busy = $state(false);

  const taskRunning = $derived(task?.State === 'Running' || task?.State === 'Cancelling');
  const anyScan = $derived(taskRunning || Object.keys(progress).length > 0 || Object.keys(requested).length > 0);

  const ICONS: Record<string, IconName> = {
    movies: 'film', // i18n-ignore (icon name)
    tvshows: 'tv',
    music: 'music',
    musicvideos: 'music',
    audiobooks: 'audio',
    books: 'book',
    homevideos: 'folderOpen',
    boxsets: 'collection',
    mixed: 'folder',
  };
  const typeLabel = (type: string) => {
    const k = `adminLibraries.types.${type}`;
    const s = t(k);
    return s === k ? type : s;
  };

  async function refresh(): Promise<void> {
    const [list, tk] = await Promise.all([
      admin.folders().catch((err: unknown) => {
        error = errorMessage(err);
        return null;
      }),
      admin.scanTask().catch(() => undefined),
    ]);
    task = tk;
    if (!list) return;
    error = '';
    const now = Date.now();
    const next: Record<string, number> = {};
    for (const f of list) {
      const id = f.ItemId ?? f.Name;
      const active = f.RefreshStatus && f.RefreshStatus !== 'Idle' && f.RefreshProgress != null;
      if (active) next[id] = Math.round(f.RefreshProgress ?? 0);
      else if (progress[id] != null && progress[id] < 100 && taskRunning) next[id] = progress[id];
      if (active || (requested[id] && now - requested[id] > 20_000)) delete requested[id];
    }
    progress = next;
    const before = new Set((folders ?? []).map((f) => f.ItemId));
    folders = list;
    if (list.some((f) => !before.has(f.ItemId))) void loadCounts(list);
  }

  async function loadCounts(list: VirtualFolder[]): Promise<void> {
    const pairs = await Promise.all(list.map(async (f) => [f.ItemId ?? f.Name, await admin.count(f).catch(() => null)] as const));
    counts = Object.fromEntries(pairs);
  }

  async function loadReference(): Promise<void> {
    const cap = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);
    const [cul, cty, info] = await Promise.all([
      admin.cultures().catch(() => [] as Culture[]),
      admin.countries().catch(() => [] as Country[]),
      admin.serverPaths().catch(() => null),
    ]);
    const seen = new Set<string>();
    const langs = (cul ?? [])
      .filter((c) => c.TwoLetterISOLanguageName && !seen.has(c.TwoLetterISOLanguageName) && seen.add(c.TwoLetterISOLanguageName))
      .map((c) => {
        const l = fmt.language(c.TwoLetterISOLanguageName);
        return { value: c.TwoLetterISOLanguageName, label: cap(l === c.TwoLetterISOLanguageName ? c.DisplayName : l) };
      })
      .sort((a, b) => fmt.compare(a.label, b.label));
    languages = [{ value: '', label: t('adminLibraries.fields.serverDefault') }, ...langs];
    const seen3 = new Set<string>();
    subtitleLanguages = (cul ?? [])
      .filter((c) => c.ThreeLetterISOLanguageName && !seen3.has(c.ThreeLetterISOLanguageName) && seen3.add(c.ThreeLetterISOLanguageName))
      .map((c) => {
        const l = fmt.language(c.TwoLetterISOLanguageName || c.ThreeLetterISOLanguageName!);
        return { value: c.ThreeLetterISOLanguageName!, label: cap(l.length <= 3 ? c.DisplayName : l) };
      })
      .sort((a, b) => fmt.compare(a.label, b.label));
    let region: Intl.DisplayNames | null = null;
    try {
      region = new Intl.DisplayNames([document.documentElement.lang || 'fr'], { type: 'region' });
    } catch {
      region = null;
    }
    countries = [
      { value: '', label: t('adminLibraries.fields.serverDefault') },
      ...(cty ?? [])
        .filter((c) => c.TwoLetterISORegionName)
        .map((c) => ({ value: c.TwoLetterISORegionName, label: region?.of(c.TwoLetterISORegionName) ?? c.DisplayName }))
        .sort((a, b) => fmt.compare(a.label, b.label)),
    ];
    paths = info;
  }

  $effect(() => {
    const id = serverId;
    return untrack(() => watch(id));
  });

  function watch(serverId: string): () => void {
    const stop = live(serverId, refresh, () => (anyScan ? 1500 : 15_000), ['LibraryChanged', 'ScheduledTaskEnded', 'ScheduledTasksInfo']);
    // Per-library progress pushed by the server while it scans.
    const off = w.events.onServerEvent((ev) => {
      if (ev.serverId && ev.serverId !== serverId) return;
      if (ev.type !== 'RefreshProgress') return;
      const d = ev.data as { ItemId?: string; Progress?: string | number } | null;
      if (!d?.ItemId || !folders?.some((f) => f.ItemId === d.ItemId)) return;
      const p = Math.round(Number(d.Progress) || 0);
      const next = { ...progress, [d.ItemId]: p };
      if (p >= 100) delete next[d.ItemId];
      progress = next;
    });
    void loadReference();
    return () => {
      stop();
      off();
    };
  }

  // The sidebar and home rows list the libraries too.
  function changed(): void {
    invalidateApiCache();
    dataVersion.library++;
  }

  async function scanAll(): Promise<void> {
    try {
      await admin.refreshAll();
      task = task ? { ...task, State: 'Running', CurrentProgressPercentage: task.CurrentProgressPercentage ?? 0 } : task;
      toast('info', t('adminLibraries.scan.startedAll'));
      setTimeout(() => void refresh(), 600);
    } catch (err) {
      toast('error', t('adminLibraries.scan.failed', { error: errorMessage(err) }));
    }
  }

  async function scanOne(f: VirtualFolder): Promise<void> {
    try {
      await admin.refreshFolder(f);
      requested = { ...requested, [f.ItemId ?? f.Name]: Date.now() };
      toast('info', t('adminLibraries.scan.started', { name: f.Name }));
      setTimeout(() => void refresh(), 600);
    } catch (err) {
      toast('error', t('adminLibraries.scan.failed', { error: errorMessage(err) }));
    }
  }

  async function confirmRemove(): Promise<void> {
    const f = removing;
    if (!f || confirmName.trim() !== f.Name || busy) return;
    busy = true;
    try {
      await admin.remove(f);
      toast('success', t('adminLibraries.remove.done', { name: f.Name }));
      removing = null;
      changed();
      await refresh();
    } catch (err) {
      toast('error', t('adminLibraries.remove.failed', { error: errorMessage(err) }));
    } finally {
      busy = false;
    }
  }

  const lastScan = $derived(task?.LastExecutionResult?.EndTimeUtc);
  const scanPct = $derived(Math.round(task?.CurrentProgressPercentage ?? 0));

  // Read-only view: every folder grouped by content type.
  const byType = $derived.by(() => {
    const map = new Map<string, { names: string[]; paths: string[] }>();
    for (const f of folders ?? []) {
      const type = contentType(f);
      const e = map.get(type) ?? { names: [], paths: [] };
      e.names.push(f.Name);
      e.paths.push(...(f.Locations ?? []));
      map.set(type, e);
    }
    return [...map.entries()];
  });
  const serverDirs = $derived.by(() => {
    if (!paths) return [] as [string, string][];
    const all: [string, string | undefined][] = [
      ['data', paths.ProgramDataPath],
      ['metadata', paths.InternalMetadataPath ?? paths.MetadataPath],
      ['people', paths.ItemsByNamePath],
      ['cache', paths.CachePath],
      ['transcoding', paths.TranscodingTempPath],
      ['logs', paths.LogPath],
    ];
    return all.filter((x): x is [string, string] => !!x[1]);
  });

  const COUNT_KEYS = new Set(['movies', 'tvshows', 'music', 'musicvideos', 'books', 'audiobooks', 'homevideos', 'boxsets']);
  function countLine(f: VirtualFolder): string {
    const n = counts[f.ItemId ?? f.Name];
    if (n == null) return '';
    return t(`adminLibraries.count.${COUNT_KEYS.has(contentType(f)) ? contentType(f) : 'items'}`, { n });
  }
</script>

<div class="libs">
  <div class="bar">
    <div class="scan-state" aria-live="polite">
      {#if taskRunning}
        <span class="a-status ok">{t('adminLibraries.scan.running', { pct: scanPct })}</span>
        <div class="a-progress bar-progress"><span style:--p={scanPct / 100}></span></div>
      {:else if lastScan}
        <span class="a-status">{t('adminLibraries.scan.last', { when: fmt.relative(lastScan) })}</span>
      {:else if task}
        <span class="a-status">{t('adminLibraries.scan.never')}</span>
      {/if}
    </div>
    <button type="button" class="a-push" disabled={taskRunning || !folders?.length} onclick={scanAll}>
      <Icon name="refresh" size={14} /> {t('adminLibraries.scan.all')}
    </button>
    <button type="button" class="a-push primary" onclick={() => (adding = true)}>
      <Icon name="plus" size={14} /> {t('adminLibraries.add.button')}
    </button>
  </div>

  {#if folders === null && !error}
    <div class="skeleton loading"></div>
  {:else if error && !folders}
    <div class="a-group"><p class="a-empty">{t('adminLibraries.loadFailed')} <span class="caption">{error}</span></p></div>
  {:else if folders && folders.length === 0}
    <div class="a-group">
      <p class="a-empty">{t('adminLibraries.empty')}</p>
    </div>
  {:else if folders}
    <div class="list">
      {#each folders as f, i (f.ItemId ?? f.Name)}
        {@const id = f.ItemId ?? f.Name}
        {@const type = contentType(f)}
        {@const pct = progress[id]}
        {@const pending = pct == null && !!requested[id]}
        {@const monitor = f.LibraryOptions?.EnableRealtimeMonitor}
        <article class="a-group lib" style:--i={Math.min(i, 12)}>
          <div class="a-row head">
            <span class="type-icon"><Icon name={ICONS[type] ?? 'folder'} size={18} /></span>
            <div class="a-txt">
              <div class="a-lbl">{f.Name}</div>
              <div class="a-desc">
                {countLine(f) ? t('adminLibraries.summary', { type: typeLabel(type), count: countLine(f) }) : typeLabel(type)}
              </div>
            </div>
            <div class="a-actions">
              <button type="button" class="a-push" disabled={pct != null || pending} onclick={() => scanOne(f)}>
                {t('adminLibraries.scan.one')}
              </button>
              <button type="button" class="a-push" onclick={() => (editing = $state.snapshot(f) as VirtualFolder)}>
                {t('common.actions.edit')}
              </button>
              <button
                type="button"
                class="a-push icon ghost"
                aria-label={t('adminLibraries.remove.label', { name: f.Name })}
                title={t('adminLibraries.remove.label', { name: f.Name })}
                onclick={() => {
                  confirmName = '';
                  removing = f;
                }}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          </div>
          <div class="paths">
            {#each f.Locations ?? [] as p (p)}
              <div class="path"><Icon name={p.startsWith('\\\\') ? 'network' : 'folder'} size={13} /><span class="mono">{p}</span></div>
            {:else}
              <div class="path none">{t('adminLibraries.noFolders')}</div>
            {/each}
          </div>
          <div class="foot">
            {#if monitor !== undefined}
              <span class="a-status" class:ok={monitor}>{monitor ? t('adminLibraries.monitor.on') : t('adminLibraries.monitor.off')}</span>
            {/if}
            {#if pct != null || pending}
              <span class="scan-line">
                <span class="caption">{pending ? t('adminLibraries.scan.queued') : t('adminLibraries.scan.progress', { pct })}</span>
                <span class="a-progress lib-progress" class:muted={pending}><span style:--p={(pct ?? 0) / 100}></span></span>
              </span>
            {/if}
          </div>
        </article>
      {/each}
    </div>

    <h3 class="a-gh where">{t('adminLibraries.where.title')}</h3>
    <div class="a-group">
      {#each byType as [type, e] (type)}
        <div class="a-row where-row">
          <div class="a-txt">
            <div class="a-lbl">{typeLabel(type)}</div>
            <div class="a-desc">{fmt.list(e.names)}</div>
          </div>
          <div class="where-paths">
            {#each e.paths as p (p)}<span class="mono">{p}</span>{/each}
          </div>
        </div>
      {/each}
    </div>
    {#if serverDirs.length}
      <div class="a-group">
        {#each serverDirs as [k, p] (k)}
          <div class="a-row compact where-row">
            <div class="a-txt"><div class="a-lbl soft">{t(`adminLibraries.where.${k}`)}</div></div>
            <div class="where-paths"><span class="mono">{p}</span></div>
          </div>
        {/each}
      </div>
    {/if}
    <p class="a-foot">{t('adminLibraries.where.foot', { server })}</p>
  {/if}
</div>

<AddLibrary
  open={adding}
  {admin}
  {kind}
  serverName={server}
  existing={(folders ?? []).map((f) => f.Name)}
  {languages}
  {countries}
  onclose={() => (adding = false)}
  oncreated={() => {
    adding = false;
    changed();
    void refresh();
  }}
/>

<LibraryEditor
  open={!!editing}
  {admin}
  {kind}
  folder={editing}
  serverName={server}
  {languages}
  {countries}
  {subtitleLanguages}
  onclose={() => (editing = null)}
  onsaved={() => {
    editing = null;
    changed();
    void refresh();
  }}
/>

<Sheet open={!!removing} onclose={() => (removing = null)} label={t('adminLibraries.remove.title')} width={480}>
  {#if removing}
    <div class="a-sheet">
      <h2>{t('adminLibraries.remove.title')}</h2>
      <p>{t('adminLibraries.remove.body', { name: removing.Name })}</p>
      <p class="safe"><Icon name="info" size={14} /> {t('adminLibraries.remove.filesKept')}</p>
      <label>
        {t('adminLibraries.remove.typeName', { name: removing.Name })}
        <input
          class="a-input"
          data-autofocus
          spellcheck="false"
          autocomplete="off"
          bind:value={confirmName}
          placeholder={removing.Name}
          onkeydown={(e) => {
            if (e.key === 'Enter') void confirmRemove();
          }}
        />
      </label>
      <div class="a-sheet-actions">
        <button type="button" class="a-push ghost" onclick={() => (removing = null)}>{t('common.actions.cancel')}</button>
        <button type="button" class="a-push danger" disabled={confirmName.trim() !== removing.Name || busy} onclick={confirmRemove}>
          {t('adminLibraries.remove.confirm')}
        </button>
      </div>
    </div>
  {/if}
</Sheet>

<style>
  .libs {
    display: flex;
    flex-direction: column;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
  }
  .scan-state {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .bar-progress {
    width: 160px;
  }
  .loading {
    height: 320px;
    border-radius: var(--r-sm);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .list > :global(.a-group + .a-group) {
    margin-top: 0;
  }
  .lib {
    animation: rise var(--t-slow) var(--ease-out) both;
    animation-delay: calc(var(--i) * 30ms * var(--tempo));
  }
  .head {
    padding-bottom: 4px;
  }
  .type-icon {
    display: grid;
    place-items: center;
    width: 22px;
    color: var(--label-2);
  }
  .paths {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 2px 18px 0 56px;
  }
  .path {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .path :global(.wi-icon) {
    color: var(--label-3);
  }
  .path .mono {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: text;
  }
  .path.none {
    color: var(--label-3);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 18px;
    min-height: 20px;
    padding: 8px 18px 12px 56px;
  }
  .scan-line {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .lib-progress {
    flex: 1;
    max-width: 220px;
  }
  .where {
    margin-top: 34px;
  }
  .where-row {
    align-items: flex-start;
  }
  .where-paths {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    min-width: 0;
    max-width: 60%;
    font-size: var(--fs-footnote);
    color: var(--label-2);
    user-select: text;
  }
  .where-paths .mono {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .safe {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 10px 12px;
    border-radius: var(--r-sm);
    background: var(--fill-1);
  }
  .safe :global(.wi-icon) {
    margin-top: 3px;
    flex: none;
  }
</style>
