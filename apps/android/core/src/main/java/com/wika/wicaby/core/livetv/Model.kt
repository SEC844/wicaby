package com.wika.wicaby.core.livetv

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonClassDiscriminator
import java.math.BigDecimal

// Live TV shared model (spec §4.3, §4.4, §21.4): types, PF flag bits, capabilities, and the
// normalisation of Emby / Jellyfin DTOs into lean rows. Mirrors D/shared/livetv/model.ts field for
// field (golden vectors: tools/checks/fixtures/livetv/normalize.json, replayed by LiveTvParityTest).
// Pure Kotlin, minSdk 23: no java-time, no android-icu (grep gate in LiveTvParityTest).
// DeviceClass, PlatformTuning and DeviceFacts live in DeviceClass.kt (C-5).

@Serializable
enum class ServerKind {
    @SerialName("emby") EMBY,
    @SerialName("jellyfin") JELLYFIN,
}

/** Programme flag bits (PF). */
object PF {
    const val LIVE = 1
    const val NEW = 2
    const val PREMIERE = 4
    const val REPEAT = 8
    const val HD = 16
    const val MOVIE = 32
    const val SPORTS = 64
    const val NEWS = 128
    const val KIDS = 256
    const val SERIES = 512

    /** The bits by their model.ts names (Live, New, …), in bit order. */
    val byName: Map<String, Int> = linkedMapOf(
        "Live" to LIVE, "New" to NEW, "Premiere" to PREMIERE, "Repeat" to REPEAT, "HD" to HD,
        "Movie" to MOVIE, "Sports" to SPORTS, "News" to NEWS, "Kids" to KIDS, "Series" to SERIES,
    )
}

/** A channel number key: '5.1' → (5, 1), '105' → (105, -1). Serialised as `[major, minor]`. */
@Serializable(with = NumKeySerializer::class)
data class NumKey(val major: Long, val minor: Long)

@OptIn(ExperimentalSerializationApi::class)
internal object NumKeySerializer : KSerializer<NumKey> {
    private val delegate = ListSerializer(Long.serializer())
    override val descriptor: SerialDescriptor = SerialDescriptor("com.wika.wicaby.core.livetv.NumKey", delegate.descriptor)
    override fun serialize(encoder: Encoder, value: NumKey) = delegate.serialize(encoder, listOf(value.major, value.minor))
    override fun deserialize(decoder: Decoder): NumKey = delegate.deserialize(decoder).let { NumKey(it[0], it[1]) }
}

@Serializable
data class ChannelRow(
    val id: String,
    val serverId: String,
    /** As sent ('' when absent). */
    val number: String,
    /** '5.1' → [5,1], '105' → [105,-1], '' → null. */
    val numKey: NumKey?,
    val name: String,
    val logoTag: String? = null,
    val favorite: Boolean,
    val tags: List<String>,
    val radio: Boolean,
    /** Position in the server answer (server order). */
    val serverIndex: Int,
    /** UserData.LastPlayedDate, seeds Récentes. */
    val lastPlayed: Long? = null,
)

