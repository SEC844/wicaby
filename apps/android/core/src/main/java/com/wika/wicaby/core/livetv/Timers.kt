package com.wika.wicaby.core.livetv

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Live TV recordings logic (spec §6.7, §9.1–§9.3, §7.1): timer status mapping, the timer overlay,
// the recording marks, record-option presence and DVR error mapping. Mirrors
// D/shared/livetv/timers.ts (golden vectors: timers.json).

/**
 * Server RecordingStatus → ours. null = not shown (Cancelled tombstones; Completed rows, which only
 * Emby returns: they are dropped on both servers).
 */
fun mapTimerStatus(status: String?): TimerStatus? = when (status) {
    "Cancelled", "Completed" -> null
    "InProgress" -> TimerStatus.RECORDING
    "ConflictedOk" -> TimerStatus.CONFLICT_OK
    "ConflictedNotOk" -> TimerStatus.CONFLICT_WONT
    "Error" -> TimerStatus.ERROR
    else -> TimerStatus.SCHEDULED // New, Scheduled, or missing
}

private fun num(v: JsonElement?): Long = v.jsNumber()?.toLong() ?: 0L

fun normalizeTimer(dto: JsonObject): TimerLite? {
    val id = dto.str("Id") ?: return null
    val status = mapTimerStatus(dto["Status"].jsString()) ?: return null
    val start = parseServerDate(dto["StartDate"]) ?: return null
    val end = parseServerDate(dto["EndDate"]) ?: return null
    return TimerLite(
        id = id,
        programId = dto.str("ProgramId"),
        channelId = dto.str("ChannelId"),
        seriesTimerId = dto.str("SeriesTimerId"),
        start = start,
        end = end,
        name = dto["Name"].jsString() ?: "",
        status = status,
        prePaddingS = num(dto["PrePaddingSeconds"]),
        postPaddingS = num(dto["PostPaddingSeconds"]),
    )
}

/** The timers list, normalised and sorted by start (then id). */
fun normalizeTimers(items: List<JsonObject>): List<TimerLite> =
    items.mapNotNull(::normalizeTimer).sortedWith(compareBy<TimerLite> { it.start }.thenBy { it.id })

private fun statusRank(s: TimerStatus): Int = when (s) {
    TimerStatus.RECORDING -> 0
    TimerStatus.SCHEDULED -> 1
    TimerStatus.CONFLICT_OK -> 2
    TimerStatus.CONFLICT_WONT -> 3
    TimerStatus.ERROR -> 4
}

/** programId → timer; when two timers name the same programme, the stronger status wins. */
fun buildOverlay(timers: List<TimerLite>): Map<String, TimerLite> {
    val m = LinkedHashMap<String, TimerLite>()
    for (t in timers) {
        val pid = t.programId ?: continue
        val prev = m[pid]
        if (prev == null || statusRank(t.status) < statusRank(prev.status)) m[pid] = t
    }
    return m
}

@Serializable
enum class Mark {
    @SerialName("timer") TIMER,
    @SerialName("series") SERIES,
    @SerialName("recording") RECORDING,
    @SerialName("conflict-wont") CONFLICT_WONT,
    @SerialName("conflict-ok") CONFLICT_OK,
    @SerialName("error") ERROR,
    @SerialName("rule-skip") RULE_SKIP,
}

/** §6.7. The overlay wins once loaded (null = not loaded yet: the programme payload is used). */
fun markFor(programId: String, timerId: String?, seriesTimerId: String?, overlay: Map<String, TimerLite>?): Mark? {
    val hasRule = !seriesTimerId.isNullOrEmpty()
    if (overlay == null) {
        if (!timerId.isNullOrEmpty()) return if (hasRule) Mark.SERIES else Mark.TIMER
        return if (hasRule) Mark.RULE_SKIP else null
    }
    val t = overlay[programId] ?: return if (hasRule) Mark.RULE_SKIP else null
    return when (t.status) {
        TimerStatus.RECORDING -> Mark.RECORDING
        TimerStatus.CONFLICT_WONT -> Mark.CONFLICT_WONT
        TimerStatus.CONFLICT_OK -> Mark.CONFLICT_OK
        TimerStatus.ERROR -> Mark.ERROR
        TimerStatus.SCHEDULED -> if (t.seriesTimerId != null) Mark.SERIES else Mark.TIMER
    }
}

fun markFor(p: ProgramLite, overlay: Map<String, TimerLite>?): Mark? = markFor(p.id, p.timerId, p.seriesTimerId, overlay)

/** The Programmés badge: timers that will not record. */
fun conflictCount(timers: List<TimerLite>): Int = timers.count { it.status == TimerStatus.CONFLICT_WONT }

// ---- Record options (§9.2): a field absent from the defaults object is not shown ----

@Serializable
enum class RecordMode {
    @SerialName("single") SINGLE,
    @SerialName("series") SERIES,
}

