package com.wika.wicaby.mobile.ui.livetv

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.livetv.Dialect
import com.wika.wicaby.core.livetv.DvrOp
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.ServerKind
import com.wika.wicaby.core.livetv.parseServerDate
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.player.PlayerActivity
import com.wika.wicaby.mobile.ui.Centered
import com.wika.wicaby.mobile.ui.ErrorState
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.PillButton
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.Spinner
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.uiLocale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.JsonObject
import java.text.DateFormat
import java.util.Date

// Enregistrements on mobile (spec §9.5, work package M-3): one recordings call plus the in-progress
// ones, grouped on the client. A tap plays through the normal item flow; a long-press starts the
// multi-select, and deletes run one after the other behind one confirmation and one summary toast.

/** The §9.5 sections. Series are one group per show (SeriesId, else SeriesName, else the title). */
internal class RecordingGroups(
    val inProgress: List<JsonObject>,
    val recent: List<JsonObject>,
    val series: List<Pair<String, List<JsonObject>>>,
    val movies: List<JsonObject>,
    val sports: List<JsonObject>,
    val other: List<JsonObject>,
) {
    val isEmpty get() = inProgress.isEmpty() && recent.isEmpty()
}

private fun JsonObject.created(): Long = parseServerDate(s("DateCreated")) ?: parseServerDate(s("StartDate")) ?: 0L

// shortcut: grouping trusts the Is* flags and SeriesName (V9 open); add the 4 category queries if a server sends neither.
internal fun groupRecordings(all: List<JsonObject>, inProgressIds: Set<String>): RecordingGroups {
    val sorted = all.distinctBy { it.s("Id") }.sortedByDescending { it.created() }
    val (live, done) = sorted.partition { it.s("Id") in inProgressIds || it.s("Status") == "InProgress" }
    val series = LinkedHashMap<String, MutableList<JsonObject>>()
    val movies = ArrayList<JsonObject>()
    val sports = ArrayList<JsonObject>()
    val other = ArrayList<JsonObject>()
    for (r in done) when {
        r.b("IsMovie") || r.s("Type") == "Movie" -> movies += r
        r.b("IsSports") -> sports += r
        r.b("IsSeries") || r.s("SeriesName") != null || r.s("SeriesId") != null || r.s("Type") == "Episode" ->
            series.getOrPut(r.s("SeriesId") ?: r.s("SeriesName") ?: r.s("Name").orEmpty()) { ArrayList() } += r
        else -> other += r
    }
    return RecordingGroups(live, done.take(20), series.map { (k, v) -> k to v }, movies, sports, other)
}

private suspend fun loadRecordings(repo: LiveTvRepository): Pair<List<JsonObject>, Set<String>> = coroutineScope {
    val kind = repo.api.kind
    val uid = repo.api.userId
    val live = async { items(repo.dvr(DvrOp.RECORDINGS, Dialect.recordings(kind, uid, inProgress = true))) }
    val all = items(repo.dvr(DvrOp.RECORDINGS, Dialect.recordings(kind, uid)))
    val inProgress = live.await()
    (inProgress + all) to inProgress.mapNotNull { it.s("Id") }.toSet()
}

/** Jellyfin answers 404/405 on the Live TV route for some recordings: DELETE /Items/{id} then (§5.2). */
private suspend fun deleteRecording(repo: LiveTvRepository, id: String) {
    val kind = repo.api.kind
    try {
        repo.dvr(DvrOp.DELETE_RECORDING, Dialect.deleteRecording(kind, id))
    } catch (e: DvrFailure) {
        if (kind != ServerKind.JELLYFIN || (e.status != 404 && e.status != 405)) throw e
        repo.dvr(DvrOp.DELETE_RECORDING, Dialect.deleteItem(kind, id))
    }
}

