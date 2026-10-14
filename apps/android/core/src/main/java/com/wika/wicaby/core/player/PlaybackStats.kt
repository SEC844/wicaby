package com.wika.wicaby.core.player

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.media3.common.C
import androidx.media3.common.MimeTypes
import androidx.media3.exoplayer.analytics.AnalyticsListener
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.net.LocalNetwork
import java.text.NumberFormat
import java.util.Locale

// Playback stats panel (Infuse T#9, TV and mobile): what the player really gets and how it plays it.
// Playback.stats() fills it from Media3's formats and counters and the PlaybackInfo source; the apps
// draw the rows. The helpers below are pure and unit-tested.
object PlaybackStats {
    // Toggled from the player's menu; stays on for the next videos of this process.
    var visible by mutableStateOf(false)

    data class Snapshot(
        val container: String? = null,
        val hls: Boolean = false,
        // "HEVC · Main 10 · L5.1 · 3840×2160 · 23.976 · HDR10"
        val video: String? = null,
        val bitDepth: Int? = null,
        val videoDecoder: String? = null,
        // "E-AC3 Atmos · 5.1 · 48 kHz"
        val audio: String? = null,
        val audioDecoder: String? = null,
        val passthrough: Boolean = false,
        val bitrate: Long? = null,
        val method: String = "DirectPlay",
        val reasons: List<String> = emptyList(),
        val bufferMs: Long = 0,
        val dropped: Int = 0,
        // "SRT", "PGS"…: the selected subtitle track's format.
        val subtitle: String? = null,
        val server: String? = null,
        val link: Link? = null,
        val offline: Boolean = false,
    )

    // How the server is reached: its address in use is on the LAN, elsewhere, or forwarded by the mesh node.
    enum class Link(val label: Int) { Local(R.string.stats_link_local), Remote(R.string.stats_link_remote), Mesh(R.string.stats_link_mesh) }

    /** The path to [host] (the server address in use): no DNS lookup, so a LAN name with dots counts as remote. */
    fun link(mesh: Boolean, host: String): Link = when {
        mesh -> Link.Mesh
        LocalNetwork.isLanHost(host) { emptyList() } -> Link.Local
        else -> Link.Remote
    }

    private val codecs = mapOf(
        MimeTypes.VIDEO_H265 to "HEVC", MimeTypes.VIDEO_H264 to "H.264", MimeTypes.VIDEO_AV1 to "AV1", MimeTypes.VIDEO_VP9 to "VP9",
        MimeTypes.VIDEO_VP8 to "VP8", MimeTypes.VIDEO_DOLBY_VISION to "Dolby Vision", MimeTypes.VIDEO_MPEG2 to "MPEG-2",
        MimeTypes.VIDEO_MP4V to "MPEG-4", MimeTypes.VIDEO_VC1 to "VC-1", MimeTypes.VIDEO_H263 to "H.263",
        MimeTypes.AUDIO_AAC to "AAC", MimeTypes.AUDIO_AC3 to "AC3", MimeTypes.AUDIO_E_AC3 to "E-AC3", MimeTypes.AUDIO_E_AC3_JOC to "E-AC3 Atmos",
        MimeTypes.AUDIO_AC4 to "AC4", MimeTypes.AUDIO_TRUEHD to "TrueHD", MimeTypes.AUDIO_DTS to "DTS", MimeTypes.AUDIO_DTS_HD to "DTS-HD",
        MimeTypes.AUDIO_DTS_EXPRESS to "DTS Express", MimeTypes.AUDIO_DTS_X to "DTS:X", MimeTypes.AUDIO_MPEG to "MP3",
        MimeTypes.AUDIO_MPEG_L2 to "MP2", MimeTypes.AUDIO_OPUS to "Opus", MimeTypes.AUDIO_VORBIS to "Vorbis", MimeTypes.AUDIO_FLAC to "FLAC",
        MimeTypes.AUDIO_ALAC to "ALAC", MimeTypes.AUDIO_RAW to "PCM",
    )

