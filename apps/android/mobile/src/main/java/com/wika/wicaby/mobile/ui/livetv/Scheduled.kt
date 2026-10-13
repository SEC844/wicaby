package com.wika.wicaby.mobile.ui.livetv

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.livetv.Dialect
import com.wika.wicaby.core.livetv.DvrOp
import com.wika.wicaby.core.livetv.GuideClock
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.TimerLite
import com.wika.wicaby.core.livetv.TimerStatus
import com.wika.wicaby.core.livetv.conflictCount
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.ui.Centered
import com.wika.wicaby.mobile.ui.Chip
import com.wika.wicaby.mobile.ui.ErrorState
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.PillButton
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.Spinner
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.uiLocale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.text.SimpleDateFormat
import java.util.Date
import java.util.TimeZone
import com.wika.wicaby.core.R as CoreR

// Programmés on mobile (spec §9.3, §9.4, §9.7, work package M-3): À venir (the timers overlay by day,
// status pills, the conflict banner) and Règles de série (edit, delete, priority order). Read-only when
// the account cannot record. Statuses come from the server only; nothing is predicted.

@Composable
fun Scheduled(repo: LiveTvRepository, nonce: Int) {
    var seg by rememberSaveable { mutableIntStateOf(0) }
    LaunchedEffect(repo) { checkRecordPolicy(repo) }
    // Pull to refresh: the overlay refetches (GET /LiveTv/Timers only).
    LaunchedEffect(nonce) { if (nonce > 0) repo.refreshTimers() }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(horizontal = 20.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Chip(stringResource(R.string.livetv_scheduled_upcoming), seg == 0) { seg = 0 }
            Chip(stringResource(R.string.livetv_scheduled_rules), seg == 1) { seg = 1 }
        }
        if (seg == 0) Upcoming(repo) else Rules(repo, nonce)
    }
}

private const val REC_KEY = "rec"

@Composable
private fun Upcoming(repo: LiveTvRepository) {
    val timers by repo.timers.collectAsState()
    val caps by repo.caps.collectAsState()
    val channels by repo.channels.collectAsState()
    val now by rememberNow(repo)
    val byId = remember(channels) { channels.associateBy { it.id } }
    var onlyWont by rememberSaveable { mutableStateOf(false) }
    val wont = conflictCount(timers)
    val filter = onlyWont && wont > 0
    val clock = remember { GuideClock(TimeZone.getDefault()) }
    val groups = remember(timers, now, filter) {
        timers.filter { it.end > now && (!filter || it.status == TimerStatus.CONFLICT_WONT) }
            .groupBy { if (it.status == TimerStatus.RECORDING) REC_KEY else clock.dayKey(it.start) }
            .toList().sortedBy { (k, _) -> if (k == REC_KEY) "" else k }
    }
    val dayLabel = rememberDayLabel(clock, now)
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
        if (!caps.canRecord) item { Caption(stringResource(R.string.livetv_scheduled_read_only)) }
        if (wont > 0) item {
            Row(
                Modifier.padding(horizontal = 20.dp, vertical = 8.dp).fillMaxWidth().background(G.fill2, RoundedCornerShape(Radius.md)).padding(start = 16.dp, end = 10.dp, top = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(pluralStringResource(R.plurals.livetv_scheduled_conflicts, wont, wont), style = Type.callout, color = G.label, modifier = Modifier.weight(1f))
                Chip(stringResource(R.string.livetv_scheduled_show), filter) { onlyWont = !filter }
            }
        }
        if (groups.isEmpty()) item { Caption(stringResource(R.string.livetv_scheduled_empty), Modifier.padding(top = 32.dp)) }
        for ((key, list) in groups) {
            item(key = "h-$key", contentType = "header") {
                Text(
                    if (key == REC_KEY) stringResource(R.string.livetv_scheduled_recording_now) else dayLabel(key),
                    style = Type.headline, color = G.label, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 6.dp),
                )
            }
            items(list, key = { it.id }, contentType = { "timer" }) { t ->
                val ch = t.channelId?.let(byId::get)
                TimerRow(repo, t, ch?.let { listOf(it.number, it.name).filter(String::isNotEmpty).joinToString(" ") }, caps.canRecord)
            }
        }
    }
}

/** Aujourd’hui, Demain, then the local date. */
@Composable
private fun rememberDayLabel(clock: GuideClock, now: Long): (String) -> String {
    val locale = uiLocale()
    val today = stringResource(R.string.livetv_guide_today)
    val tomorrow = stringResource(R.string.livetv_guide_tomorrow)
    val todayKey = clock.dayKey(now)
    return remember(locale, todayKey, today, tomorrow) {
        val chips = clock.dayChips(now).associateBy { it.key }
        val f = SimpleDateFormat(android.text.format.DateFormat.getBestDateTimePattern(locale, "EEEEdMMMM"), locale);
        { key: String ->
            when (key) {
                todayKey -> today
                chips.values.firstOrNull { it.index == 1 }?.key -> tomorrow
                else -> clock.parseDayKey(key)?.let { f.format(Date(it)).replaceFirstChar { c -> c.titlecase(locale) } } ?: key
            }
        }
    }
}

