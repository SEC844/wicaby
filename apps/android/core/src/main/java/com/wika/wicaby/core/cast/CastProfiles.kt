package com.wika.wicaby.core.cast

import kotlinx.serialization.json.JsonArrayBuilder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

// The DeviceProfiles a renderer's PlaybackInfo is asked with (cast spec §2.6.5–6): a line-for-line port of the
// desktop's D/main/cast/profiles.ts (same inputs, same JSON), so both apps ask the server for the same streams.
// Pure; CastProfilesTest runs it on the recorded Sinks of CK/fixtures/cast/. The Cast one is for CA-10.
object CastProfiles {
    const val DLNA_BITRATE = 40_000_000
    const val CAST_BITRATE = 20_000_000

    private class Row(val mime: Regex, val containers: String, val audio: Boolean)

    // Sink MIME types -> server containers, in this order.
    private val SINK_CONTAINERS = listOf(
        Row(Regex("^video/(mp4|x-m4v)$"), "mp4,m4v", false),
        Row(Regex("^video/(x-matroska|x-mkv)$"), "mkv", false),
        Row(Regex("^video/(mpeg|vnd\\.dlna\\.mpeg-tts|mp2t)$"), "ts", false),
        Row(Regex("^video/(x-msvideo|avi)$"), "avi", false),
        Row(Regex("^audio/mpeg$"), "mp3", true),
        Row(Regex("^audio/(x-)?flac$"), "flac", true),
        Row(Regex("^audio/(mp4|x-m4a)$"), "m4a", true),
    )
    private val FALLBACK_MIME = mapOf(
        "mp4" to "video/mp4", "m4v" to "video/mp4", "mkv" to "video/x-matroska", "ts" to "video/mpeg", "mpegts" to "video/mpeg",
        "avi" to "video/x-msvideo", "mp3" to "audio/mpeg", "flac" to "audio/flac", "m4a" to "audio/mp4", "aac" to "audio/mp4",
    )
    private val TEXT_SUBS = listOf("srt", "subrip", "ass", "ssa", "vtt", "webvtt")
    private val IMAGE_SUBS = listOf("pgs", "pgssub", "dvdsub", "dvbsub", "vobsub")

    fun isSony(model: String) = Regex("sony|bravia", RegexOption.IGNORE_CASE).containsMatchIn(model)

    // A container a DLNA Sink can name (direct play picks the first of a source's "mov,mp4,…" list that is one).
    fun known(container: String) = SINK_CONTAINERS.any { r -> container in r.containers.split(',') }

    // "http-get:*:video/mp4:DLNA.ORG_PN=…,…" -> its MIME types, lower case, in order, once each.
    fun sinkMimes(sinkCsv: String): List<String> = sinkCsv.split(',').map { it.trim().split(':') }
        .filter { p -> p.size >= 4 && p[0].equals("http-get", true) }.map { it[2].lowercase() }.distinct()

    // The MIME a renderer is told for [container]: the first one its Sink lists, else the common one.
    fun mime(container: String, audio: Boolean, sinkCsv: String = ""): String {
        val c = container.lowercase().split(',')[0]
        val row = SINK_CONTAINERS.firstOrNull { r -> (if (c == "mpegts") "ts" else c) in r.containers.split(',') && r.audio == audio }
        return row?.let { r -> sinkMimes(sinkCsv).firstOrNull { r.mime.matches(it) } }
            ?: FALLBACK_MIME[c] ?: if (audio) "audio/mpeg" else "video/mpeg"
    }

    // §2.6.5: Sink containers (none listed: mp4, ts, mp3, m4a), h264/hevc with aac/ac3/eac3/mp3, an HTTP TS
    // transcode (never HLS), 40 Mbps. Sony: subtitles burnt in, except those inside a direct-streamed MKV; others:
    // srt on the side (the server converts other text formats to it). [sony] may also come from the manufacturer.
    fun dlna(sinkCsv: String, model: String, sony: Boolean = isSony(model)): JsonObject {
        val mimes = sinkMimes(sinkCsv)
        val rows = SINK_CONTAINERS.filter { r -> mimes.any { r.mime.matches(it) } }
            .ifEmpty { SINK_CONTAINERS.filter { it.containers in setOf("mp4,m4v", "ts", "mp3", "m4a") } }
        val video = rows.filter { !it.audio }.map { it.containers }
        val audio = rows.filter { it.audio }.map { it.containers }
        return buildJsonObject {
            head("Wicaby DLNA", model, DLNA_BITRATE)
            putJsonArray("CodecProfiles") {}
            putJsonArray("ResponseProfiles") {}
            putJsonArray("DirectPlayProfiles") {
                if (video.isNotEmpty()) addJsonObject {
                    put("Container", video.joinToString(",")); put("Type", "Video"); put("VideoCodec", "h264,hevc"); put("AudioCodec", "aac,ac3,eac3,mp3")
                }
                audio.forEach { c -> addJsonObject { put("Container", c); put("Type", "Audio") } }
            }
            putJsonArray("TranscodingProfiles") {
                addJsonObject {
                    put("Container", "ts"); put("Type", "Video"); put("VideoCodec", "h264"); put("AudioCodec", "aac,ac3")
                    put("Protocol", "http"); put("Context", "Streaming")
                }
                mp3()
            }
            putJsonArray("SubtitleProfiles") {
                if (sony) {
                    (TEXT_SUBS + IMAGE_SUBS).forEach { sub(it, "Embed", "mkv") }
                    (TEXT_SUBS + IMAGE_SUBS).forEach { sub(it, "Encode") }
                } else {
                    sub("srt", "External")
                    IMAGE_SUBS.forEach { sub(it, "Encode") }
                }
            }
        }
    }

