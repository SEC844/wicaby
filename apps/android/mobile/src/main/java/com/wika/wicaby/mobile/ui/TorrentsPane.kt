package com.wika.wicaby.mobile.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.torrents.QbitConnection
import com.wika.wicaby.core.torrents.Torrent
import com.wika.wicaby.core.torrents.TorrentFilter
import com.wika.wicaby.core.torrents.TorrentsState
import com.wika.wicaby.core.torrents.TorrentsViewModel
import com.wika.wicaby.core.torrents.formatBytes
import com.wika.wicaby.core.torrents.formatEta
import com.wika.wicaby.core.torrents.formatPercent
import com.wika.wicaby.core.torrents.formatSpeed
import com.wika.wicaby.mobile.R
import kotlinx.coroutines.delay

// qBittorrent, drawn from core's TorrentsViewModel state; all logic lives there.
fun LazyListScope.torrentsPane(s: TorrentsState, vm: TorrentsViewModel) {
    if (!s.ready) return
    if (s.connection == QbitConnection.Unconfigured) {
        item("qbit-setup") { QbitSetup(s, vm) }
        return
    }
    item("qbit-head") { QbitHeader(s, vm) }
    if (s.torrents.isEmpty()) {
        item("qbit-empty") { Text(stringResource(s.filter.emptyRes), style = Type.body, color = G.label2, modifier = Modifier.padding(vertical = 40.dp)) }
    }
    items(s.torrents, key = { it.hash }, contentType = { "torrent" }) { t -> TorrentRow(t, t.hash in s.pending, vm) }
    item("qbit-foot") {
        Group(Modifier.padding(top = 24.dp)) {
            GroupRow(stringResource(R.string.qbit_disconnect), { vm.disconnect() }, icon = Ic.LogOut, titleColor = G.red, chevron = false)
        }
    }
}

// The view model's one-shot messages ("Torrent ajouté", errors), as a transient pill.
@Composable
fun TorrentNotice(s: TorrentsState, vm: TorrentsViewModel, modifier: Modifier) {
    val text = s.notice
    LaunchedEffect(text) {
        if (text != null) {
            delay(2_600)
            vm.consumeNotice()
        }
    }
    AnimatedVisibility(text != null, enter = fadeIn(), exit = fadeOut(), modifier = modifier) {
        Text(text.orEmpty(), style = Type.callout, color = G.label, modifier = Modifier.clip(CircleShape).background(G.raised).padding(horizontal = 18.dp, vertical = 10.dp))
    }
}

@Composable
private fun QbitSetup(s: TorrentsState, vm: TorrentsViewModel) {
    var url by rememberSaveable { mutableStateOf(s.config?.url.orEmpty()) }
    var user by rememberSaveable { mutableStateOf(s.config?.username.orEmpty()) }
    var pw by remember { mutableStateOf("") }
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.qbit_title), style = Type.title3, color = G.label)
        Text(stringResource(R.string.qbit_sub), style = Type.footnote, color = G.label2)
        WicabyField(url, { url = it }, stringResource(R.string.qbit_address), keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, leading = Ic.Server)
        WicabyField(user, { user = it }, stringResource(R.string.username), imeAction = ImeAction.Next, leading = Ic.User)
        WicabyField(pw, { pw = it }, stringResource(R.string.password), password = true, imeAction = ImeAction.Go, onSubmit = { vm.connect(url, user, pw) }, leading = Ic.Lock)
        Box(Modifier.fillMaxWidth()) {
            PillButton(stringResource(R.string.connect), { vm.connect(url, user, pw) }, primary = true, modifier = Modifier.fillMaxWidth())
            if (s.setup.busy) Spinner(Modifier.align(Alignment.CenterEnd).padding(end = 16.dp).size(20.dp), onAccent(LocalAccent.current))
        }
        s.setup.error?.let { Text(it, style = Type.callout, color = G.red) }
    }
}

@Composable
private fun QbitHeader(s: TorrentsState, vm: TorrentsViewModel) {
    var link by rememberSaveable { mutableStateOf("") }
    Column(Modifier.padding(top = 4.dp)) {
        when (val c = s.connection) {
            is QbitConnection.Offline -> Text(c.message, style = Type.footnote, color = G.red)
            is QbitConnection.Online -> Text(
                stringResource(R.string.qbit_transfer, formatSpeed(s.transfer.dlSpeed), formatSpeed(s.transfer.upSpeed), c.version),
                style = Type.footnote, color = G.label2,
            )
            else -> Text(stringResource(R.string.qbit_connecting), style = Type.footnote, color = G.label2)
        }
        Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            WicabyField(
                link, { link = it }, stringResource(R.string.qbit_add_hint), modifier = Modifier.weight(1f), keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Done, onSubmit = { if (vm.addLinks(link)) link = "" },
            )
            Spacer(Modifier.size(8.dp))
            PillButton(null, { if (vm.addLinks(link)) link = "" }, icon = Ic.Plus, contentDescription = stringResource(R.string.qbit_add))
        }
        LazyRow(Modifier.padding(top = 12.dp, bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(TorrentFilter.entries, key = { it.name }) { f ->
                Chip(stringResource(R.string.filter_count, stringResource(f.labelRes), s.counts[f] ?: 0), selected = f == s.filter) { vm.setFilter(f) }
            }
        }
    }
}

@Composable
private fun TorrentRow(t: Torrent, pending: Boolean, vm: TorrentsViewModel) {
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(t.name, style = Type.callout, color = G.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
            ProgressLine(t.progress, Modifier.padding(vertical = 2.dp), track = G.fill4)
            val eta = if (t.hasEta && !t.isComplete) formatEta(t.eta) else null
            val speed = if (t.dlSpeed > 0) stringResource(R.string.speed_down, formatSpeed(t.dlSpeed)) else if (t.upSpeed > 0) stringResource(R.string.speed_up, formatSpeed(t.upSpeed)) else null
            Text(
                listOfNotNull(stringResource(t.status.labelRes), formatPercent(t.progress), formatBytes(t.bytes), speed, eta).joinToString("  ·  "),
                style = Type.caption, color = G.label3, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
            if (pending) Spinner(Modifier.size(18.dp)) else IconButton({ vm.togglePause(t) }) {
                Icon(if (t.isPaused) Ic.Play else Ic.Pause, stringResource(if (t.isPaused) R.string.play else R.string.pause), tint = G.label, modifier = Modifier.size(16.dp))
            }
        }
        Box {
            IconButton({ menu = true }) { Icon(Ic.Trash, stringResource(R.string.remove), tint = G.label2, modifier = Modifier.size(20.dp)) }
            DropdownMenu(menu, { menu = false }, containerColor = G.elevated2, shape = RoundedCornerShape(Radius.md)) {
                DropdownMenuItem(text = { Text(stringResource(R.string.remove), style = Type.body) }, onClick = { menu = false; vm.remove(t.hash, deleteFiles = false) })
                DropdownMenuItem(text = { Text(stringResource(R.string.remove_with_files), style = Type.body, color = G.red) }, onClick = { menu = false; vm.remove(t.hash, deleteFiles = true) })
            }
        }
    }
}
