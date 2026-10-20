package com.wika.wicaby.core.player

import android.content.Context
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.MediaStream
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

// X-05: the audio and subtitle picked by hand during an episode, replayed on the rest of the series.
// The same rules and JSON as the desktop's track-selection.ts (golden vectors in
// CK/fixtures/track/track-fixtures.json, TrackMemoryTest.kt). Nothing matching: the server default.
object TrackMemory {
    // ordinal: position among the tracks of that type, -1 when unknown (old desktop files).
    data class Intent(
        val language: String,
        val codec: String? = null,
        val channels: Int? = null,
        val title: String? = null,
        val forced: Boolean = false,
        val sdh: Boolean = false,
        val ordinal: Int = -1,
        // isCommentary of the picked track; null in older entries: the title decides.
        val commentary: Boolean? = null,
    ) {
        // An old language-only entry (migrated): no ordinal, codec or title was recorded.
        val legacy get() = ordinal < 0 && codec.isNullOrEmpty()
    }

    // subtitleOff: subtitles turned off (subtitle is then null).
    data class Choice(val audio: Intent? = null, val subtitle: Intent? = null, val subtitleOff: Boolean = false, val at: Long = 0)

    // ---- Pure (unit-tested on the JVM).

    private val aliases = mapOf(
        "fr" to "fre", "fra" to "fre", "en" to "eng", "de" to "ger", "deu" to "ger", "es" to "spa", "it" to "ita", "ja" to "jpn", "jp" to "jpn",
        "pt" to "por", "nl" to "dut", "nld" to "dut", "zh" to "chi", "zho" to "chi", "ko" to "kor", "ru" to "rus", "pl" to "pol", "sv" to "swe",
        "da" to "dan", "no" to "nor", "nb" to "nor", "nob" to "nor", "fi" to "fin", "ar" to "ara", "cs" to "cze", "ces" to "cze", "el" to "gre",
        "ell" to "gre", "he" to "heb", "hu" to "hun", "tr" to "tur",
    )
    private val unknown = setOf("", "und", "unk", "mis", "mul", "zxx")

    fun normLang(lang: String?): String {
        val v = lang.orEmpty().trim().lowercase().split('-', '_')[0]
        val n = aliases[v] ?: v
        return if (n in unknown) "" else n
    }

    // Unknown never matches, not even another unknown.
    fun sameLang(a: String?, b: String?): Boolean = normLang(a).let { it.isNotEmpty() && it == normLang(b) }

    private fun words(s: MediaStream) = "${s.title.orEmpty()} ${s.displayTitle.orEmpty()}".lowercase()
    private val forcedRe = Regex("""\bforced\b|\bforcé""")
    fun isForced(s: MediaStream): Boolean = s.isForced || forcedRe.containsMatchIn(words(s))
    fun isCommentary(s: MediaStream): Boolean = words(s).contains("comment")
    private val sdhRe = Regex("""\bsdh\b|\bcc\b|malentendant|hearing""")
    fun isSdh(s: MediaStream): Boolean = s.isHearingImpaired || sdhRe.containsMatchIn(words(s))
    private val adRe = Regex("""\bad\b|audio[ -]?description|description audio|\bdvs\b""")
    // Audio description.
    fun isAd(s: MediaStream): Boolean = s.isVisualImpaired || adRe.containsMatchIn(words(s))

    // The picker badge: "SDH" on a subtitle, "AD" on an audio track (one string in every language).
    fun badge(s: MediaStream): String? = when {
        s.type == "Subtitle" && isSdh(s) -> "SDH"
        s.type == "Audio" && isAd(s) -> "AD"
        else -> null
    }

    // The track's twin (same type, language, forced and commentary class) that fits the accessibility
    // preferences when the track itself does not; the track itself when there is none. [ad]: "avoid"
    // (an AD track gives way to a plain one), "prefer" or "any". As track-selection.ts accessible().
    fun accessible(streams: List<MediaStream>, index: Int, sdh: Boolean, ad: String): Int {
        val s = streams.firstOrNull { it.index == index && (it.type == "Audio" || it.type == "Subtitle") } ?: return index
        fun fits(x: MediaStream) = if (x.type == "Audio") ad == "any" || isAd(x) == (ad == "prefer") else !sdh || isSdh(x)
        if (fits(s)) return index
        return streams.firstOrNull {
            it.type == s.type && fits(it) && sameLang(it.language, s.language) && isForced(it) == isForced(s) && isCommentary(it) == isCommentary(s)
        }?.index ?: index
    }

    private val nonWord = Regex("""[^\p{L}\p{N}]+""")
    private fun normTitle(t: String?) = t.orEmpty().lowercase().replace(nonWord, " ").trim()

    // Language +10 (+1 exact tag), codec +5, channels +3, title +2 (two untitled tracks are equal too,
    // except for a legacy entry), forced class +2, SDH class +2 (subtitles), same ordinal +1.
    fun score(s: MediaStream, intent: Intent, ordinal: Int): Int {
        if (!sameLang(s.language, intent.language)) return 0
        var n = 10
        if (s.language.orEmpty().lowercase() == intent.language.lowercase()) n += 1
        if (!intent.codec.isNullOrEmpty() && s.codec.orEmpty().lowercase() == intent.codec.lowercase()) n += 5
        if ((intent.channels ?: 0) > 0 && s.channels == intent.channels) n += 3
        if (normTitle(s.title) == normTitle(intent.title) && (normTitle(intent.title).isNotEmpty() || !intent.legacy)) n += 2
        if (isForced(s) == intent.forced) n += 2
        if (s.type == "Subtitle" && isSdh(s) == intent.sdh) n += 2
        if (intent.ordinal >= 0 && ordinal == intent.ordinal) n += 1
        return n
    }

