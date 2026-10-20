package com.wika.wicaby.core.data

import android.content.Context
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.player.Quality
import com.wika.wicaby.core.player.TrackMemory
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

// An item with several MediaSources ("versions"): 4K and 1080p, VF and VOST, a director's cut.
// Labels for the detail page's Version picker, the choice remembered per item (across launches),
// and the audio/subtitle picks made on the detail page (per item and version, this process only).
// Playback reads both, so the player, PlaybackInfo and the play session follow the choice.
object Versions {
    // ---- Labels (pure: unit-tested on the JVM).

    // One label per source, same order: its name when it has a meaningful one, else what tells
    // it apart ("4K HDR · HEVC · Atmos", plus the audio languages when those differ).
    fun labels(item: Item): List<String> = labels(item.name, item.mediaSources)

    fun labels(title: String, sources: List<MediaSource>): List<String> {
        val names = sources.map { cleanName(title, it) }
        val quality = sources.map(::quality)
        val langs = sources.map(::languages)
        val showLangs = langs.toSet().size > 1
        val base = sources.indices.map { i ->
            names[i] ?: listOf(quality[i], langs[i].takeIf { showLangs }.orEmpty()).filter { it.isNotEmpty() }.joinToString(" · ")
        }
        // Two names that read the same get their quality; anything still equal gets a number.
        val withQuality = base.mapIndexed { i, l ->
            if (names[i] != null && base.count { it == l } > 1 && quality[i].isNotEmpty()) "$l · ${quality[i]}" else l
        }
        return withQuality.mapIndexed { i, l ->
            when {
                l.isEmpty() -> "${i + 1}"
                withQuality.count { it == l } > 1 -> "$l (${i + 1})"
                else -> l
            }
        }
    }

    // "4K HDR · HEVC · Atmos": resolution and dynamic range, video codec, the default audio's best feature.
    fun quality(s: MediaSource): String {
        val v = s.mediaStreams.firstOrNull { it.type == "Video" }
        val a = defaultAudioStream(s)
        val picture = listOfNotNull(v?.let { resolution(it.width ?: 0, it.height ?: 0) }, v?.let(::dynamicRange)).joinToString(" ")
        return listOfNotNull(picture.ifEmpty { null }, v?.codec?.let(::videoCodec), a?.let(::audioFeature)).joinToString(" · ")
    }

    fun resolution(width: Int, height: Int): String? = when {
        width >= 3200 || height >= 1800 -> "4K"
        width >= 1700 || height >= 900 -> "1080p"
        width >= 1200 || height >= 650 -> "720p"
        width > 0 || height > 0 -> "SD"
        else -> null
    }

    // The same mapping as the detail page's range chip, short form ("Dolby Vision", "HDR10"…).
    private fun dynamicRange(v: MediaStream): String? = VideoRange.of(v).primary

    private fun videoCodec(c: String): String = when (c.lowercase()) {
        "hevc", "h265" -> "HEVC"
        "h264", "avc" -> "H.264"
        "av1" -> "AV1"
        "vp9" -> "VP9"
        "mpeg2video" -> "MPEG-2"
        "vc1" -> "VC-1"
        else -> c.uppercase()
    }

    private fun audioFeature(a: MediaStream): String? {
        val text = listOfNotNull(a.profile, a.displayTitle, a.title).joinToString(" ")
        val codec = a.codec?.lowercase()
        return when {
            text.contains("Atmos", true) -> "Atmos"
            text.contains("DTS:X", true) || text.contains("DTS-X", true) -> "DTS:X"
            codec == "truehd" -> "TrueHD"
            (codec == "dts" || codec == "dca") && text.contains("MA", false) -> "DTS-HD MA"
            codec == "dts" || codec == "dca" -> "DTS"
            (a.channels ?: 0) >= 8 -> "7.1"
            (a.channels ?: 0) >= 6 -> "5.1"
            else -> null
        }
    }

    // "FR/EN": the audio languages, as two-letter codes.
    fun languages(s: MediaSource): String =
        s.mediaStreams.filter { it.type == "Audio" }.mapNotNull { it.language?.let(::iso2) }.distinct().joinToString("/") { it.uppercase() }

    private val bibliographic = mapOf(
        "fre" to "fr", "ger" to "de", "dut" to "nl", "chi" to "zh", "cze" to "cs", "gre" to "el", "per" to "fa", "rum" to "ro",
        "slo" to "sk", "alb" to "sq", "arm" to "hy", "baq" to "eu", "bur" to "my", "geo" to "ka", "ice" to "is", "mac" to "mk",
        "mao" to "mi", "may" to "ms", "tib" to "bo", "wel" to "cy",
    )
    private val iso3to2: Map<String, String> by lazy {
        Locale.getISOLanguages().mapNotNull { c -> runCatching { Locale(c).isO3Language to c }.getOrNull() }.toMap()
    }

