package com.wika.wicaby.core.data

import android.annotation.SuppressLint
import com.wika.wicaby.core.Core
import android.content.Context
import android.hardware.display.DisplayManager
import android.media.AudioFormat
import android.media.AudioManager
import android.media.MediaCodecInfo
import android.media.MediaCodecInfo.CodecProfileLevel as PL
import android.media.MediaCodecList
import android.os.Build
import android.view.Display
import androidx.media3.common.AudioAttributes
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.decoder.ffmpeg.FfmpegLibrary
import androidx.media3.exoplayer.audio.AudioCapabilities
import kotlinx.serialization.json.JsonArrayBuilder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

// ---------------------------------------------------------------------------
// What the device can show, as plain data. Built from MediaCodecList, the
// display's HDR capabilities and the HDMI sink below; turned into the
// DeviceProfile Emby/Jellyfin use to pick direct play or transcoding.

enum class Range { HDR10, HLG, DV5, DV7, DV8 }

data class VideoCaps(
    val maxWidth: Int,
    val maxHeight: Int,
    val maxFpsAtMax: Int = 0, // 0 = not measured
    val profiles: Set<String> = emptySet(), // server names ("high", "main 10"); empty = unconstrained
    val maxLevel: Int = 0, // server VideoLevel (h264 51, hevc 153); 0 = unconstrained
    val tenBit: Boolean = false,
    val ranges: Set<Range> = emptySet(), // decoder AND display can show these
)

data class Caps(
    val video: Map<String, VideoCaps>,
    val audio: Set<String>,
    val dvHdr10PlusBug: Boolean = false,
)

// Fire TV 4K / 4K Max on MT8696 give a black screen on HEVC DV with HDR10+ (Jellyfin KnownDefects).
private val DV_HDR10PLUS_BUG = setOf("AFTKRT", "AFTKA", "AFTKM", "AFTMM")

// Shield 2019 plays DV profile 7 but does not report it.
private val UNREPORTED_DV7 = setOf("SHIELD Android TV")

private val EMBED_SUBS = listOf("srt", "subrip", "ass", "ssa", "vtt", "webvtt", "ttml", "pgs", "pgssub", "dvdsub", "dvbsub", "mov_text")
private val EXTERNAL_SUBS = listOf("srt", "subrip", "vtt", "webvtt", "ttml", "ass", "ssa")

// A transcode to HLS/TS cannot carry bitmap subtitles: let the server burn them in.
private val ENCODE_SUBS = listOf("pgs", "pgssub", "dvdsub", "dvbsub", "sub", "idx")

private fun JsonArrayBuilder.cond(type: String, property: String, value: Any) = addJsonObject {
    put("Condition", type)
    put("Property", property)
    put("Value", value.toString())
    put("IsRequired", false)
}

// Jellyfin VideoRangeType values this codec cannot show.
fun unsupportedRanges(v: VideoCaps, dvHdr10PlusBug: Boolean): List<String> {
    val hdr10 = Range.HDR10 in v.ranges
    val hlg = Range.HLG in v.ranges
    val dv8 = Range.DV8 in v.ranges
    return buildList {
        add("DOVIInvalid")
        // HDR10+ falls back to its static HDR10 metadata.
        if (!hdr10) addAll(listOf("HDR10", "HDR10Plus"))
        if (!hlg) add("HLG")
        if (Range.DV5 !in v.ranges) add("DOVI")
        // Profile 8 falls back to its HDR10/HLG base layer; 8.2 (SDR) always plays.
        if (!hdr10 && !dv8) addAll(listOf("DOVIWithHDR10", "DOVIWithHDR10Plus"))
        if (!hlg && !dv8) add("DOVIWithHLG")
        if (Range.DV7 !in v.ranges) addAll(listOf("DOVIWithEL", "DOVIWithELHDR10Plus"))
        if (dvHdr10PlusBug) addAll(listOf("DOVIWithHDR10Plus", "DOVIWithELHDR10Plus"))
    }.distinct()
}

