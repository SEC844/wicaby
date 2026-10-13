<script lang="ts">
  // Server settings: name, languages, paths and log retention (/System/Configuration),
  // plus network. Emby keeps network fields in the main configuration; Jellyfin
  // splits them into the named configuration "network". Only fields the server
  // actually returns are shown, and the whole object read is posted back, so
  // fields this page does not know survive a save.
  import { onMount } from 'svelte';
  import type { ServerKind } from '../../shared/contract';
  import Picker from '../components/Picker.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { fmt, t } from '../lib/i18n.svelte';
  import { toast } from '../lib/stores.svelte';
  import ConfirmSheet from './server/ConfirmSheet.svelte';
  import RestartBanner from './server/RestartBanner.svelte';
  import SaveBar from './server/SaveBar.svelte';
  import { adminApi, adminError, checkPendingRestart, isPort, markRestart, serverKind } from './server/serverAdmin.svelte';

  let { serverId, kind: kindProp }: { serverId: string; kind?: ServerKind } = $props();
  const kind = $derived(serverKind(serverId, kindProp));
  const api = $derived(adminApi(serverId));

  type Src = 'config' | 'network';
  type FieldType = 'text' | 'int' | 'port' | 'bool' | 'list' | 'culture' | 'language' | 'country' | 'path';
  interface Field {
    key: string;
    src: Src;
    type: FieldType;
    // i18n id under adminServer.server.fields
    id: string;
    restart?: boolean;
    // May cut the connection this client is using.
    risky?: boolean;
    min?: number;
    max?: number;
    check?: (v: unknown) => boolean;
  }

  const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
  const SUBNET = /^([0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9a-f:]+)(\/([0-9]{1,3}|[0-9]{1,3}(\.[0-9]{1,3}){3}))?$/i;

  const GENERAL: Field[] = [
    { key: 'ServerName', src: 'config', type: 'text', id: 'serverName', check: (v) => String(v ?? '').length <= 64 },
    { key: 'UICulture', src: 'config', type: 'culture', id: 'uiCulture' },
    { key: 'PreferredMetadataLanguage', src: 'config', type: 'language', id: 'metadataLanguage' },
    { key: 'MetadataCountryCode', src: 'config', type: 'country', id: 'metadataCountry' },
    { key: 'LogFileRetentionDays', src: 'config', type: 'int', id: 'logRetention', min: 1, max: 3650 },
    { key: 'CachePath', src: 'config', type: 'path', id: 'cachePath' },
    { key: 'MetadataPath', src: 'config', type: 'path', id: 'metadataPath' },
  ];

  const NETWORK_EMBY: Field[] = [
    { key: 'HttpServerPortNumber', src: 'config', type: 'port', id: 'httpPort', restart: true, risky: true },
    { key: 'HttpsPortNumber', src: 'config', type: 'port', id: 'httpsPort', restart: true, risky: true },
    { key: 'EnableRemoteAccess', src: 'config', type: 'bool', id: 'remoteAccess', restart: true, risky: true },
    { key: 'PublicPort', src: 'config', type: 'port', id: 'publicHttpPort', restart: true, risky: true },
    { key: 'PublicHttpsPort', src: 'config', type: 'port', id: 'publicHttpsPort', restart: true, risky: true },
    { key: 'WanDdns', src: 'config', type: 'text', id: 'domain', restart: true, check: (v) => !v || HOST.test(String(v)) },
    { key: 'EnableUPnP', src: 'config', type: 'bool', id: 'upnp', restart: true },
    { key: 'LocalNetworkSubnets', src: 'config', type: 'list', id: 'lan', restart: true, risky: true, check: (v) => (v as string[]).every((s) => SUBNET.test(s)) },
  ];

  const NETWORK_JELLYFIN: Field[] = [
    { key: 'InternalHttpPort', src: 'network', type: 'port', id: 'httpPort', restart: true, risky: true },
    { key: 'InternalHttpsPort', src: 'network', type: 'port', id: 'httpsPort', restart: true, risky: true },
    { key: 'EnableRemoteAccess', src: 'network', type: 'bool', id: 'remoteAccess', restart: true, risky: true },
    { key: 'PublicHttpPort', src: 'network', type: 'port', id: 'publicHttpPort', restart: true, risky: true },
    { key: 'PublicHttpsPort', src: 'network', type: 'port', id: 'publicHttpsPort', restart: true, risky: true },
    { key: 'BaseUrl', src: 'network', type: 'text', id: 'baseUrl', restart: true, risky: true, check: (v) => !v || /^\/?[\w\-./]*$/.test(String(v)) },
    { key: 'EnableUPnP', src: 'network', type: 'bool', id: 'upnp', restart: true },
    { key: 'LocalNetworkSubnets', src: 'network', type: 'list', id: 'lan', restart: true, risky: true, check: (v) => (v as string[]).every((s) => SUBNET.test(s)) },
    { key: 'KnownProxies', src: 'network', type: 'list', id: 'proxies', restart: true, check: (v) => (v as string[]).every((s) => SUBNET.test(s) || HOST.test(s)) },
  ];

  type Obj = Record<string, unknown>;
  let loading = $state(true);
  let error = $state('');
  let saving = $state(false);
  let draft = $state<Record<Src, Obj | null>>({ config: null, network: null });
  let saved = $state<Record<Src, string>>({ config: '', network: '' });
  let cultures = $state<{ value: string; label: string }[]>([]);
  let languages = $state<{ value: string; label: string }[]>([]);
  let countries = $state<{ value: string; label: string }[]>([]);
  let confirmRisky = $state(false);

  const networkFields = $derived(kind === 'jellyfin' ? NETWORK_JELLYFIN : NETWORK_EMBY);
  const visible = (fields: Field[]) => fields.filter((f) => draft[f.src] && f.key in (draft[f.src] as Obj));
  const allFields = $derived([...GENERAL, ...networkFields]);

  function snapshot(o: Obj | null): string {
    return o ? JSON.stringify(o) : '';
  }
  function savedValue(f: Field): unknown {
    return saved[f.src] ? (JSON.parse(saved[f.src]) as Obj)[f.key] : undefined;
  }
  function changed(f: Field): boolean {
    return JSON.stringify(draft[f.src]?.[f.key]) !== JSON.stringify(savedValue(f));
  }

  function valid(f: Field): boolean {
    const v = draft[f.src]?.[f.key];
    if (f.type === 'port') return isPort(v);
    if (f.type === 'int') return Number.isInteger(v) && (f.min === undefined || (v as number) >= f.min) && (f.max === undefined || (v as number) <= f.max);
    return f.check ? f.check(v) : true;
  }

  // Local HTTP and HTTPS on the same port can never both bind.
  const portClash = $derived.by(() => {
    const [http, https] = kind === 'jellyfin' ? ['InternalHttpPort', 'InternalHttpsPort'] : ['HttpServerPortNumber', 'HttpsPortNumber'];
    const o = kind === 'jellyfin' ? draft.network : draft.config;
    return !!o && o[http] !== undefined && o[http] === o[https];
  });

  const dirty = $derived(snapshot(draft.config) !== saved.config || snapshot(draft.network) !== saved.network);
  const invalid = $derived(portClash || allFields.some((f) => draft[f.src] && f.key in (draft[f.src] as Obj) && !valid(f)));
  const riskyChanges = $derived(allFields.filter((f) => f.risky && draft[f.src] && changed(f)));

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      const [config, network] = await Promise.all([
        api.get<Obj>('/System/Configuration'),
        kind === 'jellyfin' ? api.get<Obj>('/System/Configuration/network').catch(() => null) : Promise.resolve(null),
      ]);
      draft = { config, network };
      saved = { config: snapshot(config), network: snapshot(network) };
      void loadOptions();
      void checkPendingRestart(serverId);
    } catch (err) {
      error = adminError(err);
    } finally {
      loading = false;
    }
  }

  // The pickers fill in once the localisation lists arrive; until then they show the raw code.
  async function loadOptions(): Promise<void> {
    const byLabel = (a: { label: string }, b: { label: string }) => fmt.compare(a.label, b.label);
    const [opts, cults, ctrs] = await Promise.all([
      api.get<{ Name: string; Value: string }[]>('/Localization/Options').catch(() => []),
      api.get<{ DisplayName: string; TwoLetterISOLanguageName: string }[]>('/Localization/Cultures').catch(() => []),
      api.get<{ DisplayName: string; TwoLetterISORegionName: string }[]>('/Localization/Countries').catch(() => []),
    ]);
    cultures = (opts ?? []).map((o) => ({ value: o.Value, label: o.Name })).sort(byLabel);
    languages = uniq((cults ?? []).filter((c) => c.TwoLetterISOLanguageName).map((c) => ({ value: c.TwoLetterISOLanguageName, label: c.DisplayName }))).sort(byLabel);
    countries = uniq((ctrs ?? []).filter((c) => c.TwoLetterISORegionName).map((c) => ({ value: c.TwoLetterISORegionName, label: c.DisplayName }))).sort(byLabel);
  }
  function uniq<T extends { value: string }>(list: T[]): T[] {
    const seen = new Set<string>();
    return list.filter((o) => !seen.has(o.value) && seen.add(o.value));
  }

  function optionsFor(f: Field): { value: string; label: string }[] {
    const list = f.type === 'culture' ? cultures : f.type === 'language' ? languages : countries;
    const cur = String(draft[f.src]?.[f.key] ?? '');
    const unset = { value: '', label: t('adminServer.common.notSet') };
    const withCur = cur && !list.some((o) => o.value === cur) ? [{ value: cur, label: cur }, ...list] : list;
    return f.type === 'culture' ? withCur : [unset, ...withCur];
  }

  function set(f: Field, value: unknown): void {
    const o = draft[f.src];
    if (o) o[f.key] = value;
  }
  function setInt(f: Field, raw: string): void {
    const n = Number(raw);
    set(f, raw.trim() !== '' && Number.isFinite(n) ? n : raw);
  }
  function setList(f: Field, raw: string): void {
    set(
      f,
      raw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  function revert(): void {
    draft = {
      config: saved.config ? JSON.parse(saved.config) : null,
      network: saved.network ? JSON.parse(saved.network) : null,
    };
  }

  function requestSave(): void {
    if (riskyChanges.length) confirmRisky = true;
    else void save();
  }

  async function save(): Promise<void> {
    confirmRisky = false;
    saving = true;
    const needsRestart = allFields.some((f) => f.restart && draft[f.src] && changed(f));
    try {
      if (snapshot(draft.config) !== saved.config && draft.config) {
        await api.post('/System/Configuration', undefined, $state.snapshot(draft.config));
        saved.config = snapshot(draft.config);
      }
      if (snapshot(draft.network) !== saved.network && draft.network) {
        await api.post('/System/Configuration/network', undefined, $state.snapshot(draft.network));
        saved.network = snapshot(draft.network);
      }
      if (needsRestart) markRestart(serverId);
      else void checkPendingRestart(serverId);
      toast('success', t('adminServer.common.saved'));
    } catch (err) {
      toast('error', adminError(err));
    } finally {
      saving = false;
    }
  }

  // The shell remounts the section on a server switch.
  onMount(() => void load());
</script>

{#snippet field(f: Field)}
  {@const v = draft[f.src]?.[f.key]}
  {@const bad = !valid(f)}
  {@const label = t(`adminServer.server.fields.${f.id}.label`)}
  {#if f.type === 'list'}
    <div class="a-row stack">
      <div class="a-txt">
        <span class="a-lbl">{label}</span>
        <span class="a-desc" class:warn={bad}>{bad ? t(`adminServer.server.fields.${f.id}.invalid`) : t(`adminServer.server.fields.${f.id}.desc`)}</span>
      </div>
      <textarea
        class="a-input mono"
        rows="3"
        spellcheck="false"
        aria-label={label}
        placeholder={t(`adminServer.server.fields.${f.id}.placeholder`)}
        value={((v as string[]) ?? []).join('\n')}
        onchange={(e) => setList(f, e.currentTarget.value)}
      ></textarea>
    </div>
  {:else}
    <div class="a-row">
      <div class="a-txt">
        <span class="a-lbl">{label}</span>
        <span class="a-desc" class:warn={bad}>
          {bad ? t(`adminServer.server.fields.${f.id}.invalid`) : t(`adminServer.server.fields.${f.id}.desc`)}
        </span>
      </div>
      {#if f.type === 'bool'}
        <Toggle {label} checked={!!v} onchange={(x) => set(f, x)} />
      {:else if f.type === 'port' || f.type === 'int'}
        <input
          class="a-input num tabular"
          type="number"
          inputmode="numeric"
          aria-label={label}
          min={f.type === 'port' ? 1 : f.min}
          max={f.type === 'port' ? 65535 : f.max}
          value={v as number}
          oninput={(e) => setInt(f, e.currentTarget.value)}
        />
      {:else if f.type === 'text'}
        <input class="a-input text" type="text" spellcheck="false" aria-label={label} value={(v as string) ?? ''} oninput={(e) => set(f, e.currentTarget.value)} />
      {:else if f.type === 'path'}
        <span class="a-val path" title={(v as string) || undefined}>{(v as string) || t('adminServer.common.default')}</span>
      {:else}
        <Picker {label} value={String(v ?? '')} options={optionsFor(f)} onchange={(x) => set(f, x)} />
      {/if}
    </div>
  {/if}
{/snippet}

<RestartBanner {serverId} />

{#if loading}
  <div class="skeleton sk"></div>
{:else if error}
  <div class="a-group">
    <div class="a-empty">
      {error}
      <div class="retry"><button type="button" class="a-push" onclick={load}>{t('common.actions.retry')}</button></div>
    </div>
  </div>
{:else}
  <h3 class="a-gh">{t('adminServer.server.general')}</h3>
  <div class="a-group">
    {#each visible(GENERAL) as f (f.key)}{@render field(f)}{/each}
  </div>

  {#if visible(networkFields).length}
    <h3 class="a-gh">{t('adminServer.server.network')}</h3>
    <div class="a-group">
      {#each visible(networkFields) as f (f.key)}{@render field(f)}{/each}
    </div>
    <p class="a-foot" class:warn={portClash}>{portClash ? t('adminServer.server.portClash') : t('adminServer.server.networkFoot')}</p>
  {:else if kind === 'jellyfin'}
    <p class="a-foot">{t('adminServer.server.networkUnavailable')}</p>
  {/if}

  <SaveBar {dirty} {invalid} busy={saving} onsave={requestSave} onrevert={revert} />
{/if}

<ConfirmSheet
  open={confirmRisky}
  title={t('adminServer.server.riskyTitle')}
  message={t('adminServer.server.riskyText')}
  confirmLabel={t('adminServer.server.riskyConfirm')}
  danger
  busy={saving}
  onconfirm={save}
  onclose={() => (confirmRisky = false)}
>
  <ul class="changes">
    {#each riskyChanges as f (f.key)}
      <li>{t(`adminServer.server.fields.${f.id}.label`)}</li>
    {/each}
  </ul>
</ConfirmSheet>

<style>
  .sk {
    height: 420px;
    border-radius: var(--r-sm);
  }
  .retry {
    margin-top: 12px;
  }
  .a-row.stack {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .a-desc.warn,
  .a-foot.warn {
    color: var(--warning);
  }
  .num {
    width: 104px;
    text-align: right;
  }
  .text {
    width: 260px;
  }
  textarea {
    width: 100%;
    font-size: var(--fs-footnote);
  }
  .path {
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .changes {
    margin: 0;
    padding-left: 18px;
    font-size: var(--fs-callout);
    color: var(--label);
    line-height: 1.6;
  }
</style>
