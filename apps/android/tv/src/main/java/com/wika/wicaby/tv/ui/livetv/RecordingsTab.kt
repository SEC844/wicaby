package com.wika.wicaby.tv.ui.livetv

import android.view.KeyEvent as AndroidKey
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.json
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.parseServerDate
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.play
import com.wika.wicaby.tv.ui.AlertAction
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.FocusMemory
import com.wika.wicaby.tv.ui.LocalOverlay
import com.wika.wicaby.tv.ui.MediaRow
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.SheetButton
import com.wika.wicaby.tv.ui.Spinner
import com.wika.wicaby.tv.ui.TvAlert
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.remembered
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

// "Enregistrements" on TV (spec §9.5, TV-4): one recordings call grouped on the client into En cours,
// Récemment enregistrés (20 newest), Séries (one row per show), Films, Sport and Autres; OK plays
// through the normal item flow. "Sélectionner" (or Menu) lists them with check marks; one
// confirmation, serialized DELETEs, one summary toast.

private const val RECENT = 20

private class Rec(val dto: JsonObject, val item: Item) {
    val created = parseServerDate(dto.text("DateCreated")) ?: 0L
    val inProgress = dto.text("Status") == "InProgress"
    val series = dto.flag("IsSeries")
}

@Composable
fun RecordingsTab(api: Api, repo: LiveTvRepository, memory: FocusMemory) {
    val context = LocalContext.current
    val overlay = LocalOverlay.current
    val resources = LocalResources.current
    val dvr = remember(repo) { dvrOf(repo) }
    val caps by repo.caps.collectAsState()
    var selecting by rememberSaveable { mutableStateOf(false) }
    var selected by remember { mutableStateOf(emptySet<String>()) }
    LaunchedEffect(repo) {
        launch { quietly { dvr.readPolicy() } }
        quietly { dvr.loadRecordings() }
    }
    val raw = dvr.recordings
    if (raw == null) {
        Box(Modifier.fillMaxWidth().padding(vertical = 48.dp), contentAlignment = Alignment.Center) { Spinner(Modifier.size(28.dp)) }
        return
    }
    val recs = remember(raw) { raw.mapNotNull { o -> runCatching { json.decodeFromJsonElement(Item.serializer(), o) }.getOrNull()?.let { Rec(o, it) } }.sortedByDescending { it.created } }
    if (recs.isEmpty()) {
        Text(stringResource(R.string.livetv_recordings_empty), style = Type.body, color = C.label3, modifier = Modifier.padding(horizontal = 48.dp, vertical = 24.dp))
        return
    }
    val canSelect = caps.canRecord && !selecting
    // The mode pill stays on screen in both modes: focus goes there before the rails or the list go away
    // (a removed focused card would send focus to the top bar).
    val modePill = remember { FocusRequester() }
    fun stop() {
        runCatching { modePill.requestFocus() }
        selecting = false
        selected = emptySet()
    }
    fun start() {
        runCatching { modePill.requestFocus() }
        selecting = true
    }
    fun confirmDelete() {
        val chosen = recs.filter { it.item.id in selected }
        if (chosen.isEmpty()) return
        val res = resources
        overlay.show {
            TvAlert(
                pluralStringResource(R.plurals.livetv_recordings_delete_many, chosen.size, chosen.size),
                stringResource(R.string.livetv_recordings_delete_hint),
                listOf(
                    AlertAction(stringResource(R.string.livetv_recordings_delete), destructive = true) {
                        overlay.close()
                        var done = 0
                        // One at a time: the server deletes files, and a failure stops the rest.
                        dvrLaunch(context, null, after = {
                            if (done > 0) toast(context, res.getQuantityString(R.plurals.livetv_toasts_recordings_deleted, done, done))
                            stop()
                        }) {
                            for (r in chosen) {
                                dvr.deleteRecording(r.item.id)
                                done++
                            }
                        }
                    },
                    AlertAction(stringResource(R.string.cancel)) { overlay.close() },
                ),
                focusIndex = 1,
                onDismiss = overlay::close,
            )
        }
    }

    Column(
        Modifier.fillMaxWidth().onKeyEvent { e ->
            // §9.5: Menu enters the selection mode.
            if (!canSelect || e.nativeKeyEvent.keyCode != AndroidKey.KEYCODE_MENU) return@onKeyEvent false
            if (e.type == KeyEventType.KeyUp) start()
            true
        },
    ) {
        if (caps.canRecord) {
            Row(Modifier.padding(start = 48.dp, bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                // One pill that changes its label keeps focus when the mode flips (a removed focused pill would not).
                Pill(
                    stringResource(if (selecting) R.string.cancel else R.string.livetv_recordings_select),
                    onClick = { if (selecting) stop() else start() }, modifier = Modifier.remembered(memory, "rec-select").focusRequester(modePill),
                )
                if (selecting) Pill(stringResource(R.string.livetv_recordings_delete) + " · " + selected.size, onClick = ::confirmDelete)
            }
        }
        if (selecting) {
            Text(stringResource(R.string.livetv_recordings_select_hint), style = Type.footnote, color = C.label3, modifier = Modifier.padding(start = 48.dp, top = 6.dp, bottom = 10.dp))
            Column(Modifier.padding(horizontal = 48.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (r in recs) {
                    key(r.item.id) {
                        val name = r.item.seriesName?.takeIf { it != r.item.name }?.let { "$it · ${r.item.name}" } ?: r.item.name
                        val day = if (r.created > 0) " · " + dayText(r.created, repo.now()) else ""
                        SheetButton(name + day, centered = false, checked = r.item.id in selected, onClick = {
                            selected = if (r.item.id in selected) selected - r.item.id else selected + r.item.id
                        })
                    }
                }
            }
            return@Column
        }
        val done = recs.filter { !it.inProgress }
        val movies = done.filter { !it.series && it.dto.flag("IsMovie") }
        val sports = done.filter { !it.series && !it.dto.flag("IsMovie") && it.dto.flag("IsSports") }
        val other = done.filter { !it.series && !it.dto.flag("IsMovie") && !it.dto.flag("IsSports") }
        val shows = done.filter { it.series }.groupBy { it.item.seriesId ?: it.item.seriesName ?: it.item.name }.values.sortedBy { (it[0].item.seriesName ?: it[0].item.name).lowercase() }
        val open: (Item) -> Unit = { play(context, it) }
        @Composable
        fun rail(title: String, list: List<Rec>, key: String, wide: Boolean = true) {
            if (list.isNotEmpty()) MediaRow(title, list.map { it.item }, api, memory, "rec-$key", wide = wide, onFocusItem = {}, onClick = open)
        }
        rail(stringResource(R.string.livetv_recordings_sections_in_progress), recs.filter { it.inProgress }, "progress")
        rail(stringResource(R.string.livetv_recordings_sections_recent), done.take(RECENT), "recent")
        if (shows.isNotEmpty()) Text(stringResource(R.string.livetv_recordings_sections_series), style = Type.title2, color = C.label, modifier = Modifier.padding(start = 48.dp, top = 22.dp))
        for (eps in shows) {
            val name = eps[0].item.seriesName ?: eps[0].item.name
            rail(name + " · " + pluralStringResource(R.plurals.livetv_recordings_episodes, eps.size, eps.size), eps, "show-${eps[0].item.seriesId ?: name}")
        }
        rail(stringResource(R.string.livetv_recordings_sections_movies), movies, "movies", wide = false)
        rail(stringResource(R.string.livetv_recordings_sections_sports), sports, "sports")
        rail(stringResource(R.string.livetv_recordings_sections_other), other, "other")
    }
}