fun buildDeviceProfile(caps: Caps, maxBitrate: Int, jellyfin: Boolean): JsonObject {
    val video = caps.video
    val hlsVideo = listOf("hevc", "h264").filter { it in video }.ifEmpty { listOf("h264") }.joinToString(",")
    val hlsAudio = listOf("aac", "ac3", "eac3", "mp3").filter { it in caps.audio }.ifEmpty { listOf("aac") }.joinToString(",")
    return buildJsonObject {
        put("Name", Core.profileName)
        put("MaxStreamingBitrate", maxBitrate)
        put("MaxStaticBitrate", maxBitrate)
        put("MusicStreamingTranscodingBitrate", 320_000)
        putJsonArray("DirectPlayProfiles") {
            addJsonObject {
                put("Container", "mp4,m4v,mov,mkv,webm,ts,mpegts,m2ts,avi,flv,3gp")
                put("Type", "Video")
                put("VideoCodec", video.keys.joinToString(","))
                put("AudioCodec", caps.audio.joinToString(","))
            }
            addJsonObject { put("Container", "mp3,aac,m4a,m4b,flac,ogg,oga,opus,wav,mka"); put("Type", "Audio") }
        }
        putJsonArray("TranscodingProfiles") {
            addJsonObject {
                put("Container", "ts")
                put("Type", "Video")
                put("VideoCodec", hlsVideo)
                put("AudioCodec", hlsAudio)
                put("Context", "Streaming")
                put("Protocol", "hls")
                put("MaxAudioChannels", "6")
                put("MinSegments", 1)
                put("BreakOnNonKeyFrames", true)
            }
            addJsonObject {
                put("Container", "mp3"); put("Type", "Audio"); put("AudioCodec", "mp3")
                put("Context", "Streaming"); put("Protocol", "http"); put("MaxAudioChannels", "2")
            }
        }
        putJsonArray("ContainerProfiles") {}
        putJsonArray("CodecProfiles") {
            for ((codec, c) in video) {
                addJsonObject {
                    put("Type", "Video")
                    put("Codec", codec)
                    putJsonArray("Conditions") {
                        if (c.maxWidth > 0) cond("LessThanEqual", "Width", c.maxWidth)
                        if (c.maxHeight > 0) cond("LessThanEqual", "Height", c.maxHeight)
                        if (!c.tenBit) cond("LessThanEqual", "VideoBitDepth", 8)
                        if (c.profiles.isNotEmpty()) cond("EqualsAny", "VideoProfile", c.profiles.joinToString("|"))
                        if (c.maxLevel > 0) cond("LessThanEqual", "VideoLevel", c.maxLevel)
                        // Emby only knows SDR/HDR.
                        if (!jellyfin && c.tenBit && c.ranges.none { it == Range.HDR10 || it == Range.HLG || it == Range.DV5 }) {
                            cond("Equals", "VideoRange", "SDR")
                        }
                    }
                }
                // A 4K30 decoder is not a 4K60 decoder.
                if (c.maxHeight > 1080 && c.maxFpsAtMax in 1 until 50) {
                    addJsonObject {
                        put("Type", "Video")
                        put("Codec", codec)
                        putJsonArray("ApplyConditions") { cond("GreaterThanEqual", "Height", 1200) }
                        putJsonArray("Conditions") { cond("LessThanEqual", "VideoFramerate", c.maxFpsAtMax) }
                    }
                }
                // Jellyfin's workaround: NotEquals with a pipe list never matches, so the profile is
                // scoped by ApplyConditions to the bad ranges and the StreamBuilder transcodes them.
                if (jellyfin && codec in setOf("hevc", "av1", "vp9")) {
                    val bad = unsupportedRanges(c, caps.dvHdr10PlusBug && codec == "hevc").joinToString("|")
                    addJsonObject {
                        put("Type", "Video")
                        put("Codec", codec)
                        putJsonArray("ApplyConditions") { cond("EqualsAny", "VideoRangeType", bad) }
                        putJsonArray("Conditions") { cond("NotEquals", "VideoRangeType", bad) }
                    }
                }
            }
        }
        putJsonArray("ResponseProfiles") {}
        putJsonArray("SubtitleProfiles") {
            EMBED_SUBS.forEach { f -> addJsonObject { put("Format", f); put("Method", "Embed") } }
            EXTERNAL_SUBS.forEach { f -> addJsonObject { put("Format", f); put("Method", "External") } }
            addJsonObject { put("Format", "vtt"); put("Method", "Hls") }
            ENCODE_SUBS.forEach { f -> addJsonObject { put("Format", f); put("Method", "Encode") } }
        }
    }
}

// MediaCodec level bit -> ffprobe level as the servers store it.
private val AVC_LEVELS = listOf(10, 10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52, 60, 61, 62)
private val HEVC_LEVELS = listOf(30, 60, 63, 90, 93, 120, 123, 150, 153, 156, 180, 183, 186)

fun avcLevel(bit: Int): Int = AVC_LEVELS.getOrElse(Integer.numberOfTrailingZeros(bit)) { 0 }

// Main and High tier alternate bit by bit.
fun hevcLevel(bit: Int): Int = HEVC_LEVELS.getOrElse(Integer.numberOfTrailingZeros(bit) / 2) { 0 }

