package com.wika.wicaby.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.HomeRows
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.tv.R

// TP-07: what the home screen and Réglages > Accueil share about the home rows (core HomeRows).

fun homeUser(api: Api) = "${api.server.id}/${api.userId}"

// The libraries with a "Recently Added" row, as desktop's Home.svelte `libs`: all but playlists, Live TV and folders.
fun latestViews(views: List<Item>) = views.filter { it.collectionType !in setOf("playlists", "livetv", "folders") }

// The servers with Live TV (desktop liveTv.servers): the "Live TV" row only exists when there is one.
fun liveViews(views: List<Item>) = views.filter { it.collectionType == "livetv" }

// [views]: every library of every server (allViews), not only the ones with a tab.
// "Ce jour-là" (photos PH-08) only with a photo library.
fun homeDefaults(views: List<Item>, merged: Boolean) =
    HomeRows.defaults(
        latestViews(views).map { Servers.libraryRef(it) }, merged, live = liveViews(views).isNotEmpty(),
        memories = views.any { it.collectionType in com.wika.wicaby.tv.ui.photos.PHOTO_COLLECTIONS },
    )

@Composable
fun homeRowLabel(id: String, views: List<Item>, merged: Boolean): String = when (id) {
    HomeRows.RESUME -> stringResource(if (merged) com.wika.wicaby.core.R.string.continue_watching_merged else R.string.continue_watching)
    HomeRows.NEXT_UP -> stringResource(R.string.next_up)
    HomeRows.UPCOMING -> stringResource(R.string.row_upcoming)
    HomeRows.BECAUSE -> stringResource(R.string.row_because_any)
    HomeRows.LIVE_NOW -> stringResource(R.string.row_live_now)
    HomeRows.MEMORIES -> stringResource(com.wika.wicaby.core.R.string.photos_memories_title)
    else -> stringResource(R.string.latest_in, views.firstOrNull { Servers.libraryRef(it) == HomeRows.latestViewId(id) }?.let { viewLabel(it, views) }.orEmpty())
}

// Home's "Live TV" card (desktop ChannelTile): the channel logo, the programme on now, the channel.
@Composable
fun LiveNowCard(item: Item, api: Api, focusModifier: Modifier, onFocus: () -> Unit, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val h = dpPx(52.dp)
    Column(Modifier.width(232.dp)) {
        Box(
            Modifier.fillMaxWidth().aspectRatio(16f / 9f).then(focusModifier)
                .tvFocus(RoundedCornerShape(Radius.md), focusedScale = 1.06f, onFocusChange = { focused = it; if (it) onFocus() }, onClick = onClick)
                .background(C.elevated2),
            contentAlignment = Alignment.Center,
        ) {
            val url = remember(item.id) { item.imageTags["Primary"]?.let { Servers.forItem(item, api).image(item.id, "Primary", it, maxHeight = h) } }
            if (url != null) AsyncImage(url, contentDescription = item.name, contentScale = ContentScale.Fit, modifier = Modifier.height(52.dp).width(104.dp))
            else Text(item.name, style = Type.callout, color = C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(12.dp))
        }
        Text(item.currentProgram?.name ?: item.name, style = Type.callout, color = if (focused) C.label else C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 12.dp, start = 2.dp))
        Text(item.name, style = Type.footnote, color = C.label3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp, start = 2.dp))
    }
}
