<script lang="ts">
  // Android TV StatsOverlay (PlayerActivity.kt, core player/PlaybackStats.kt, Infuse T#9): what the TV really gets
  // and how it plays it, top left, refreshed every second. The method and why the server converts, the container,
  // the video and audio streams, the subtitle format, the bitrate, the buffer, dropped frames and the server.
  import type { MediaStream } from '$shared/models';
  import { locale, t } from '../../lib/i18n.svelte';
  import type { Playback } from '../../lib/playback.svelte';

  let { pb }: { pb: Playback } = $props();

  // Both servers send the profile and level, the shared model does not list them.
  type Stream = MediaStream & { Profile?: string; Level?: number };

  const NAMES: Record<string, string> = {
    hevc: 'HEVC', h265: 'HEVC', h264: 'H.264', avc: 'H.264', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', mpeg2video: 'MPEG-2', vc1: 'VC-1', mpeg4: 'MPEG-4',
    aac: 'AAC', ac3: 'AC3', eac3: 'E-AC3', truehd: 'TrueHD', dts: 'DTS', mp3: 'MP3', mp2: 'MP2', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', alac: 'ALAC', pcm_s16le: 'PCM', pcm_s24le: 'PCM',
    subrip: 'SRT', srt: 'SRT', ass: 'ASS', ssa: 'SSA', webvtt: 'WebVTT', vtt: 'WebVTT', pgssub: 'PGS', pgs: 'PGS', dvdsub: 'VobSub', dvbsub: 'DVB', mov_text: 'TX3G',
  };
  const name = (c?: string) => (c ? (NAMES[c.toLowerCase()] ?? c.toUpperCase()) : undefined);
  const num = (n: number, d = 1) => n.toLocaleString(locale.current, { maximumFractionDigits: d });
  // "VideoCodecNotSupported" → stats_reason_video_codec_not_supported.
  const reasonKey = (r: string) => `stats_reason_${r.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`;
  const privateHost = (h: string) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost$|\[?fe80:|\[?fd)/i.test(h) || h.endsWith('.local');

  let tick = $state(0);
  $effect(() => {
    const id = setInterval(() => tick++, 1000);
    return () => clearInterval(id);
  });

  const rows = $derived.by(() => {
    void tick;
    const out: [string, string][] = [];
    const ps = pb.source;
    const live = pb.player.stats();
    const streams: Stream[] = ps?.MediaStreams ?? pb.streams;
    const video = streams.find((s) => s.Type === 'Video');
    const audio = streams.find((s) => s.Type === 'Audio' && s.Index === pb.audioIndex) ?? streams.find((s) => s.Type === 'Audio');
    const sub = streams.find((s) => s.Type === 'Subtitle' && s.Index === pb.subtitleIndex);
    const method = pb.playMethod === 'DirectPlay' ? t('stats_direct_play') : pb.playMethod === 'DirectStream' ? t('stats_direct_stream') : t('play_method_transcode');
    out.push([t('stats_method'), method]);
    if (pb.transcodeReasons.length) {
      const label = (r: string) => {
        const k = reasonKey(r);
        const s = t(k);
        return s === k ? r : s;
      };
      out.push([t('stats_reason'), pb.transcodeReasons.map(label).join(', ')]);
    }
    const hls = pb.playMethod !== 'DirectPlay' && (ps?.TranscodingSubProtocol ?? '').toLowerCase() === 'hls';
    if (ps?.Container) out.push([t('stats_container'), `${ps.Container.split(',')[0].toUpperCase()}${hls ? ' · HLS' : ''}`]);
    if (video) {
      const w = live.width ?? video.Width;
      const h = live.height ?? video.Height;
      const parts = [
        name(video.Codec),
        video.Profile,
        video.Level ? `L${video.Codec?.toLowerCase() === 'hevc' ? num(video.Level / 30) : num(video.Level / 10)}` : undefined,
        w && h ? `${w}×${h}` : undefined,
        video.RealFrameRate ? num(video.RealFrameRate, 3) : undefined,
        video.BitDepth ? `${video.BitDepth} bits` : undefined,
        video.VideoRangeType && video.VideoRangeType !== 'SDR' ? video.VideoRangeType : video.VideoRange && video.VideoRange !== 'SDR' ? video.VideoRange : undefined,
      ];
      out.push([t('stats_video'), parts.filter(Boolean).join(' · ')]);
    }
    if (audio) {
      const parts = [name(audio.Codec), audio.Profile, audio.ChannelLayout ?? (audio.Channels ? `${audio.Channels} ch` : undefined), audio.SampleRate ? `${num(audio.SampleRate / 1000)} kHz` : undefined];
      out.push([t('stats_audio'), parts.filter(Boolean).join(' · ')]);
    }
    if (sub) out.push([t('stats_subtitles'), name(sub.Codec) ?? '']);
    const bitrate = ps?.Bitrate ?? video?.BitRate;
    if (bitrate) out.push([t('stats_bitrate'), t('stats_mbps', num(bitrate / 1_000_000))]);
    if (live.bufferMs !== undefined) out.push([t('stats_buffer'), t('stats_seconds', num(live.bufferMs / 1000))]);
    if (live.dropped !== undefined) out.push([t('stats_dropped'), String(live.dropped)]);
    try {
      const host = new URL(pb.api.base).hostname;
      out.push([t('stats_server'), `${host} · ${privateHost(host) ? t('stats_link_local') : t('stats_link_remote')}`]);
    } catch {
      // No address to show.
    }
    return out;
  });
</script>

<div class="stats">
  <p class="t-eyebrow title">{t('stats_title').toUpperCase()}</p>
  {#each rows as [label, value] (label)}
    <div class="row"><span class="t-callout k">{label}</span><span class="t-callout v">{value}</span></div>
  {/each}
</div>

<style>
  .stats {
    position: absolute;
    top: 48rem;
    left: 56rem;
    max-width: 680rem;
    padding: 14rem 18rem;
    border-radius: var(--r-lg);
    background: rgba(0, 0, 0, 0.72);
    color: #fff;
    pointer-events: none;
  }
  p {
    margin: 0 0 8rem;
    color: rgba(255, 255, 255, 0.5);
  }
  .row {
    display: flex;
  }
  .k {
    width: 180rem;
    flex-shrink: 0;
    color: rgba(255, 255, 255, 0.7);
  }
  .v {
    min-width: 0;
  }
</style>
