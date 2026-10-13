package com.wika.wicaby.mobile.ui.livetv

import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.livetv.Dialect
import com.wika.wicaby.core.livetv.DvrError
import com.wika.wicaby.core.livetv.DvrOp
import com.wika.wicaby.core.livetv.DvrPadding
import com.wika.wicaby.core.livetv.KEEP_UP_TO_CHOICES
import com.wika.wicaby.core.livetv.LiveApiException
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.PADDING_CHOICES_MIN
import com.wika.wicaby.core.livetv.PF
import com.wika.wicaby.core.livetv.PrefField
import com.wika.wicaby.core.livetv.ProgramLite
import com.wika.wicaby.core.livetv.RecordMode
import com.wika.wicaby.core.livetv.Req
import com.wika.wicaby.core.livetv.TimerStatus
import com.wika.wicaby.core.livetv.applyOptions
import com.wika.wicaby.core.livetv.encodeUriComponent
import com.wika.wicaby.core.livetv.mapDvrError
import com.wika.wicaby.core.livetv.quickRecordBody
import com.wika.wicaby.core.livetv.visibleOptions
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.ui.Chip
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.LocalAccent
import com.wika.wicaby.mobile.ui.PillButton
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.onAccent
import com.wika.wicaby.mobile.ui.uiLocale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import java.text.DateFormatSymbols
import java.util.Collections
import java.util.WeakHashMap
import com.wika.wicaby.core.R as CoreR

// Recording on mobile (spec §9.1, §9.2, §9.7, work package M-3): the DVR write helper the M-3 screens
// share, the record actions of the programme sheet and the options sheet (a new recording, a timer's
// padding, or a series rule). Capability by presence: a field the server did not send is not shown,
// and only the changed fields are applied to the object it sent.

class DvrFailure(val code: DvrError, val status: Int, message: String) : Exception(message)

/** A DVR request. Failures are mapped (§9.1); a 403 hides the record actions for the session. */
suspend fun LiveTvRepository.dvr(op: DvrOp, req: Req): JsonElement? = try {
    api.json(req)
} catch (e: LiveApiException) {
    val code = mapDvrError(api.kind, op, e.status, e.message.orEmpty())
    noteDvrError(code)
    throw DvrFailure(code, e.status, e.message.orEmpty())
}

fun dvrMessage(context: Context, e: Throwable): String = when ((e as? DvrFailure)?.code) {
    DvrError.ALREADY_SCHEDULED -> context.getString(R.string.livetv_toasts_already_scheduled)
    DvrError.FORBIDDEN -> context.getString(R.string.livetv_toasts_forbidden)
    DvrError.PREMIERE -> context.getString(R.string.livetv_toasts_premiere)
    DvrError.NOT_SERIES -> context.getString(R.string.livetv_toasts_not_series)
    else -> e.message.orEmpty() // the server's own words (§9.1)
}

fun toast(context: Context, text: String) = Toast.makeText(context, text, Toast.LENGTH_SHORT).show()

/** Runs a DVR action off a click: one at a time, failures toasted. */
fun launchDvr(scope: CoroutineScope, context: Context, busy: MutableState<Boolean>, block: suspend () -> Unit) {
    if (busy.value) return
    busy.value = true
    scope.launch {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            toast(context, dvrMessage(context, e))
        } finally {
            busy.value = false
        }
    }
}

