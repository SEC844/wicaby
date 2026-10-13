package com.wika.wicaby.tv.ui.livetv

import com.wika.wicaby.tv.ui.dpadEdges
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.livetv.ChannelRow
import com.wika.wicaby.core.livetv.GuideClock
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.PendingJump
import com.wika.wicaby.core.livetv.ProgramLite
import com.wika.wicaby.core.livetv.searchPrograms
import com.wika.wicaby.core.livetv.voiceChannels
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.FocusMemory
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.remembered
import kotlinx.coroutines.delay
import java.util.TimeZone

// TP-12, desktop Search.svelte's Live TV section: the library search (typed or spoken) also finds the
// channels (name or number, "chaîne 5", "France deux": core voiceChannels, on the cached lineup) and the
// current or upcoming programmes (core searchPrograms). A channel tunes; a programme opens the guide on it,
// whose OK sheet records it or sets a reminder.

private const val HOUR = 3_600_000L

internal class LiveHits(val repo: LiveTvRepository, val channels: List<ChannelRow>, val programs: List<ProgramLite>) {
    val empty get() = channels.isEmpty() && programs.isEmpty()
}

/** Null while a query of 2+ characters is pending; empty without Live TV ([enabled] = the server has a Live TV view). */
@Composable
internal fun liveHits(api: Api, query: String, enabled: Boolean): LiveHits? {
    val context = LocalContext.current
    val repo = remember(api, enabled) { if (enabled) LiveTv.repo(context, api) else null }
    LaunchedEffect(repo) { repo?.open() }
    val q = query.trim()
    val hits by produceState<LiveHits?>(null, repo, q) {
        value = null
        if (repo == null || q.length < 2) return@produceState
        delay(350)
        repo.loadChannels()
        val hidden = repo.prefs.prefs.value.hidden.toHashSet()
        val now = repo.now()
        val programs = runCatching { repo.searchPrograms(q, now + 7 * 24 * HOUR) }.getOrDefault(emptyList())
        value = LiveHits(repo, voiceChannels(repo.channels.value.filter { it.id !in hidden }, q), programs.filter { it.end > now }.take(12))
    }
    return if (repo == null) null else hits
}

/** The Chaînes and Programmes rows above the library results: Left/Right along a row, Down to the next. */
internal fun LazyGridScope.liveHitRows(hits: LiveHits, memory: FocusMemory) {
    if (hits.channels.isNotEmpty()) item("live-channels", span = { GridItemSpan(maxLineSpan) }) {
        val context = LocalContext.current
        HitRow(stringResource(R.string.livetv_search_channels)) {
            items(hits.channels, key = { it.id }) { r ->
                Pill(
                    "${r.number}  ${r.name}".trim(), icon = Ic.Play, onClick = { LiveTv.tune(context, hits.repo, r.id) },
                    modifier = Modifier.remembered(memory, "live-ch/${r.id}"),
                )
            }
        }
    }
    if (hits.programs.isNotEmpty()) item("live-programs", span = { GridItemSpan(maxLineSpan) }) {
        val now = hits.repo.now()
        val byId = remember(hits) { hits.repo.channels.value.associateBy { it.id } }
        val clock = remember { GuideClock(TimeZone.getDefault()) }
        val onNow = stringResource(R.string.livetv_now_rows_on_now)
        HitRow(stringResource(R.string.livetv_search_programs)) {
            items(hits.programs, key = { "${it.channelId}|${it.id}|${it.start}" }) { p ->
                val whenText = if (p.start <= now) onNow else "${dayLabel(clock, p.start, now)} ${timeText(p.start)}"
                Pill(
                    listOfNotNull(p.title, whenText, byId[p.channelId]?.name).joinToString(" · "),
                    // Main switches to the Live TV tab, which opens the guide focused on the programme.
                    onClick = { LiveTv.guideFor.value = LiveTv.GuideAsk(p.channelId, viaBack = false, jump = PendingJump(p.channelId, p.start, p.id)) },
                    modifier = Modifier.remembered(memory, "live-pg/${p.channelId}|${p.id}|${p.start}"),
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalComposeUiApi::class)
@Composable
private fun HitRow(title: String, content: LazyListScope.() -> Unit) = Column(Modifier.fillMaxWidth()) {
    Text(title, style = Type.title3, color = C.label, modifier = Modifier.padding(bottom = 2.dp))
    LazyRow(
        Modifier.fillMaxWidth().dpadEdges().focusRestorer(),
        contentPadding = PaddingValues(vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        content = content,
    )
}
