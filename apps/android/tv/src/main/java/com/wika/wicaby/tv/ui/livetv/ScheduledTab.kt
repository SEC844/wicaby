package com.wika.wicaby.tv.ui.livetv

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.TimerLite
import com.wika.wicaby.core.livetv.TimerStatus
import com.wika.wicaby.core.livetv.conflictCount
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.FocusMemory
import com.wika.wicaby.tv.ui.LocalOverlay
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.SheetButton
import com.wika.wicaby.tv.ui.TvSheet
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.remembered
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// "Programmés" on TV (spec §9.3, §9.4, §9.7, TV-4): À venir (recording now, today, tomorrow, then
// dates; status pills in text; the conflict banner from server statuses only; the tuner line) and
// the series rules. OK on a row opens its actions. Read-only without Policy.EnableLiveTvManagement
// or after a 403.

/** Runs [block] and drops its failure (the lists keep what they had). */
internal suspend fun quietly(block: suspend () -> Unit) = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (_: Exception) {
}

@Composable
fun ScheduledTab(repo: LiveTvRepository, now: Long, memory: FocusMemory) {
    val dvr = remember(repo) { dvrOf(repo) }
    val timers by repo.timers.collectAsState()
    val caps by repo.caps.collectAsState()
    val channels by repo.channels.collectAsState()
    var rulesView by rememberSaveable { mutableStateOf(false) }
    var onlyConflicts by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(repo) {
        launch { quietly { dvr.readPolicy() } }
        launch { quietly { dvr.loadRules() } }
        repo.refreshTimers()
    }
    val overlay = LocalOverlay.current
    // A sheet that removed its row hands focus to the view pill: a focused row that vanishes would send focus to the top bar.
    val anchor = remember { FocusRequester() }
    val removed: () -> Unit = {
        overlay.close()
        runCatching { anchor.requestFocus() }
    }
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(start = 48.dp, bottom = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Pill(stringResource(R.string.livetv_scheduled_upcoming), onClick = { rulesView = false }, selected = !rulesView, modifier = Modifier.remembered(memory, "sched-upcoming", default = true).then(if (rulesView) Modifier else Modifier.focusRequester(anchor)))
            Pill(stringResource(R.string.livetv_scheduled_rules), onClick = { rulesView = true }, selected = rulesView, modifier = Modifier.remembered(memory, "sched-rules").then(if (rulesView) Modifier.focusRequester(anchor) else Modifier))
        }
        if (!caps.canRecord) Text(stringResource(R.string.livetv_scheduled_read_only), style = Type.footnote, color = C.label3, modifier = Modifier.padding(start = 48.dp, bottom = 10.dp))
        if (rulesView) {
            SeriesRulesView(dvr, timers, caps.canRecord, now, onRemoved = removed)
            return@Column
        }
        val conflicts = conflictCount(timers)
        if (conflicts > 0) {
            Row(
                Modifier.padding(start = 48.dp, end = 48.dp, bottom = 10.dp).fillMaxWidth().background(C.fill2, RoundedCornerShape(Radius.md)).padding(horizontal = 18.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(pluralStringResource(R.plurals.livetv_scheduled_conflicts, conflicts, conflicts), style = Type.headline, color = C.label, modifier = Modifier.weight(1f))
                Pill(stringResource(R.string.livetv_scheduled_show), onClick = { onlyConflicts = !onlyConflicts }, selected = onlyConflicts)
            }
        }
        caps.tunerCount?.let { total ->
            val used = timers.count { it.status == TimerStatus.RECORDING }
            Text(stringResource(R.string.livetv_scheduled_tuners, used, total), style = Type.footnote, color = C.label3, modifier = Modifier.padding(start = 48.dp, bottom = 10.dp))
        }
        val byId = remember(channels) { channels.associateBy { it.id } }
        // Recording now first, then one group per local day (the list is sorted by start).
        // The filter only applies while the banner (its toggle) is on screen.
        val groups = timers.filter { it.end > now && (!onlyConflicts || conflicts == 0 || it.status == TimerStatus.CONFLICT_WONT) }
            .groupBy { if (it.status == TimerStatus.RECORDING) Long.MIN_VALUE else dayIndex(it.start) }
            .toSortedMap()
        if (groups.isEmpty()) Text(stringResource(R.string.livetv_scheduled_empty), style = Type.body, color = C.label3, modifier = Modifier.padding(horizontal = 48.dp, vertical = 24.dp))
        Column(Modifier.padding(horizontal = 48.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((day, list) in groups) {
                Section(if (day == Long.MIN_VALUE) stringResource(R.string.livetv_scheduled_recording_now) else dayText(list[0].start, now))
                for (t in list) {
                    key(t.id) {
                        val ch = t.channelId?.let(byId::get)
                        val pad = if (t.prePaddingS != 0L || t.postPaddingS != 0L) stringResource(R.string.livetv_scheduled_padding, t.prePaddingS / 60, t.postPaddingS / 60) else null
                        ListRow(
                            lead = timeText(t.start) + " – " + timeText(t.end),
                            title = t.name,
                            sub = listOfNotNull(ch?.let { "${it.number} ${it.name}".trim() }, pad).joinToString(" · "),
                            trail = { StatusPill(t.status) },
                            onClick = { if (caps.canRecord || t.seriesTimerId != null) overlay.show { TimerSheet(dvr, t, onDismiss = overlay::close, onRemoved = removed) } },
                            modifier = Modifier.remembered(memory, "timer-${t.id}"),
                        )
                    }
                }
            }
        }
    }
}

/** Status in text, never colour alone (§9.3); only "Ne sera pas enregistré" is emphasised. */
@Composable
private fun StatusPill(s: TimerStatus) {
    val wont = s == TimerStatus.CONFLICT_WONT
    Row(
        Modifier.background(if (wont) C.fill4 else C.fill2, RoundedCornerShape(50)).padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (s == TimerStatus.RECORDING) Box(Modifier.size(8.dp).background(C.red, CircleShape)) // static red dot (§11)
        Text(
            stringResource(
                when (s) {
                    TimerStatus.SCHEDULED -> R.string.livetv_scheduled_status_scheduled
                    TimerStatus.RECORDING -> R.string.livetv_scheduled_status_recording
                    TimerStatus.CONFLICT_OK -> R.string.livetv_scheduled_status_conflict_ok
                    TimerStatus.CONFLICT_WONT -> R.string.livetv_scheduled_status_wont
                    TimerStatus.ERROR -> R.string.livetv_scheduled_status_error
                },
            ),
            style = Type.caption, color = if (wont) C.label else C.label2, maxLines = 1,
        )
    }
}

/** A timer's actions: padding, its rule, skip or cancel. */
@Composable
private fun TimerSheet(dvr: TvDvr, t: TimerLite, onDismiss: () -> Unit, onRemoved: () -> Unit) {
    val context = LocalContext.current
    val caps by dvr.repo.caps.collectAsState()
    var page by remember { mutableStateOf(0) } // 0 actions, 1 padding, 2 rule
    val holder = remember { FocusHolder() }
    fun go(p: Int) {
        holder.hold()
        page = p
    }
    val first = remember { FocusRequester() }
    LaunchedEffect(page) {
        delay(60)
        if (page == 0) runCatching { first.requestFocus() }
    }
    val canceled = stringResource(R.string.livetv_toasts_recording_canceled)
    TvSheet(onDismiss, width = 680.dp) {
        FocusAnchor(holder)
        when (page) {
            1 -> return@TvSheet RecordOptionsContent(dvr, RecordTarget.Timer(t.id), onDone = { go(0) })
            2 -> return@TvSheet RuleContent(dvr, t.seriesTimerId.orEmpty(), holder, onDone = onRemoved)
        }
        Text(t.name, style = Type.title2, color = C.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(dayText(t.start, dvr.repo.now()) + " · " + timeText(t.start) + " – " + timeText(t.end), style = Type.footnote, color = C.label2, modifier = Modifier.padding(top = 4.dp, bottom = 18.dp))
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            var firstSet = false
            fun firstMod(): Modifier = if (firstSet) Modifier else Modifier.focusRequester(first).also { firstSet = true }
            if (caps.canRecord) SheetButton(stringResource(R.string.livetv_scheduled_edit_padding), onClick = { go(1) }, modifier = firstMod())
            if (t.seriesTimerId != null) SheetButton(stringResource(R.string.livetv_scheduled_view_rule), onClick = { go(2) }, modifier = firstMod())
            if (caps.canRecord) {
                SheetButton(stringResource(if (t.seriesTimerId != null) R.string.livetv_scheduled_skip_episode else R.string.livetv_scheduled_cancel), modifier = firstMod(), onClick = {
                    dvrLaunch(context, { canceled }) { dvr.cancelTimer(t.id) }
                    onRemoved()
                })
            }
        }
    }
}