// ---------------------------------------------------------------------------
// Probing.

private val VIDEO = mapOf(
    "video/avc" to "h264",
    "video/hevc" to "hevc",
    "video/x-vnd.on2.vp9" to "vp9",
    "video/av01" to "av1",
    "video/x-vnd.on2.vp8" to "vp8",
    "video/mp4v-es" to "mpeg4",
    "video/mpeg2" to "mpeg2video",
    "video/wvc1" to "vc1",
    "video/3gpp" to "h263",
)

private val AUDIO = mapOf(
    "audio/mp4a-latm" to listOf("aac"),
    "audio/mpeg" to listOf("mp3"),
    "audio/mpeg-l2" to listOf("mp2"),
    "audio/ac3" to listOf("ac3"),
    "audio/eac3" to listOf("eac3"),
    "audio/eac3-joc" to listOf("eac3"),
    "audio/ac4" to listOf("ac4"),
    "audio/opus" to listOf("opus"),
    "audio/vorbis" to listOf("vorbis"),
    "audio/flac" to listOf("flac"),
    "audio/alac" to listOf("alac"),
    "audio/raw" to listOf("pcm_s16le", "pcm_s24le"),
    "audio/g711-alaw" to listOf("pcm_alaw"),
    "audio/g711-mlaw" to listOf("pcm_mulaw"),
    "audio/vnd.dts" to listOf("dts", "dca"),
    "audio/vnd.dts.hd" to listOf("dts", "dca"),
    "audio/true-hd" to listOf("truehd"),
)

// The FFmpeg extension decodes these in software when no platform decoder or passthrough exists.
private val FFMPEG_AUDIO = mapOf(
    MimeTypes.AUDIO_AC3 to listOf("ac3"),
    MimeTypes.AUDIO_E_AC3 to listOf("eac3"),
    MimeTypes.AUDIO_DTS to listOf("dts", "dca"),
    MimeTypes.AUDIO_DTS_HD to listOf("dts", "dca"),
    MimeTypes.AUDIO_TRUEHD to listOf("truehd"),
    MimeTypes.AUDIO_FLAC to listOf("flac"),
    MimeTypes.AUDIO_ALAC to listOf("alac"),
    MimeTypes.AUDIO_OPUS to listOf("opus"),
    MimeTypes.AUDIO_VORBIS to listOf("vorbis"),
    MimeTypes.AUDIO_MPEG to listOf("mp3"),
    MimeTypes.AUDIO_MPEG_L2 to listOf("mp2"),
)

// Bitstream passthrough to the HDMI sink: mime, Android encoding, channels, server names.
private class Pass(val mime: String, val encoding: Int, val channels: Int, val names: List<String>)

private val PASSTHROUGH = listOf(
    Pass(MimeTypes.AUDIO_AC3, AudioFormat.ENCODING_AC3, 6, listOf("ac3")),
    Pass(MimeTypes.AUDIO_E_AC3, AudioFormat.ENCODING_E_AC3, 6, listOf("eac3")),
    Pass(MimeTypes.AUDIO_E_AC3_JOC, AudioFormat.ENCODING_E_AC3_JOC, 6, listOf("eac3")),
    Pass(MimeTypes.AUDIO_DTS, AudioFormat.ENCODING_DTS, 6, listOf("dts", "dca")),
    Pass(MimeTypes.AUDIO_DTS_HD, AudioFormat.ENCODING_DTS_HD, 8, listOf("dts", "dca")),
    Pass(MimeTypes.AUDIO_TRUEHD, AudioFormat.ENCODING_DOLBY_TRUEHD, 8, listOf("truehd")),
)

private val SIZES = listOf(7680 to 4320, 4096 to 2160, 3840 to 2160, 2560 to 1440, 1920 to 1080, 1280 to 720, 720 to 576, 720 to 480)

private class Probe(var w: Int = 0, var h: Int = 0, var fps: Int = 0, val profiles: MutableSet<String> = mutableSetOf(), var level: Int = 0, var tenBit: Boolean = false)

object DeviceCaps {
    @Volatile
    private var video: Map<String, VideoCaps>? = null

    @Volatile
    private var decoders: Set<String>? = null

    fun caps(context: Context): Caps {
        val v = video ?: probeVideo(context).also { video = it }
        return Caps(v, audio(context), Build.MODEL in DV_HDR10PLUS_BUG)
    }

    // Passthrough follows the HDMI sink (TV or AVR), which can change any time: never cached.
    fun audio(context: Context): Set<String> {
        val dec = decoders ?: probeAudioDecoders().also { decoders = it }
        return dec + passthrough(context)
    }