    /** "HEVC", "E-AC3 Atmos"; an unknown type shows its subtype ("x-foo" -> "X-FOO"). */
    fun codecName(mime: String?): String? = mime?.let { codecs[it] ?: it.substringAfter('/').uppercase(Locale.ROOT) }

    /** The profile in an RFC 6381 codecs string: "hvc1.2.4.L153" -> "Main 10", "avc1.640028" -> "High", "dvh1.08.06" -> "Profile 8". */
    fun profile(codecs: String?): String? {
        val parts = codecs?.split('.') ?: return null
        val p = parts.getOrNull(1) ?: return null
        return when (parts[0].lowercase(Locale.ROOT)) {
            "hvc1", "hev1" -> when (p.trimStart('A', 'B', 'C')) { "1" -> "Main"; "2" -> "Main 10"; "3" -> "Main Still"; "4" -> "RExt"; else -> null }
            "avc1", "avc3" -> when (p.take(2).uppercase(Locale.ROOT)) { "42" -> "Baseline"; "4D" -> "Main"; "58" -> "Extended"; "64" -> "High"; "6E" -> "High 10"; "7A" -> "High 4:2:2"; "F4" -> "High 4:4:4"; else -> null }
            "dvhe", "dvh1", "dvav", "dva1", "dav1" -> p.toIntOrNull()?.let { "Profile $it" }
            "av01" -> when (p) { "0" -> "Main"; "1" -> "High"; "2" -> "Professional"; else -> null }
            else -> null
        }
    }

    /** The level in an RFC 6381 codecs string: "hvc1.2.4.L153" -> "5.1", "avc1.640028" -> "4.0", "av01.0.08M.10" -> "4.0", "dvh1.08.06" -> "6". */
    fun level(codecs: String?): String? {
        val parts = codecs?.split('.') ?: return null
        fun tenths(n: Int?) = n?.takeIf { it > 0 }?.let { "${it / 10}.${it % 10}" }
        return when (parts[0].lowercase(Locale.ROOT)) {
            // general_level_idc is 30 x the level; L main tier, H high tier.
            "hvc1", "hev1" -> parts.getOrNull(3)?.takeIf { it.length > 1 && it[0] in "LHlh" }?.drop(1)?.toIntOrNull()?.takeIf { it > 0 }?.let { "${it / 30}.${it % 30 / 3}" }
            "avc1", "avc3" -> tenths(parts.getOrNull(1)?.takeIf { it.length == 6 }?.takeLast(2)?.toIntOrNull(16))
            "vp09" -> tenths(parts.getOrNull(2)?.toIntOrNull())
            // seq_level_idx: 2 + idx/4 . idx%4; 31 means "no level".
            "av01" -> parts.getOrNull(2)?.take(2)?.toIntOrNull()?.takeIf { it < 31 }?.let { "${2 + (it shr 2)}.${it and 3}" }
            "dvhe", "dvh1", "dvav", "dva1", "dav1" -> parts.getOrNull(2)?.toIntOrNull()?.toString()
            else -> null
        }
    }

    private val subtitleFormats = mapOf(
        "subrip" to "SRT", "srt" to "SRT", "ass" to "ASS", "ssa" to "SSA", "pgssub" to "PGS", "hdmv_pgs_subtitle" to "PGS", "pgs" to "PGS",
        "dvdsub" to "VobSub", "dvd_subtitle" to "VobSub", "vobsub" to "VobSub", "dvbsub" to "DVB", "dvb_subtitle" to "DVB",
        "webvtt" to "WebVTT", "vtt" to "WebVTT", "mov_text" to "TX3G", "ttml" to "TTML",
    )

    /** The server's subtitle codec, as people know it: "subrip" -> "SRT", "pgssub" -> "PGS"; else upper case. */
    fun subtitleFormat(codec: String?): String? = codec?.takeIf { it.isNotBlank() }?.let { subtitleFormats[it.lowercase(Locale.ROOT)] ?: it.uppercase(Locale.ROOT) }

