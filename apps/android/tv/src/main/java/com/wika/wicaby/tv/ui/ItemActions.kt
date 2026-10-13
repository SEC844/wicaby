package com.wika.wicaby.tv.ui

import android.content.Context
import android.content.res.Resources
import android.os.SystemClock
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.caps
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ListKind
import com.wika.wicaby.core.data.Playlists
import com.wika.wicaby.core.data.addToList
import com.wika.wicaby.core.data.createList
import com.wika.wicaby.core.data.lists
import com.wika.wicaby.core.data.previousEpisodes
import com.wika.wicaby.tv.R
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// "…" on the item page (desktop's ItemMenu): add to a playlist or a collection, mark the earlier
// episodes as watched. Hidden when the item takes none of them.
@Composable
fun MorePill(api: Api, item: Item, modifier: Modifier = Modifier) {
    val overlay = LocalOverlay.current
    // Playlists and collections live on a server: none for a source whose user data is local (a file source).
    val kinds = if (api.server.caps.localUserData) emptyList() else ListKind.entries.filter { Playlists.accepts(it, item) }
    val previous = item.isEpisode && item.seriesId != null
    if (kinds.isEmpty() && !previous) return
    val label = stringResource(R.string.item_more)
    Pill(null, icon = Ic.More, modifier = modifier.semantics { contentDescription = label }, onClick = {
        overlay.show { ItemActionsSheet(api, item, kinds, previous, overlay::close) }
    })
}

// One sheet, three steps: the actions, then the lists of that kind (with "Nouvelle…" first), then
// the name of the new one on the TV keyboard. Back closes it from any step.
@Composable
private fun ItemActionsSheet(api: Api, item: Item, kinds: List<ListKind>, previous: Boolean, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val res = LocalResources.current
    val scope = rememberCoroutineScope()
    var kind by remember { mutableStateOf<ListKind?>(null) }
    var naming by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val first = remember { FocusRequester() }
    LaunchedEffect(kind) {
        delay(60)
        runCatching { first.requestFocus() }
    }

    // Changes on the server, then every row on show reloads (Cache.changed) and the sheet closes.
    fun submit(added: String, block: suspend () -> Unit) {
        if (busy) return
        busy = true
        scope.launch {
            runCatching { block() }
                .onSuccess {
                    Cache.changed()
                    Toast.makeText(context, res.getString(R.string.list_added, added), Toast.LENGTH_SHORT).show()
                    onDismiss()
                }
                .onFailure {
                    if (it is CancellationException) throw it
                    busy = false
                    Toast.makeText(context, res.getString(R.string.server_pref_failed), Toast.LENGTH_SHORT).show()
                }
        }
    }

    TvSheet(onDismiss, width = 520.dp) {
        val k = kind
        val playlist = k == ListKind.Playlist
        val title = when (k) {
            null -> item.name
            ListKind.Playlist -> stringResource(R.string.add_to_playlist_title)
            ListKind.Collection -> stringResource(R.string.add_to_collection_title)
        }
        Text(title, style = Type.title3, color = C.label, textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth().padding(bottom = 18.dp))
        if (k == null) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                kinds.forEachIndexed { i, it ->
                    SheetButton(
                        stringResource(if (it == ListKind.Playlist) R.string.add_to_playlist else R.string.add_to_collection),
                        icon = Ic.ListAdd, onClick = { kind = it },
                        modifier = if (i == 0) Modifier.focusRequester(first) else Modifier,
                    )
                }
                if (previous) {
                    SheetButton(
                        stringResource(R.string.mark_previous_played), icon = Ic.Check,
                        modifier = if (kinds.isEmpty()) Modifier.focusRequester(first) else Modifier,
                        onClick = {
                            onDismiss()
                            markPrevious(api, item, context.applicationContext, res)
                        },
                    )
                }
            }
        } else if (naming) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                val placeholder = stringResource(if (playlist) R.string.new_playlist_name else R.string.new_collection_name)
                fun create() {
                    val n = name.trim()
                    if (n.isNotEmpty()) submit(n) { api.createList(k, n, item) }
                }
                TvTextField(name, { name = it.take(120) }, placeholder, Modifier.fillMaxWidth(), autoEdit = true, onSubmit = ::create)
                SheetButton(stringResource(R.string.list_create), onClick = ::create)
            }
        } else {
            // A playlist keeps one media type: the others are left out, as on desktop.
            val targets by produceState<List<Item>?>(null, k) {
                value = runCatching { Playlists.targetsFor(k, item, api.lists(k)) }.getOrDefault(emptyList())
            }
            Column(Modifier.heightIn(max = 340.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                SheetButton(
                    stringResource(if (playlist) R.string.new_playlist else R.string.new_collection),
                    icon = Ic.Plus, onClick = { naming = true }, modifier = Modifier.focusRequester(first),
                )
                val list = targets
                when {
                    list == null -> Spinner(Modifier.size(28.dp).align(Alignment.CenterHorizontally))
                    list.isEmpty() -> Text(
                        stringResource(if (playlist) R.string.no_playlists else R.string.no_collections), style = Type.callout, color = C.label3,
                        textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    )
                    else -> list.forEach { t -> SheetButton(t.name, centered = false, onClick = { submit(t.name) { api.addToList(k, t.id, item) } }) }
                }
            }
        }
    }
}

// Desktop's markPlayed: the sheet is already closed, the marking outlives it (Core.scope) under a
// progress toast, then a count toast; every row reloads whatever happened.
private fun markPrevious(api: Api, item: Item, context: Context, res: Resources) {
    Core.scope.launch(Dispatchers.Main) {
        var toast: Toast? = null
        var shownAt = 0L
        fun show(text: String) {
            toast?.cancel()
            toast = Toast.makeText(context, text, Toast.LENGTH_SHORT).also { it.show() }
            shownAt = SystemClock.elapsedRealtime()
        }
        try {
            val n = api.markPlayed(previousEpisodes(api.episodes(item.seriesId!!), item), true) { done, total ->
                // A toast cannot be updated in place: replaced at most every 1.5 s so it stays readable.
                if (done == 0 || SystemClock.elapsedRealtime() - shownAt >= 1500) show(res.getString(R.string.marking_progress, done, total))
            }
            show(res.getQuantityString(R.plurals.marked_watched_count, n, n))
        } catch (e: Exception) {
            show(res.getString(R.string.server_pref_failed))
        } finally {
            Cache.changed()
        }
    }
}