    // §2.6.6, the Default Media Receiver (Emby; CA-10). [model] is the mDNS TXT "md". MKV is never listed: always remuxed.
    fun cast(model: String, jellyfin: Boolean, allowHevc: Boolean = false, dolby: Boolean = false): JsonObject {
        val uhd = Regex("ultra|chromecast with google tv|google tv streamer", RegexOption.IGNORE_CASE).containsMatchIn(model)
        val av1 = Regex("google tv streamer", RegexOption.IGNORE_CASE).containsMatchIn(model)
        val hevc = uhd || allowHevc
        val audio = (listOf("aac", "mp3", "opus", "vorbis", "flac") + if (dolby) listOf("ac3", "eac3") else emptyList()).joinToString(",")
        val videoCodecs = listOfNotNull("h264", "hevc".takeIf { hevc }, "av1".takeIf { av1 }, "vp8", "vp9").joinToString(",")
        return buildJsonObject {
            head("Wicaby Cast", model, CAST_BITRATE)
            putJsonArray("ResponseProfiles") {}
            putJsonArray("DirectPlayProfiles") {
                addJsonObject { put("Container", "mp4,m4v"); put("Type", "Video"); put("VideoCodec", videoCodecs); put("AudioCodec", audio) }
                addJsonObject { put("Container", "webm"); put("Type", "Video"); put("VideoCodec", "vp8,vp9"); put("AudioCodec", "opus,vorbis") }
                addJsonObject { put("Container", "mp3"); put("Type", "Audio") }
                addJsonObject { put("Container", "aac,m4a"); put("Type", "Audio"); put("AudioCodec", "aac") }
                addJsonObject { put("Container", "flac"); put("Type", "Audio") }
                addJsonObject { put("Container", "opus,ogg,webm"); put("Type", "Audio"); put("AudioCodec", "opus,vorbis") }
            }
            putJsonArray("CodecProfiles") {
                addJsonObject {
                    put("Type", "Video"); put("Codec", "h264")
                    putJsonArray("Conditions") {
                        addJsonObject { put("Condition", "LessThanEqual"); put("Property", "VideoLevel"); put("Value", if (uhd) "51" else "41"); put("IsRequired", false) }
                    }
                }
            }
            putJsonArray("TranscodingProfiles") {
                // HEVC goes out in fMP4 segments on Jellyfin; Emby transcodes it to h264.
                if (hevc && jellyfin) hls("mp4", "hevc,h264")
                hls("ts", "h264")
                mp3()
            }
            // The server converts text subtitles to the External format; image ones are burnt in.
            putJsonArray("SubtitleProfiles") {
                sub("vtt", "External")
                IMAGE_SUBS.forEach { sub(it, "Encode") }
            }
        }
    }

    private fun JsonObjectBuilder.head(name: String, model: String, max: Int) {
        put("Name", if (model.isNotEmpty()) "$name ($model)" else name)
        put("MaxStreamingBitrate", max)
        put("MaxStaticBitrate", max)
        put("MusicStreamingTranscodingBitrate", 320_000)
        putJsonArray("ContainerProfiles") {}
    }

    private fun JsonArrayBuilder.hls(container: String, video: String) = addJsonObject {
        put("Container", container); put("Type", "Video"); put("VideoCodec", video); put("AudioCodec", "aac")
        put("Protocol", "hls"); put("Context", "Streaming"); put("MinSegments", 1); put("BreakOnNonKeyFrames", true)
    }

    private fun JsonArrayBuilder.mp3() = addJsonObject {
        put("Container", "mp3"); put("Type", "Audio"); put("AudioCodec", "mp3"); put("Protocol", "http"); put("Context", "Streaming")
    }

    private fun JsonArrayBuilder.sub(format: String, method: String, container: String? = null) = addJsonObject {
        put("Format", format)
        put("Method", method)
        container?.let { put("Container", it) }
    }
}
