<script lang="ts">
  // Transcoding: the named configuration "encoding" (/System/Configuration/encoding)
  // on both servers, with different shapes:
  // - Jellyfin has one HardwareAccelerationType plus HardwareDecodingCodecs, tone
  //   mapping, presets and CRF fields;
  // - Emby lists hardware codecs one by one (CodecConfigurations, with names from
  //   /Encoding/CodecInformation/Video).
  // A row shows only when the server returns its field; fields this page does not
  // know are offered raw under "Other settings". Live jobs come from /Sessions.
  import { onMount } from 'svelte';
  import type { ServerKind } from '../../shared/contract';
  import Icon from '../components/Icon.svelte';
  import Picker from '../components/Picker.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { fmt, has, t } from '../lib/i18n.svelte';
  import { toast } from '../lib/stores.svelte';
  import RestartBanner from './server/RestartBanner.svelte';
  import SaveBar from './server/SaveBar.svelte';
  import { live } from './live';
  import { adminApi, adminError, checkPendingRestart, serverKind } from './server/serverAdmin.svelte';

  let { serverId, kind: kindProp }: { serverId: string; kind?: ServerKind } = $props();
  const kind = $derived(serverKind(serverId, kindProp));
  const api = $derived(adminApi(serverId));

  type Obj = Record<string, unknown>;
  type FieldType = 'bool' | 'int' | 'float' | 'text' | 'hwaccel' | 'preset' | 'tonemapAlgo' | 'tonemapMode';
  interface Field {
    // Alternative names across servers and versions; the first one present wins.
    keys: string[];
    id: string;
    type: FieldType;
    min?: number;
    max?: number;
    when?: (o: Obj) => boolean;
  }

  const hw = (o: Obj) => !!o.HardwareAccelerationType && o.HardwareAccelerationType !== 'none';
  const hwIs = (...types: string[]) => (o: Obj) => types.includes(String(o.HardwareAccelerationType));

  const GROUPS: { id: string; fields: Field[] }[] = [
    {
      id: 'hardware',
      fields: [
        { keys: ['HardwareAccelerationType'], id: 'hwaccel', type: 'hwaccel' },
        { keys: ['VaapiDevice'], id: 'vaapiDevice', type: 'text', when: hwIs('vaapi') },
        { keys: ['QsvDevice'], id: 'qsvDevice', type: 'text', when: hwIs('qsv') },
        { keys: ['EnableHardwareEncoding'], id: 'hwEncoding', type: 'bool', when: hw },
        { keys: ['EnableDecodingColorDepth10Hevc'], id: 'hevc10', type: 'bool', when: hw },
        { keys: ['EnableDecodingColorDepth10Vp9'], id: 'vp910', type: 'bool', when: hw },
      ],
    },
    {
      id: 'encoding',
      fields: [
        { keys: ['AllowHevcEncoding'], id: 'hevcEncoding', type: 'bool' },
        { keys: ['AllowAv1Encoding'], id: 'av1Encoding', type: 'bool' },
        { keys: ['EncoderPreset', 'H264Preset'], id: 'preset', type: 'preset' },
        { keys: ['H264Crf'], id: 'h264Crf', type: 'int', min: 0, max: 51 },
        { keys: ['H265Crf'], id: 'h265Crf', type: 'int', min: 0, max: 51 },
        { keys: ['EncodingThreadCount'], id: 'threads', type: 'int', min: -1, max: 256 },
        { keys: ['MaxConcurrentTranscodes', 'MaxSimultaneousTranscodes', 'MaxTranscodeSessions'], id: 'maxTranscodes', type: 'int', min: 0, max: 100 },
      ],
    },
    {
      id: 'tonemap',
      fields: [
        { keys: ['EnableTonemapping', 'EnableToneMapping', 'EnableHardwareToneMapping'], id: 'tonemap', type: 'bool' },
        { keys: ['EnableVppTonemapping'], id: 'vppTonemap', type: 'bool', when: hwIs('qsv', 'vaapi') },
        { keys: ['TonemappingAlgorithm'], id: 'tonemapAlgo', type: 'tonemapAlgo' },
        { keys: ['TonemappingMode'], id: 'tonemapMode', type: 'tonemapMode' },
      ],
    },
    {
      id: 'processing',
      fields: [
        { keys: ['EnableThrottling'], id: 'throttling', type: 'bool' },
        { keys: ['ThrottleDelaySeconds'], id: 'throttleDelay', type: 'int', min: 10, max: 3600, when: (o) => !!o.EnableThrottling },
        { keys: ['EnableSegmentDeletion'], id: 'segmentDeletion', type: 'bool' },
        { keys: ['SegmentKeepSeconds'], id: 'segmentKeep', type: 'int', min: 10, max: 3600, when: (o) => !!o.EnableSegmentDeletion },
        { keys: ['EnableSubtitleExtraction'], id: 'subtitleExtraction', type: 'bool' },
        { keys: ['DownMixAudioBoost'], id: 'downmixBoost', type: 'float', min: 0.5, max: 3 },
        { keys: ['TranscodingTempPath'], id: 'tempPath', type: 'text' },
      ],
    },
  ];

  // Jellyfin's decoder list (jellyfin-web offers these per acceleration type).
  const DECODE_CODECS = ['h264', 'hevc', 'mpeg2video', 'mpeg4', 'vc1', 'vp8', 'vp9', 'av1'];
  const HW_LABELS: Record<string, string> = {
    amf: 'AMD AMF',
    qsv: 'Intel Quick Sync',
    nvenc: 'NVIDIA NVENC',
    vaapi: 'VA-API',
    videotoolbox: 'VideoToolbox',
    v4l2m2m: 'Video4Linux2',
    rkmpp: 'Rockchip MPP',
  };
  const PRESETS = ['auto', 'veryslow', 'slower', 'slow', 'medium', 'fast', 'faster', 'veryfast', 'superfast', 'ultrafast'];
  const TONEMAP_ALGOS = ['none', 'clip', 'linear', 'gamma', 'reinhard', 'hable', 'mobius', 'bt2390'];
  const TONEMAP_MODES = ['auto', 'max', 'rgb', 'lum', 'itp'];
  // Not worth a raw row: lists handled above, read-only internals.
  const HIDDEN = new Set(['HardwareDecodingCodecs', 'CodecConfigurations', 'EncoderAppPath', 'EncoderAppPathDisplay', 'AllowOnDemandMetadataBasedKeyframeExtractionForExtensions']);

  interface CodecInfo {
    Id: string;
    Name: string;
    Description?: string;
    IsHardwareCodec?: boolean;
    Direction?: string;
    IsEnabledByDefault?: boolean;
    DefaultPriority?: number;
    MediaTypeName?: string;
  }
  interface CodecConfig {
    CodecId: string;
    IsEnabled: boolean;
    Priority: number;
  }

  let loading = $state(true);
  let error = $state('');
  let saving = $state(false);
  let draft = $state<Obj | null>(null);
  let saved = $state('');
  let os = $state('');
  let embyCodecs = $state<CodecInfo[]>([]);
  let showOther = $state(false);

  const dirty = $derived(!!draft && JSON.stringify(draft) !== saved);
  const savedObj = $derived<Obj>(saved ? JSON.parse(saved) : {});

  function keyOf(f: Field): string | undefined {
    return draft ? f.keys.find((k) => k in draft!) : undefined;
  }
  function shown(fields: Field[]): (Field & { key: string })[] {
    const o = draft;
    if (!o) return [];
    return fields.flatMap((f) => {
      const key = keyOf(f);
      return key && (!f.when || f.when(o)) ? [{ ...f, key }] : [];
    });
  }
  const used = $derived(new Set(GROUPS.flatMap((g) => g.fields.flatMap((f) => (keyOf(f) ? [keyOf(f)!] : [])))));
  const others = $derived(
    draft
      ? Object.entries(draft)
          .filter(([k, v]) => !used.has(k) && !HIDDEN.has(k) && (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string'))
          .map(([k]) => k)
          .sort()
      : [],
  );

  function valid(f: Field, key: string): boolean {
    const v = draft?.[key];
    if (f.type === 'int') return Number.isInteger(v) && (f.min === undefined || (v as number) >= f.min) && (f.max === undefined || (v as number) <= f.max);
    if (f.type === 'float') return typeof v === 'number' && Number.isFinite(v) && (f.min === undefined || v >= f.min) && (f.max === undefined || v <= f.max);
    return true;
  }
  const invalid = $derived(
    GROUPS.some((g) => shown(g.fields).some((f) => !valid(f, f.key))) || others.some((k) => typeof draft?.[k] === 'string' && typeof savedObj[k] === 'number'),
  );

  // Acceleration types the server's platform can use (jellyfin-web offers the same split).
  const hwOptions = $derived.by(() => {
    const p = os.toLowerCase();
    const types = p.includes('windows')
      ? ['amf', 'qsv', 'nvenc']
      : p.includes('darwin') || p.includes('mac') || p.includes('osx')
        ? ['videotoolbox']
        : p.includes('linux')
          ? ['amf', 'qsv', 'nvenc', 'vaapi', 'v4l2m2m', 'rkmpp']
          : Object.keys(HW_LABELS);
    const cur = String(draft?.HardwareAccelerationType ?? 'none');
    const list = ['none', ...types];
    if (!list.includes(cur)) list.push(cur);
    return list.map((v) => ({ value: v, label: v === 'none' ? t('adminServer.transcoding.hwNone') : (HW_LABELS[v] ?? v) }));
  });

  function enumOptions(values: string[], cur: unknown, prefix: string): { value: string; label: string }[] {
    const list = values.includes(String(cur)) || cur === undefined ? values : [String(cur), ...values];
    return list.map((v) => ({ value: v, label: has(`${prefix}.${v}`) ? t(`${prefix}.${v}`) : v }));
  }
  function optionsFor(f: Field, key: string): { value: string; label: string }[] {
    const cur = draft?.[key];
    if (f.type === 'hwaccel') return hwOptions;
    if (f.type === 'preset') return enumOptions(PRESETS, cur, 'adminServer.transcoding.presets');
    if (f.type === 'tonemapAlgo') return enumOptions(TONEMAP_ALGOS, cur, 'adminServer.transcoding.tonemapAlgos');
    return enumOptions(TONEMAP_MODES, cur, 'adminServer.transcoding.tonemapModes');
  }

  function set(key: string, value: unknown): void {
    if (draft) draft[key] = value;
  }
  function setNumber(key: string, raw: string): void {
    const n = Number(raw.replace(',', '.'));
    set(key, raw.trim() !== '' && Number.isFinite(n) ? n : raw);
  }

  // ---- Jellyfin: decoder list ----
  const decoding = $derived(new Set((draft?.HardwareDecodingCodecs as string[] | undefined) ?? []));
  function toggleDecode(codec: string, on: boolean): void {
    const next = DECODE_CODECS.filter((c) => (c === codec ? on : decoding.has(c)));
    // Keep codecs this page does not list.
    const extra = [...decoding].filter((c) => !DECODE_CODECS.includes(c));
    set('HardwareDecodingCodecs', [...next, ...extra]);
  }

  // ---- Emby: per-codec hardware list ----
  const hwCodecs = $derived(embyCodecs.filter((c) => c.IsHardwareCodec));
  function codecEnabled(c: CodecInfo): boolean {
    const conf = (draft?.CodecConfigurations as CodecConfig[] | undefined)?.find((x) => x.CodecId === c.Id);
    return conf ? conf.IsEnabled : c.IsEnabledByDefault !== false;
  }
  function toggleCodec(c: CodecInfo, on: boolean): void {
    const list = [...((draft?.CodecConfigurations as CodecConfig[] | undefined) ?? [])];
    const i = list.findIndex((x) => x.CodecId === c.Id);
    if (i >= 0) list[i] = { ...list[i], IsEnabled: on };
    else list.push({ CodecId: c.Id, IsEnabled: on, Priority: c.DefaultPriority ?? 0 });
    set('CodecConfigurations', list);
  }

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      const [enc, info] = await Promise.all([
        api.get<Obj>('/System/Configuration/encoding'),
        api.get<{ OperatingSystem?: string; OperatingSystemDisplayName?: string }>('/System/Info').catch(() => null),
      ]);
      draft = enc;
      saved = JSON.stringify(enc);
      os = info?.OperatingSystem ?? info?.OperatingSystemDisplayName ?? '';
      if (kind === 'emby' && Array.isArray(enc?.CodecConfigurations))
        embyCodecs = (await api.get<CodecInfo[]>('/Encoding/CodecInformation/Video').catch(() => [])) ?? [];
      void checkPendingRestart(serverId);
    } catch (err) {
      error = adminError(err);
    } finally {
      loading = false;
    }
  }

  async function save(): Promise<void> {
    if (!draft) return;
    saving = true;
    try {
      await api.post('/System/Configuration/encoding', undefined, $state.snapshot(draft));
      saved = JSON.stringify(draft);
      toast('success', t('adminServer.common.saved'));
    } catch (err) {
      toast('error', adminError(err));
    } finally {
      saving = false;
    }
  }

  function humanize(key: string): string {
    return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  }

  // ---- Live jobs ----
  interface TranscodingInfo {
    VideoCodec?: string;
    AudioCodec?: string;
    Container?: string;
    IsVideoDirect?: boolean;
    IsAudioDirect?: boolean;
    Bitrate?: number;
    Framerate?: number;
    CompletionPercentage?: number;
    Width?: number;
    Height?: number;
    TranscodeReasons?: string[];
    HardwareAccelerationType?: string;
    VideoEncoderIsHardware?: boolean;
    VideoEncoderHwAccel?: string;
    VideoDecoderIsHardware?: boolean;
    VideoDecoderHwAccel?: string;
    CurrentCpuUsage?: number;
  }
  interface SessionInfo {
    Id: string;
    UserName?: string;
    DeviceName?: string;
    Client?: string;
    NowPlayingItem?: { Name?: string; SeriesName?: string; MediaStreams?: { Type: string; Codec?: string }[] };
    TranscodingInfo?: TranscodingInfo;
  }
  let jobs = $state<SessionInfo[]>([]);
  let jobsLoaded = $state(false);
  let jobsError = $state(false);

  async function loadJobs(): Promise<void> {
    try {
      const list = await api.get<SessionInfo[]>('/Sessions', kind === 'jellyfin' ? { activeWithinSeconds: 960 } : undefined);
      jobs = (Array.isArray(list) ? list : []).filter((s) => s.NowPlayingItem && s.TranscodingInfo && !(s.TranscodingInfo.IsVideoDirect && s.TranscodingInfo.IsAudioDirect));
      jobsError = false;
    } catch {
      jobsError = true;
    } finally {
      jobsLoaded = true;
    }
  }

  function jobTitle(s: SessionInfo): string {
    const it = s.NowPlayingItem!;
    return it.SeriesName ? `${it.SeriesName} · ${it.Name ?? ''}` : (it.Name ?? '');
  }
  function jobDetail(ti: TranscodingInfo, s: SessionInfo): string {
    const parts: string[] = [];
    const src = s.NowPlayingItem?.MediaStreams?.find((m) => m.Type === 'Video')?.Codec;
    if (ti.IsVideoDirect) parts.push(t('adminServer.transcoding.jobs.videoDirect'));
    else if (ti.VideoCodec) parts.push(`${src ? `${src.toUpperCase()} → ` : ''}${ti.VideoCodec.toUpperCase()}`);
    if (ti.Height) parts.push(`${ti.Height}p`);
    if (ti.Framerate) parts.push(t('adminServer.transcoding.jobs.fps', { n: fmt.number(ti.Framerate, { maximumFractionDigits: 0 }) }));
    if (ti.Bitrate) parts.push(fmt.bitrate(ti.Bitrate / 1_000_000, 1));
    if (!ti.IsAudioDirect && ti.AudioCodec) parts.push(ti.AudioCodec.toUpperCase());
    return parts.join(' · ');
  }
  // Jellyfin names the acceleration type; Emby flags the encoder (and decoder) as hardware.
  function jobEngine(ti: TranscodingInfo): { label: string; hw: boolean } | null {
    if (ti.IsVideoDirect) return null;
    const accel =
      ti.HardwareAccelerationType && ti.HardwareAccelerationType !== 'none'
        ? ti.HardwareAccelerationType
        : ti.VideoEncoderIsHardware
          ? ti.VideoEncoderHwAccel || ti.VideoDecoderHwAccel || ''
          : '';
    if (!accel && !ti.VideoEncoderIsHardware) return { label: t('adminServer.transcoding.jobs.software'), hw: false };
    return { label: t('adminServer.transcoding.jobs.hardware', { name: HW_LABELS[accel.toLowerCase()] ?? accel }), hw: true };
  }
  function reasons(ti: TranscodingInfo): string {
    return fmt.list((ti.TranscodeReasons ?? []).map((r) => (has(`adminServer.transcoding.reasons.${r}`) ? t(`adminServer.transcoding.reasons.${r}`) : humanize(r))));
  }

  onMount(() => {
    void load();
    // Polls every 5 s while the window is visible, and at once when a session starts or stops.
    return live(serverId, loadJobs, () => 5000, ['Sessions', 'PlaybackStart', 'PlaybackStopped']);
  });
