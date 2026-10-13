package com.wika.wicaby.tv.ui.livetv

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.livetv.TimerLite
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.LocalOverlay
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.SheetButton
import com.wika.wicaby.tv.ui.TvSheet
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.tvFocus
import com.wika.wicaby.tv.ui.uiLocale
import java.text.SimpleDateFormat
import java.util.Date
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// "Règles de série" on TV (spec §9.4, TV-4): the rules by priority with their summary and episode
// count (from the timer overlay, no extra request), one rule's sheet (episodes, skip, edit, delete,
// the server cascades) and "Réorganiser les priorités…" with the D-pad pick-up. Saving rewrites
// Priority as n…1 (first = highest) only for the rules whose value changes, one after the other.

private fun JsonObject.id(): String = text("Id").orEmpty()

/** "Toutes les chaînes · Inédits · 5 derniers épisodes · marges −2 / +30 min". */
@Composable
internal fun ruleSummary(r: JsonObject): String {
    val keep = r.num("KeepUpTo").toInt()
    val pre = (r.num("PrePaddingSeconds") / 60).toInt()
    val post = (r.num("PostPaddingSeconds") / 60).toInt()
    return listOfNotNull(
        if (r.flag("RecordAnyChannel")) stringResource(R.string.livetv_scheduled_all_channels) else r.text("ChannelName"),
        if (r.flag("RecordNewOnly")) stringResource(com.wika.wicaby.core.R.string.livetv_category_new) else null,
        if (keep > 0) keepText(keep) else null,
        if (pre != 0 || post != 0) stringResource(R.string.livetv_scheduled_padding, pre, post) else null,
    ).joinToString(" · ")
}

@Composable
internal fun episodesText(n: Int): String =
    if (n == 0) stringResource(R.string.livetv_scheduled_rule_episodes_zero) else pluralStringResource(R.plurals.livetv_scheduled_rule_episodes, n, n)

/** The rules list of Programmés. */
@Composable
internal fun SeriesRulesView(dvr: TvDvr, timers: List<TimerLite>, canRecord: Boolean, now: Long, onRemoved: () -> Unit) {
    val overlay = LocalOverlay.current
    val rules = dvr.rules
    val counts = remember(timers, now / 60_000) {
        timers.filter { it.seriesTimerId != null && it.end > now }.groupingBy { it.seriesTimerId!! }.eachCount()
    }
    Column(Modifier.padding(horizontal = 48.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (canRecord && rules.size > 1) {
            Pill(stringResource(R.string.livetv_scheduled_reorder), onClick = { overlay.show { PrioritiesSheet(dvr, onDismiss = overlay::close) } }, modifier = Modifier.padding(bottom = 10.dp))
        }
        if (rules.isEmpty()) Text(stringResource(R.string.livetv_scheduled_rules_empty), style = Type.body, color = C.label3, modifier = Modifier.padding(vertical = 24.dp))
        for (r in rules) {
            key(r.id()) {
                ListRow(
                    title = r.text("Name").orEmpty(),
                    sub = listOf(ruleSummary(r), episodesText(counts[r.id()] ?: 0)).filter { it.isNotEmpty() }.joinToString(" · "),
                    onClick = { overlay.show { RuleSheet(dvr, r.id(), onDismiss = overlay::close, onRemoved = onRemoved) } },
                )
            }
        }
    }
}

/** One focusable list row of the DVR tabs: focus is `fill-4` + label, no scale (§11). */
@Composable
internal fun ListRow(title: String, sub: String?, onClick: () -> Unit, modifier: Modifier = Modifier, lead: String? = null, trail: (@Composable () -> Unit)? = null) {
    var focused by remember { mutableStateOf(false) }
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 60.dp)
            .tvFocus(RoundedCornerShape(Radius.sm), focusedScale = 1f, sheen = false, elevation = 0.dp, onFocusChange = { focused = it }, onClick = onClick)
            .background(if (focused) C.fill4 else C.fill1)
            .semantics(mergeDescendants = true) { contentDescription = listOfNotNull(lead, title, sub).joinToString(", ") }
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        if (lead != null) Text(lead, style = Type.mono, color = if (focused) C.label else C.label2, maxLines = 1, modifier = Modifier.width(150.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = Type.headline, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!sub.isNullOrEmpty()) Text(sub, style = Type.footnote, color = C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        trail?.invoke()
    }
}

/** One rule: summary, the episodes it scheduled, skip one, edit the rule, delete it ([onRemoved] after a delete). */
@Composable
fun RuleSheet(dvr: TvDvr, ruleId: String, onDismiss: () -> Unit, onRemoved: () -> Unit = onDismiss) {
    val holder = remember { FocusHolder() }
    TvSheet(onDismiss, width = 680.dp) {
        FocusAnchor(holder)
        RuleContent(dvr, ruleId, holder, onDone = onRemoved)
    }
}

/** [onDone] runs after the rule was deleted. */
@Composable
internal fun ColumnScope.RuleContent(dvr: TvDvr, ruleId: String, holder: FocusHolder, onDone: () -> Unit) {
    val context = LocalContext.current
    var editing by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    // Every content swap parks focus first (FocusHolder).
    fun swap(block: () -> Unit) {
        holder.hold()
        block()
    }
    if (editing) return RecordOptionsContent(dvr, RecordTarget.Rule(ruleId), onDone = { swap { editing = false } })
    val timers by dvr.repo.timers.collectAsState()
    val caps by dvr.repo.caps.collectAsState()
    val now = dvr.repo.now()
    val rule = dvr.rules.firstOrNull { it.id() == ruleId }
    val episodes = timers.filter { it.seriesTimerId == ruleId && it.end > now }
    val name = rule?.text("Name").orEmpty()
    LaunchedEffect(ruleId) { if (rule == null) quietly { dvr.loadRules() } }
    val first = remember { FocusRequester() }
    LaunchedEffect(confirming, rule != null) {
        delay(60)
        runCatching { first.requestFocus() }
    }
    val canceled = stringResource(R.string.livetv_toasts_recording_canceled)
    val seriesCanceled = stringResource(R.string.livetv_toasts_series_canceled)

    Text(name, style = Type.title2, color = C.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
    if (rule != null) Text(ruleSummary(rule), style = Type.footnote, color = C.label2, modifier = Modifier.padding(top = 4.dp))
    if (confirming) {
        Text(stringResource(R.string.livetv_scheduled_delete_rule_confirm, name), style = Type.callout, color = C.label2, modifier = Modifier.padding(vertical = 18.dp))
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SheetButton(stringResource(R.string.cancel), onClick = { swap { confirming = false } }, modifier = Modifier.focusRequester(first))
            SheetButton(stringResource(R.string.livetv_scheduled_delete_rule), onClick = {
                if (busy) return@SheetButton
                busy = true
                dvrLaunch(context, { seriesCanceled }, after = { busy = false }) {
                    dvr.deleteRule(ruleId, before = onDone)
                }
            })
        }
        return
    }
    // The actions first: a long episode list must not push them off a 540 dp screen.
    if (caps.canRecord && rule != null) {
        Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Pill(stringResource(R.string.livetv_scheduled_edit_rule), onClick = { swap { editing = true } }, modifier = Modifier.focusRequester(first))
            Pill(stringResource(R.string.livetv_scheduled_delete_rule), onClick = { swap { confirming = true } })
        }
    }
    Text(episodesText(episodes.size), style = Type.headline, color = C.label, modifier = Modifier.padding(top = 16.dp, bottom = 8.dp))
    Column(Modifier.heightIn(max = 200.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (ep in episodes) {
            key(ep.id) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(dayText(ep.start, now) + " · " + timeText(ep.start), style = Type.mono, color = C.label2, maxLines = 1, modifier = Modifier.width(190.dp))
                    Text(ep.name, style = Type.callout, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    if (caps.canRecord) Pill(stringResource(R.string.livetv_scheduled_skip_episode), onClick = {
                        if (!busy) {
                            busy = true
                            // The row goes away: focus waits on the anchor, then returns to the first action.
                            holder.hold()
                            dvrLaunch(context, { canceled }, after = {
                                busy = false
                                runCatching { first.requestFocus() }
                            }) { dvr.cancelTimer(ep.id) }
                        }
                    })
                }
            }
        }
    }
}