@Serializable
data class ProgramLite(
    val id: String,
    val channelId: String,
    /** Epoch ms. */
    val start: Long,
    val end: Long,
    val title: String,
    val episodeTitle: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    /** PF bits. */
    val flags: Int,
    val rating: String? = null,
    val seriesId: String? = null,
    /** Payload values, used only before the timer overlay loads. */
    val timerId: String? = null,
    val seriesTimerId: String? = null,
    /** Only when the fetch asked for images. */
    val imageTag: String? = null,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed interface LensRef {
    @Serializable @SerialName("all") data object All : LensRef
    @Serializable @SerialName("favorites") data object Favorites : LensRef
    @Serializable @SerialName("recents") data object Recents : LensRef
    @Serializable @SerialName("radio") data object Radio : LensRef
    @Serializable @SerialName("tag") data class Tag(val tag: String) : LensRef
    @Serializable @SerialName("group") data class Group(val id: String) : LensRef
}

@Serializable
enum class Category(val id: String) {
    @SerialName("movies") MOVIES("movies"),
    @SerialName("sports") SPORTS("sports"),
    @SerialName("news") NEWS("news"),
    @SerialName("kids") KIDS("kids"),
    @SerialName("series") SERIES("series"),
    @SerialName("new") NEW("new"),
    ;

    companion object {
        fun fromId(id: String?): Category? = entries.firstOrNull { it.id == id }
    }
}

@Serializable
enum class TimerStatus {
    @SerialName("scheduled") SCHEDULED,
    @SerialName("recording") RECORDING,
    @SerialName("conflict-ok") CONFLICT_OK,
    @SerialName("conflict-wont") CONFLICT_WONT,
    @SerialName("error") ERROR,
}

@Serializable
data class TimerLite(
    val id: String,
    val programId: String? = null,
    val channelId: String? = null,
    val seriesTimerId: String? = null,
    val start: Long,
    val end: Long,
    val name: String,
    val status: TimerStatus,
    val prePaddingS: Long,
    val postPaddingS: Long,
)

/** `boolean | 'unknown'` in model.ts: serialised as true, false or "unknown". */
@Serializable(with = TriSerializer::class)
enum class Tri { TRUE, FALSE, UNKNOWN }

internal object TriSerializer : KSerializer<Tri> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("com.wika.wicaby.core.livetv.Tri", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: Tri) {
        val e = when (value) {
            Tri.TRUE -> JsonPrimitive(true)
            Tri.FALSE -> JsonPrimitive(false)
            Tri.UNKNOWN -> JsonPrimitive("unknown")
        }
        if (encoder is JsonEncoder) encoder.encodeJsonElement(e) else encoder.encodeString(e.content)
    }
    override fun deserialize(decoder: Decoder): Tri {
        val raw = if (decoder is JsonDecoder) decoder.decodeJsonElement().let { (it as? JsonPrimitive)?.content } else decoder.decodeString()
        return when (raw) {
            "true" -> Tri.TRUE
            "false" -> Tri.FALSE
            else -> Tri.UNKNOWN
        }
    }
}

@Serializable
enum class CategorySource {
    @SerialName("flags") FLAGS,
    @SerialName("genres") GENRES,
    @SerialName("unknown") UNKNOWN,
}

@Serializable
enum class ProgramSearch {
    @SerialName("server") SERVER,
    @SerialName("items") ITEMS,
    @SerialName("memory") MEMORY,
}

@Serializable
enum class OnNowSource {
    @SerialName("recommended") RECOMMENDED,
    @SerialName("window") WINDOW,
}

@Serializable
data class LiveCaps(
    val kind: ServerKind,
    /** Policy.EnableLiveTvManagement, downgraded on 403. */
    val canRecord: Boolean,
    /** Emby /LiveTv/ChannelTags answered 200. */
    val channelTags: Boolean,
    /** §6.6 */
    val categorySource: CategorySource,
    /** §6.6 */
    val categoryFilterOnChannels: Tri,
    val programSearch: ProgramSearch,
    val recordingOptions: ServerKind,
    /** Services[].Tuners.length; hidden when 0. */
    val tunerCount: Int? = null,
    /** §5.1 V15 probe. */
    val onNowSource: OnNowSource,
    /** false on Jellyfin (no IsNew in BaseItemDto). */
    val newFlag: Boolean,
    /** §4.4 V16 probe. */
    val hdFlag: Tri,
    /** false after one 404/405 (Jellyfin 12.2). */
    val killEncodes: Boolean,
    /** §21.4, 0 unless |skew| > 2 min. */
    val clockSkewMs: Long,
)

/** What the player gets for its zap list. */
@Serializable
data class ZapEntry(val id: String, val number: String, val name: String, val logoTag: String? = null)

fun zapEntry(r: ChannelRow): ZapEntry = ZapEntry(r.id, r.number, r.name, r.logoTag)

/** Capabilities before any probe ran. */
fun defaultCaps(kind: ServerKind): LiveCaps = LiveCaps(
    kind = kind,
    canRecord = true,
    channelTags = false,
    categorySource = CategorySource.UNKNOWN,
    categoryFilterOnChannels = Tri.UNKNOWN,
    programSearch = if (kind == ServerKind.EMBY) ProgramSearch.SERVER else ProgramSearch.ITEMS,
    recordingOptions = kind,
    onNowSource = OnNowSource.RECOMMENDED,
    newFlag = kind == ServerKind.EMBY,
    hdFlag = if (kind == ServerKind.JELLYFIN) Tri.TRUE else Tri.UNKNOWN,
    killEncodes = true,
    clockSkewMs = 0,
)

