<script lang="ts">
  // Plugins: installed list, catalogue and (Jellyfin) repositories.
  // Emby:     GET /Plugins, POST /Plugins/{id}/Delete, GET /Packages?TargetSystems=Server,
  //           POST /Packages/Installed/{name}?AssemblyGuid&Version&UpdateClass. No enable/disable.
  // Jellyfin: GET /Plugins (with Status, CanUninstall), POST /Plugins/{id}/{version}/Enable|Disable,
  //           DELETE /Plugins/{id}/{version}, GET /Packages, POST /Packages/Installed/{name}?assemblyGuid&version&repositoryUrl,
  //           GET|POST /Repositories.
  // Plugin settings open the server's own web page in the browser (/web/ConfigurationPages).
  // Every install, removal or toggle takes effect after a restart.
  import { onMount } from 'svelte';
  import type { ServerKind } from '../../shared/contract';
  import Icon from '../components/Icon.svelte';
  import Picker from '../components/Picker.svelte';
  import Segmented from '../components/Segmented.svelte';
  import Sheet from '../components/Sheet.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { w } from '../lib/bridge';
  import { fmt, has, t } from '../lib/i18n.svelte';
  import { toast } from '../lib/stores.svelte';
  import ConfirmSheet from './server/ConfirmSheet.svelte';
  import RestartBanner from './server/RestartBanner.svelte';
  import { adminApi, adminError, checkPendingRestart, compareVersions, markRestart, sameGuid, serverKind, serverWebUrl } from './server/serverAdmin.svelte';

  let { serverId, kind: kindProp }: { serverId: string; kind?: ServerKind } = $props();
  const kind = $derived(serverKind(serverId, kindProp));
  const api = $derived(adminApi(serverId));

  interface Plugin {
    Id: string;
    Name: string;
    Version: string;
    Description?: string;
    CanUninstall?: boolean;
    Status?: string;
  }
  interface Pkg {
    guid: string;
    name: string;
    description: string;
    category: string;
    owner: string;
    latest?: string;
    repositoryUrl?: string;
    premium: boolean;
  }
  interface Repo {
    Name: string;
    Url: string;
    Enabled: boolean;
  }
  interface ConfigPage {
    Name: string;
    PluginId?: string;
  }

  type Tab = 'installed' | 'catalog' | 'repos';
  let tab = $state<Tab>('installed');
  let loading = $state(true);
  let error = $state('');
  let plugins = $state<Plugin[]>([]);
  let pages = $state<ConfigPage[]>([]);
  let packages = $state<Pkg[] | null>(null);
  let catalogError = $state('');
  let repos = $state<Repo[] | null>(null);
  let busy = $state<Record<string, boolean>>({});
  let query = $state('');
  let category = $state('');
  let removing = $state<Plugin | null>(null);
  // Installing or updating runs third-party code on the server; removing a repository drops its catalogue.
  type Pending = { kind: 'install' | 'update'; pkg: Pkg } | { kind: 'removeRepo'; repo: Repo; index: number };
  let pending = $state<Pending | null>(null);
  let addingRepo = $state(false);
  let repoName = $state('');
  let repoUrl = $state('');

  const tabs = $derived([
    { value: 'installed' as Tab, label: t('adminServer.plugins.tabs.installed') },
    { value: 'catalog' as Tab, label: t('adminServer.plugins.tabs.catalog') },
    ...(kind === 'jellyfin' ? [{ value: 'repos' as Tab, label: t('adminServer.plugins.tabs.repos') }] : []),
  ]);

  // ---- Loading ----

  async function loadInstalled(): Promise<void> {
    loading = true;
    error = '';
    try {
      const list = await api.get<Plugin[]>('/Plugins');
      plugins = [...(list ?? [])].sort((a, b) => fmt.compare(a.Name, b.Name));
      void loadPages();
      // The catalogue also tells which installed plugins have an update.
      if (!packages) void loadCatalog();
      void checkPendingRestart(serverId);
    } catch (err) {
      error = adminError(err);
    } finally {
      loading = false;
    }
  }

  async function loadPages(): Promise<void> {
    pages = (await api.get<ConfigPage[]>('/web/ConfigurationPages', kind === 'emby' ? { PageType: 'PluginConfiguration' } : undefined).catch(() => [])) ?? [];
  }

  // Both servers send lowercase package fields; versions differ (Emby versionStr, Jellyfin version).
  interface RawVersion {
    versionStr?: string;
    version?: string;
    classification?: string;
    repositoryUrl?: string;
  }
  interface RawPkg {
    guid?: string;
    name: string;
    shortDescription?: string;
    description?: string;
    overview?: string;
    category?: string;
    owner?: string;
    isPremium?: boolean;
    versions?: RawVersion[];
  }
  let catalogLoad: Promise<void> | null = null;
  function loadCatalog(): Promise<void> {
    catalogLoad ??= fetchCatalog().finally(() => (catalogLoad = null));
    return catalogLoad;
  }
  async function fetchCatalog(): Promise<void> {
    catalogError = '';
    try {
      const raw = (await api.get<RawPkg[]>('/Packages', kind === 'emby' ? { TargetSystems: 'Server' } : undefined)) ?? [];
      packages = raw
        .map((p) => {
          const versions = (p.versions ?? []).filter((v) => !v.classification || v.classification === 'Release');
          const best = versions.reduce<RawVersion | undefined>((a, v) => (!a || compareVersions(v.versionStr ?? v.version ?? '', a.versionStr ?? a.version ?? '') > 0 ? v : a), undefined);
          return {
            guid: p.guid ?? '',
            name: p.name,
            description: p.shortDescription || p.description || p.overview || '',
            category: p.category ?? '',
            owner: p.owner ?? '',
            latest: best?.versionStr ?? best?.version,
            repositoryUrl: best?.repositoryUrl,
            premium: !!p.isPremium,
          };
        })
        .sort((a, b) => fmt.compare(a.name, b.name));
    } catch (err) {
      packages = [];
      catalogError = adminError(err);
    }
  }

  async function loadRepos(): Promise<void> {
    repos = (await api.get<Repo[]>('/Repositories').catch(() => [])) ?? [];
  }

  $effect(() => {
    if (tab === 'catalog' && !packages) void loadCatalog();
    if (tab === 'repos' && !repos) void loadRepos();
  });

  // ---- Matching installed plugins and packages ----

  function packageOf(p: Plugin): Pkg | undefined {
    return packages?.find((k) => sameGuid(k.guid, p.Id)) ?? packages?.find((k) => k.name.toLowerCase() === p.Name.toLowerCase());
  }
  function installedOf(k: Pkg): Plugin | undefined {
    return plugins.find((p) => sameGuid(k.guid, p.Id)) ?? plugins.find((p) => p.Name.toLowerCase() === k.name.toLowerCase());
  }
  function updateFor(p: Plugin): Pkg | undefined {
    const k = packageOf(p);
    return k?.latest && compareVersions(k.latest, p.Version) > 0 ? k : undefined;
  }
  function configPage(p: Plugin): ConfigPage | undefined {
    return pages.find((pg) => sameGuid(pg.PluginId, p.Id));
  }

  const categories = $derived([...new Set((packages ?? []).map((k) => k.category).filter(Boolean))].sort(fmt.compare));
  const filtered = $derived(
    (packages ?? []).filter((k) => {
      const q = query.trim().toLowerCase();
      return (!category || k.category === category) && (!q || k.name.toLowerCase().includes(q) || k.description.toLowerCase().includes(q));
    }),
  );

  // ---- Actions ----

  async function run(key: string, fn: () => Promise<unknown>, done: string): Promise<boolean> {
    busy[key] = true;
    try {
      await fn();
      toast('success', done);
      return true;
    } catch (err) {
      toast('error', adminError(err));
      return false;
    } finally {
      busy[key] = false;
    }
  }

  async function setEnabled(p: Plugin, on: boolean): Promise<void> {
    const ok = await run(p.Id, () => api.post(`/Plugins/${p.Id}/${encodeURIComponent(p.Version)}/${on ? 'Enable' : 'Disable'}`), on ? t('adminServer.plugins.enabled') : t('adminServer.plugins.disabled'));
    if (ok) {
      markRestart(serverId);
      p.Status = on ? 'Active' : 'Disabled';
      void loadInstalled();
    }
  }

  async function uninstall(): Promise<void> {
    const p = removing;
    if (!p) return;
    const ok = await run(
      p.Id,
      () => (kind === 'jellyfin' ? api.del(`/Plugins/${p.Id}/${encodeURIComponent(p.Version)}`) : api.post(`/Plugins/${p.Id}/Delete`)),
      t('adminServer.plugins.uninstalled', { name: p.Name }),
    );
    removing = null;
    if (ok) {
      markRestart(serverId);
      void loadInstalled();
    }
  }

  async function install(k: Pkg): Promise<void> {
    const query =
      kind === 'jellyfin'
        ? { assemblyGuid: k.guid || undefined, version: k.latest, repositoryUrl: k.repositoryUrl }
        : { AssemblyGuid: k.guid || undefined, Version: k.latest, UpdateClass: 'Release' };
    const ok = await run(`pkg:${k.name}`, () => api.post(`/Packages/Installed/${encodeURIComponent(k.name)}`, query), t('adminServer.plugins.installing', { name: k.name }));
    if (ok) {
      markRestart(serverId);
      void loadInstalled();
    }
  }

  async function confirmPending(): Promise<void> {
    const p = pending;
    if (!p) return;
    if (p.kind === 'removeRepo') {
      // Only the entry that was confirmed: by position, and only if the list has not changed under it.
      const list = repos ?? [];
      if (list[p.index]?.Url === p.repo.Url && list[p.index]?.Name === p.repo.Name) {
        await saveRepos(list.filter((_, j) => j !== p.index), t('adminServer.plugins.repos.removed'));
      }
    } else {
      await install(p.pkg);
    }
    pending = null;
  }

  const pendingBusy = $derived(!!pending && (pending.kind === 'removeRepo' ? !!busy.repos : !!busy[`pkg:${pending.pkg.name}`]));
  const pendingTitle = $derived(
    !pending
      ? ''
      : pending.kind === 'removeRepo'
        ? t('adminServer.plugins.repos.removeTitle', { name: pending.repo.Name })
        : pending.kind === 'update'
          ? t('adminServer.plugins.confirmUpdateTitle', { name: pending.pkg.name, version: pending.pkg.latest ?? '' })
          : t('adminServer.plugins.confirmInstallTitle', { name: pending.pkg.name }),
  );

  function configure(p: Plugin): void {
    const page = configPage(p);
    const url = page
      ? serverWebUrl(serverId, kind, `configurationpage?name=${encodeURIComponent(page.Name)}`)
      : serverWebUrl(serverId, kind, kind === 'jellyfin' ? 'dashboard/plugins' : 'plugins');
    if (url) void w.app.openExternal(url);
  }

  function statusOf(p: Plugin): { label: string; cls: '' | 'ok' | 'warn' | 'bad' } | null {
    if (!p.Status) return null;
    const cls = p.Status === 'Active' ? 'ok' : p.Status === 'Restart' || p.Status === 'Deleted' ? 'warn' : p.Status === 'Disabled' || p.Status === 'Superseded' || p.Status === 'Superceded' ? '' : 'bad';
    const key = `adminServer.plugins.status.${p.Status}`;
    return { label: has(key) ? t(key) : p.Status, cls };
  }

  // ---- Repositories (Jellyfin) ----

  const repoUrlValid = $derived(/^https?:\/\/\S+$/i.test(repoUrl.trim()) && !(repos ?? []).some((r) => r.Url === repoUrl.trim()));
  async function saveRepos(next: Repo[], done: string): Promise<void> {
    const ok = await run('repos', () => api.post('/Repositories', undefined, next), done);
    if (ok) {
      repos = next;
      packages = null;
    }
  }
  async function addRepo(): Promise<void> {
    if (!repoUrlValid || !repoName.trim()) return;
    await saveRepos([...(repos ?? []), { Name: repoName.trim(), Url: repoUrl.trim(), Enabled: true }], t('adminServer.plugins.repos.added'));
    addingRepo = false;
    repoName = repoUrl = '';
  }

  onMount(() => void loadInstalled());