    private fun isSoftware(info: MediaCodecInfo): Boolean =
        if (Build.VERSION.SDK_INT >= 29) info.isSoftwareOnly
        else info.name.lowercase().let { it.startsWith("omx.google.") || it.startsWith("c2.android.") || it.contains("ffmpeg") }

    private fun probeAudioDecoders(): Set<String> {
        val a = LinkedHashSet<String>()
        for (info in MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos) {
            if (info.isEncoder) continue
            info.supportedTypes.forEach { AUDIO[it.lowercase()]?.let(a::addAll) }
        }
        if (runCatching { FfmpegLibrary.isAvailable() }.getOrDefault(false)) {
            FFMPEG_AUDIO.forEach { (mime, names) -> if (FfmpegLibrary.supportsFormat(mime)) a += names }
        }
        return a
    }

    // What the sink takes as bitstream, with the user's per-codec overrides applied.
    fun passthrough(context: Context): Set<String> {
        val o = Core.passthroughOverride
        val detected = detectPassthrough(context)
        if (o.isEmpty()) return detected
        val names = { k: String -> if (k == "dts") listOf("dts", "dca") else listOf(k) }
        return detected + o.filterValues { it }.keys.flatMap(names) - o.filterValues { !it }.keys.flatMap(names).toSet()
    }

