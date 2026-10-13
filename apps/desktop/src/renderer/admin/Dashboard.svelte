<script lang="ts">
  // Server overview: identity, pending restart/update, power, and the live
  // sessions with what they play and how (direct or transcoded).
  // Emby and Jellyfin share these routes: /System/Info, /Sessions,
  // /Sessions/{id}/Playing/{command}, /Sessions/{id}/Message, /System/Restart|Shutdown.
  import { onMount } from 'svelte';
  import type { ServerKind } from '../../shared/contract';
  import type { BaseItem, MediaStream } from '../../shared/models';
  import Icon from '../components/Icon.svelte';
  import Sheet from '../components/Sheet.svelte';
  import { w } from '../lib/bridge';
  import { clock, episodeCode } from '../lib/format';
  import { fmt, has, t } from '../lib/i18n.svelte';
  import { imageUrl, userImageUrl } from '../lib/images';
  import { errorMessage, toast } from '../lib/stores.svelte';
  import { live, ticksToMs } from './live';

  let { serverId }: { serverId: string; kind?: ServerKind } = $props();

  interface SystemInfo {
    ServerName?: string;
    Version?: string;
    OperatingSystem?: string;
    OperatingSystemDisplayName?: string;
    SystemArchitecture?: string;
    HasPendingRestart?: boolean;
    HasUpdateAvailable?: boolean;
    CanSelfRestart?: boolean;
    IsShuttingDown?: boolean;
    LocalAddress?: string;
    LocalAddresses?: string[];
    WanAddress?: string;
    RemoteAddresses?: string[];
    HttpServerPortNumber?: number;
    HttpsPortNumber?: number;
    SupportsHttps?: boolean;
    ProgramDataPath?: string;
    CachePath?: string;
    LogPath?: string;
    TranscodingTempPath?: string;
  }
  interface TranscodingInfo {
    AudioCodec?: string;
    VideoCodec?: string;
    Container?: string;
    IsVideoDirect?: boolean;
    IsAudioDirect?: boolean;
    Bitrate?: number;
    Framerate?: number;
    CompletionPercentage?: number;
    Width?: number;
    Height?: number;
    AudioChannels?: number;
    TranscodeReasons?: string[];
    // Emby
    VideoDecoderIsHardware?: boolean;
    VideoEncoderIsHardware?: boolean;
    VideoDecoderHwAccel?: string;
    VideoEncoderHwAccel?: string;
    CurrentCpuUsage?: number;
    // Jellyfin
    HardwareAccelerationType?: string;
  }
  interface SessionInfo {
    Id: string;
    UserId?: string;
    UserName?: string;
    UserPrimaryImageTag?: string;
    Client?: string;
    ApplicationVersion?: string;
    DeviceName?: string;
    DeviceId?: string;
    RemoteEndPoint?: string;
    LastActivityDate?: string;
    SupportsRemoteControl?: boolean;
    NowPlayingItem?: BaseItem & { Bitrate?: number; AlbumId?: string; AlbumPrimaryImageTag?: string; PrimaryImageItemId?: string };
    PlayState?: { PositionTicks?: number; IsPaused?: boolean; PlayMethod?: 'DirectPlay' | 'DirectStream' | 'Transcode' };
    TranscodingInfo?: TranscodingInfo;
  }
  interface TaskLite {
    Triggers?: { Type?: string }[];
    LastExecutionResult?: { StartTimeUtc?: string };
  }

  let info = $state<SystemInfo | null>(null);
  let infoError = $state('');
  let sessions = $state<SessionInfo[] | null>(null);
  let sessionsError = $state('');
  let startedAt = $state<number | null>(null);
  let now = $state(Date.now());

  let confirm = $state<'restart' | 'shutdown' | null>(null);
  let busy = $state(false);
  let msgFor = $state<SessionInfo | null>(null);
  let msgHeader = $state('');
  let msgText = $state('');
  let pending = $state<Record<string, boolean>>({});

  const name = $derived(info?.ServerName ?? '');
  const playing = $derived((sessions ?? []).filter((s) => s.NowPlayingItem));
  // Other recent devices: no item, active in the last 15 minutes.
  const idle = $derived(
    (sessions ?? [])
      .filter((s) => !s.NowPlayingItem && s.UserName)
      .sort((a, b) => Date.parse(b.LastActivityDate ?? '') - Date.parse(a.LastActivityDate ?? '')),
  );
  const transcodes = $derived(playing.filter((s) => s.PlayState?.PlayMethod === 'Transcode').length);
  const totalBitrate = $derived(playing.reduce((sum, s) => sum + (bitrate(s) ?? 0), 0));

  async function loadInfo(): Promise<void> {
    try {
      info = await w.api.get<SystemInfo>('/System/Info', undefined, serverId);
      infoError = '';
    } catch (err) {
      infoError = errorMessage(err);
    }
  }

  async function loadSessions(): Promise<void> {
    try {
      // Emby and Jellyfin both accept ActiveWithinSeconds (Jellyfin is case-insensitive).
      const list = await w.api.get<SessionInfo[]>('/Sessions', { ActiveWithinSeconds: 900 }, serverId);
      sessions = Array.isArray(list) ? list : [];
      sessionsError = '';
      now = Date.now();
    } catch (err) {
      sessionsError = errorMessage(err);
    }
  }

  // "Started around": the earliest last run among the tasks that run at startup.
  async function loadStart(): Promise<void> {
    const tasks = await w.api.get<TaskLite[]>('/ScheduledTasks', { IsHidden: false }, serverId).catch(() => [] as TaskLite[]);
    const starts = tasks
      .filter((x) => x.Triggers?.some((tr) => tr.Type === 'StartupTrigger'))
      .map((x) => Date.parse(x.LastExecutionResult?.StartTimeUtc ?? ''))
      .filter((n) => Number.isFinite(n));
    startedAt = starts.length ? Math.min(...starts) : null;
  }

  onMount(() => {
    const stopSessions = live(serverId, loadSessions, () => (playing.length ? 2000 : 5000), ['Sessions', 'PlaybackStart', 'PlaybackStopped', 'PlaybackProgress', 'SessionEnded', 'UserDataChanged']);
    const stopInfo = live(serverId, loadInfo, () => 30_000, ['RestartRequired', 'ServerRestarting', 'ServerShuttingDown', 'PackageInstallationCompleted']);
    void loadStart();
    return () => {
      stopSessions();
      stopInfo();
    };
  });

  // ---- Power ----

  async function power(): Promise<void> {
    const which = confirm;
    if (!which) return;
    busy = true;
    try {
      await w.api.post(which === 'restart' ? '/System/Restart' : '/System/Shutdown', undefined, undefined, serverId);
      toast('info', t(which === 'restart' ? 'admin.dashboard.restarting' : 'admin.dashboard.shuttingDown', { name }));
      confirm = null;
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = false;
    }
  }

  // ---- Session remote control ----

  async function command(s: SessionInfo, cmd: 'Pause' | 'Unpause' | 'Stop'): Promise<void> {
    pending[s.Id] = true;
    try {
      await w.api.post(`/Sessions/${encodeURIComponent(s.Id)}/Playing/${cmd}`, undefined, undefined, serverId);
      // Reflect it at once; the next poll confirms.
      if (s.PlayState && cmd !== 'Stop') s.PlayState.IsPaused = cmd === 'Pause';
      setTimeout(() => void loadSessions(), 600);
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      pending[s.Id] = false;
    }
  }

  function openMessage(s: SessionInfo): void {
    msgFor = s;
    msgHeader = '';
    msgText = '';
  }

  async function sendMessage(): Promise<void> {
    const s = msgFor;
    const text = msgText.trim();
    if (!s || !text) return;
    busy = true;
    // Emby reads the MessageCommand from the query string, Jellyfin from the body: send both.
    const cmd = { Header: msgHeader.trim() || t('admin.dashboard.messageDefaultHeader'), Text: text, TimeoutMs: 10_000 };
    try {
      await w.api.post(`/Sessions/${encodeURIComponent(s.Id)}/Message`, cmd, cmd, serverId);
      toast('success', t('admin.dashboard.messageSent'));
      msgFor = null;
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = false;
    }
  }

  // ---- Presentation helpers ----

  function title(item: NonNullable<SessionInfo['NowPlayingItem']>): { main: string; sub: string } {
    if (item.Type === 'Episode') {
      const code = episodeCode(item);
      return { main: item.SeriesName ?? item.Name, sub: [code, item.Name].filter(Boolean).join(' · ') };
    }
    if (item.Type === 'Audio') return { main: item.Name, sub: [item.Artists?.join(', '), item.Album].filter(Boolean).join(' · ') };
    return { main: item.Name, sub: item.ProductionYear ? String(item.ProductionYear) : '' };
  }

  function poster(item: NonNullable<SessionInfo['NowPlayingItem']>): string | null {
    if (item.SeriesId && item.SeriesPrimaryImageTag) return imageUrl(item.SeriesId, 'Primary', { tag: item.SeriesPrimaryImageTag, maxHeight: 132, server: serverId });
    if (item.AlbumId && item.AlbumPrimaryImageTag) return imageUrl(item.AlbumId, 'Primary', { tag: item.AlbumPrimaryImageTag, maxHeight: 132, server: serverId });
    if (item.ImageTags?.Primary) return imageUrl(item.PrimaryImageItemId ?? item.Id, 'Primary', { tag: item.ImageTags.Primary, maxHeight: 132, server: serverId });
    return null;
  }

  function videoStream(s: SessionInfo): MediaStream | undefined {
    const item = s.NowPlayingItem;
    return (item?.MediaStreams ?? item?.MediaSources?.[0]?.MediaStreams)?.find((x) => x.Type === 'Video');
  }
  function audioStream(s: SessionInfo): MediaStream | undefined {
    const item = s.NowPlayingItem;
    return (item?.MediaStreams ?? item?.MediaSources?.[0]?.MediaStreams)?.find((x) => x.Type === 'Audio');
  }

  // Bits per second: the transcode output, else the source file.
  function bitrate(s: SessionInfo): number | undefined {
    const ti = s.TranscodingInfo;
    if (s.PlayState?.PlayMethod === 'Transcode' && ti?.Bitrate) return ti.Bitrate;
    const item = s.NowPlayingItem;
    const src = item?.MediaSources?.[0] as { Bitrate?: number } | undefined;
    return src?.Bitrate ?? item?.Bitrate ?? ti?.Bitrate;
  }

  const mbps = (bps: number) => fmt.bitrate(bps / 1_000_000, bps < 10_000_000 ? 1 : 0);
  const codec = (c?: string) => (c ? (c.toLowerCase() === 'h264' ? 'H.264' : c.toLowerCase() === 'hevc' || c.toLowerCase() === 'h265' ? 'HEVC' : c.toUpperCase()) : '');
  const res = (wd?: number, ht?: number) => (!wd ? '' : wd >= 3800 ? '4K' : wd >= 1900 ? '1080p' : wd >= 1260 ? '720p' : ht ? `${ht}p` : '');
  const channels = (n?: number) => (!n ? '' : n === 1 ? '1.0' : n === 2 ? '2.0' : n === 6 ? '5.1' : n === 8 ? '7.1' : `${n} ch`);

  function reason(r: string): string {
    const key = `admin.dashboard.reasons.${r}`;
    return has(key) ? t(key) : r.replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  // "HEVC 4K → H.264 1080p", "AAC 5.1 → AAC 2.0" or "copie".
  function transcodeLines(s: SessionInfo): { label: string; value: string }[] {
    const ti = s.TranscodingInfo;
    if (!ti) return [];
    const v = videoStream(s);
    const a = audioStream(s);
    const out: { label: string; value: string }[] = [];
    if (v || ti.VideoCodec) {
      const from = [codec(v?.Codec), res(v?.Width, v?.Height)].filter(Boolean).join(' ');
      const to = ti.IsVideoDirect ? t('admin.dashboard.direct') : [codec(ti.VideoCodec), res(ti.Width, ti.Height)].filter(Boolean).join(' ');
      out.push({ label: t('admin.dashboard.video'), value: from && !ti.IsVideoDirect ? `${from} → ${to}` : to || from });
    }
    if (a || ti.AudioCodec) {
      const from = [codec(a?.Codec), channels(a?.Channels)].filter(Boolean).join(' ');
      const to = ti.IsAudioDirect ? t('admin.dashboard.direct') : [codec(ti.AudioCodec), channels(ti.AudioChannels)].filter(Boolean).join(' ');
      out.push({ label: t('admin.dashboard.audio'), value: from && !ti.IsAudioDirect ? `${from} → ${to}` : to || from });
    }
    const stats: string[] = [];
    if (ti.Bitrate) stats.push(mbps(ti.Bitrate));
    if (ti.Framerate) stats.push(t('admin.dashboard.fps', { n: fmt.number(ti.Framerate, { maximumFractionDigits: 0 }) }));
    if (ti.Container) stats.push(ti.Container.toUpperCase());
    if (ti.CompletionPercentage) stats.push(t('admin.dashboard.buffered', { n: Math.round(ti.CompletionPercentage) }));
    if (ti.CurrentCpuUsage) stats.push(t('admin.dashboard.cpu', { n: Math.round(ti.CurrentCpuUsage) }));
    if (stats.length) out.push({ label: t('admin.dashboard.stream'), value: stats.join(' · ') });
    if (!ti.IsVideoDirect && ti.VideoCodec) out.push({ label: t('admin.dashboard.acceleration'), value: acceleration(ti) });
    return out;
  }

  // Jellyfin names one HardwareAccelerationType; Emby flags decoder and encoder separately.
  function acceleration(ti: TranscodingInfo): string {
    const jf = ti.HardwareAccelerationType;
    if (jf && jf.toLowerCase() !== 'none') return t('admin.dashboard.hardware', { accel: jf.toUpperCase() });
    if (!ti.VideoDecoderIsHardware && !ti.VideoEncoderIsHardware) return t('admin.dashboard.software');
    const names = [ti.VideoDecoderIsHardware && ti.VideoDecoderHwAccel, ti.VideoEncoderIsHardware && ti.VideoEncoderHwAccel].filter((x): x is string => Boolean(x)).map((x) => x.toUpperCase());
    const accel = [...new Set(names)].join(' / ');
    if (!accel) return t('admin.dashboard.hardwareGeneric');
    const part = ti.VideoDecoderIsHardware && ti.VideoEncoderIsHardware ? '' : ti.VideoEncoderIsHardware ? t('admin.dashboard.encodeOnly') : t('admin.dashboard.decodeOnly');
    return [t('admin.dashboard.hardware', { accel }), part].filter(Boolean).join(' · ');
  }

  function position(s: SessionInfo): { pct: number; text: string } {
    const total = ticksToMs(s.NowPlayingItem?.RunTimeTicks);
    const pos = ticksToMs(s.PlayState?.PositionTicks);
    return { pct: total ? Math.min(1, pos / total) : 0, text: total ? `${clock(pos)} / ${clock(total)}` : clock(pos) };
  }

  const remote = (addr?: string) => (addr ? addr.replace(/^::ffff:/, '') : '');
  const os = $derived([info?.OperatingSystemDisplayName || info?.OperatingSystem, info?.SystemArchitecture].filter(Boolean).join(' · '));
  const addresses = $derived(
    [...new Set([info?.LocalAddress, ...(info?.LocalAddresses ?? []), info?.WanAddress, ...(info?.RemoteAddresses ?? [])].filter((x): x is string => Boolean(x)))],
  );
</script>

<!-- ---- Server ---- -->
<h3 class="a-gh">{t('admin.dashboard.server')}</h3>
{#if info}
  <div class="a-group">
    <div class="a-row">
      <span class="srv-glyph"><Icon name="server" size={20} /></span>
      <div class="a-txt">
        <div class="a-lbl">{info.ServerName}</div>
        <div class="a-desc">{t('admin.dashboard.version', { version: info.Version ?? '' })}{os ? ` · ${os}` : ''}</div>
      </div>
      {#if info.HasPendingRestart}
        <span class="a-status warn">{t('admin.dashboard.restartPending')}</span>
      {:else if info.HasUpdateAvailable}
        <span class="a-status warn">{t('admin.dashboard.updateAvailable')}</span>
      {:else}
        <span class="a-status ok">{t('admin.dashboard.healthy')}</span>
      {/if}
    </div>
    {#if startedAt}
      <div class="a-row compact">
        <div class="a-txt"><div class="a-lbl soft">{t('admin.dashboard.started')}</div></div>
        <span class="a-val" title={fmt.date(startedAt, { dateStyle: 'full', timeStyle: 'short' })}>{t('admin.dashboard.startedAround', { when: fmt.relative(startedAt, now) })}</span>
      </div>
    {/if}
    {#if addresses.length}
      <div class="a-row compact">
        <div class="a-txt"><div class="a-lbl soft">{t('admin.dashboard.addresses')}</div></div>
        <span class="a-val mono addr">{addresses.join('\n')}</span>
      </div>
    {/if}
    {#if info.HttpServerPortNumber}
      <div class="a-row compact">
        <div class="a-txt"><div class="a-lbl soft">{t('admin.dashboard.ports')}</div></div>
        <span class="a-val">{info.SupportsHttps && info.HttpsPortNumber ? t('admin.dashboard.portsBoth', { http: info.HttpServerPortNumber, https: info.HttpsPortNumber }) : t('admin.dashboard.portsHttp', { http: info.HttpServerPortNumber })}</span>
      </div>
    {/if}
    {#if info.HasUpdateAvailable}
      <div class="a-row">
        <div class="a-txt">
          <div class="a-lbl">{t('admin.dashboard.updateAvailable')}</div>
          <div class="a-desc">{t('admin.dashboard.updateDesc')}</div>
        </div>
      </div>
    {/if}
    {#if info.HasPendingRestart}
      <div class="a-row">
        <div class="a-txt">
          <div class="a-lbl">{t('admin.dashboard.restartPending')}</div>
          <div class="a-desc">{t('admin.dashboard.restartPendingDesc')}</div>
        </div>
      </div>
    {/if}
    <div class="a-row">
      <div class="a-txt">
        <div class="a-lbl">{t('admin.dashboard.power')}</div>
        <div class="a-desc">{info.CanSelfRestart === false ? t('admin.dashboard.cantRestart') : t('admin.dashboard.powerDesc')}</div>
      </div>
      <div class="a-actions">
        <button type="button" class="a-push" disabled={info.CanSelfRestart === false} onclick={() => (confirm = 'restart')}>{t('admin.dashboard.restart')}</button>
        <button type="button" class="a-push ghost" onclick={() => (confirm = 'shutdown')}>{t('admin.dashboard.shutdown')}</button>
      </div>
    </div>
  </div>
  {#if info.ProgramDataPath}
    <details class="paths">
      <summary>{t('admin.dashboard.paths')}</summary>
      <dl>
        {#each [['data', info.ProgramDataPath], ['cache', info.CachePath], ['logs', info.LogPath], ['transcode', info.TranscodingTempPath]] as [k, v] (k)}
          {#if v}<dt>{t(`admin.dashboard.path.${k}`)}</dt><dd class="mono">{v}</dd>{/if}
        {/each}
      </dl>
    </details>
  {/if}
{:else if infoError}
  <div class="a-group"><p class="a-empty">{t('admin.dashboard.unreachable')} <span class="caption">{infoError}</span></p></div>
{:else}
  <div class="skeleton block"></div>
{/if}

<!-- ---- Sessions ---- -->
<div class="sessions-head">
  <h3 class="a-gh">{t('admin.dashboard.nowPlaying')}</h3>
  {#if sessions}
    <span class="summary">
      {[t('admin.dashboard.streams', { count: playing.length }), transcodes ? t('admin.dashboard.transcodes', { count: transcodes }) : '', totalBitrate ? t('admin.dashboard.bandwidth', { rate: mbps(totalBitrate) }) : ''].filter(Boolean).join(' · ')}
    </span>
  {/if}
</div>

{#if sessionsError && !sessions}
  <div class="a-group"><p class="a-empty">{t('admin.dashboard.unreachable')} <span class="caption">{sessionsError}</span></p></div>
{:else if !sessions}
  <div class="skeleton block"></div>
{:else if playing.length === 0}
  <div class="a-group"><p class="a-empty">{t('admin.dashboard.nothingPlaying')}</p></div>
{:else}
  <div class="cards">
    {#each playing as s, i (s.Id)}
      {@const item = s.NowPlayingItem!}
      {@const tt = title(item)}
      {@const img = poster(item)}
      {@const pos = position(s)}
      {@const method = s.PlayState?.PlayMethod ?? 'DirectPlay'}
      {@const paused = s.PlayState?.IsPaused}
      {@const br = bitrate(s)}
      <article class="card" style:--i={Math.min(i, 12)}>
        <div class="top">
          <div class="art" class:square={item.Type === 'Audio'}>
            {#if img}<img src={img} alt="" loading="lazy" decoding="async" onload={(e) => e.currentTarget.classList.add('in')} />{/if}
          </div>
          <div class="what">
            <div class="who">
              {#if s.UserId && s.UserPrimaryImageTag}
                <img class="avatar" src={userImageUrl(s.UserId, s.UserPrimaryImageTag, 22, serverId)} alt="" />
              {:else}
                <span class="avatar mono-gram">{(s.UserName ?? '?').slice(0, 1).toUpperCase()}</span>
              {/if}
              <span class="user">{s.UserName ?? t('admin.dashboard.unknownUser')}</span>
              <span class="device">{[s.DeviceName, s.Client].filter(Boolean).join(' · ')}</span>
            </div>
            <div class="name" title={tt.main}>{tt.main}</div>
            {#if tt.sub}<div class="sub">{tt.sub}</div>{/if}
            <div class="method">
              <span class="pill" class:transcode={method === 'Transcode'}>{t(`admin.dashboard.method.${method}`)}</span>
              {#if paused}<span class="pill">{t('admin.dashboard.paused')}</span>{/if}
              {#if br}<span class="mono rate">{mbps(br)}</span>{/if}
            </div>
          </div>
          <div class="controls">
            <button type="button" class="a-push icon" disabled={!s.SupportsRemoteControl || pending[s.Id]} title={paused ? t('admin.dashboard.resume') : t('admin.dashboard.pause')} aria-label={paused ? t('admin.dashboard.resume') : t('admin.dashboard.pause')} onclick={() => command(s, paused ? 'Unpause' : 'Pause')}>
              <Icon name={paused ? 'play' : 'pause'} size={15} />
            </button>
            <button type="button" class="a-push icon" disabled={!s.SupportsRemoteControl || pending[s.Id]} title={t('admin.dashboard.stop')} aria-label={t('admin.dashboard.stop')} onclick={() => command(s, 'Stop')}>
              <Icon name="stop" size={14} />
            </button>
            <button type="button" class="a-push icon" title={t('admin.dashboard.message')} aria-label={t('admin.dashboard.message')} onclick={() => openMessage(s)}>
              <Icon name="bubble" size={15} />
            </button>
          </div>
        </div>
        <div class="progress-row">
          <div class="a-progress" class:muted={paused} style:--p={pos.pct}><span></span></div>
          <span class="mono time">{pos.text}</span>
        </div>
        {#if s.TranscodingInfo && method !== 'DirectPlay'}
          {@const reasons = s.TranscodingInfo?.TranscodeReasons ?? []}
          <div class="details">
            {#if reasons.length}
              <div class="reasons">{reasons.map(reason).join(' · ')}</div>
            {/if}
            <dl>
              {#each transcodeLines(s) as l (l.label)}
                <dt>{l.label}</dt><dd class="mono">{l.value}</dd>
              {/each}
            </dl>
          </div>
        {/if}
        {#if remote(s.RemoteEndPoint)}
          <div class="foot-line">{t('admin.dashboard.remote', { address: remote(s.RemoteEndPoint) })}{#if s.ApplicationVersion} · {s.Client} {s.ApplicationVersion}{/if}</div>
        {/if}
      </article>
    {/each}
  </div>
{/if}

{#if idle.length}
  <h3 class="a-gh">{t('admin.dashboard.devices')}</h3>
  <div class="a-group">
    {#each idle.slice(0, 12) as s (s.Id)}
      <div class="a-row compact">
        <span class="dev-glyph"><Icon name="device" size={16} /></span>
        <div class="a-txt">
          <div class="a-lbl">{s.DeviceName ?? s.Client}<span class="a-desc inline">{s.UserName}</span></div>
          <div class="a-desc">{[s.Client, s.ApplicationVersion, remote(s.RemoteEndPoint)].filter(Boolean).join(' · ')}</div>
        </div>
        {#if s.LastActivityDate}<span class="a-val">{fmt.relative(s.LastActivityDate, now)}</span>{/if}
        <button type="button" class="a-push icon" title={t('admin.dashboard.message')} aria-label={t('admin.dashboard.message')} onclick={() => openMessage(s)}>
          <Icon name="bubble" size={15} />
        </button>
      </div>
    {/each}
  </div>
{/if}

<!-- ---- Sheets ---- -->
<Sheet open={confirm !== null} onclose={() => (confirm = null)} label={t(confirm === 'shutdown' ? 'admin.dashboard.confirmShutdownTitle' : 'admin.dashboard.confirmRestartTitle', { name })} width={440}>
  <div class="a-sheet">
    <h2>{t(confirm === 'shutdown' ? 'admin.dashboard.confirmShutdownTitle' : 'admin.dashboard.confirmRestartTitle', { name })}</h2>
    <p>{t(confirm === 'shutdown' ? 'admin.dashboard.confirmShutdownBody' : 'admin.dashboard.confirmRestartBody')}</p>
    {#if playing.length}<p class="warn-line">{t('admin.dashboard.confirmPlaying', { count: playing.length })}</p>{/if}
    <div class="a-sheet-actions">
      <button type="button" class="a-push ghost" data-autofocus onclick={() => (confirm = null)}>{t('common.actions.cancel')}</button>
      <button type="button" class="a-push primary" disabled={busy} onclick={power}>{t(confirm === 'shutdown' ? 'admin.dashboard.shutdown' : 'admin.dashboard.restart')}</button>
    </div>
  </div>
</Sheet>

<Sheet open={msgFor !== null} onclose={() => (msgFor = null)} label={t('admin.dashboard.message')} width={460}>
  <form class="a-sheet" onsubmit={(e) => { e.preventDefault(); void sendMessage(); }}>
    <h2>{t('admin.dashboard.message')}</h2>
    <p>{t('admin.dashboard.messageTo', { user: msgFor?.UserName ?? '', device: msgFor?.DeviceName ?? msgFor?.Client ?? '' })}</p>
    <label>{t('admin.dashboard.messageHeader')}<input class="a-input" bind:value={msgHeader} placeholder={t('admin.dashboard.messageDefaultHeader')} maxlength="80" /></label>
    <label>{t('admin.dashboard.messageText')}<textarea class="a-input" rows="3" bind:value={msgText} maxlength="500" data-autofocus></textarea></label>
    <div class="a-sheet-actions">
      <button type="button" class="a-push ghost" onclick={() => (msgFor = null)}>{t('common.actions.cancel')}</button>
      <button type="submit" class="a-push primary" disabled={busy || !msgText.trim()}>{t('admin.dashboard.send')}</button>
    </div>
  </form>
</Sheet>

<style>
  .block {
    height: 160px;
    border-radius: var(--r-sm);
  }
  .srv-glyph,
  .dev-glyph {
    flex: none;
    display: grid;
    place-items: center;
    color: var(--label-2);
  }
  .srv-glyph {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--fill-2);
  }
  .addr {
    white-space: pre;
    font-size: var(--fs-footnote);
    line-height: 1.5;
  }
  .inline {
    display: inline;
    margin: 0;
  }

  .paths {
    margin: 10px 2px 0;
    font-size: var(--fs-footnote);
    color: var(--label-3);
  }
  .paths summary {
    cursor: pointer;
    width: fit-content;
  }
  .paths summary:hover {
    color: var(--label-2);
  }
  .paths dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 4px 14px;
    margin: 8px 0 0;
  }
  .paths dt {
    color: var(--label-3);
  }
  .paths dd {
    margin: 0;
    color: var(--label-2);
    overflow-wrap: anywhere;
    user-select: text;
  }

  .sessions-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    margin-top: 30px;
  }
  .sessions-head .a-gh {
    margin-top: 0;
  }
  .summary {
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
    gap: 12px;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
    animation: rise var(--t-med) var(--ease-out) both;
    animation-delay: calc(var(--i) * 30ms * var(--tempo));
  }
  .top {
    display: flex;
    gap: 14px;
    min-width: 0;
  }
  .art {
    flex: none;
    width: 58px;
    height: 87px;
    border-radius: var(--r-xs);
    background: var(--fill-1);
    overflow: hidden;
  }
  .art.square {
    height: 58px;
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity var(--t-med) var(--ease);
  }
  .art img:global(.in) {
    opacity: 1;
  }
  .what {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    font-size: var(--fs-footnote);
    color: var(--label-2);
    margin-bottom: 4px;
  }
  .avatar {
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    object-fit: cover;
  }
  .mono-gram {
    display: grid;
    place-items: center;
    font-size: 10px;
    font-weight: 600;
    color: var(--label);
    background: var(--fill-3);
  }
  .user {
    font-weight: 500;
    color: var(--label);
    flex: none;
  }
  .device {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--label-3);
  }
  .name {
    font-size: var(--fs-headline);
    font-weight: 600;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    font-size: var(--fs-footnote);
    color: var(--label-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .method {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
  }
  .pill {
    height: 20px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    background: var(--fill-2);
    font-size: var(--fs-caption);
    font-weight: 500;
    color: var(--label-2);
  }
  .pill.transcode {
    color: var(--label);
    background: var(--fill-3);
  }
  .rate {
    font-size: 10.5px;
    color: var(--label-3);
  }
  .controls {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .progress-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .progress-row .a-progress {
    flex: 1;
  }
  .time {
    flex: none;
    font-size: 10.5px;
    color: var(--label-3);
  }
  .details {
    padding-top: 10px;
    border-top: 1px solid var(--separator);
    font-size: var(--fs-footnote);
  }
  .reasons {
    color: var(--label-2);
    margin-bottom: 6px;
  }
  .details dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 3px 14px;
    margin: 0;
  }
  .details dt {
    color: var(--label-3);
  }
  .details dd {
    margin: 0;
    font-size: var(--fs-caption);
    line-height: 1.6;
    color: var(--label-2);
    overflow-wrap: anywhere;
  }
  .foot-line {
    font-size: var(--fs-caption);
    color: var(--label-3);
  }
  .warn-line {
    color: var(--label) !important;
  }
</style>