</script>

<RestartBanner {serverId} />

<div class="head">
  <Segmented label={t('adminServer.plugins.tabsLabel')} value={tab} options={tabs} onchange={(v) => (tab = v)} />
  {#if tab === 'catalog'}
    <input class="a-input search" type="search" placeholder={t('adminServer.plugins.search')} aria-label={t('adminServer.plugins.search')} bind:value={query} />
    {#if categories.length}
      <Picker
        label={t('adminServer.plugins.category')}
        value={category}
        options={[{ value: '', label: t('adminServer.plugins.allCategories') }, ...categories.map((c) => ({ value: c, label: c }))]}
        onchange={(v) => (category = v)}
      />
    {/if}
  {:else if tab === 'repos'}
    <span class="grow"></span>
    <button type="button" class="a-push" onclick={() => (addingRepo = true)}><Icon name="plus" size={14} />{t('adminServer.plugins.repos.add')}</button>
  {/if}
</div>

{#if tab === 'installed'}
  {#if loading}
    <div class="skeleton sk"></div>
  {:else if error}
    <div class="a-group">
      <div class="a-empty">
        {error}
        <div class="retry"><button type="button" class="a-push" onclick={loadInstalled}>{t('common.actions.retry')}</button></div>
      </div>
    </div>
  {:else if !plugins.length}
    <div class="a-group"><div class="a-empty">{t('adminServer.plugins.noneInstalled')}</div></div>
  {:else}
    <div class="a-group">
      {#each plugins as p (p.Id)}
        {@const st = statusOf(p)}
        {@const upd = updateFor(p)}
        <div class="a-row">
          <span class="ic"><Icon name="puzzle" size={18} /></span>
          <div class="a-txt">
            <span class="a-lbl"><span class="ell">{p.Name}</span><span class="ver tabular">{p.Version}</span></span>
            {#if p.Description}<span class="a-desc clamp">{p.Description}</span>{/if}
          </div>
          {#if st}<span class="a-status {st.cls}">{st.label}</span>{/if}
          <div class="a-actions">
            {#if upd}
              <button type="button" class="a-push" disabled={busy[`pkg:${upd.name}`]} onclick={() => (pending = { kind: 'update', pkg: upd })}>{t('adminServer.plugins.update', { version: upd.latest ?? '' })}</button>
            {/if}
            {#if configPage(p)}
              <button type="button" class="a-push ghost" title={t('adminServer.plugins.configureHint')} onclick={() => configure(p)}>
                {t('adminServer.plugins.configure')}<Icon name="externalLink" size={13} />
              </button>
            {/if}
            {#if kind === 'jellyfin' && p.Status && p.Status !== 'Deleted' && p.Status !== 'NotSupported'}
              <Toggle label={t('adminServer.plugins.enable', { name: p.Name })} checked={p.Status !== 'Disabled'} disabled={busy[p.Id]} onchange={(v) => setEnabled(p, v)} />
            {/if}
            {#if p.CanUninstall !== false && p.Status !== 'Deleted'}
              <button type="button" class="a-push icon ghost" aria-label={t('adminServer.plugins.uninstall', { name: p.Name })} title={t('adminServer.plugins.uninstallShort')} disabled={busy[p.Id]} onclick={() => (removing = p)}>
                <Icon name="trash" size={15} />
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
    <p class="a-foot">{t('adminServer.plugins.installedFoot')}</p>
  {/if}
{:else if tab === 'catalog'}
  {#if !packages}
    <div class="skeleton sk"></div>
  {:else if catalogError}
    <div class="a-group">
      <div class="a-empty">
        {catalogError}
        <div class="retry"><button type="button" class="a-push" onclick={() => ((packages = null), loadCatalog())}>{t('common.actions.retry')}</button></div>
      </div>
    </div>
  {:else if !filtered.length}
    <div class="a-group"><div class="a-empty">{packages.length ? t('adminServer.plugins.noMatch') : t('adminServer.plugins.catalogEmpty')}</div></div>
  {:else}
    <div class="a-group">
      {#each filtered as k (k.guid || k.name)}
        {@const inst = installedOf(k)}
        <div class="a-row">
          <span class="ic"><Icon name="puzzle" size={18} /></span>
          <div class="a-txt">
            <span class="a-lbl"><span class="ell">{k.name}</span>{#if k.latest}<span class="ver tabular">{k.latest}</span>{/if}</span>
            {#if k.description}<span class="a-desc clamp">{k.description}</span>{/if}
            <span class="a-desc meta">{[k.category, k.owner, k.premium ? t('adminServer.plugins.premium') : ''].filter(Boolean).join(' · ')}</span>
          </div>
          <div class="a-actions">
            {#if inst && k.latest && compareVersions(k.latest, inst.Version) > 0}
              <button type="button" class="a-push" disabled={busy[`pkg:${k.name}`]} onclick={() => (pending = { kind: 'update', pkg: k })}>{t('adminServer.plugins.update', { version: k.latest })}</button>
            {:else if inst}
              <span class="a-status ok">{t('adminServer.plugins.installed')}</span>
            {:else}
              <button type="button" class="a-push" disabled={busy[`pkg:${k.name}`] || !k.latest} onclick={() => (pending = { kind: 'install', pkg: k })}>{t('adminServer.plugins.install')}</button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
    <p class="a-foot">{t('adminServer.plugins.catalogFoot', { n: filtered.length })}</p>
  {/if}
{:else if tab === 'repos'}
  {#if !repos}
    <div class="skeleton sk"></div>
  {:else if !repos.length}
    <div class="a-group"><div class="a-empty">{t('adminServer.plugins.repos.none')}</div></div>
  {:else}
    <div class="a-group">
      {#each repos as r, i (`${i}:${r.Url}`)}
        <div class="a-row">
          <div class="a-txt">
            <span class="a-lbl">{r.Name}</span>
            <span class="a-desc url">{r.Url}</span>
          </div>
          <div class="a-actions">
            <Toggle
              label={t('adminServer.plugins.repos.enable', { name: r.Name })}
              checked={r.Enabled}
              disabled={busy.repos}
              onchange={(v) => saveRepos(repos!.map((x, j) => (j === i ? { ...x, Enabled: v } : x)), t('adminServer.common.saved'))}
            />
            <button
              type="button"
              class="a-push icon ghost"
              aria-label={t('adminServer.plugins.repos.remove', { name: r.Name })}
              disabled={busy.repos}
              onclick={() => (pending = { kind: 'removeRepo', repo: r, index: i })}
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
        </div>
      {/each}
    </div>
    <p class="a-foot">{t('adminServer.plugins.repos.foot')}</p>
  {/if}
{/if}

<ConfirmSheet
  open={!!removing}
  title={t('adminServer.plugins.uninstallTitle', { name: removing?.Name ?? '' })}
  message={t('adminServer.plugins.uninstallText')}
  confirmLabel={t('adminServer.plugins.uninstallShort')}
  danger
  busy={!!removing && busy[removing.Id]}
  onconfirm={uninstall}
  onclose={() => (removing = null)}
/>

<ConfirmSheet
  open={!!pending}
  title={pendingTitle}
  message={pending?.kind === 'removeRepo' ? t('adminServer.plugins.repos.removeText') : t('adminServer.plugins.confirmInstallText')}
  confirmLabel={pending?.kind === 'removeRepo' ? t('adminServer.plugins.repos.remove', { name: pending.repo.Name }) : pending?.kind === 'update' ? t('adminServer.plugins.update', { version: pending.pkg.latest ?? '' }) : t('adminServer.plugins.install')}
  danger={pending?.kind === 'removeRepo'}
  busy={pendingBusy}
  onconfirm={confirmPending}
  onclose={() => (pending = null)}
/>

<Sheet open={addingRepo} onclose={() => (addingRepo = false)} label={t('adminServer.plugins.repos.addTitle')} width={480}>
  <form class="a-sheet" onsubmit={(e) => (e.preventDefault(), void addRepo())}>
    <h2>{t('adminServer.plugins.repos.addTitle')}</h2>
    <p>{t('adminServer.plugins.repos.addText')}</p>
    <label>{t('adminServer.plugins.repos.name')}<input class="a-input" type="text" bind:value={repoName} data-autofocus /></label>
    <label>
      {t('adminServer.plugins.repos.url')}
      <input class="a-input mono" type="url" spellcheck="false" placeholder="https://…/manifest.json" bind:value={repoUrl} />
    </label>
    {#if repoUrl.trim() && !repoUrlValid}<span class="warn">{t('adminServer.plugins.repos.badUrl')}</span>{/if}
    <div class="a-sheet-actions">
      <button type="button" class="a-push ghost" onclick={() => (addingRepo = false)}>{t('common.actions.cancel')}</button>
      <button type="submit" class="a-push primary" disabled={!repoUrlValid || !repoName.trim() || busy.repos}>{t('common.actions.add')}</button>
    </div>
  </form>
</Sheet>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 16px;
  }
  .grow {
    flex: 1;
  }
  .search {
    flex: 1;
    min-width: 120px;
  }
  .sk {
    height: 360px;
    border-radius: var(--r-sm);
  }
  .retry {
    margin-top: 12px;
  }
  .ic {
    flex: none;
    display: grid;
    color: var(--label-3);
  }
  .ell {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ver {
    flex: none;
    font-size: var(--fs-footnote);
    font-weight: 400;
    color: var(--label-3);
  }
  .clamp {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .meta {
    font-size: var(--fs-caption);
  }
  .url {
    font-family: var(--font-mono);
    font-size: var(--fs-caption);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: text;
  }
  .warn {
    font-size: var(--fs-footnote);
    color: var(--warning);
  }
</style>