    private fun iso2(lang: String): String? {
        val l = lang.lowercase().substringBefore('-')
        if (l.isEmpty() || l == "und" || l == "mis" || l == "zxx") return null
        return if (l.length == 2) l else bibliographic[l] ?: iso3to2[l] ?: l
    }

    // A source name worth showing: not empty, not just the title (and year), no file extension.
    internal fun cleanName(title: String, s: MediaSource): String? {
        var n = s.name?.trim().orEmpty()
        if (n.isEmpty()) return null
        n = n.replace(Regex("""\.(mkv|mp4|m4v|avi|ts|m2ts|mov|webm|iso)$""", RegexOption.IGNORE_CASE), "")
        if (title.isNotBlank() && n.startsWith(title, ignoreCase = true)) n = n.substring(title.length)
        n = n.trimStart().replace(Regex("""^\(\d{4}\)"""), "")
        n = n.trim(' ', '-', '–', '—', '_', '.', ':', '|', '·')
        return n.ifEmpty { null }
    }

    // The server's pick, unless an audio-description track has a plain twin (or the reverse, per Réglages).
    fun defaultAudioStream(s: MediaSource): MediaStream? {
        val audio = s.mediaStreams.filter { it.type == "Audio" }
        val d = audio.firstOrNull { it.index == s.defaultAudioStreamIndex } ?: audio.firstOrNull { it.isDefault } ?: audio.firstOrNull() ?: return null
        val i = TrackMemory.accessible(s.mediaStreams, d.index, Core.preferSdh, Core.audioDescription)
        return audio.firstOrNull { it.index == i }
    }

    // -1 = off. The server's pick already applies the user's language, subtitle mode and forced
    // rules, and it is what PlaybackInfo plays; only "Préférer les sous-titres SDH" swaps it for its SDH twin.
    fun defaultSubtitleIndex(s: MediaSource): Int =
        s.defaultSubtitleStreamIndex?.takeIf { d -> s.mediaStreams.any { it.type == "Subtitle" && it.index == d } }
            ?.let { TrackMemory.accessible(s.mediaStreams, it, Core.preferSdh, Core.audioDescription) } ?: -1

    // ---- The choice, remembered per item.

    private val sp by lazy { Core.app.getSharedPreferences("wicaby_versions", Context.MODE_PRIVATE) }

    // The version picked for this item, else the one picked in the player for its series (X-02), else the server's default.
    fun selected(item: Item): MediaSource? {
        val list = item.mediaSources
        if (list.size <= 1) return list.firstOrNull()
        val id = runCatching { sp.getString(item.id, null) }.getOrNull()
        val sig = item.seriesId?.let { s -> runCatching { series.getString(s, null) }.getOrNull()?.substringBefore('|') }
        return list.firstOrNull { it.id == id } ?: sig?.let { s -> list.firstOrNull { signature(it) == s } } ?: list.first()
    }

    fun select(itemId: String, sourceId: String) {
        runCatching { sp.edit().putString(itemId, sourceId).apply() }
    }

    // ---- X-02: the version picked in the player, remembered per series by its signature
    // ("2160p hevc dv": height class, codec, dynamic range; matching only, the sheet shows labels());
    // the 300 most recent series.

    private val series by lazy { Core.app.getSharedPreferences("wicaby_series_versions", Context.MODE_PRIVATE) }

    private fun hdrKind(v: MediaStream?): String = when (VideoRange.of(v).primary) {
        VideoRange.DV -> "dv"
        "HDR10+" -> "hdr10+"
        "HLG" -> "hlg"
        null -> "sdr"
        else -> "hdr10"
    }

    private fun video(s: MediaSource) = s.mediaStreams.firstOrNull { it.type == "Video" }

    fun signature(s: MediaSource): String = video(s).let { v -> Quality.signature(v?.width, v?.height, v?.codec, hdrKind(v)) }

    fun rememberForSeries(seriesId: String, s: MediaSource) {
        runCatching {
            // "signature|epoch ms": the oldest entries go first past 300 series.
            val e = series.edit().putString(seriesId, signature(s) + "|" + System.currentTimeMillis())
            val all = series.all
            if (all.size >= 300) {
                all.entries.filter { it.key != seriesId }.sortedBy { (it.value as? String)?.substringAfter('|')?.toLongOrNull() ?: 0L }
                    .take(all.size - 299).forEach { e.remove(it.key) }
            }
            e.apply()
        }
    }

    // ---- Audio / subtitle picked on the detail page, handed to the next PlaybackInfo.

    class TrackPick(val audio: Int?, val subtitle: Int?)

    private val picks = ConcurrentHashMap<String, TrackPick>()

    fun pick(itemId: String, sourceId: String?): TrackPick? = picks["$itemId|$sourceId"]

    fun setPick(itemId: String, sourceId: String?, audio: Int?, subtitle: Int?) {
        picks["$itemId|$sourceId"] = TrackPick(audio, subtitle)
    }
}
