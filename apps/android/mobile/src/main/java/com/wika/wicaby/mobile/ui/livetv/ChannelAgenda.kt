package com.wika.wicaby.mobile.ui.livetv

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.livetv.ChannelRow
import com.wika.wicaby.core.livetv.DayChip
import com.wika.wicaby.core.livetv.GuideClock
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.ProgramLite
import com.wika.wicaby.core.livetv.Viewport
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.ui.Centered
import com.wika.wicaby.mobile.ui.Chip
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.PillButton
import com.wika.wicaby.mobile.ui.TopBar
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.uiLocale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.TimeZone
import com.wika.wicaby.core.R as CoreR

// A channel's agenda (spec §3.2): a day strip over a pager of days (a horizontal swipe changes the
// day, §10.3), each a vertical list of programmes. The airing one is marked; a tap opens the programme sheet.

@Composable
fun ChannelAgenda(repo: LiveTvRepository, ch: ChannelRow, onBack: () -> Unit) {
    val context = LocalContext.current
    val now by rememberNow(repo)
    val clock = remember { GuideClock(TimeZone.getDefault()) }
    val todayKey = clock.dayKey(now)
    val days = remember(todayKey) { clock.dayChips(now) }
    val pager = rememberPagerState { days.size }
    val scope = rememberCoroutineScope()
    val ver by repo.guideVersion.collectAsState()
    LaunchedEffect(pager.settledPage, days) {
        val d = days[pager.settledPage.coerceIn(days.indices)]
        repo.setViewport(Viewport(listOf(ch.id), 0, 0, d.start, d.end, repo.tuning))
    }

    Column(Modifier.fillMaxSize()) {
        TopBar(ch.name, onBack)
        Row(Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) {
            PillButton(stringResource(R.string.livetv_sheet_watch_channel), { tune(context, repo, ch.id) }, icon = Ic.Play, primary = true, compact = true)
        }
        val labels = dayLabels(days)
        LazyRow(contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            itemsIndexed(days, key = { _, d -> d.key }) { i, _ ->
                Chip(labels[i], selected = pager.currentPage == i) { scope.launch { pager.animateScrollToPage(i) } }
            }
        }
        HorizontalPager(pager, key = { days[it].key }, modifier = Modifier.fillMaxSize()) { page ->
            DayList(repo, ch, days[page], now, ver)
        }
    }
}

/** Aujourd’hui, Demain, then the short local date ("ven. 16 oct."). */
@Composable
private fun dayLabels(days: List<DayChip>): List<String> {
    val locale = uiLocale()
    val today = stringResource(R.string.livetv_guide_today)
    val tomorrow = stringResource(R.string.livetv_guide_tomorrow)
    return remember(days, locale, today, tomorrow) {
        val f = SimpleDateFormat(android.text.format.DateFormat.getBestDateTimePattern(locale, "EEEdMMM"), locale)
        days.map {
            when (it.index) {
                0 -> today
                1 -> tomorrow
                else -> f.format(Date(it.start))
            }
        }
    }
}

@Composable
private fun DayList(repo: LiveTvRepository, ch: ChannelRow, day: DayChip, now: Long, ver: Long) {
    val fmt = rememberTimeFormat()
    val progs = remember(ch.id, day, ver) { repo.programs(ch.id, day.start, day.end) }
    val list = rememberLazyListState()
    // Today opens on the airing programme, once it is known.
    var placed by remember(day) { mutableStateOf(false) }
    LaunchedEffect(day, progs) {
        if (placed || progs.isEmpty()) return@LaunchedEffect
        val i = progs.indexOfFirst { it.end > now }
        // Today's slabs land one tile at a time: wait for the one holding the airing programme.
        if (i < 0 && now < day.end) return@LaunchedEffect
        placed = true
        if (i > 0) list.scrollToItem(i)
    }
    if (progs.isEmpty()) {
        // Give the tiles a moment before saying there is nothing (no spinner flash on a warm cache).
        var settled by remember(day) { mutableStateOf(false) }
        LaunchedEffect(day) {
            delay(2_000)
            settled = true
        }
        Centered {
            when {
                repo.rowFailed(ch.id, day.start, day.end) ->
                    PillButton(stringResource(CoreR.string.livetv_guide_retry), { repo.retryRow(ch.id) }, icon = Ic.Refresh)
                settled -> Text(stringResource(CoreR.string.livetv_guide_no_info), style = Type.body, color = G.label2, textAlign = TextAlign.Center)
            }
        }
        return
    }
    var sheet by remember { mutableStateOf<ProgramLite?>(null) }
    val overlay by repo.overlay.collectAsState()
    LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 24.dp)) {
        items(progs, key = { it.id }, contentType = { "program" }) { p ->
            val airing = p.start <= now && p.end > now
            val past = p.end <= now
            Row(
                Modifier.fillMaxWidth().heightIn(min = 60.dp)
                    .then(if (airing) Modifier.background(G.fill2) else Modifier)
                    .clickable(role = Role.Button) { sheet = p }
                    .padding(horizontal = 20.dp, vertical = 10.dp),
            ) {
                // §21.7: label-3 misses 4.5:1, so past rows keep label-2 and carry a full progress line as the "past" cue.
                Text(fmt(p.start), style = Type.mono, color = G.label2, maxLines = 1, modifier = Modifier.width(72.dp))
                Column(Modifier.weight(1f)) {
                    Text(p.title, style = Type.headline, color = if (past) G.label2 else G.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    p.episodeTitle?.let { Text(it, style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    if (airing || past) ProgramProgress(p, now, Modifier.padding(top = 6.dp).width(140.dp))
                }
                // M-3: the recording mark, from the timers overlay (no programme refetch, §7.2).
                overlay[p.id]?.let { StatusPill(it.status, Modifier.padding(start = 8.dp)) }
            }
        }
    }
    sheet?.let { p -> ProgramSheet(repo, ch, p, now, onDismiss = { sheet = null }) }
}

/** Tap on a programme (§10.3): its times and episode; "Regarder la chaîne" while it airs. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ProgramSheet(repo: LiveTvRepository, ch: ChannelRow, p: ProgramLite, now: Long, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val fmt = rememberTimeFormat()
    ModalBottomSheet(onDismiss, containerColor = G.elevated, contentColor = G.label) {
        Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 28.dp)) {
            Text(ch.name, style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(p.title, style = Type.title3, color = G.label, modifier = Modifier.padding(top = 4.dp))
            p.episodeTitle?.let { Text(it, style = Type.body, color = G.label2, modifier = Modifier.padding(top = 2.dp)) }
            Text("${fmt(p.start)} – ${fmt(p.end)}", style = Type.mono, color = G.label2, modifier = Modifier.padding(top = 8.dp))
            if (p.start <= now && p.end > now) {
                ProgramProgress(p, now, Modifier.padding(top = 8.dp).width(160.dp))
                PillButton(
                    stringResource(R.string.livetv_sheet_watch_channel), { onDismiss(); tune(context, repo, ch.id) },
                    Modifier.padding(top = 18.dp), icon = Ic.Play, primary = true,
                )
            }
            RecordActions(repo, p, now, Modifier.padding(top = 14.dp))
        }
    }
}