class OptionField(val id: String, val field: String, val modes: Set<RecordMode>)

private val BOTH = setOf(RecordMode.SINGLE, RecordMode.SERIES)
private val SERIES_ONLY = setOf(RecordMode.SERIES)

val OPTION_FIELDS: List<OptionField> = listOf(
    OptionField("startEarly", "PrePaddingSeconds", BOTH),
    OptionField("endLate", "PostPaddingSeconds", BOTH),
    OptionField("newOnly", "RecordNewOnly", SERIES_ONLY),
    OptionField("anyChannel", "RecordAnyChannel", SERIES_ONLY),
    OptionField("anyTime", "RecordAnyTime", SERIES_ONLY),
    OptionField("days", "Days", SERIES_ONLY),
    OptionField("skipInLibrary", "SkipEpisodesInLibrary", SERIES_ONLY),
    OptionField("keepUpTo", "KeepUpTo", SERIES_ONLY),
    OptionField("keepUntil", "KeepUntil", BOTH),
    OptionField("maxLength", "MaxRecordingSeconds", SERIES_ONLY),
    OptionField("folder", "ParentFolderId", BOTH),
)

val PADDING_CHOICES_MIN: List<Int> = listOf(0, 1, 2, 5, 10, 15, 30, 60)
val KEEP_UP_TO_CHOICES: List<Int> = listOf(0, 1, 2, 3, 5, 10, 20)

fun visibleOptions(defaults: JsonObject?, mode: RecordMode): List<String> {
    if (defaults == null) return emptyList()
    return OPTION_FIELDS.filter { f -> mode in f.modes && defaults.containsKey(f.field) && defaults[f.field] !is JsonNull }.map { it.id }
}

/** POST body: the defaults object with only the changed fields applied (fields the server did not send are never added). */
fun applyOptions(defaults: JsonObject, changes: Map<String, JsonElement>): JsonObject {
    val out = LinkedHashMap<String, JsonElement>(defaults)
    for ((k, v) in changes) if (defaults.containsKey(k)) out[k] = v
    return JsonObject(out)
}

/** Quick record: the defaults unchanged, plus the synced lt.dvrPadding when set. */
fun quickRecordBody(defaults: JsonObject, padding: DvrPadding?): JsonObject {
    if (padding == null) return JsonObject(LinkedHashMap(defaults))
    return applyOptions(defaults, mapOf("PrePaddingSeconds" to jsonNumber(padding.pre), "PostPaddingSeconds" to jsonNumber(padding.post)))
}

/** A JSON number as JavaScript would write it (120.0 → 120). */
internal fun jsonNumber(d: Double): JsonPrimitive =
    if (d == kotlin.math.floor(d) && kotlin.math.abs(d) < 9.0e15) JsonPrimitive(d.toLong()) else JsonPrimitive(d)

// ---- Errors (§9.1, §9.7) ----

@Serializable
enum class DvrOp {
    @SerialName("createTimer") CREATE_TIMER,
    @SerialName("createSeriesTimer") CREATE_SERIES_TIMER,
    @SerialName("updateTimer") UPDATE_TIMER,
    @SerialName("updateSeriesTimer") UPDATE_SERIES_TIMER,
    @SerialName("cancelTimer") CANCEL_TIMER,
    @SerialName("deleteSeriesTimer") DELETE_SERIES_TIMER,
    @SerialName("deleteRecording") DELETE_RECORDING,
    @SerialName("timers") TIMERS,
    @SerialName("recordings") RECORDINGS,
}

@Serializable
enum class DvrError {
    @SerialName("already-scheduled") ALREADY_SCHEDULED,
    @SerialName("forbidden") FORBIDDEN,
    @SerialName("premiere") PREMIERE,
    @SerialName("not-series") NOT_SERIES,
    @SerialName("not-found") NOT_FOUND,
    @SerialName("server") SERVER,
}

private val PREMIERE_RE = Regex("premiere|licen[cs]e|supporter", RegexOption.IGNORE_CASE)

fun mapDvrError(kind: ServerKind, op: DvrOp, status: Int, message: String = ""): DvrError = when {
    status == 403 || status == 401 -> DvrError.FORBIDDEN
    status == 400 && (op == DvrOp.CREATE_TIMER || op == DvrOp.CREATE_SERIES_TIMER) -> DvrError.ALREADY_SCHEDULED
    status == 404 -> DvrError.NOT_FOUND
    status >= 500 && kind == ServerKind.EMBY && PREMIERE_RE.containsMatchIn(message) -> DvrError.PREMIERE
    status >= 500 && op == DvrOp.CREATE_SERIES_TIMER -> DvrError.NOT_SERIES
    else -> DvrError.SERVER
}

/** After a 403 on any DVR route the record actions are hidden for the session. */
fun canRecordAfter(canRecord: Boolean, err: DvrError): Boolean = if (err == DvrError.FORBIDDEN) false else canRecord