    // The best track of that type scoring 10 or more, lowest index on a tie (a legacy entry first prefers
    // the default track, as the old language-only pick did). The forced class must match, and a
    // commentary never stands in for the main track (or the reverse).
    fun match(streams: List<MediaStream>, type: String, intent: Intent): Int? {
        val commentary = intent.commentary ?: intent.title.orEmpty().lowercase().contains("comment")
        var best: Pair<Int, Int>? = null // index to score (doubled, +1 breaks a legacy tie)
        streams.filter { it.type == type }.forEachIndexed { ordinal, s ->
            if (isForced(s) != intent.forced || isCommentary(s) != commentary) return@forEachIndexed
            val base = score(s, intent, ordinal)
            val sc = base * 2 + if (intent.legacy && s.isDefault) 1 else 0
            val b = best
            if (base >= 10 && (b == null || sc > b.second || (sc == b.second && s.index < b.first))) best = s.index to sc
        }
        return best?.first
    }

    /** What the memory picks: audio index or null; subtitle index, -1 = off, null = no match. */
    fun pick(choice: Choice?, streams: List<MediaStream>): Pair<Int?, Int?> {
        if (choice == null) return null to null
        val audio = choice.audio?.let { match(streams, "Audio", it) }
        val subtitle = if (choice.subtitleOff) -1 else choice.subtitle?.let { match(streams, "Subtitle", it) }
        return audio to subtitle
    }

    // A manual pick; stream null = subtitles off. Untagged audio is not remembered.
    fun remember(prev: Choice?, kind: String, stream: MediaStream?, streams: List<MediaStream>, now: Long): Choice? {
        val base = prev ?: Choice()
        val ordinal = stream?.let { s -> streams.filter { it.type == s.type }.indexOfFirst { it.index == s.index } } ?: -1
        fun intent(s: MediaStream, forced: Boolean, sdh: Boolean, channels: Int?) =
            Intent(s.language.orEmpty(), s.codec?.lowercase()?.ifEmpty { null }, channels?.takeIf { it > 0 }, s.title?.ifEmpty { null }, forced, sdh, ordinal, isCommentary(s))
        return if (kind == "audio") {
            if (stream == null || normLang(stream.language).isEmpty()) return null
            base.copy(audio = intent(stream, false, false, stream.channels), at = now)
        } else {
            base.copy(subtitle = stream?.let { intent(it, isForced(it), isSdh(it), null) }, subtitleOff = stream == null, at = now)
        }
    }

    // The desktop's JSON: audio was a bare language and subtitle { language, forced } in old files.
    fun parse(e: JsonElement?): Choice? {
        val o = e as? JsonObject ?: return null
        fun str(v: JsonElement?) = (v as? JsonPrimitive)?.takeIf { it.isString }?.content
        fun intent(v: JsonElement?, audio: Boolean): Intent? {
            val i = v as? JsonObject ?: return null
            val lang = str(i["language"]) ?: return null
            return Intent(
                lang, str(i["codec"]), (i["channels"] as? JsonPrimitive)?.intOrNull, str(i["title"]),
                if (audio) false else (i["forced"] as? JsonPrimitive)?.booleanOrNull == true,
                (i["sdh"] as? JsonPrimitive)?.booleanOrNull == true, (i["ordinal"] as? JsonPrimitive)?.intOrNull ?: -1,
                (i["commentary"] as? JsonPrimitive)?.booleanOrNull,
            )
        }
        val a = o["audio"]
        val s = o["subtitle"]
        return Choice(
            audio = str(a)?.let { Intent(it) } ?: intent(a, true),
            subtitle = intent(s, false),
            subtitleOff = s is JsonNull,
            at = (o["at"] as? JsonPrimitive)?.longOrNull ?: 0,
        )
    }

    fun encode(c: Choice): JsonObject = buildJsonObject {
        fun obj(i: Intent, audio: Boolean) = buildJsonObject {
            put("language", i.language)
            i.codec?.let { put("codec", it) }
            if (audio) i.channels?.let { put("channels", it) }
            i.title?.let { put("title", it) }
            put("forced", i.forced)
            if (!audio) put("sdh", i.sdh)
            put("ordinal", i.ordinal)
            i.commentary?.let { put("commentary", it) }
        }
        c.audio?.let { put("audio", obj(it, true)) }
        if (c.subtitleOff) put("subtitle", JsonNull) else c.subtitle?.let { put("subtitle", obj(it, false)) }
        put("at", c.at)
    }

    // ---- Store: one entry per series, the 300 most recent.

    private const val CAP = 300
    private val sp by lazy { Core.app.getSharedPreferences("wicaby_track_memory", Context.MODE_PRIVATE) }

    fun get(seriesId: String): Choice? = runCatching { sp.getString(seriesId, null)?.let { parse(com.wika.wicaby.core.data.json.parseToJsonElement(it)) } }.getOrNull()

    fun record(seriesId: String, kind: String, stream: MediaStream?, streams: List<MediaStream>) {
        runCatching {
            val next = remember(get(seriesId), kind, stream, streams, System.currentTimeMillis()) ?: return
            val e = sp.edit().putString(seriesId, encode(next).toString())
            val all = sp.all
            if (all.size >= CAP) {
                all.keys.filter { it != seriesId }
                    .sortedBy { k -> runCatching { get(k)?.at }.getOrNull() ?: 0L }
                    .take(all.size - CAP + 1).forEach { e.remove(it) }
            }
            e.apply()
        }
    }
}
