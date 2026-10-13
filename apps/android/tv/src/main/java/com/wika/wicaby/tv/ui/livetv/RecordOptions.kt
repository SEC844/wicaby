package com.wika.wicaby.tv.ui.livetv

import android.content.Context
import android.view.KeyEvent as AndroidKey
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.livetv.DvrError
import com.wika.wicaby.core.livetv.DvrOp
import com.wika.wicaby.core.livetv.DvrPadding
import com.wika.wicaby.core.livetv.Dialect
import com.wika.wicaby.core.livetv.KEEP_UP_TO_CHOICES
import com.wika.wicaby.core.livetv.LiveApiException
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.PADDING_CHOICES_MIN
import com.wika.wicaby.core.livetv.PF
import com.wika.wicaby.core.livetv.PrefField
import com.wika.wicaby.core.livetv.ProgramLite
import com.wika.wicaby.core.livetv.RecordMode
import com.wika.wicaby.core.livetv.Req
import com.wika.wicaby.core.livetv.ServerKind
import com.wika.wicaby.core.livetv.applyOptions
import com.wika.wicaby.core.livetv.encodeUriComponent
import com.wika.wicaby.core.livetv.mapDvrError
import com.wika.wicaby.core.livetv.quickRecordBody
import com.wika.wicaby.core.livetv.visibleOptions
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.LocalOverlay
import com.wika.wicaby.tv.ui.OverlayHost
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.SheetButton
import com.wika.wicaby.tv.ui.Spinner
import com.wika.wicaby.tv.ui.TvSheet
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.tvFocus
import com.wika.wicaby.tv.ui.uiLocale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import java.text.DateFormatSymbols
import java.util.WeakHashMap

// Recording on TV (spec §9.1, §9.2, §9.7, §10.2, TV-4): the DVR calls on the repository's dialect
// executor (the timer overlay stays in LiveTvRepository; every write refetches it, never the guide),
// the record keys (MEDIA_RECORD / PROG_RED; a long press opens the options), and the options sheet.
// Capability by presence: a field absent from the object the server sent is not shown.

