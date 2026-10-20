package com.wika.wicaby.mobile.ui

import android.widget.Toast
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.produceState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.syncplay.SyncGroup
import com.wika.wicaby.core.syncplay.SyncPlay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

// Jellyfin SyncPlay ("Regarder ensemble"), from the detail page and the player: in a group, who is in it and
// Leave; otherwise a new group on [itemId] from [startMs] (read when tapped), or one of the server's groups
// (joining plays the group's item).
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TogetherSheet(api: Api, itemId: String, startMs: () -> Long, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val group = SyncPlay.group
    val groups = produceState<List<SyncGroup>?>(null, api) { value = runCatching { SyncPlay.groups(api) }.getOrDefault(emptyList()) }.value
    fun act(block: suspend () -> Unit) {
        scope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                Toast.makeText(context, Core.str(R.string.syncplay_failed), Toast.LENGTH_SHORT).show()
            }
            onDismiss()
        }
    }
    ModalBottomSheet(onDismiss, containerColor = G.elevated, contentColor = G.label, shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl)) {
        Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 28.dp)) {
            Text(stringResource(R.string.syncplay_title), style = Type.title3, color = G.label, modifier = Modifier.padding(bottom = 16.dp))
            if (group != null) {
                Text(stringResource(R.string.syncplay_members, group.participants.joinToString(", ")), style = Type.body, color = G.label2, modifier = Modifier.padding(bottom = 16.dp))
                Group { GroupRow(stringResource(R.string.syncplay_leave), { SyncPlay.leave(); onDismiss() }, icon = Ic.LogOut, chevron = false) }
            } else {
                Group {
                    GroupRow(stringResource(R.string.syncplay_new), { act { SyncPlay.create(api, Core.str(R.string.syncplay_group_name, Core.deviceName), itemId, startMs()) } }, icon = Ic.Users)
                    groups.orEmpty().forEach { g ->
                        GroupDivider()
                        GroupRow(g.name, { act { SyncPlay.join(api, g.id) } }, subtitle = g.participants.joinToString(", ").ifEmpty { null })
                    }
                }
                if (groups?.isEmpty() == true) Text(stringResource(R.string.syncplay_none), style = Type.footnote, color = G.label2, modifier = Modifier.padding(top = 10.dp, start = 4.dp))
            }
        }
    }
}
