package com.wika.wicaby.tv.ui

import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.syncplay.SyncGroup
import com.wika.wicaby.core.syncplay.SyncPlay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Jellyfin SyncPlay ("Regarder ensemble"): the detail page's pill and sheet; the player has its own panel
// on the same helpers.

/** The server's groups, loaded once (null while loading, empty on failure). */
@Composable
fun rememberSyncGroups(api: Api): State<List<SyncGroup>?> = produceState<List<SyncGroup>?>(null, api) {
    value = runCatching { SyncPlay.groups(api) }.getOrDefault(emptyList())
}

/** A group label: its name and who is in it. */
fun SyncGroup.label() = if (participants.isEmpty()) name else "$name · ${participants.joinToString(", ")}"

/** Runs a create or join, a toast on failure; [done] after either. */
fun syncAct(scope: CoroutineScope, context: Context, done: () -> Unit, block: suspend () -> Unit) {
    scope.launch {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            Toast.makeText(context, Core.str(R.string.syncplay_failed), Toast.LENGTH_SHORT).show()
        }
        done()
    }
}

fun syncGroupName() = Core.str(R.string.syncplay_group_name, Core.deviceName)

@Composable
fun TogetherPill(api: Api, itemId: String, startMs: Long, modifier: Modifier) {
    val overlay = LocalOverlay.current
    Pill(null, icon = Ic.Group, description = stringResource(R.string.syncplay_title), modifier = modifier, onClick = {
        overlay.show { TogetherSheet(api, itemId, startMs, overlay::close) }
    })
}

// In a group: who is in it and Leave. Otherwise: a new group on this item, or one of the server's groups
// (joining plays the group's item).
@Composable
private fun TogetherSheet(api: Api, itemId: String, startMs: Long, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val group = SyncPlay.group
    val groups = rememberSyncGroups(api).value
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        delay(60)
        runCatching { first.requestFocus() }
    }
    TvSheet(onDismiss, width = 520.dp) {
        Text(stringResource(R.string.syncplay_title), style = Type.title3, color = C.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(bottom = 18.dp))
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (group != null) {
                Text(stringResource(R.string.syncplay_members, group.participants.joinToString(", ")), style = Type.callout, color = C.label2, modifier = Modifier.padding(bottom = 12.dp))
                SheetButton(stringResource(R.string.syncplay_leave), icon = Ic.Logout, modifier = Modifier.focusRequester(first), onClick = {
                    SyncPlay.leave()
                    onDismiss()
                })
            } else {
                SheetButton(stringResource(R.string.syncplay_new), icon = Ic.Group, modifier = Modifier.focusRequester(first), onClick = {
                    syncAct(scope, context, onDismiss) { SyncPlay.create(api, syncGroupName(), itemId, startMs) }
                })
                if (groups?.isEmpty() == true) Text(stringResource(R.string.syncplay_none), style = Type.callout, color = C.label2, modifier = Modifier.padding(top = 8.dp))
                groups.orEmpty().forEach { g ->
                    SheetButton(g.label(), icon = Ic.Person, onClick = { syncAct(scope, context, onDismiss) { SyncPlay.join(api, g.id) } })
                }
            }
        }
    }
}