    // The server's TranscodeReasons, worded as the desktop app's dashboard words them (admin.dashboard.reasons).
    private val reasonTexts = mapOf(
        "ContainerNotSupported" to R.string.stats_reason_container_not_supported,
        "VideoCodecNotSupported" to R.string.stats_reason_video_codec_not_supported,
        "AudioCodecNotSupported" to R.string.stats_reason_audio_codec_not_supported,
        "SubtitleCodecNotSupported" to R.string.stats_reason_subtitle_codec_not_supported,
        "ContainerBitrateExceedsLimit" to R.string.stats_reason_container_bitrate_exceeds_limit,
        "VideoBitrateNotSupported" to R.string.stats_reason_video_bitrate_not_supported,
        "AudioBitrateNotSupported" to R.string.stats_reason_audio_bitrate_not_supported,
        "VideoResolutionNotSupported" to R.string.stats_reason_video_resolution_not_supported,
        "VideoLevelNotSupported" to R.string.stats_reason_video_level_not_supported,
        "VideoProfileNotSupported" to R.string.stats_reason_video_profile_not_supported,
        "VideoBitDepthNotSupported" to R.string.stats_reason_video_bit_depth_not_supported,
        "VideoFramerateNotSupported" to R.string.stats_reason_video_framerate_not_supported,
        "VideoRangeTypeNotSupported" to R.string.stats_reason_video_range_type_not_supported,
        "RefFramesNotSupported" to R.string.stats_reason_ref_frames_not_supported,
        "AnamorphicVideoNotSupported" to R.string.stats_reason_anamorphic_video_not_supported,
        "InterlacedVideoNotSupported" to R.string.stats_reason_interlaced_video_not_supported,
        "AudioChannelsNotSupported" to R.string.stats_reason_audio_channels_not_supported,
        "AudioProfileNotSupported" to R.string.stats_reason_audio_profile_not_supported,
        "AudioSampleRateNotSupported" to R.string.stats_reason_audio_sample_rate_not_supported,
        "AudioBitDepthNotSupported" to R.string.stats_reason_audio_bit_depth_not_supported,
        "SecondaryAudioNotSupported" to R.string.stats_reason_secondary_audio_not_supported,
        "AudioIsExternal" to R.string.stats_reason_audio_is_external,
        "DirectPlayError" to R.string.stats_reason_direct_play_error,
        "UnknownVideoStreamInfo" to R.string.stats_reason_unknown_video_stream_info,
        "UnknownAudioStreamInfo" to R.string.stats_reason_unknown_audio_stream_info,
        "StreamCountExceedsLimit" to R.string.stats_reason_stream_count_exceeds_limit,
    )

    /** A reason's string, or null for one the app does not know (shown spaced out: "NewThingNotSupported" -> "New Thing Not Supported"). */
    fun reasonText(reason: String): Int? = reasonTexts[reason]

    fun spaced(reason: String): String = reason.replace(Regex("([a-z])([A-Z])"), "$1 $2")

    /** The decoded picture's range: "Dolby Vision", "HDR10" (PQ), "HLG", else null (SDR or unknown). */
    fun hdr(mime: String?, colorTransfer: Int): String? = when {
        mime == MimeTypes.VIDEO_DOLBY_VISION -> "Dolby Vision"
        colorTransfer == C.COLOR_TRANSFER_ST2084 -> "HDR10"
        colorTransfer == C.COLOR_TRANSFER_HLG -> "HLG"
        else -> null
    }

    /** "1.0", "2.0", "5.1", "7.1", else "4 ch". */
    fun channels(count: Int): String? = when {
        count <= 0 -> null
        count <= 2 -> "$count.0"
        count == 6 -> "5.1"
        count == 8 -> "7.1"
        else -> "$count ch"
    }

    /** Software decoders: Android's own (OMX.google, c2.android), FFmpeg and Media3's libraries (libdav1d...). */
    fun isSoftware(decoder: String): Boolean {
        val d = decoder.lowercase(Locale.ROOT)
        return d.startsWith("omx.google.") || d.startsWith("c2.android.") || d.contains("ffmpeg") || d.startsWith("lib") || d.contains(".sw.")
    }