@Composable
private fun Caption(text: String, modifier: Modifier = Modifier) {
    Text(text, style = Type.footnote, color = G.label2, textAlign = TextAlign.Center, modifier = modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 8.dp))
}

@Composable
private fun TimerRow(repo: LiveTvRepository, t: TimerLite, channel: String?, canRecord: Boolean) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val fmt = rememberTimeFormat()
    val busy = remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var target by remember { mutableStateOf<RecordTarget?>(null) }
    val canceled = stringResource(R.string.livetv_toasts_recording_canceled)
    Box {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 64.dp)
                .then(if (canRecord) Modifier.clickable(role = Role.Button) { menu = true } else Modifier)
                .padding(horizontal = 20.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f).padding(end = 10.dp)) {
                Text("${fmt(t.start)} – ${fmt(t.end)}", style = Type.mono, color = G.label2, maxLines = 1)
                Text(t.name, style = Type.headline, color = G.label, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                val pad = if (t.prePaddingS > 0 || t.postPaddingS > 0) stringResource(R.string.livetv_scheduled_padding, t.prePaddingS / 60, t.postPaddingS / 60) else null
                listOfNotNull(channel, pad).joinToString(" · ").takeIf { it.isNotEmpty() }?.let {
                    Text(it, style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            StatusPill(t.status)
        }
        if (menu) {
            DropdownMenu(true, { menu = false }, containerColor = G.elevated2, shape = RoundedCornerShape(Radius.md)) {
                // A series child is skipped (a Cancelled tombstone), a one-off is cancelled (§5.2).
                MenuItem(stringResource(if (t.seriesTimerId != null) R.string.livetv_scheduled_skip_episode else R.string.livetv_scheduled_cancel)) {
                    menu = false
                    launchDvr(scope, context, busy) { cancelTimer(repo, t.id); toast(context, canceled) }
                }
                MenuItem(stringResource(R.string.livetv_scheduled_edit_padding)) { menu = false; target = RecordTarget.Timer(t.id) }
                t.seriesTimerId?.let { rule -> MenuItem(stringResource(R.string.livetv_scheduled_edit_rule)) { menu = false; target = RecordTarget.Rule(rule) } }
            }
        }
    }
    target?.let { RecordOptionsSheet(repo, it, onDismiss = { target = null }) }
}

@Composable
private fun MenuItem(text: String, onClick: () -> Unit) =
    DropdownMenuItem(text = { Text(text, style = Type.body, color = G.label) }, onClick = onClick)

// ---- Règles de série (§9.4) ----

private fun JsonObject.priority(): Double = n("Priority") ?: 0.0

/** GET /LiveTv/SeriesTimers, first = highest priority. */
private suspend fun loadRules(repo: LiveTvRepository): List<JsonObject> =
    items(repo.dvr(DvrOp.TIMERS, Dialect.seriesTimers(repo.api.kind))).sortedByDescending { it.priority() }

@Composable
private fun Rules(repo: LiveTvRepository, nonce: Int) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val caps by repo.caps.collectAsState()
    val timers by repo.timers.collectAsState()
    var ver by remember { mutableIntStateOf(0) }
    var rules by remember { mutableStateOf<List<JsonObject>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var order by remember { mutableStateOf<List<JsonObject>?>(null) } // non-null while reordering
    val busy = remember { mutableStateOf(false) }
    LaunchedEffect(nonce, ver) {
        failed = false
        try {
            rules = loadRules(repo)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            failed = true
        }
    }
    val list = rules ?: return Centered { if (failed) ErrorState({ ver++ }) else Spinner() }
    val prioritiesMsg = stringResource(R.string.livetv_toasts_priorities_updated)
    val reorder = order
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
        if (!caps.canRecord) item { Caption(stringResource(R.string.livetv_scheduled_read_only)) }
        if (list.isEmpty()) item { Caption(stringResource(R.string.livetv_scheduled_rules_empty), Modifier.padding(top = 32.dp)) }
        if (reorder != null) {
            item { Caption(stringResource(R.string.livetv_scheduled_reorder_hint)) }
            reorderRows(reorder) { order = it }
            item {
                Row(Modifier.padding(horizontal = 20.dp, vertical = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    PillButton(stringResource(R.string.livetv_record_apply), {
                        launchDvr(scope, context, busy) {
                            // Priority n…1 (first = highest), re-posted only for the rules whose value changes, one after the other.
                            val n = reorder.size
                            reorder.forEachIndexed { i, r ->
                                val id = r.s("Id") ?: return@forEachIndexed
                                if (r.priority() != (n - i).toDouble()) updateRule(repo, id, mapOf("Priority" to JsonPrimitive(n - i)))
                            }
                            toast(context, prioritiesMsg)
                            order = null
                            ver++
                        }
                    }, primary = true, compact = true)
                    PillButton(stringResource(R.string.cancel), { order = null }, compact = true)
                }
            }
        } else {
            items(list, key = { it.s("Id") ?: it.hashCode().toString() }) { r ->
                RuleRow(repo, r, timers.count { t -> t.seriesTimerId == r.s("Id") }, caps.canRecord, onChanged = { ver++ })
            }
            if (caps.canRecord && list.size > 1) item {
                PillButton(stringResource(R.string.livetv_scheduled_reorder), { order = list }, Modifier.padding(horizontal = 20.dp, vertical = 16.dp), compact = true)
            }
        }
    }
}

/** Mobile priority order: arrows on each row (also reachable with TalkBack). */
private fun LazyListScope.reorderRows(order: List<JsonObject>, onOrder: (List<JsonObject>) -> Unit) {
    itemsIndexed(order, key = { _, r -> "o-" + (r.s("Id") ?: r.hashCode().toString()) }) { i, r ->
        fun move(to: Int) = onOrder(order.toMutableList().apply { add(to, removeAt(i)) })
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("${i + 1}", style = Type.mono, color = G.label2, modifier = Modifier.padding(end = 12.dp))
            Text(r.s("Name").orEmpty(), style = Type.headline, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            IconButton({ move(i - 1) }, enabled = i > 0) {
                Icon(Ic.ChevronDown, stringResource(R.string.livetv_manage_move_up), tint = if (i > 0) G.label else G.label3, modifier = Modifier.size(20.dp).rotate(180f))
            }
            IconButton({ move(i + 1) }, enabled = i < order.size - 1) {
                Icon(Ic.ChevronDown, stringResource(R.string.livetv_manage_move_down), tint = if (i < order.size - 1) G.label else G.label3, modifier = Modifier.size(20.dp))
            }
        }
    }
}

@Composable
private fun RuleRow(repo: LiveTvRepository, r: JsonObject, episodes: Int, canRecord: Boolean, onChanged: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val busy = remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var edit by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf(false) }
    val id = r.s("Id") ?: return
    val name = r.s("Name").orEmpty()
    val canceled = stringResource(R.string.livetv_toasts_series_canceled)
    val channel = if (r.b("RecordAnyChannel")) stringResource(R.string.livetv_scheduled_all_channels) else r.s("ChannelName")
    val keep = r.n("KeepUpTo")?.toInt() ?: 0
    val pre = ((r.n("PrePaddingSeconds") ?: 0.0) / 60).toLong()
    val post = ((r.n("PostPaddingSeconds") ?: 0.0) / 60).toLong()
    val summary = listOfNotNull(
        if (r.b("RecordNewOnly")) stringResource(R.string.livetv_recordings_new_only) else null,
        if (keep > 0) keepUpToLabel(keep) else null,
        if (pre > 0 || post > 0) stringResource(R.string.livetv_scheduled_padding, pre, post) else null,
    ).joinToString(" · ")
    val count = if (episodes == 0) stringResource(CoreR.string.livetv_scheduled_rule_episodes_zero) else pluralStringResource(R.plurals.livetv_scheduled_rule_episodes, episodes, episodes)
    Box {
        Column(
            Modifier.fillMaxWidth().heightIn(min = 64.dp)
                .then(if (canRecord) Modifier.clickable(role = Role.Button) { menu = true } else Modifier)
                .padding(horizontal = 20.dp, vertical = 10.dp),
        ) {
            Text(name, style = Type.headline, color = G.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
            channel?.let { Text(it, style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            if (summary.isNotEmpty()) Text(summary, style = Type.footnote, color = G.label2, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(count, style = Type.caption, color = G.label2, modifier = Modifier.padding(top = 2.dp))
        }
        if (menu) {
            DropdownMenu(true, { menu = false }, containerColor = G.elevated2, shape = RoundedCornerShape(Radius.md)) {
                MenuItem(stringResource(R.string.livetv_scheduled_edit_rule)) { menu = false; edit = true }
                MenuItem(stringResource(R.string.livetv_scheduled_delete_rule)) { menu = false; confirm = true }
            }
        }
    }
    if (edit) RecordOptionsSheet(repo, RecordTarget.Rule(id), onDismiss = { edit = false }, onDone = onChanged)
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            containerColor = G.elevated2,
            shape = RoundedCornerShape(Radius.lg),
            text = { Text(stringResource(R.string.livetv_scheduled_delete_rule_confirm, name), style = Type.body, color = G.label) },
            confirmButton = {
                PillButton(stringResource(R.string.livetv_scheduled_delete_rule), {
                    confirm = false
                    launchDvr(scope, context, busy) {
                        // The server cascades to the rule's scheduled episodes.
                        repo.dvr(DvrOp.DELETE_SERIES_TIMER, Dialect.deleteSeriesTimer(repo.api.kind, id))
                        repo.refreshTimers()
                        toast(context, canceled)
                        onChanged()
                    }
                }, compact = true)
            },
            dismissButton = { PillButton(stringResource(R.string.cancel), { confirm = false }, compact = true) },
        )
    }
}
