package com.wika.wicaby.tv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.tv.LocalApi
import com.wika.wicaby.tv.LocalNav
import kotlinx.coroutines.delay

// TP-06: several servers on TV. The primary server keeps the whole app as before; a screen of an
// extra server (a title, a folder, a library tab) runs under ServerScope.

// Cache keys of an extra server's screens start with its id: Emby ids clash across servers. "" for the primary.
val LocalCacheNs = staticCompositionLocalOf { "" }

// [serverId] null: the primary, nothing changes. An extra server that was removed meanwhile shows nothing (Back leaves).
@Composable
fun ServerScope(serverId: String?, content: @Composable () -> Unit) {
    if (serverId == null) return content()
    val api = Servers.extraOf(serverId) ?: return
    CompositionLocalProvider(LocalApi provides api, LocalCacheNs provides "${api.server.id}/", content = content)
}

// "Disponible sur 2 serveurs" on the item page (desktop Item.svelte): OK opens the server picker, and
// the page switches to that server's copy, which Lecture then plays. Nothing with a single server.
@Composable
fun CopiesPill(api: Api, item: Item, modifier: Modifier = Modifier) {
    val copies by produceState(emptyList<Item>(), item.id, api) { value = runCatching { Servers.copies(item, api) }.getOrDefault(emptyList()) }
    if (copies.size < 2) return
    val overlay = LocalOverlay.current
    val nav = LocalNav.current
    val label = pluralStringResource(com.wika.wicaby.core.R.plurals.item_copies_available_on, copies.size, copies.size)
    Pill(label, icon = Ic.Server, modifier = modifier, onClick = {
        overlay.show {
            ServerPicker(label, copies, current = api.server.id, onDismiss = overlay::close) { c ->
                overlay.close()
                if (c.serverId != api.server.id) {
                    nav.pop()
                    nav.push(c.route())
                }
            }
        }
    })
}

@Composable
private fun ServerPicker(title: String, copies: List<Item>, current: String, onDismiss: () -> Unit, onPick: (Item) -> Unit) {
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        delay(60)
        runCatching { first.requestFocus() }
    }
    TvSheet(onDismiss, width = 460.dp) {
        Text(title, style = Type.title3, color = C.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(bottom = 18.dp))
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            copies.forEach { c ->
                val mine = c.serverId == current
                SheetButton(
                    Servers.of(c.serverId)?.server?.name ?: c.serverId.orEmpty(), icon = Ic.Server, checked = mine, onClick = { onPick(c) },
                    modifier = if (mine) Modifier.focusRequester(first) else Modifier,
                )
            }
        }
    }
}

// The primary's libraries, then each extra server's (Live TV stays with the primary). Alone, api.views() as is.
suspend fun allViews(api: Api): List<Item> {
    val others = Servers.online.filter { it.server.id != api.server.id }
    if (others.isEmpty()) return api.views()
    return com.wika.wicaby.core.music.MusicSource.apply(api.views() + Servers.fanOut(others) { it.views() }.flatMap { it.orEmpty() }.filter { it.collectionType != "livetv" })
}

// "Films · Home" when another server has a library of the same name (desktop Home.svelte libLabel).
fun viewLabel(v: Item, views: List<Item>): String =
    if (views.any { it.name == v.name && it.serverId != v.serverId }) "${v.name} · ${Servers.of(v.serverId)?.server?.name ?: v.serverId}" else v.name
