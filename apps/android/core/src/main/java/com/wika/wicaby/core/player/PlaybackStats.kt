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
        // "HEVC Main 10 · 3840×2160 · 23.976 · HDR10"
        val video: String? = null,
        val videoDecoder: String? = null,
        // "E-AC3 Atmos · 5.1"
        val audio: String? = null,
        val audioDecoder: String? = null,
        val passthrough: Boolean = false,
        val bitrate: Long? = null,
        val method: String = "DirectPlay",
        val reasons: List<String> = emptyList(),
        val bufferMs: Long = 0,
        val dropped: Int = 0,
    )

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
            s.video?.let { R.string.stats_video to it },
            decoder(s.videoDecoder)?.let { R.string.stats_video_decoder to it },
            s.audio?.let { R.string.stats_audio to it },
            (if (s.passthrough) ctx.getString(R.string.stats_passthrough) else decoder(s.audioDecoder))?.let { R.string.stats_audio_decoder to it },
            s.bitrate?.takeIf { it > 0 }?.let { R.string.stats_bitrate to ctx.getString(R.string.stats_mbps, nf.format(it / 1_000_000.0)) },
            R.string.stats_method to ctx.getString(method),
            s.reasons.takeIf { it.isNotEmpty() }?.let { R.string.stats_reason to it.joinToString(", ") },
            R.string.stats_buffer to ctx.getString(R.string.stats_seconds, nf.format(s.bufferMs / 1000.0)),
            R.string.stats_dropped to s.dropped.toString(),
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