@Composable
fun Recordings(repo: LiveTvRepository, nonce: Int) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val caps by repo.caps.collectAsState()
    var ver by remember { mutableIntStateOf(0) }
    var data by remember { mutableStateOf<Pair<List<JsonObject>, Set<String>>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<Set<String>?>(null) } // non-null = select mode
    var confirm by remember { mutableStateOf<List<JsonObject>?>(null) }
    var open by remember { mutableStateOf(setOf<String>()) } // expanded shows
    val busy = remember { mutableStateOf(false) }
    LaunchedEffect(repo) { checkRecordPolicy(repo) }
    LaunchedEffect(nonce, ver) {
        failed = false
        try {
            data = loadRecordings(repo)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            failed = true
        }
    }
    val d = data ?: return Centered { if (failed) ErrorState({ ver++ }) else Spinner() }
    val groups = remember(d) { groupRecordings(d.first, d.second) }
    val byId = remember(d) { d.first.associateBy { it.s("Id") } }
    val sel = selected
    val canDelete = caps.canRecord

    fun tap(r: JsonObject) {
        val id = r.s("Id") ?: return
        if (sel != null) selected = if (id in sel) sel - id else sel + id
        else PlayerActivity.start(context, id, fromStart = false, server = Servers.extraOf(repo.api.serverId)?.server?.id)
    }
    fun press(r: JsonObject) {
        val id = r.s("Id") ?: return
        if (canDelete) selected = (sel ?: emptySet()) + id
    }

    Column(Modifier.fillMaxSize()) {
        if (sel != null) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(pluralStringResource(R.plurals.livetv_recordings_selected, sel.size, sel.size), style = Type.headline, color = G.label, modifier = Modifier.weight(1f))
                PillButton(stringResource(R.string.cancel), { selected = null }, compact = true)
                if (sel.isNotEmpty()) PillButton(stringResource(R.string.delete), { confirm = sel.mapNotNull(byId::get) }, icon = Ic.Trash, compact = true)
            }
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            if (groups.isEmpty) item {
                Text(
                    stringResource(R.string.livetv_recordings_empty), style = Type.body, color = G.label2, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 48.dp),
                )
            }
            section("live", R.string.livetv_recordings_sections_in_progress, groups.inProgress, sel, ::tap, ::press)
            section("recent", R.string.livetv_recordings_sections_recent, groups.recent, sel, ::tap, ::press)
            if (groups.series.isNotEmpty()) {
                header("series", R.string.livetv_recordings_sections_series)
                for ((key, eps) in groups.series) {
                    val expanded = key in open
                    item(key = "show-$key", contentType = "show") {
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 56.dp)
                                .combinedClickable(role = Role.Button, onClick = { open = if (expanded) open - key else open + key })
                                .padding(horizontal = 20.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(eps.first().let { it.s("SeriesName") ?: it.s("Name").orEmpty() }, style = Type.headline, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(pluralStringResource(R.plurals.livetv_recordings_episodes, eps.size, eps.size), style = Type.footnote, color = G.label2)
                            }
                            Icon(Ic.ChevronDown, null, tint = G.label2, modifier = Modifier.size(18.dp).rotate(if (expanded) 180f else 0f))
                        }
                    }
                    if (expanded) items(eps, key = { "s-" + it.s("Id") }, contentType = { "recording" }) { RecordingRow(it, sel, ::tap, ::press, inset = true) }
                }
            }
            section("movies", R.string.livetv_recordings_sections_movies, groups.movies, sel, ::tap, ::press)
            section("sports", R.string.livetv_recordings_sections_sports, groups.sports, sel, ::tap, ::press)
            section("other", R.string.livetv_recordings_sections_other, groups.other, sel, ::tap, ::press)
        }
    }

    confirm?.let { list ->
        val deletedMsg = { n: Int -> context.resources.getQuantityString(R.plurals.livetv_toasts_recordings_deleted, n, n) }
        AlertDialog(
            onDismissRequest = { confirm = null },
            containerColor = G.elevated2,
            shape = RoundedCornerShape(Radius.lg),
            text = {
                Text(
                    if (list.size == 1) stringResource(R.string.livetv_recordings_delete_confirm, list[0].s("Name").orEmpty())
                    else pluralStringResource(R.plurals.livetv_recordings_delete_many, list.size, list.size),
                    style = Type.body, color = G.label,
                )
            },
            confirmButton = {
                PillButton(stringResource(R.string.delete), {
                    confirm = null
                    launchDvr(scope, context, busy) {
                        val gone = HashSet<String>()
                        try {
                            // Serialized: one DELETE after the other; the first failure stops the run.
                            for (r in list) {
                                val id = r.s("Id") ?: continue
                                deleteRecording(repo, id)
                                gone += id
                            }
                        } finally {
                            if (gone.isNotEmpty()) {
                                toast(context, deletedMsg(gone.size))
                                data = d.first.filter { it.s("Id") !in gone } to (d.second - gone)
                            }
                            selected = null
                        }
                    }
                }, icon = Ic.Trash, compact = true)
            },
            dismissButton = { PillButton(stringResource(R.string.cancel), { confirm = null }, compact = true) },
        )
    }
}

private fun LazyListScope.header(key: String, label: Int) = item(key = "h-$key", contentType = "header") {
    Text(stringResource(label), style = Type.title3, color = G.label, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 6.dp))
}

private fun LazyListScope.section(key: String, label: Int, list: List<JsonObject>, sel: Set<String>?, tap: (JsonObject) -> Unit, press: (JsonObject) -> Unit) {
    if (list.isEmpty()) return
    header(key, label)
    items(list, key = { "$key-" + it.s("Id") }, contentType = { "recording" }) { RecordingRow(it, sel, tap, press) }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RecordingRow(r: JsonObject, sel: Set<String>?, tap: (JsonObject) -> Unit, press: (JsonObject) -> Unit, inset: Boolean = false) {
    val fmt = rememberTimeFormat()
    val picked = sel != null && r.s("Id") in sel
    val start = parseServerDate(r.s("StartDate"))
    val locale = uiLocale()
    val day = remember(locale) { DateFormat.getDateInstance(DateFormat.MEDIUM, locale) }
    val aired = start?.let { day.format(Date(it)) + " " + fmt(it) }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 60.dp)
            .then(if (picked) Modifier.background(G.fill4) else Modifier)
            .combinedClickable(role = Role.Button, onClick = { tap(r) }, onLongClick = { press(r) })
            .padding(start = if (inset) 36.dp else 20.dp, end = 20.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(r.s("Name").orEmpty(), style = Type.headline, color = G.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
            r.s("EpisodeTitle")?.let { Text(it, style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            listOfNotNull(r.s("ChannelName"), aired).joinToString(" · ").takeIf { it.isNotEmpty() }?.let {
                Text(it, style = Type.caption, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (sel != null) Icon(if (picked) Ic.CircleCheck else Ic.Check, null, tint = if (picked) G.label else G.label3, modifier = Modifier.size(22.dp))
    }
}