</script>

{#snippet field(f: Field & { key: string })}
  {@const v = draft?.[f.key]}
  {@const bad = !valid(f, f.key)}
  {@const label = t(`adminServer.transcoding.fields.${f.id}.label`)}
  <div class="a-row">
    <div class="a-txt">
      <span class="a-lbl">{label}</span>
      <span class="a-desc" class:warn={bad}>
        {bad ? t('adminServer.transcoding.range', { min: f.min ?? '', max: f.max ?? '' }) : t(`adminServer.transcoding.fields.${f.id}.desc`)}
      </span>
    </div>
    {#if f.type === 'bool'}
      <Toggle {label} checked={!!v} onchange={(x) => set(f.key, x)} />
    {:else if f.type === 'int' || f.type === 'float'}
      <input
        class="a-input num tabular"
        type="number"
        aria-label={label}
        step={f.type === 'float' ? 0.1 : 1}
        min={f.min}
        max={f.max}
        value={v as number}
        oninput={(e) => setNumber(f.key, e.currentTarget.value)}
      />
    {:else if f.type === 'text'}
      <input class="a-input text" type="text" spellcheck="false" aria-label={label} placeholder={t('adminServer.common.default')} value={(v as string) ?? ''} oninput={(e) => set(f.key, e.currentTarget.value)} />
    {:else}
      <Picker {label} value={String(v ?? '')} options={optionsFor(f, f.key)} onchange={(x) => set(f.key, x)} />
    {/if}
  </div>
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
{:else if draft}
  <h3 class="a-gh">{t('adminServer.transcoding.jobs.title')}</h3>
  <div class="a-group">
    {#if !jobsLoaded}
      <div class="a-empty">{t('adminServer.common.loading')}</div>
    {:else if jobsError}
      <div class="a-empty">{t('adminServer.transcoding.jobs.unavailable')}</div>
    {:else if !jobs.length}
      <div class="a-empty">{t('adminServer.transcoding.jobs.none')}</div>
    {:else}
      {#each jobs as s (s.Id)}
        {@const ti = s.TranscodingInfo!}
        {@const engine = jobEngine(ti)}
        <div class="a-row job">
          <div class="a-txt">
            <span class="a-lbl"><span class="ell">{jobTitle(s)}</span></span>
            <span class="a-desc">{[s.UserName, s.DeviceName ?? s.Client].filter(Boolean).join(' · ')}</span>
            <span class="a-desc tabular">{jobDetail(ti, s)}</span>
            {#if ti.TranscodeReasons?.length}<span class="a-desc">{reasons(ti)}</span>{/if}
          </div>
          <div class="side">
            {#if engine}<span class="a-status" class:ok={engine.hw}>{engine.label}</span>{/if}
            {#if typeof ti.CompletionPercentage === 'number'}
              <div class="a-progress bar" style:--p={Math.min(100, ti.CompletionPercentage) / 100}><span></span></div>
              <span class="pct tabular">{fmt.number(ti.CompletionPercentage, { maximumFractionDigits: 0 })} %</span>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  {#each GROUPS as g (g.id)}
    {@const rows = shown(g.fields)}
    {#if rows.length || (g.id === 'hardware' && (hwCodecs.length || 'HardwareDecodingCodecs' in draft))}
      <h3 class="a-gh">{t(`adminServer.transcoding.groups.${g.id}`)}</h3>
      <div class="a-group">
        {#each rows as f (f.key)}{@render field(f)}{/each}
        {#if g.id === 'hardware' && 'HardwareDecodingCodecs' in draft && draft.HardwareAccelerationType && draft.HardwareAccelerationType !== 'none'}
          <div class="a-row stack">
            <div class="a-txt">
              <span class="a-lbl">{t('adminServer.transcoding.decodeCodecs.label')}</span>
              <span class="a-desc">{t('adminServer.transcoding.decodeCodecs.desc')}</span>
            </div>
            <div class="chips" role="group" aria-label={t('adminServer.transcoding.decodeCodecs.label')}>
              {#each DECODE_CODECS as c (c)}
                <button type="button" class="chip" class:on={decoding.has(c)} aria-pressed={decoding.has(c)} onclick={() => toggleDecode(c, !decoding.has(c))}>
                  {#if decoding.has(c)}<Icon name="check" size={13} />{/if}{t(`adminServer.transcoding.codecs.${c}`)}
                </button>
              {/each}
            </div>
          </div>
        {/if}
        {#if g.id === 'hardware' && kind === 'emby' && Array.isArray(draft.CodecConfigurations)}
          {#if hwCodecs.length}
            {#each hwCodecs as c (c.Id)}
              <div class="a-row compact">
                <div class="a-txt">
                  <span class="a-lbl soft">{c.Name}</span>
                  <span class="a-desc">{c.Direction === 'Encoder' ? t('adminServer.transcoding.encoder') : t('adminServer.transcoding.decoder')}{c.Description ? ` · ${c.Description}` : ''}</span>
                </div>
                <Toggle label={c.Name} checked={codecEnabled(c)} onchange={(x) => toggleCodec(c, x)} />
              </div>
            {/each}
          {:else}
            <div class="a-empty">{t('adminServer.transcoding.noHwCodecs')}</div>
          {/if}
        {/if}
      </div>
    {/if}
  {/each}

  {#if others.length}
    <button type="button" class="disclosure" aria-expanded={showOther} onclick={() => (showOther = !showOther)}>
      {showOther ? t('adminServer.transcoding.hideOther') : t('adminServer.transcoding.showOther', { n: others.length })}
    </button>
    {#if showOther}
      <div class="a-group">
        {#each others as k (k)}
          {@const v = draft[k]}
          <div class="a-row compact">
            <div class="a-txt">
              <span class="a-lbl soft">{humanize(k)}</span>
            </div>
            {#if typeof v === 'boolean'}
              <Toggle label={humanize(k)} checked={v} onchange={(x) => set(k, x)} />
            {:else if typeof savedObj[k] === 'number'}
              <input class="a-input num tabular" type="number" aria-label={humanize(k)} value={v as number} oninput={(e) => setNumber(k, e.currentTarget.value)} />
            {:else}
              <input class="a-input text" type="text" spellcheck="false" aria-label={humanize(k)} value={String(v ?? '')} oninput={(e) => set(k, e.currentTarget.value)} />
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  <SaveBar {dirty} {invalid} busy={saving} onsave={save} onrevert={() => (draft = JSON.parse(saved))} />
{/if}

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
  .a-desc.warn {
    color: var(--warning);
  }
  .num {
    width: 104px;
    text-align: right;
  }
  .text {
    width: 260px;
  }
  .ell {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .job .side {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    width: 180px;
  }
  .job .bar {
    width: 100%;
  }
  .pct {
    font-size: var(--fs-caption);
    color: var(--label-3);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 12px;
    border-radius: 999px;
    background: var(--fill-1);
    box-shadow: inset 0 0 0 1px var(--separator);
    font-size: var(--fs-callout);
    color: var(--label-3);
  }
  .chip:hover,
  .chip:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  .chip.on {
    padding-left: 9px;
    background: var(--fill-3);
    box-shadow: none;
    color: var(--label);
    font-weight: 500;
  }
  .disclosure {
    align-self: flex-start;
    margin: 22px 0 8px 2px;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
  }
  .disclosure:hover,
  .disclosure:focus-visible {
    color: var(--label);
  }
</style>