    /** The server's reasons in a transcoding URL (TranscodeReasons=ContainerNotSupported,AudioCodecNotSupported). */
    fun reasons(url: String?): List<String> = query(url, "TranscodeReasons")?.split(',', '|')?.map { it.trim() }?.filter { it.isNotEmpty() }.orEmpty()

    /** The transcode's target bitrate (VideoBitrate + AudioBitrate in the URL), else null. */
    fun transcodeBitrate(url: String?): Long? {
        val v = query(url, "VideoBitrate")?.toLongOrNull()
        val a = query(url, "AudioBitrate")?.toLongOrNull()
        return if (v == null && a == null) null else (v ?: 0) + (a ?: 0)
    }

    private fun query(url: String?, name: String): String? {
        val q = url?.substringAfter('?', "") ?: return null
        return q.split('&').firstOrNull { it.substringBefore('=').equals(name, ignoreCase = true) }
            ?.substringAfter('=', "")?.let { java.net.URLDecoder.decode(it, "UTF-8") }?.ifEmpty { null }
    }

    /** The panel's rows: label to value, in the UI language. */
    fun rows(ctx: Context, s: Snapshot): List<Pair<String, String>> {
        fun decoder(name: String?) = name?.let { ctx.getString(if (isSoftware(it)) R.string.stats_software else R.string.stats_hardware, it) }
        val nf = NumberFormat.getInstance(Core.locale).apply { maximumFractionDigits = 1 }
        val method = when (s.method) {
            "Transcode" -> R.string.play_method_transcode
            "DirectStream" -> R.string.stats_direct_stream
            else -> R.string.stats_direct_play
        }
        val container = listOfNotNull(s.container?.uppercase(Locale.ROOT), "HLS".takeIf { s.hls }).joinToString(" → ").ifEmpty { null }
        return listOfNotNull(
            container?.let { R.string.stats_container to it },
            line(s.video, s.bitDepth?.let { ctx.getString(R.string.stats_bits, it) })?.let { R.string.stats_video to it },
            decoder(s.videoDecoder)?.let { R.string.stats_video_decoder to it },
            s.audio?.let { R.string.stats_audio to it },
            (if (s.passthrough) ctx.getString(R.string.stats_passthrough) else decoder(s.audioDecoder))?.let { R.string.stats_audio_decoder to it },
            s.bitrate?.takeIf { it > 0 }?.let { R.string.stats_bitrate to ctx.getString(R.string.stats_mbps, nf.format(it / 1_000_000.0)) },
            R.string.stats_method to ctx.getString(method),
            s.reasons.takeIf { it.isNotEmpty() }?.let { r -> R.string.stats_reason to r.joinToString(", ") { reasonText(it)?.let(ctx::getString) ?: spaced(it) } },
            s.subtitle?.let { R.string.stats_subtitles to it },
            R.string.stats_buffer to ctx.getString(R.string.stats_seconds, nf.format(s.bufferMs / 1000.0)),
            R.string.stats_dropped to s.dropped.toString(),
            (if (s.offline) ctx.getString(R.string.stats_downloaded) else line(s.server, s.link?.let { ctx.getString(it.label) }))?.let { R.string.stats_server to it },
        ).map { (label, value) -> ctx.getString(label) to value }
    }

    /** One line: the parts present, " · " between them. */
    fun line(vararg parts: String?): String? = parts.filterNot { it.isNullOrBlank() }.joinToString(" · ").ifEmpty { null }
}

// The decoder names Media3 picked (MediaCodec "c2.qti.hevc.decoder", FFmpeg "ffmpegLib..."), for the stats panel.
class StatsProbe : AnalyticsListener {
    var videoDecoder: String? = null
        private set
    var audioDecoder: String? = null
        private set

    override fun onVideoDecoderInitialized(eventTime: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) {
        videoDecoder = decoderName
    }

    override fun onAudioDecoderInitialized(eventTime: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) {
        audioDecoder = decoderName
    }

    fun clear() {
        videoDecoder = null
        audioDecoder = null
    }
}
