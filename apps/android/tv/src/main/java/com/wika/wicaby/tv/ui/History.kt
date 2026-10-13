package com.wika.wicaby.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.WatchHistory
import com.wika.wicaby.core.data.runtimeText
import com.wika.wicaby.tv.LocalApi
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.play
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import com.wika.wicaby.core.R as CR

// TP-08: desktop's History page (renderer/routes/History.svelte), opened from the profile menu:
// stats over the loaded history, then one row per day. A card opens Play / More Info / Remove.
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun HistoryScreen() {
    val api = LocalApi.current ?: return
    val context = LocalContext.current
    val nav = LocalNav.current
    val overlay = LocalOverlay.current
    val scope = rememberCoroutineScope()
    val memory = rememberFocusMemory()
    val load = rememberLoad("history") { WatchHistory.load(api) }.value
    // Removed this visit: gone at once, the reload after Cache.changed() agrees.
    val removed = remember { mutableStateListOf<String>() }
    val items = remember(load.value, removed.size) { load.value?.items?.filterNot { Servers.key(it) in removed } }
    val groups = remember(items) { WatchHistory.groupByDay(items.orEmpty()) }
    val stats = remember(items) { WatchHistory.stats(items.orEmpty(), load.value?.seriesGenres.orEmpty()) }
    val list = remember { FocusRequester() }
    // Desktop showServer={multi}: with several servers signed in, each card names its server.
    val serverLine: (@Composable (Item) -> String?)? = if (!Servers.multi) null else { item ->
        listOfNotNull(episodeLine(item) ?: item.productionYear?.toString(), Servers.of(item.serverId)?.server?.name).joinToString(" · ")
    }
    // First visit: focus starts on the newest card.
    if (memory.key == null) groups.firstOrNull()?.let { (day, l) -> memory.key = "day-$day/${Servers.key(l.first())}" }

    fun confirmRemove(item: Item) = overlay.show(list) {
        TvAlert(
            stringResource(CR.string.history_remove_title),
            stringResource(CR.string.history_remove_body, item.seriesName?.takeIf { item.isEpisode }?.let { "$it · ${item.name}" } ?: item.name),
            listOf(
                AlertAction(stringResource(CR.string.history_remove), destructive = true) {
                    overlay.close()
                    removed += Servers.key(item)
                    scope.launch {
                        // Marking it unplayed is what clears the server's last play date (both servers), on the item's own server.
                        val a = Servers.forItem(item, api)
                        runCatching { a.setPlayed(item.id, false) }.onSuccess {
                            Cache.changed()
                            com.wika.wicaby.core.trakt.TraktService.shared.history(a, item, false) // B25: its latest Trakt play goes too
                        }.onFailure { removed -= Servers.key(item) }
                        delay(80)
                        runCatching { list.requestFocus() }
                    }
                },
                AlertAction(stringResource(R.string.cancel)) { overlay.close() },
            ),
            focusIndex = 1, onDismiss = overlay::close,
        )
    }
    fun menu(item: Item) = overlay.show {
        TvAlert(
            item.seriesName?.takeIf { item.isEpisode } ?: item.name, episodeLine(item),
            listOf(
                AlertAction(stringResource(if (item.resumeMs > 0) R.string.resume else R.string.play)) { overlay.close(); play(context, item) },
                AlertAction(stringResource(R.string.more_info)) { overlay.close(); nav.push(item.route()) },
                AlertAction(stringResource(CR.string.history_remove), destructive = true) { overlay.close(); confirmRemove(item) },
            ),
            focusIndex = 0, onDismiss = overlay::close,
        )
    }

    val listState = rememberLazyListState()
    val pivot = remember { PivotSpec(0.3f) }
    Box(Modifier.fillMaxSize().background(C.bg)) {
        when {
            load.error != null && items == null -> Centered { ErrorState { Cache.changed() } }
            items == null -> Centered { Spinner() }
            groups.isEmpty() -> Centered { Empty() }
        }
        if (groups.isEmpty()) return@Box
        CompositionLocalProvider(LocalBringIntoViewSpec provides pivot) {
            LazyColumn(state = listState, modifier = Modifier.fillMaxSize().focusRequester(list).focusRestorer(), contentPadding = PaddingValues(top = 44.dp, bottom = 80.dp)) {
                item("head") {
                    Column(Modifier.padding(start = 48.dp, end = 48.dp, bottom = 6.dp)) {
                        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            Text(stringResource(CR.string.history), style = Type.largeTitle, color = C.label)
                            val total = groups.sumOf { it.second.size }
                            Text(pluralStringResource(R.plurals.items_count, total, total), style = Type.callout, color = C.label3, modifier = Modifier.padding(bottom = 6.dp))
                        }
                        Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Stat(stringResource(CR.string.history_week), duration(stats.weekMs))
                            Stat(stringResource(CR.string.history_month), duration(stats.monthMs))
                            if (stats.genres.isNotEmpty()) Stat(stringResource(CR.string.history_top_genres), stats.genres.joinToString(", "), wide = true)
                        }
                    }
                }
                groups.forEach { (day, dayItems) ->
                    item("day-$day") {
                        MediaRow(dayLabel(day), dayItems, api, memory, "day-$day", wide = true, onFocusItem = {}, onClick = ::menu, subtitle = serverLine)
                    }
                }
            }
        }
    }
}

@Composable
private fun Stat(label: String, value: String, wide: Boolean = false) {
    Column(Modifier.clip(RoundedCornerShape(Radius.md)).background(C.fill2).padding(horizontal = 16.dp, vertical = 12.dp).widthIn(min = 150.dp, max = if (wide) 420.dp else 220.dp)) {
        Text(label, style = Type.footnote, color = C.label3)
        Text(value, style = if (wide) Type.callout else Type.title3, color = C.label, maxLines = 2, modifier = Modifier.padding(top = 4.dp))
    }
}

@Composable
private fun Empty() {
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.widthIn(max = 460.dp)) {
        Box(Modifier.size(72.dp).clip(CircleShape).background(C.fill2), contentAlignment = Alignment.Center) {
            Icon(Ic.History, null, tint = C.label2, modifier = Modifier.size(30.dp))
        }
        Text(stringResource(CR.string.history_empty_title), style = Type.title2, color = C.label, modifier = Modifier.padding(top = 16.dp))
        Text(stringResource(CR.string.history_empty_body), style = Type.callout, color = C.label3, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 6.dp))
    }
}

@Composable
private fun duration(ms: Long): String = runtimeText(ms * TICKS_PER_MS) ?: stringResource(CR.string.duration_minutes, 0)

// "Aujourd'hui", "Hier", then "Lundi 5 octobre" (the year only when it is not this one), as on desktop.
@Composable
private fun dayLabel(day: Long): String {
    when (WatchHistory.daysAgo(day)) {
        0 -> return stringResource(CR.string.history_today)
        1 -> return stringResource(CR.string.history_yesterday)
    }
    val locale = uiLocale()
    val year = { ms: Long -> Calendar.getInstance().apply { timeInMillis = ms }.get(Calendar.YEAR) }
    val skeleton = if (year(day) != year(System.currentTimeMillis())) "EEEEdMMMMy" else "EEEEdMMMM"
    val pattern = android.text.format.DateFormat.getBestDateTimePattern(locale, skeleton)
    return SimpleDateFormat(pattern, locale).format(Date(day)).replaceFirstChar { it.titlecase(locale) }
}