// ---- Dates ----

private val DATE_RE = Regex(
    "^(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})(?::(\\d{2})(?:[.,](\\d+))?)?$JS_WS*(Z|[+-]\\d{2}(?::?\\d{2})?)?$",
    RegexOption.IGNORE_CASE,
)

/** Server dates: ISO 8601 with up to 7 fractional digits (.NET); no zone means UTC. Invalid → null. */
fun parseServerDate(s: String?): Long? {
    if (s == null) return null
    val m = DATE_RE.matchEntire(jsTrim(s)) ?: return null
    val g = m.groupValues
    val ms = if (g[7].isNotEmpty()) (g[7] + "00").substring(0, 3).toLong() else 0L
    var t = Civil.utc(g[1].toLong(), g[2].toLong() - 1, g[3].toLong(), g[4].toLong(), g[5].toLong(), if (g[6].isNotEmpty()) g[6].toLong() else 0L, ms)
    val z = g[8]
    if (z.isNotEmpty() && !z.equals("Z", ignoreCase = true)) {
        val sign = if (z[0] == '-') -1 else 1
        val digits = z.substring(1).replaceFirst(":", "")
        val off = digits.substring(0, 2).toLong() * 60 + (if (digits.length > 2) digits.substring(2, 4).toLong() else 0L)
        t -= sign * off * 60_000L
    }
    return t
}

/** typeof check of model.ts: only a JSON string is a date. */
fun parseServerDate(v: JsonElement?): Long? = v.jsString()?.let { parseServerDate(it) }

// ---- DTO normalisation (§4.4) ----

private val FLAG_FIELDS: List<Pair<String, Int>> = listOf(
    "IsLive" to PF.LIVE, "IsNew" to PF.NEW, "IsPremiere" to PF.PREMIERE, "IsRepeat" to PF.REPEAT, "IsHD" to PF.HD,
    "IsMovie" to PF.MOVIE, "IsSports" to PF.SPORTS, "IsNews" to PF.NEWS, "IsKids" to PF.KIDS, "IsSeries" to PF.SERIES,
)

/** Flags straight from the DTO. Missing means false; "New" is never inferred. */
fun flagsOf(dto: JsonObject, kind: ServerKind? = null): Int {
    var f = 0
    for ((field, bit) in FLAG_FIELDS) if (dto[field].isJsTrue()) f = f or bit
    if (kind == ServerKind.JELLYFIN) f = f and PF.NEW.inv() // Jellyfin BaseItemDto has no IsNew
    return f
}

fun normalizeChannel(dto: JsonObject, serverId: String, serverIndex: Int): ChannelRow? {
    val id = dto.str("Id") ?: return null
    val rawNumber = dto["ChannelNumber"]?.takeUnless { it is JsonNull } ?: dto["Number"]
    val number = rawNumber.jsString() ?: rawNumber.jsNumber()?.let { jsNumberString(it) } ?: ""
    val ud = dto.obj("UserData")
    val images = dto.obj("ImageTags")
    val tags = (dto["Tags"] as? JsonArray)?.mapNotNull { e -> e.jsString()?.takeIf { it.isNotEmpty() } } ?: emptyList()
    val type = dto.str("ChannelType") ?: dto.str("Type")
    return ChannelRow(
        id = id,
        serverId = serverId,
        number = number,
        numKey = parseChannelNumber(number),
        name = dto["Name"].jsString() ?: "",
        logoTag = images?.str("Primary"),
        favorite = ud?.get("IsFavorite").isJsTrue(),
        tags = tags,
        radio = type == "Radio",
        serverIndex = serverIndex,
        lastPlayed = parseServerDate(ud?.get("LastPlayedDate")),
    )
}