    private fun detectPassthrough(context: Context): Set<String> = runCatching {
        val exo = AudioCapabilities.getCapabilities(context, AudioAttributes.DEFAULT, null)
        val am = context.getSystemService(AudioManager::class.java)
        val attrs = android.media.AudioAttributes.Builder()
            .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MOVIE)
            .build()
        PASSTHROUGH.filter { p ->
            val format = Format.Builder().setSampleMimeType(p.mime).setChannelCount(p.channels).setSampleRate(48_000).build()
            exo.isPassthroughPlaybackSupported(format, AudioAttributes.DEFAULT) ||
                (Build.VERSION.SDK_INT >= 33 && bitstream(am, p, attrs))
        }.flatMapTo(LinkedHashSet()) { it.names }
    }.getOrDefault(emptySet())

    @SuppressLint("NewApi")
    private fun bitstream(am: AudioManager, p: Pass, attrs: android.media.AudioAttributes): Boolean = runCatching {
        val mask = if (p.channels == 8) AudioFormat.CHANNEL_OUT_7POINT1_SURROUND else AudioFormat.CHANNEL_OUT_5POINT1
        val f = AudioFormat.Builder().setEncoding(p.encoding).setSampleRate(48_000).setChannelMask(mask).build()
        AudioManager.getDirectPlaybackSupport(f, attrs) and AudioManager.DIRECT_PLAYBACK_BITSTREAM_SUPPORTED != 0
    }.getOrDefault(false)

    @Suppress("DEPRECATION")
    private fun displayHdr(context: Context): Set<Int> = runCatching {
        if (Build.VERSION.SDK_INT < 24) return@runCatching emptySet()
        val d = context.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY) ?: return@runCatching emptySet()
        val types = d.hdrCapabilities?.supportedHdrTypes?.toMutableSet() ?: mutableSetOf()
        // The current mode may be SDR-only (a 1080p UI); the content switches to an HDR mode.
        if (Build.VERSION.SDK_INT >= 34) d.supportedModes.forEach { types += it.supportedHdrTypes.toList() }
        types.toSet()
    }.getOrDefault(emptySet())

    private fun probeVideo(context: Context): Map<String, VideoCaps> {
        val list = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder && !(Build.VERSION.SDK_INT >= 29 && it.isAlias) }
        val byCodec = HashMap<String, MutableList<Pair<MediaCodecInfo, String>>>()
        val dvProfiles = HashSet<Int>()
        for (info in list) {
            for (mime in info.supportedTypes) {
                val m = mime.lowercase()
                VIDEO[m]?.let { byCodec.getOrPut(it) { mutableListOf() } += info to mime }
                if (m == MimeTypes.VIDEO_DOLBY_VISION) {
                    runCatching { info.getCapabilitiesForType(mime).profileLevels.forEach { dvProfiles += it.profile } }
                }
            }
        }
        val hdr = displayHdr(context)
        val result = LinkedHashMap<String, VideoCaps>()
        for ((codec, decs) in byCodec) {
            // A software decoder that claims 4K would turn direct play into a slideshow.
            val hw = decs.filter { !isSoftware(it.first) }.ifEmpty { decs }
            val p = Probe()
            for ((info, mime) in hw) {
                val caps = runCatching { info.getCapabilitiesForType(mime) }.getOrNull() ?: continue
                caps.videoCapabilities?.let { vc ->
                    val size = SIZES.firstOrNull { (w, h) -> runCatching { vc.areSizeAndRateSupported(w, h, 24.0) }.getOrDefault(false) }
                    if (size != null && size.first * size.second > p.w * p.h) {
                        p.w = size.first
                        p.h = size.second
                        p.fps = listOf(60, 50, 30, 25, 24).first { runCatching { vc.areSizeAndRateSupported(size.first, size.second, it.toDouble()) }.getOrDefault(false) || it == 24 }
                    }
                }
                for (pl in caps.profileLevels) {
                    when (codec) {
                        "h264" -> {
                            when (pl.profile) {
                                PL.AVCProfileBaseline, PL.AVCProfileConstrainedBaseline -> p.profiles += listOf("baseline", "constrained baseline")
                                PL.AVCProfileMain -> p.profiles += "main"
                                PL.AVCProfileHigh, PL.AVCProfileConstrainedHigh -> p.profiles += "high"
                                // Hi10P anime is almost never hardware-decodable; claim it only when listed.
                                PL.AVCProfileHigh10 -> { p.profiles += "high 10"; p.tenBit = true }
                            }
                            p.level = maxOf(p.level, avcLevel(pl.level))
                        }
                        "hevc" -> {
                            when (pl.profile) {
                                PL.HEVCProfileMain -> p.profiles += "main"
                                PL.HEVCProfileMain10, PL.HEVCProfileMain10HDR10, PL.HEVCProfileMain10HDR10Plus -> { p.profiles += "main 10"; p.tenBit = true }
                            }
                            p.level = maxOf(p.level, hevcLevel(pl.level))
                        }
                        "vp9" -> if (pl.profile in setOf(PL.VP9Profile2, PL.VP9Profile2HDR, PL.VP9Profile2HDR10Plus)) p.tenBit = true
                        "av1" -> if (pl.profile in setOf(PL.AV1ProfileMain10, PL.AV1ProfileMain10HDR10, PL.AV1ProfileMain10HDR10Plus)) p.tenBit = true
                    }
                }
            }
            if (p.w == 0) continue
            val ranges = mutableSetOf<Range>()
            if (p.tenBit && codec in setOf("hevc", "vp9", "av1")) {
                if (Display.HdrCapabilities.HDR_TYPE_HDR10 in hdr || Display.HdrCapabilities.HDR_TYPE_HDR10_PLUS in hdr) ranges += Range.HDR10
                if (Display.HdrCapabilities.HDR_TYPE_HLG in hdr) ranges += Range.HLG
                if (Display.HdrCapabilities.HDR_TYPE_DOLBY_VISION in hdr) {
                    if (codec == "hevc") {
                        if (PL.DolbyVisionProfileDvheStn in dvProfiles) ranges += Range.DV5
                        if (PL.DolbyVisionProfileDvheSt in dvProfiles) ranges += Range.DV8
                        if (PL.DolbyVisionProfileDvheDtb in dvProfiles || (Build.MODEL in UNREPORTED_DV7 && dvProfiles.isNotEmpty())) ranges += Range.DV7
                    }
                    if (codec == "av1" && PL.DolbyVisionProfileDvav110 in dvProfiles) ranges += listOf(Range.DV5, Range.DV8)
                }
            }
            // Some decoders report a nonsense low level; trust the size probe then.
            val level = when (codec) {
                "h264" -> p.level.takeIf { it >= 41 } ?: 0
                "hevc" -> p.level.takeIf { it >= 120 } ?: 0
                else -> 0
            }
            val profiles = if (codec == "h264" || codec == "hevc") p.profiles.toSet() else emptySet()
            result[codec] = VideoCaps(p.w, p.h, p.fps, profiles, level, p.tenBit, ranges)
        }
        return result
    }
}

// maxHeight (X-02 preset, 0 = none): caps direct play and transcodes alike, as on desktop (width at 16:9).
fun deviceProfile(context: Context, maxBitrate: Int, jellyfin: Boolean, maxHeight: Int = 0): JsonObject =
    buildDeviceProfile(DeviceCaps.caps(context).capHeight(maxHeight), maxBitrate, jellyfin)

fun Caps.capHeight(maxHeight: Int): Caps {
    if (maxHeight <= 0) return this
    val maxWidth = Math.round(maxHeight * 16 / 9f)
    fun cap(v: Int, max: Int) = if (v in 1..max) v else max
    return copy(video = video.mapValues { (_, v) -> v.copy(maxWidth = cap(v.maxWidth, maxWidth), maxHeight = cap(v.maxHeight, maxHeight)) })
}