/** "Réorganiser les priorités…": pick-up order, saved with Appliquer. */
@Composable
fun PrioritiesSheet(dvr: TvDvr, onDismiss: () -> Unit) {
    val context = LocalContext.current
    var order by remember { mutableStateOf(dvr.rules.sortedByDescending { it.num("Priority") }) }
    var busy by remember { mutableStateOf(false) }
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        delay(60)
        runCatching { first.requestFocus() }
    }
    val done = stringResource(R.string.livetv_toasts_priorities_updated)
    TvSheet(onDismiss, width = 600.dp) {
        Text(stringResource(R.string.livetv_scheduled_reorder), style = Type.title2, color = C.label)
        Text(stringResource(R.string.livetv_scheduled_reorder_hint), style = Type.footnote, color = C.label3, modifier = Modifier.padding(top = 4.dp, bottom = 14.dp))
        Column(Modifier.heightIn(max = 300.dp).verticalScroll(rememberScrollState())) {
            PickupList(order, key = { it.id() }, onMove = { from, to -> order = order.toMutableList().apply { add(to, removeAt(from)) } }) { r, picked, focused ->
                Text("${order.indexOf(r) + 1}", style = Type.mono, color = pickFg(picked, focused), modifier = Modifier.width(32.dp))
                Text(r.text("Name").orEmpty(), style = Type.headline, color = if (picked) C.bg else C.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
        }
        Row(Modifier.padding(top = 20.dp).focusRestorer(first), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Pill(stringResource(R.string.livetv_record_apply), primary = true, modifier = Modifier.focusRequester(first), onClick = {
                if (busy) return@Pill
                busy = true
                val list = order
                dvrLaunch(context, { done }, after = { busy = false }) {
                    val n = list.size
                    // Serially, and only the rules whose value changes (§9.4).
                    list.forEachIndexed { i, r -> if (r.num("Priority") != (n - i).toLong()) dvr.updateRule(r.id(), mapOf("Priority" to JsonPrimitive(n - i)), refresh = false) }
                    dvr.repo.refreshTimers()
                    onDismiss()
                }
            })
            Pill(stringResource(R.string.cancel), onClick = onDismiss)
        }
    }
}

/** "Aujourd'hui", "Demain", else the short date in the UI language. */
@Composable
internal fun dayText(t: Long, now: Long): String {
    val day = dayIndex(t)
    val today = dayIndex(now)
    return when (day) {
        today -> stringResource(R.string.livetv_scheduled_today)
        today + 1 -> stringResource(R.string.livetv_scheduled_tomorrow)
        else -> uiLocale().let { l -> SimpleDateFormat(DateFormat.getBestDateTimePattern(l, "EEEdMMM"), l).format(Date(t)) }
    }
}

/** Local day number (no java.time below API 26, §21.3). */
internal fun dayIndex(t: Long): Long = Math.floorDiv(t + java.util.TimeZone.getDefault().getOffset(t), 86_400_000L)