/** null when the DTO lacks an id, a channel or valid dates. */
fun normalizeProgram(dto: JsonObject, kind: ServerKind? = null, categorySource: CategorySource? = null): ProgramLite? {
    val id = dto.str("Id") ?: return null
    val channelId = dto.str("ChannelId") ?: return null
    val start = parseServerDate(dto["StartDate"]) ?: return null
    val end = parseServerDate(dto["EndDate"]) ?: return null
    var flags = flagsOf(dto, kind)
    val genres = dto["Genres"] as? JsonArray
    if (categorySource == CategorySource.GENRES && genres != null) flags = flags or genreFlags(genres.mapNotNull { it.jsString() })
    return ProgramLite(
        id = id,
        channelId = channelId,
        start = start,
        end = end,
        title = dto["Name"].jsString() ?: "",
        episodeTitle = dto.str("EpisodeTitle"),
        season = dto["ParentIndexNumber"].jsInt(),
        episode = dto["IndexNumber"].jsInt(),
        flags = flags,
        rating = dto.str("OfficialRating"),
        seriesId = dto.str("SeriesId"),
        timerId = dto.str("TimerId"),
        seriesTimerId = dto.str("SeriesTimerId"),
        imageTag = dto.obj("ImageTags")?.str("Primary"),
    )
}

// ---- Probes on raw answers (§4.4 V16, §5.1 V15) ----

/** V16: false when none of the programmes of the first tiles carries an IsHD key at all. */
fun hdProbe(rawPrograms: List<JsonObject>): Boolean = rawPrograms.any { it.containsKey("IsHD") }

/** V15: the server ignored IsAiring when an item is not airing at [now]. */
fun onNowProbe(rawItems: List<JsonObject>, now: Long): OnNowSource {
    for (it in rawItems) {
        val s = parseServerDate(it["StartDate"])
        val e = parseServerDate(it["EndDate"])
        // An unparsable date compares false both ways (NaN in model.ts).
        if ((s != null && s > now) || (e != null && e <= now)) return OnNowSource.WINDOW
    }
    return OnNowSource.RECOMMENDED
}

// ---- Clock skew (§21.4) ----

@Serializable
data class SkewState(
    /** Answers in a row with |skew| > threshold. */
    val streak: Int = 0,
    /** Current caps.clockSkewMs. */
    val skewMs: Long = 0,
)

const val SKEW_THRESHOLD_MS = 120_000L
const val SKEW_STREAK = 3

/** Feed one answer's Date header (ms; null when absent or unparsable) with the client time it arrived at. */
fun nextSkew(state: SkewState, serverMs: Long?, clientMs: Long): SkewState {
    if (serverMs == null) return state
    val skew = serverMs - clientMs
    if (kotlin.math.abs(skew) <= SKEW_THRESHOLD_MS) return SkewState(0, 0)
    val streak = state.streak + 1
    return SkewState(streak, if (streak >= SKEW_STREAK) skew else state.skewMs)
}

// ---- JavaScript parity helpers (shared by the livetv files) ----

/** JavaScript's `\s` (and String.prototype.trim) as a regex character class. Java's `\s` is ASCII only. */
internal const val JS_WS = "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"

private fun isJsSpace(c: Char): Boolean = when (c.code) {
    0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF -> true
    else -> c.code in 0x2000..0x200A
}

/** String.prototype.trim. */
internal fun jsTrim(s: String): String = s.trim(::isJsSpace)

/** String(number) for the values a server sends (integers, plain decimals). */
internal fun jsNumberString(d: Double): String {
    if (d.isNaN()) return "NaN"
    if (d.isInfinite()) return if (d > 0) "Infinity" else "-Infinity"
    if (d == 0.0) return "0"
    val a = kotlin.math.abs(d)
    if (a >= 1e-7 && a < 1e21) return BigDecimal(d.toString()).stripTrailingZeros().toPlainString()
    return d.toString().replace("E", "e").replace(Regex("e(\\d)"), "e+$1").replace(".0e", "e")
}

/** JSON.stringify of a JSON value: compact, JavaScript number and string escaping. */
internal fun jsStringify(e: JsonElement): String = StringBuilder().also { appendJs(it, e) }.toString()

private fun appendJs(sb: StringBuilder, e: JsonElement) {
    when (e) {
        is JsonNull -> sb.append("null")
        is JsonPrimitive -> when {
            e.isString -> appendJsString(sb, e.content)
            e.content == "true" || e.content == "false" -> sb.append(e.content)
            else -> sb.append(e.content.toDoubleOrNull()?.let { if (it.isFinite()) jsNumberString(it) else "null" } ?: "null")
        }
        is JsonArray -> {
            sb.append('[')
            e.forEachIndexed { i, x -> if (i > 0) sb.append(','); appendJs(sb, x) }
            sb.append(']')
        }
        is JsonObject -> {
            sb.append('{')
            var first = true
            for ((k, v) in e) {
                if (!first) sb.append(',')
                first = false
                appendJsString(sb, k)
                sb.append(':')
                appendJs(sb, v)
            }
            sb.append('}')
        }
    }
}