internal fun JsonObject.s(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull?.takeIf { it.isNotEmpty() }
internal fun JsonObject.b(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull ?: false
internal fun JsonObject.n(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull

/** `{Items: [...]}` → the objects. */
internal fun items(e: JsonElement?): List<JsonObject> = ((e as? JsonObject)?.get("Items") as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()

private val policyRead: MutableSet<LiveTvRepository> = Collections.synchronizedSet(Collections.newSetFromMap(WeakHashMap()))

/** Policy.EnableLiveTvManagement, read once per repository: false hides every record action (§3.1, §9.7). */
suspend fun checkRecordPolicy(repo: LiveTvRepository) {
    if (!policyRead.add(repo)) return
    val user = try {
        repo.api.json(Req("GET", "/Users/${encodeUriComponent(repo.api.userId)}", emptyMap())) as? JsonObject
    } catch (_: LiveApiException) {
        policyRead.remove(repo) // unknown stays "allowed"; try again next time
        return
    }
    if ((user?.get("Policy") as? JsonObject)?.let { (it["EnableLiveTvManagement"] as? JsonPrimitive)?.booleanOrNull } == false) repo.noteDvrError(DvrError.FORBIDDEN)
}

/** Quick record: the server defaults as they are, plus the synced padding when set; the mark comes from the timers refetch. */
suspend fun quickRecord(repo: LiveTvRepository, programId: String, series: Boolean) {
    val kind = repo.api.kind
    val op = if (series) DvrOp.CREATE_SERIES_TIMER else DvrOp.CREATE_TIMER
    val defaults = repo.dvr(op, Dialect.timerDefaults(kind, programId)) as? JsonObject ?: JsonObject(emptyMap())
    val body = JsonObject(quickRecordBody(defaults, repo.prefs.prefs.value.dvrPadding) + ("ProgramId" to JsonPrimitive(programId)))
    try {
        repo.dvr(op, if (series) Dialect.createSeriesTimer(kind, body) else Dialect.createTimer(kind, body))
    } finally {
        repo.refreshTimers() // also after "already scheduled": the mark is kept and shows (§9.1)
    }
}

suspend fun cancelTimer(repo: LiveTvRepository, id: String) {
    repo.dvr(DvrOp.CANCEL_TIMER, Dialect.cancelTimer(repo.api.kind, id))
    repo.refreshTimers()
}

/** Never a partial body: GET the rule, apply the changes, POST it by id, re-GET (§5.2). */
suspend fun updateRule(repo: LiveTvRepository, id: String, changes: Map<String, JsonElement>): JsonObject {
    val kind = repo.api.kind
    val current = repo.dvr(DvrOp.UPDATE_SERIES_TIMER, Dialect.seriesTimer(kind, id)) as? JsonObject ?: JsonObject(emptyMap())
    repo.dvr(DvrOp.UPDATE_SERIES_TIMER, Dialect.updateSeriesTimer(kind, id, JsonObject(applyOptions(current, changes) + ("Id" to JsonPrimitive(id)))))
    val fresh = repo.dvr(DvrOp.UPDATE_SERIES_TIMER, Dialect.seriesTimer(kind, id)) as? JsonObject ?: current
    repo.refreshTimers()
    return fresh
}

/** What the options sheet edits. */
sealed interface RecordTarget {
    data class New(val programId: String, val isSeries: Boolean) : RecordTarget
    data class Timer(val id: String) : RecordTarget
    data class Rule(val id: String) : RecordTarget
}

/** The programme sheet's record actions (§9.1). Nothing when the account cannot record or the programme is over. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RecordActions(repo: LiveTvRepository, p: ProgramLite, now: Long, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val caps by repo.caps.collectAsState()
    val overlay by repo.overlay.collectAsState()
    val busy = remember { mutableStateOf(false) }
    var target by remember { mutableStateOf<RecordTarget?>(null) }
    LaunchedEffect(repo) { checkRecordPolicy(repo) }
    if (!caps.canRecord || p.end <= now) return
    val timer = overlay[p.id]
    val isSeries = p.flags and PF.SERIES != 0
    val scheduledMsg = stringResource(R.string.livetv_toasts_recording_scheduled)
    val seriesMsg = stringResource(R.string.livetv_toasts_series_scheduled)
    val canceledMsg = stringResource(R.string.livetv_toasts_recording_canceled)
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (timer == null) {
            PillButton(stringResource(R.string.livetv_actions_record), { launchDvr(scope, context, busy) { quickRecord(repo, p.id, false); toast(context, scheduledMsg) } }, compact = true)
            if (isSeries) PillButton(stringResource(R.string.livetv_actions_record_series), { launchDvr(scope, context, busy) { quickRecord(repo, p.id, true); toast(context, seriesMsg) } }, compact = true)
            PillButton(stringResource(R.string.livetv_record_options), { target = RecordTarget.New(p.id, isSeries) }, compact = true)
        } else {
            // A series child is skipped (a Cancelled tombstone), a one-off is cancelled (§5.2).
            val cancel = if (timer.seriesTimerId != null) R.string.livetv_scheduled_skip_episode else R.string.livetv_actions_cancel_recording
            PillButton(stringResource(cancel), { launchDvr(scope, context, busy) { cancelTimer(repo, timer.id); toast(context, canceledMsg) } }, compact = true)
            PillButton(stringResource(R.string.livetv_scheduled_edit_padding), { target = RecordTarget.Timer(timer.id) }, compact = true)
            timer.seriesTimerId?.let { rule -> PillButton(stringResource(R.string.livetv_scheduled_edit_rule), { target = RecordTarget.Rule(rule) }, compact = true) }
        }
    }
    target?.let { RecordOptionsSheet(repo, it, onDismiss = { target = null }) }
}

private val DAYS = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
private val PRESETS = listOf(
    Triple(R.string.livetv_record_every_day, "Daily", DAYS),
    Triple(R.string.livetv_record_weekdays, "Weekdays", DAYS.subList(1, 6)),
    Triple(R.string.livetv_record_weekends, "Weekends", listOf("Saturday", "Sunday")),
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

@Composable
private fun minutesLabel(m: Int): String =
    if (m == 0) stringResource(CoreR.string.livetv_record_minutes_zero) else pluralStringResource(R.plurals.livetv_record_minutes, m, m)

@Composable
fun keepUpToLabel(n: Int): String =
    if (n == 0) stringResource(CoreR.string.livetv_record_keep_up_to_value_zero) else pluralStringResource(R.plurals.livetv_record_keep_up_to_value, n, n)

/** §9.2. [onDone] runs after a successful write (the rules list reloads). */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun RecordOptionsSheet(repo: LiveTvRepository, target: RecordTarget, onDismiss: () -> Unit, onDone: () -> Unit = {}) {
    val context = LocalContext.current
    val res = androidx.compose.ui.platform.LocalResources.current
    val scope = rememberCoroutineScope()
    val kind = repo.api.kind
    var dto by remember(target) { mutableStateOf<JsonObject?>(null) }
    val changes = remember(target) { mutableStateMapOf<String, JsonElement>() }
    var mode by remember(target) { mutableStateOf(if (target is RecordTarget.Rule) RecordMode.SERIES else RecordMode.SINGLE) }
    var saveDefault by remember(target) { mutableStateOf(false) }
    val busy = remember { mutableStateOf(false) }
    LaunchedEffect(target) {
        val req = when (target) {
            is RecordTarget.New -> Dialect.timerDefaults(kind, target.programId)
            is RecordTarget.Timer -> Req("GET", "/LiveTv/Timers/${encodeUriComponent(target.id)}", emptyMap())
            is RecordTarget.Rule -> Dialect.seriesTimer(kind, target.id)
        }
        try {
            dto = repo.dvr(DvrOp.TIMERS, req) as? JsonObject ?: JsonObject(emptyMap())
            // A new recording starts from the synced padding, as the quick record does.
            val pad = repo.prefs.prefs.value.dvrPadding
            if (target is RecordTarget.New && pad != null) {
                changes["PrePaddingSeconds"] = JsonPrimitive(pad.pre.toLong())
                changes["PostPaddingSeconds"] = JsonPrimitive(pad.post.toLong())
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            toast(context, dvrMessage(context, e))
            onDismiss()
        }
    }
    val d = dto
    fun value(field: String): JsonElement? = changes[field] ?: d?.get(field)
    fun set(field: String, v: JsonElement) {
        changes[field] = v
    }
    val shown = visibleOptions(d, mode)
    val isNew = target is RecordTarget.New
    // The sheet opens once the object is loaded: a sheet that grows past the screen after opening stays clipped.
    if (d == null) return

    // A form: open full height (the half-open state hides the fields and the primary button).
    ModalBottomSheet(onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = G.elevated, contentColor = G.label) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 28.dp)) {
            Text(
                if (target is RecordTarget.Rule) d.s("Name") ?: stringResource(R.string.livetv_record_title) else stringResource(R.string.livetv_record_title),
                style = Type.title3, color = G.label,
            )
            if (target is RecordTarget.New && target.isSeries) {
                Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Chip(stringResource(R.string.livetv_record_this_episode), mode == RecordMode.SINGLE) { mode = RecordMode.SINGLE }
                    Chip(stringResource(R.string.livetv_record_whole_series), mode == RecordMode.SERIES) { mode = RecordMode.SERIES }
                }
            }
            for ((id, field, label) in listOf(
                Triple("startEarly", "PrePaddingSeconds", R.string.livetv_record_start_early),
                Triple("endLate", "PostPaddingSeconds", R.string.livetv_record_end_late),
            )) {
                if (id !in shown) continue
                val cur = Math.round(((value(field) as? JsonPrimitive)?.doubleOrNull ?: 0.0) / 60).toInt()
                Field(stringResource(label)) {
                    for (m in (PADDING_CHOICES_MIN + cur).distinct().sorted()) Chip(minutesLabel(m), cur == m) { set(field, JsonPrimitive(m * 60)) }
                }
            }
            for ((id, field, label) in TOGGLES) {
                if (id !in shown) continue
                Toggle(stringResource(label), (value(field) as? JsonPrimitive)?.booleanOrNull ?: false) { set(field, JsonPrimitive(it)) }
            }
            val anyTime = (value("RecordAnyTime") as? JsonPrimitive)?.booleanOrNull ?: false
            if ("days" in shown && !anyTime) {
                val days = (value("Days") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }?.toSet().orEmpty()
                fun setDays(list: Collection<String>) {
                    val ordered = DAYS.filter { it in list }
                    set("Days", JsonArray(ordered.map(::JsonPrimitive)))
                    // Jellyfin also carries the pattern; null means a custom set.
                    if (d.containsKey("DayPattern")) set("DayPattern", PRESETS.firstOrNull { it.third.toSet() == ordered.toSet() }?.let { JsonPrimitive(it.second) } ?: JsonNull)
                }
                val locale = uiLocale()
                val names = remember(locale) { DateFormatSymbols.getInstance(locale).shortWeekdays } // [1] = Sunday
                Field(stringResource(R.string.livetv_record_days)) {
                    for ((label, _, list) in PRESETS) Chip(stringResource(label), days == list.toSet()) { setDays(list) }
                }
                FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    DAYS.forEachIndexed { i, day -> Chip(names[i + 1], day in days) { setDays(if (day in days) days - day else days + day) } }
                }
            }
            if ("keepUpTo" in shown) {
                val cur = (value("KeepUpTo") as? JsonPrimitive)?.doubleOrNull?.toInt() ?: 0
                Field(stringResource(R.string.livetv_record_keep_up_to)) {
                    for (n in (KEEP_UP_TO_CHOICES + cur).distinct().sorted()) Chip(keepUpToLabel(n), cur == n) { set("KeepUpTo", JsonPrimitive(n)) }
                }
            }
            if ("keepUntil" in shown) {
                val cur = (value("KeepUntil") as? JsonPrimitive)?.contentOrNull
                Field(stringResource(R.string.livetv_record_keep_until)) {
                    for ((v, label) in KEEP_UNTIL) Chip(stringResource(label), cur == v) { set("KeepUntil", JsonPrimitive(v)) }
                }
            }
            if ("startEarly" in shown || "endLate" in shown) Toggle(stringResource(R.string.livetv_record_save_default), saveDefault) { saveDefault = it }

            PillButton(
                stringResource(if (isNew) R.string.livetv_record_schedule else R.string.livetv_record_apply),
                {
                    launchDvr(scope, context, busy) {
                        val edits = changes.toMap()
                        when (target) {
                            is RecordTarget.New -> {
                                val series = mode == RecordMode.SERIES
                                val body = JsonObject(applyOptions(d, edits) + ("ProgramId" to JsonPrimitive(target.programId)))
                                repo.dvr(
                                    if (series) DvrOp.CREATE_SERIES_TIMER else DvrOp.CREATE_TIMER,
                                    if (series) Dialect.createSeriesTimer(kind, body) else Dialect.createTimer(kind, body),
                                )
                                repo.refreshTimers()
                                toast(context, res.getString(if (series) R.string.livetv_toasts_series_scheduled else R.string.livetv_toasts_recording_scheduled))
                            }
                            is RecordTarget.Timer -> {
                                repo.dvr(DvrOp.UPDATE_TIMER, Dialect.updateTimer(kind, target.id, applyOptions(d, edits)))
                                repo.refreshTimers()
                                toast(context, res.getString(R.string.livetv_toasts_padding_updated))
                            }
                            is RecordTarget.Rule -> {
                                updateRule(repo, target.id, edits)
                                toast(context, res.getString(R.string.livetv_toasts_rule_updated))
                            }
                        }
                        if (saveDefault) {
                            fun secs(f: String) = (value(f) as? JsonPrimitive)?.doubleOrNull ?: 0.0
                            val p = repo.prefs.prefs.value
                            repo.prefs.update(PrefField.DVR_PADDING, p.copy(dvrPadding = DvrPadding(secs("PrePaddingSeconds"), secs("PostPaddingSeconds"))))
                        }
                        onDone()
                        onDismiss()
                    }
                },
                Modifier.padding(top = 22.dp).fillMaxWidth(), primary = true,
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Field(label: String, chips: @Composable () -> Unit) {
    Text(label, style = Type.headline, color = G.label, modifier = Modifier.padding(top = 18.dp, bottom = 8.dp))
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { chips() }
}

@Composable
private fun Toggle(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    val accent = LocalAccent.current
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(top = 6.dp).toggleable(checked, role = Role.Switch, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = Type.body, color = G.label, modifier = Modifier.weight(1f).padding(end = 12.dp))
        Switch(
            checked, null,
            colors = SwitchDefaults.colors(checkedTrackColor = accent, checkedThumbColor = onAccent(accent), uncheckedTrackColor = G.fill3, uncheckedThumbColor = G.label2, uncheckedBorderColor = Color.Transparent),
        )
    }
}

/** Recording status as text (§9.3: never colour alone); "Ne sera pas enregistré" is the only emphasised pill. */
@Composable
fun StatusPill(status: TimerStatus, modifier: Modifier = Modifier) {
    val (label, strong) = when (status) {
        TimerStatus.SCHEDULED -> R.string.livetv_scheduled_status_scheduled to false
        TimerStatus.RECORDING -> R.string.livetv_scheduled_status_recording to false
        TimerStatus.CONFLICT_OK -> R.string.livetv_scheduled_status_conflict_ok to false
        TimerStatus.CONFLICT_WONT -> R.string.livetv_scheduled_status_wont to true
        TimerStatus.ERROR -> R.string.livetv_scheduled_status_error to false
    }
    Row(
        modifier.background(if (strong) G.fill4 else G.fill2, CircleShape).padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Red only marks recording (§11), static.
        if (status == TimerStatus.RECORDING) {
            Box(Modifier.padding(end = 6.dp).size(6.dp).background(G.red, CircleShape))
        }
        Text(stringResource(label), style = Type.caption, color = if (strong) G.label else G.label2, maxLines = 1)
    }
}