internal fun JsonObject.text(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
internal fun JsonObject.num(k: String): Long = (this[k] as? JsonPrimitive)?.doubleOrNull?.toLong() ?: 0L
internal fun JsonObject.flag(k: String): Boolean = (this[k] as? JsonPrimitive)?.booleanOrNull == true
private fun JsonElement?.items(): List<JsonObject> = ((this as? JsonObject)?.get("Items") as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()

/** A DVR failure, already mapped (§9.1). */
class DvrFailure(val code: DvrError, val status: Int, message: String) : Exception(message)

/** What the options sheet edits: a new recording from the server defaults, a timer's padding, or a series rule. */
sealed interface RecordTarget {
    data class New(val programId: String, val isSeries: Boolean, val series: Boolean = false) : RecordTarget
    data class Timer(val id: String) : RecordTarget
    data class Rule(val id: String) : RecordTarget
}

private val dvrs = WeakHashMap<LiveTvRepository, TvDvr>()

/** The DVR state of one repository (one server and user). */
fun dvrOf(repo: LiveTvRepository): TvDvr = synchronized(dvrs) { dvrs.getOrPut(repo) { TvDvr(repo) } }

/** Series rules, recordings and the policy read for one repository; main thread for the state. */
class TvDvr(val repo: LiveTvRepository) {
    private val live get() = repo.api
    private val kind get() = live.kind

    /** Series rules, highest priority first. */
    var rules by mutableStateOf<List<JsonObject>>(emptyList())
        private set

    /** null until the first load. */
    var recordings by mutableStateOf<List<JsonObject>?>(null)
        private set

    private var policyRead = false

    // Record actions must be hidden from the first frame of Live TV when the account cannot record (§9.7).
    init {
        Core.scope.launch(Dispatchers.Main) { quietly { readPolicy() } }
    }

    /** Policy.EnableLiveTvManagement = false hides every record action (§9.7); unknown stays allowed until a 403. */
    suspend fun readPolicy() {
        if (policyRead) return
        policyRead = true
        val user = try {
            live.json(Req("GET", "/Users/${encodeUriComponent(live.userId)}", emptyMap())) as? JsonObject
        } catch (e: LiveApiException) {
            policyRead = false
            return
        }
        val policy = user?.get("Policy") as? JsonObject
        if (policy?.get("EnableLiveTvManagement")?.let { (it as? JsonPrimitive)?.booleanOrNull } == false) repo.noteDvrError(DvrError.FORBIDDEN)
    }

    private suspend fun call(op: DvrOp, req: Req): JsonElement? = try {
        live.json(req)
    } catch (e: LiveApiException) {
        val code = mapDvrError(kind, op, e.status, e.message.orEmpty())
        repo.noteDvrError(code)
        throw DvrFailure(code, e.status, e.message.orEmpty())
    }

    /** The object the options sheet edits. */
    suspend fun read(t: RecordTarget): JsonObject = when (t) {
        is RecordTarget.New -> call(if (t.series) DvrOp.CREATE_SERIES_TIMER else DvrOp.CREATE_TIMER, Dialect.timerDefaults(kind, t.programId))
        is RecordTarget.Timer -> call(DvrOp.UPDATE_TIMER, Req("GET", "/LiveTv/Timers/${encodeUriComponent(t.id)}", emptyMap()))
        is RecordTarget.Rule -> call(DvrOp.UPDATE_SERIES_TIMER, Dialect.seriesTimer(kind, t.id))
    } as? JsonObject ?: JsonObject(emptyMap())

    /** Quick record: the defaults unchanged, plus the synced lt.dvrPadding. */
    suspend fun record(programId: String, series: Boolean) {
        val defaults = read(RecordTarget.New(programId, series, series))
        create(programId, series, quickRecordBody(defaults, repo.prefs.prefs.value.dvrPadding))
    }

    /** POST of a new timer or rule; the answer is empty (204), the new id comes from the overlay refetch. */
    suspend fun create(programId: String, series: Boolean, body: JsonObject) {
        val b = JsonObject(body + ("ProgramId" to JsonPrimitive(programId)))
        if (series) call(DvrOp.CREATE_SERIES_TIMER, Dialect.createSeriesTimer(kind, b)) else call(DvrOp.CREATE_TIMER, Dialect.createTimer(kind, b))
        repo.refreshTimers()
    }

    /** Cancels a one-off recording, or skips one episode of a rule. */
    suspend fun cancelTimer(id: String) {
        call(DvrOp.CANCEL_TIMER, Dialect.cancelTimer(kind, id))
        repo.refreshTimers()
    }

    suspend fun updateTimer(id: String, body: JsonObject) {
        call(DvrOp.UPDATE_TIMER, Dialect.updateTimer(kind, id, body))
        repo.refreshTimers()
    }

    /** Never a partial body (§9.4): GET the rule, merge, POST by id, re-GET. */
    suspend fun updateRule(id: String, changes: Map<String, JsonElement>, refresh: Boolean = true) {
        val current = call(DvrOp.UPDATE_SERIES_TIMER, Dialect.seriesTimer(kind, id)) as? JsonObject ?: JsonObject(emptyMap())
        call(DvrOp.UPDATE_SERIES_TIMER, Dialect.updateSeriesTimer(kind, id, JsonObject(current + changes + ("Id" to JsonPrimitive(id)))))
        val fresh = call(DvrOp.UPDATE_SERIES_TIMER, Dialect.seriesTimer(kind, id)) as? JsonObject
        if (fresh != null) rules = rules.map { if (it.text("Id") == id) fresh else it }.sortedByDescending { it.num("Priority") }
        if (refresh) repo.refreshTimers()
    }

    /** The server cascades to the rule's scheduled recordings. [before] runs before the row leaves the list (focus moves first). */
    suspend fun deleteRule(id: String, before: () -> Unit = {}) {
        call(DvrOp.DELETE_SERIES_TIMER, Dialect.deleteSeriesTimer(kind, id))
        before()
        rules = rules.filter { it.text("Id") != id }
        repo.refreshTimers()
    }

    suspend fun loadRules() {
        rules = call(DvrOp.TIMERS, Dialect.seriesTimers(kind)).items().sortedByDescending { it.num("Priority") }
    }

    /** One recordings call paged by 500 (§9.5); in-progress ones come with it (Status). */
    suspend fun loadRecordings() {
        val all = ArrayList<JsonObject>()
        while (true) {
            val page = call(DvrOp.RECORDINGS, Dialect.recordings(kind, live.userId, startIndex = all.size, limit = 500)).items()
            all += page
            if (page.size < 500) break
        }
        recordings = all
    }

    /** Jellyfin answers 404/405 on the Live TV route for some recordings: DELETE /Items/{id} then. */
    suspend fun deleteRecording(id: String) {
        try {
            call(DvrOp.DELETE_RECORDING, Dialect.deleteRecording(kind, id))
        } catch (e: DvrFailure) {
            if (kind != ServerKind.JELLYFIN || (e.status != 404 && e.status != 405)) throw e
            call(DvrOp.DELETE_RECORDING, Dialect.deleteItem(kind, id))
        }
        recordings = recordings?.filter { it.text("Id") != id }
    }
}

// ---- Feedback ----

internal fun toast(context: Context, text: String) = Toast.makeText(context, text, Toast.LENGTH_SHORT).show()

/** The user-facing text of a DVR failure (§9.1, §9.7): known cases translated, else the server message. */
internal fun dvrMessage(context: Context, e: Throwable): String {
    val res = when ((e as? DvrFailure)?.code) {
        DvrError.ALREADY_SCHEDULED -> R.string.livetv_toasts_already_scheduled
        DvrError.FORBIDDEN -> R.string.livetv_toasts_forbidden
        DvrError.PREMIERE -> R.string.livetv_toasts_premiere
        DvrError.NOT_SERIES -> R.string.livetv_toasts_not_series
        else -> null
    }
    return res?.let(context::getString) ?: e.message?.takeIf { it.isNotBlank() } ?: context.getString(R.string.load_error)
}

/** Runs a DVR call outside the composition (a sheet may close first); toasts [done] or the mapped error. */
internal fun dvrLaunch(context: Context, done: (() -> String)?, after: () -> Unit = {}, block: suspend () -> Unit): Job =
    Core.scope.launch(Dispatchers.Main) {
        try {
            block()
            done?.let { toast(context, it()) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            toast(context, dvrMessage(context, e))
        } finally {
            after()
        }
    }

fun showRecordOptions(overlay: OverlayHost, dvr: TvDvr, target: RecordTarget) = overlay.show { RecordOptionsSheet(dvr, target, onDismiss = overlay::close) }

/**
 * §10.2: MEDIA_RECORD or PROG_RED records [program] (quick record); a long press opens the options.
 * Nothing happens, and the key goes on, without record rights (§9.7) or without a programme.
 */
fun Modifier.recordKeys(dvr: TvDvr, program: () -> ProgramLite?): Modifier = composed {
    val context = LocalContext.current
    val overlay = LocalOverlay.current
    val caps by dvr.repo.caps.collectAsState()
    var long by remember { mutableStateOf(false) }
    val scheduled = stringResource(R.string.livetv_toasts_recording_scheduled)
    if (!caps.canRecord) return@composed this
    onKeyEvent { e ->
        val code = e.nativeKeyEvent.keyCode
        if (code != AndroidKey.KEYCODE_PROG_RED && code != AndroidKey.KEYCODE_MEDIA_RECORD) return@onKeyEvent false
        val p = program() ?: return@onKeyEvent false
        when (e.type) {
            KeyEventType.KeyDown -> if (e.nativeKeyEvent.repeatCount == 0) {
                long = false // the key-up of a long press went to the sheet
            } else if (!long) {
                long = true
                showRecordOptions(overlay, dvr, RecordTarget.New(p.id, p.flags and PF.SERIES != 0))
            }
            KeyEventType.KeyUp -> {
                if (!long) dvrLaunch(context, { scheduled }) { dvr.record(p.id, series = false) }
                long = false
            }
        }
        true
    }
}

// ---- Options sheet (§9.2) ----

private val DAYS = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
private class Preset(val label: Int, val pattern: String, val days: List<String>)
private val PRESETS = listOf(
    Preset(R.string.livetv_record_every_day, "Daily", DAYS),
    Preset(R.string.livetv_record_weekdays, "Weekdays", DAYS.subList(1, 6)),
    Preset(R.string.livetv_record_weekends, "Weekends", listOf(DAYS[6], DAYS[0])),
)
private val KEEP_UNTIL = listOf(
    "UntilDeleted" to R.string.livetv_record_keep_until_deleted,
    "UntilSpaceNeeded" to R.string.livetv_record_keep_until_space,
    "UntilWatched" to R.string.livetv_record_keep_until_watched,
)
private val TOGGLES = listOf(
    Triple("newOnly", "RecordNewOnly", R.string.livetv_record_new_only),
    Triple("anyChannel", "RecordAnyChannel", R.string.livetv_record_any_channel),
    Triple("anyTime", "RecordAnyTime", R.string.livetv_record_any_time),
    Triple("skipInLibrary", "SkipEpisodesInLibrary", R.string.livetv_record_skip_in_library),
)

/** The fixed choices plus the current value when the server uses another one. */
private fun withCurrent(choices: List<Int>, cur: Int): List<Int> = (choices + cur).distinct().sorted()
private fun <T> List<T>.step(cur: T, by: Int): T = this[((indexOf(cur).coerceAtLeast(0) + by) % size + size) % size]

@Composable
internal fun minutesText(m: Int): String =
    if (m == 0) stringResource(R.string.livetv_record_minutes_zero) else pluralStringResource(R.plurals.livetv_record_minutes, m, m)

@Composable
internal fun keepText(n: Int): String =
    if (n == 0) stringResource(R.string.livetv_record_keep_up_to_value_zero) else pluralStringResource(R.plurals.livetv_record_keep_up_to_value, n, n)

@Composable
fun RecordOptionsSheet(dvr: TvDvr, target: RecordTarget, onDismiss: () -> Unit) =
    TvSheet(onDismiss, width = 680.dp) { RecordOptionsContent(dvr, target, onDone = onDismiss) }

/** The options inside a sheet; [onDone] after a save, a cancel or a failed load. */
@Composable
internal fun ColumnScope.RecordOptionsContent(dvr: TvDvr, target: RecordTarget, onDone: () -> Unit) {
    val context = LocalContext.current
    var dto by remember { mutableStateOf<JsonObject?>(null) }
    val changes = remember { mutableStateMapOf<String, JsonElement>() }
    var mode by remember { mutableStateOf(if (target is RecordTarget.Rule || (target as? RecordTarget.New)?.series == true) RecordMode.SERIES else RecordMode.SINGLE) }
    var saveDefault by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val first = remember { FocusRequester() }
    LaunchedEffect(target) {
        try {
            dto = dvr.read(target)
            // A new recording starts from the synced padding, as the quick record does.
            val pad = dvr.repo.prefs.prefs.value.dvrPadding
            if (target is RecordTarget.New && pad != null) {
                changes["PrePaddingSeconds"] = JsonPrimitive(pad.pre.toLong())
                changes["PostPaddingSeconds"] = JsonPrimitive(pad.post.toLong())
            }
            delay(60)
            runCatching { first.requestFocus() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            toast(context, dvrMessage(context, e))
            onDone()
        }
    }
    fun value(field: String): JsonElement? = changes[field] ?: dto?.get(field)
    fun num(field: String): Long = (value(field) as? JsonPrimitive)?.doubleOrNull?.toLong() ?: 0L
    fun on(field: String): Boolean = (value(field) as? JsonPrimitive)?.booleanOrNull == true

    val title = if (target is RecordTarget.Rule) dto?.text("Name") ?: stringResource(R.string.livetv_record_title) else stringResource(R.string.livetv_record_title)
    Text(title, style = Type.title2, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 14.dp))
    val d = dto
    if (d == null) {
        Spinner(Modifier.size(28.dp).align(Alignment.CenterHorizontally))
        return
    }
    val shown = visibleOptions(d, mode)
    var firstSet = false
    fun firstMod(): Modifier = if (firstSet) Modifier else Modifier.focusRequester(first).also { firstSet = true }
    Column(Modifier.heightIn(max = 270.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (target is RecordTarget.New && target.isSeries) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(bottom = 6.dp)) {
                Pill(stringResource(R.string.livetv_record_this_episode), onClick = { mode = RecordMode.SINGLE }, selected = mode == RecordMode.SINGLE, icon = if (mode == RecordMode.SINGLE) Ic.Check else null, modifier = firstMod())
                Pill(stringResource(R.string.livetv_record_whole_series), onClick = { mode = RecordMode.SERIES }, selected = mode == RecordMode.SERIES, icon = if (mode == RecordMode.SERIES) Ic.Check else null)
            }
        }
        for ((id, field, label) in listOf(
            Triple("startEarly", "PrePaddingSeconds", R.string.livetv_record_start_early),
            Triple("endLate", "PostPaddingSeconds", R.string.livetv_record_end_late),
        )) {
            if (id !in shown) continue
            val cur = (num(field) / 60).toInt()
            val choices = withCurrent(PADDING_CHOICES_MIN, cur)
            ChoiceRow(stringResource(label), minutesText(cur), onStep = { by -> changes[field] = JsonPrimitive(choices.step(cur, by) * 60) }, modifier = firstMod())
        }
        for ((id, field, label) in TOGGLES) {
            if (id !in shown) continue
            SheetButton(stringResource(label), onClick = { changes[field] = JsonPrimitive(!on(field)) }, checked = on(field), centered = false, modifier = firstMod())
        }
        if ("days" in shown && !on("RecordAnyTime")) {
            val days = (value("Days") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }?.toSet().orEmpty()
            // No day listed means every day.
        val preset = if (days.isEmpty()) 0 else PRESETS.indexOfFirst { it.days.toSet() == days }
            val names = DateFormatSymbols.getInstance(uiLocale()).shortWeekdays // 1 = Sunday
            val text = if (preset >= 0) stringResource(PRESETS[preset].label) else DAYS.indices.filter { DAYS[it] in days }.joinToString(" ") { names[it + 1] }
            ChoiceRow(stringResource(R.string.livetv_record_days), text, onStep = { by ->
                val p = PRESETS[if (preset < 0) 0 else ((preset + by) % PRESETS.size + PRESETS.size) % PRESETS.size]
                changes["Days"] = JsonArray(p.days.map(::JsonPrimitive))
                // Jellyfin also carries the pattern.
                if (d.containsKey("DayPattern")) changes["DayPattern"] = JsonPrimitive(p.pattern)
            }, modifier = firstMod())
        }
        if ("keepUpTo" in shown) {
            val cur = num("KeepUpTo").toInt()
            val choices = withCurrent(KEEP_UP_TO_CHOICES, cur)
            ChoiceRow(stringResource(R.string.livetv_record_keep_up_to), keepText(cur), onStep = { by -> changes["KeepUpTo"] = JsonPrimitive(choices.step(cur, by)) }, modifier = firstMod())
        }
        if ("keepUntil" in shown) {
            val cur = (value("KeepUntil") as? JsonPrimitive)?.content ?: KEEP_UNTIL[0].first
            val choices = (KEEP_UNTIL.map { it.first } + cur).distinct()
            val label = KEEP_UNTIL.firstOrNull { it.first == cur }?.let { stringResource(it.second) } ?: cur
            ChoiceRow(stringResource(R.string.livetv_record_keep_until), label, onStep = { by -> changes["KeepUntil"] = JsonPrimitive(choices.step(cur, by)) }, modifier = firstMod())
        }
        if ("startEarly" in shown || "endLate" in shown) {
            SheetButton(stringResource(R.string.livetv_record_save_default), onClick = { saveDefault = !saveDefault }, checked = saveDefault, centered = false, modifier = firstMod())
        }
    }
    val isNew = target is RecordTarget.New
    val scheduled = stringResource(if (mode == RecordMode.SERIES) R.string.livetv_toasts_series_scheduled else R.string.livetv_toasts_recording_scheduled)
    val padded = stringResource(R.string.livetv_toasts_padding_updated)
    val ruled = stringResource(R.string.livetv_toasts_rule_updated)
    val primary = remember { FocusRequester() }
    // ↓ from a full-width row lands on the primary button, not on the nearest one.
    Row(Modifier.padding(top = 22.dp).focusRestorer(primary), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Pill(stringResource(if (isNew) R.string.livetv_record_schedule else R.string.livetv_record_apply), primary = true, modifier = firstMod().focusRequester(primary), onClick = {
            if (busy) return@Pill
            busy = true
            val edits = changes.toMap()
            val done = when (target) {
                is RecordTarget.New -> scheduled
                is RecordTarget.Timer -> padded
                is RecordTarget.Rule -> ruled
            }
            dvrLaunch(context, { done }, after = { busy = false }) {
                when (target) {
                    is RecordTarget.New -> dvr.create(target.programId, mode == RecordMode.SERIES, applyOptions(d, edits))
                    is RecordTarget.Timer -> dvr.updateTimer(target.id, applyOptions(d, edits))
                    is RecordTarget.Rule -> dvr.updateRule(target.id, edits)
                }
                if (saveDefault) {
                    val p = dvr.repo.prefs.prefs.value
                    dvr.repo.prefs.update(PrefField.DVR_PADDING, p.copy(dvrPadding = DvrPadding(num("PrePaddingSeconds").toDouble(), num("PostPaddingSeconds").toDouble())))
                }
                onDone()
            }
        })
        Pill(stringResource(R.string.cancel), onClick = onDone)
    }
}

/**
 * Keeps focus inside a sheet while its content swaps: a removed focused node would hand focus to the
 * screen below (and switch its tab). [hold] parks focus on the sheet's [FocusAnchor] before a swap.
 */
internal class FocusHolder {
    val requester = FocusRequester()
    var armed by mutableStateOf(false)

    fun hold() {
        armed = true
        runCatching { requester.requestFocus() }
    }
}

/** The parking spot of a [FocusHolder]: focusable only while armed, so the D-pad never lands on it. */
@Composable
internal fun FocusAnchor(h: FocusHolder) = Box(
    Modifier.size(1.dp).focusRequester(h.requester).focusProperties { canFocus = h.armed }.onFocusChanged { if (!it.isFocused) h.armed = false }.focusable(),
)

/** A value row: OK or → takes the next choice, ← the previous one. */
@Composable
internal fun ChoiceRow(label: String, value: String, onStep: (Int) -> Unit, modifier: Modifier = Modifier) {
    var focused by remember { mutableStateOf(false) }
    val fg = if (focused) Color.Black else C.label
    Row(
        modifier
            .fillMaxWidth()
            .onKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown || (e.key != Key.DirectionLeft && e.key != Key.DirectionRight)) return@onKeyEvent false
                onStep(if (e.key == Key.DirectionLeft) -1 else 1)
                true
            }
            .tvFocus(RoundedCornerShape(Radius.md), focusedScale = 1.03f, sheen = false, elevation = 10.dp, onFocusChange = { focused = it }, onClick = { onStep(1) })
            .background(if (focused) Color.White else C.fill2)
            .padding(horizontal = 20.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(label, style = Type.headline, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text(value, style = Type.callout, color = if (focused) Color.Black else C.label2, maxLines = 1)
        Icon(Ic.Chevron, contentDescription = null, tint = if (focused) Color.Black else C.label3, modifier = Modifier.size(18.dp))
    }
}