private fun appendJsString(sb: StringBuilder, s: String) {
    sb.append('"')
    var i = 0
    while (i < s.length) {
        val c = s[i]
        when {
            c == '"' -> sb.append("\\\"")
            c == '\\' -> sb.append("\\\\")
            c == '\b' -> sb.append("\\b")
            c == '\u000C' -> sb.append("\\f")
            c == '\n' -> sb.append("\\n")
            c == '\r' -> sb.append("\\r")
            c == '\t' -> sb.append("\\t")
            c < ' ' -> sb.append("\\u").append(c.code.toString(16).padStart(4, '0'))
            Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> {
                sb.append(c).append(s[i + 1])
                i++
            }
            Character.isSurrogate(c) -> sb.append("\\u").append(c.code.toString(16).padStart(4, '0')) // lone surrogate
            else -> sb.append(c)
        }
        i++
    }
    sb.append('"')
}

/** The Json the livetv files use for their own documents (lens and group values in prefs). */
internal val LiveJson = Json {
    encodeDefaults = true
    ignoreUnknownKeys = true
}

// typeof checks on DTO values.
internal fun JsonElement?.jsString(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
internal fun JsonElement?.jsNumber(): Double? =
    (this as? JsonPrimitive)?.takeIf { !it.isString && it !is JsonNull }?.content?.toDoubleOrNull()?.takeIf { it.isFinite() }
internal fun JsonElement?.jsInt(): Int? = jsNumber()?.takeIf { it == kotlin.math.floor(it) && kotlin.math.abs(it) <= Int.MAX_VALUE }?.toInt()
internal fun JsonElement?.isJsTrue(): Boolean = (this as? JsonPrimitive)?.let { !it.isString && it !is JsonNull && it.content == "true" } == true

/** A non-empty string field. */
internal fun JsonObject.str(key: String): String? = this[key].jsString()?.takeIf { it.isNotEmpty() }
internal fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

/** Proleptic Gregorian civil-date arithmetic (what Date.UTC does), no zone involved. */
internal object Civil {
    const val DAY_MS = 86_400_000L

    fun daysFromCivil(y0: Long, m: Int, d: Int): Long {
        val y = if (m <= 2) y0 - 1 else y0
        val era = Math.floorDiv(y, 400L)
        val yoe = y - era * 400
        val mp = (m + 9) % 12
        val doy = (153L * mp + 2) / 5 + d - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    /** (year, month 1–12, day 1–31) of a day number. */
    fun civilFromDays(z0: Long): Triple<Long, Int, Int> {
        val z = z0 + 719_468
        val era = Math.floorDiv(z, 146_097L)
        val doe = z - era * 146_097
        val yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
        val doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        val mp = (5 * doy + 2) / 153
        val d = (doy - (153 * mp + 2) / 5 + 1).toInt()
        val m = (if (mp < 10) mp + 3 else mp - 9).toInt()
        return Triple(yoe + era * 400 + (if (m <= 2) 1 else 0), m, d)
    }

    /** Date.UTC(year, month0, day, h, min, s, ms): months and days overflow into the next unit; years 0–99 are 19xx. */
    fun utc(year: Long, month0: Long, day: Long, h: Long, min: Long, s: Long, ms: Long): Long {
        val y = if (year in 0..99) 1900 + year else year
        val ym = y + Math.floorDiv(month0, 12L)
        val mn = Math.floorMod(month0, 12L).toInt()
        val days = daysFromCivil(ym, mn + 1, 1) + day - 1
        return days * DAY_MS + h * 3_600_000L + min * 60_000L + s * 1_000L + ms
    }

    /** Date.prototype.toISOString. */
    fun isoUtc(t: Long): String {
        val days = Math.floorDiv(t, DAY_MS)
        val msOfDay = Math.floorMod(t, DAY_MS)
        val (y, m, d) = civilFromDays(days)
        return String.format(
            java.util.Locale.ROOT, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
            y, m, d, msOfDay / 3_600_000, msOfDay / 60_000 % 60, msOfDay / 1_000 % 60, msOfDay % 1_000,
        )
    }
}
