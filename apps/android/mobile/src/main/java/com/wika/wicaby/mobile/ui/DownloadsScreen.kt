package com.wika.wicaby.mobile.ui

import android.text.format.Formatter
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.wika.wicaby.core.torrents.TorrentsViewModel
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.data.OfflineProgress
import com.wika.wicaby.core.data.poster
import com.wika.wicaby.core.data.runtimeText
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.download.DlState
import com.wika.wicaby.mobile.download.DownloadEntry
import com.wika.wicaby.mobile.download.Downloads
import com.wika.wicaby.mobile.player.PlayerActivity
import java.io.File

@Composable
fun DownloadsScreen(api: Api) {
    val context = LocalContext.current
    val entries by Downloads.entries.collectAsState()
    val used = remember(entries.map { it.state }) { Downloads.usedBytes() }
    val pending by produceState(0, entries) { value = OfflineProgress.pending().size }
    var torrents by rememberSaveable { mutableStateOf(false) }
    // Created and collected only while the Torrents segment shows, so polling stops otherwise.
    val vm: TorrentsViewModel? = if (torrents) viewModel() else null
    val ts = vm?.state?.collectAsStateWithLifecycle()?.value
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().imeAware(), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 24.dp)) {
            item("title") {
                Column {
                    LargeTitle(stringResource(R.string.tab_downloads))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 12.dp)) {
                        Chip(stringResource(R.string.segment_offline), selected = !torrents) { torrents = false }
                        Chip(stringResource(R.string.segment_torrents), selected = torrents) { torrents = true }
                    }
                    if (!torrents && used > 0) Text(stringResource(R.string.storage_used, Formatter.formatShortFileSize(context, used)), style = Type.footnote, color = G.label2)
                    if (!torrents && pending > 0) Text(pluralStringResource(R.plurals.pending_sync, pending, pending), style = Type.footnote, color = G.label3)
                }
            }
            if (vm != null && ts != null) {
                torrentsPane(ts, vm)
            } else if (entries.isEmpty()) {
                item("empty") {
                    Column(Modifier.fillMaxWidth().padding(top = 120.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Ic.Download, null, tint = G.label3, modifier = Modifier.size(40.dp))
                        Text(stringResource(R.string.downloads_empty), style = Type.title3, color = G.label, modifier = Modifier.padding(top = 14.dp))
                        Text(
                            stringResource(R.string.downloads_empty_sub), style = Type.footnote, color = G.label2, textAlign = TextAlign.Center,
                            modifier = Modifier.padding(top = 6.dp).widthIn(max = 300.dp),
                        )
                    }
                }
            }
            if (!torrents) items(entries.sortedBy { it.item.seriesName ?: it.item.name }, key = { it.id }) { e ->
                DownloadRow(api, e, onOpen = {
                    when (e.state) {
                        DlState.Done -> PlayerActivity.start(context, e.id, false, server = Servers.extraOf(e.serverId)?.server?.id)
                        DlState.Failed -> Downloads.retry(context, e.id)
                        else -> {}
                    }
                }, onDelete = { Downloads.delete(context, e.id) })
            }
        }
        if (vm != null && ts != null) TorrentNotice(ts, vm, Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp))
    }
}

@Composable
private fun DownloadRow(api: Api, e: DownloadEntry, onOpen: () -> Unit, onDelete: () -> Unit) {
    val context = LocalContext.current
    val item = e.item
    // Local artwork first: the list must work in airplane mode.
    val art: Any? = remember(e.poster, item.id) { e.poster?.let(::File)?.takeIf { it.exists() } ?: api.poster(item, POSTER_PX) }
    Row(Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(62.dp).aspectRatio(2f / 3f).clip(RoundedCornerShape(Radius.sm)).background(G.elevated2)) {
            if (art != null) AsyncImage(art, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
        Column(Modifier.weight(1f).padding(start = 14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(if (item.isEpisode) item.seriesName ?: item.name else item.name, style = Type.headline, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val sub = if (item.isEpisode) episodeLine(item) else listOfNotNull(item.productionYear?.toString(), runtimeText(item.runTimeTicks)).joinToString("  ·  ")
            if (!sub.isNullOrBlank()) Text(sub, style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val size = { b: Long -> Formatter.formatShortFileSize(context, b) }
            when (e.state) {
                DlState.Done -> Text(stringResource(R.string.downloaded_size, size(e.total)), style = Type.caption, color = G.label3)
                DlState.Failed -> Text(stringResource(R.string.download_failed), style = Type.caption, color = G.red)
                DlState.Queued, DlState.Running -> {
                    ProgressLine(e.fraction, Modifier.padding(top = 4.dp, end = 8.dp), track = G.fill4)
                    Text(
                        if (e.state == DlState.Queued && e.bytes == 0L) stringResource(R.string.download_queued) else stringResource(R.string.download_size, size(e.bytes), size(e.total)),
                        style = Type.caption, color = G.label3,
                    )
                }
            }
        }
        if (e.state == DlState.Done) {
            Box(Modifier.size(36.dp).clip(CircleShape).background(G.fill2), contentAlignment = Alignment.Center) {
                Icon(Ic.Play, stringResource(R.string.play), tint = G.label, modifier = Modifier.size(16.dp))
            }
        }
        IconButton(onDelete) { Icon(Ic.Trash, stringResource(R.string.delete), tint = G.label2, modifier = Modifier.size(20.dp)) }
    }
}
