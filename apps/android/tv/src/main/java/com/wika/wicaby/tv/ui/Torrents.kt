package com.wika.wicaby.tv.ui

import androidx.activity.compose.LocalActivity
import androidx.activity.ComponentActivity
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.view.Gravity
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import com.wika.wicaby.tv.R
import com.wika.wicaby.core.torrents.AddOptions
import com.wika.wicaby.core.torrents.QbitConnection
import com.wika.wicaby.core.torrents.Torrent
import com.wika.wicaby.core.torrents.TorrentFilter
import com.wika.wicaby.core.torrents.TorrentStatus
import com.wika.wicaby.core.torrents.TorrentsState
import com.wika.wicaby.core.torrents.TorrentsViewModel
import com.wika.wicaby.core.torrents.formatBytes
import com.wika.wicaby.core.torrents.formatEta
import com.wika.wicaby.core.torrents.formatPercent
import com.wika.wicaby.core.torrents.formatSpeed
import kotlinx.coroutines.delay

// qBittorrent (Web API v2) on the TV: transfer list with progress, speeds and ETA,
// an OK-menu per torrent, add-by-magnet with the TV keyboard, and the connection setup.
// The state machine (polling, 4.x/5.x, auth) lives in :core's TorrentsViewModel.

private fun icon(d: String) = ImageVector.Builder(defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
    .addPath(addPathNodes(d), fill = SolidColor(Color.White))
    .build()

// Tab icon for the top bar.
val TorrentsIcon: ImageVector = icon("M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z")

private object TIc {
    val Add = icon("M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z")
    val Delete = icon("M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z")
    val Down = icon("M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z")
    val Up = icon("M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z")
    val Folder = icon("M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z")
    val Speed = icon("M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z")
}

@Composable
private fun torrentsViewModel(): TorrentsViewModel {
    val activity = LocalActivity.current as ComponentActivity
    return remember(activity) { ViewModelProvider(activity)[TorrentsViewModel::class.java] }
}

@Composable
fun TorrentsTab(onScrolled: (Boolean) -> Unit = {}, top: Dp = 104.dp) {
    val vm = torrentsViewModel()
    // Stops collecting in the background, which stops the qBittorrent polling.
    val s by vm.state.collectAsStateWithLifecycle()
    var editing by rememberSaveable { mutableStateOf(false) }
    if (!s.ready) return

    // Swapping setup <-> list removes the focused button; Compose then drops focus and the
    // view system hands it to the first tab (switching to Accueil). Park focus on an invisible
    // anchor first, swap one frame later, and let the new screen take focus from there.
    val wantSetup = s.connection == QbitConnection.Unconfigured || editing
    var showSetup by remember { mutableStateOf(wantSetup) }
    var hasFocus by remember { mutableStateOf(false) }
    val anchor = remember { FocusRequester() }
    // The anchor only accepts focus while parking it; otherwise Down from the tab bar would
    // land on this invisible box instead of the first field.
    var parking by remember { mutableStateOf(false) }
    var anchorFocused by remember { mutableStateOf(false) }
    LaunchedEffect(anchorFocused) { if (!anchorFocused) parking = false }
    LaunchedEffect(wantSetup) {
        if (wantSetup == showSetup) return@LaunchedEffect
        if (hasFocus) {
            parking = true
            withFrameNanos { }
            runCatching { anchor.requestFocus() }
            withFrameNanos { }
        }
        showSetup = wantSetup
    }

    Box(Modifier.fillMaxSize().onFocusChanged { hasFocus = it.hasFocus }) {
        Box(Modifier.align(Alignment.TopCenter).padding(top = top).size(1.dp).focusRequester(anchor).onFocusChanged { anchorFocused = it.isFocused }.focusProperties { canFocus = parking }.focusable())
        if (showSetup) {
            LaunchedEffect(Unit) { onScrolled(false) }
            SetupPanel(vm, s, top, onDone = { editing = false }, canCancel = s.connection != QbitConnection.Unconfigured)
        } else {
            TorrentList(vm, s, top, onScrolled, onSettings = { editing = true })
        }
        Notice(s.notice, onShown = vm::consumeNotice, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 32.dp))
    }
}

// ---------------------------------------------------------------------------
// Connection setup.

@Composable
private fun SetupPanel(vm: TorrentsViewModel, s: TorrentsState, top: Dp, onDone: () -> Unit, canCancel: Boolean) {
    val existing = s.config
    var url by rememberSaveable { mutableStateOf(existing?.url?.removePrefix("http://")?.trimEnd('/').orEmpty()) }
    var user by rememberSaveable { mutableStateOf(existing?.username ?: "admin") }
    var pass by rememberSaveable { mutableStateOf("") }
    var submitted by remember { mutableStateOf(false) }
    val connectButton = remember { FocusRequester() }
    // Only take focus when the user is not browsing the tab bar (it would yank focus off it).
    val first = remember { FocusRequester() }
    val autoFocus = LocalAutoFocus.current
    LaunchedEffect(Unit) {
        if (!autoFocus) return@LaunchedEffect
        delay(60)
        runCatching { first.requestFocus() }
    }
    // Saved: the store emits, the list replaces this panel (or editing ends).
    LaunchedEffect(s.setup.busy, s.setup.error, s.config) {
        if (submitted && !s.setup.busy && s.setup.error == null) {
            submitted = false
            onDone()
        }
    }
    fun submit() {
        if (url.isBlank()) return
        submitted = true
        // An empty password while editing keeps the stored one.
        vm.connect(url, user, if (pass.isEmpty() && existing != null) null else pass)
    }

    // Two columns so the whole form fits the 540 dp canvas without scrolling.
    Row(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 96.dp, end = 96.dp, top = top + 12.dp, bottom = 32.dp),
        horizontalArrangement = Arrangement.spacedBy(56.dp),
    ) {
        Column(Modifier.weight(0.4f).padding(top = 8.dp)) {
            Icon(TorrentsIcon, null, tint = C.label2, modifier = Modifier.size(30.dp))
            Text("qBittorrent", style = Type.title1, color = C.label, modifier = Modifier.padding(top = 10.dp))
            Text(
                stringResource(R.string.torrents_intro),
                style = Type.body, color = C.label2, modifier = Modifier.padding(top = 8.dp),
            )
            Text(
                stringResource(R.string.torrents_setup_hint),
                style = Type.footnote, color = C.label3, modifier = Modifier.padding(top = 14.dp),
            )
        }
        Column(Modifier.weight(0.6f)) {
            Label(stringResource(R.string.torrents_address))
            TvTextField(url, { url = it }, "192.168.1.10:8080", Modifier.fillMaxWidth().focusRequester(first), imeAction = ImeAction.Next)
            Label(stringResource(R.string.username))
            TvTextField(user, { user = it }, "admin", Modifier.fillMaxWidth(), imeAction = ImeAction.Next)
            Label(stringResource(R.string.password))
            TvTextField(
                pass, { pass = it }, stringResource(if (existing != null) R.string.torrents_password_unchanged else R.string.password),
                Modifier.fillMaxWidth().focusProperties { down = connectButton },
                password = true, onSubmit = ::submit,
            )
            s.setup.error?.let {
                Text(it, style = Type.footnote, color = C.red, modifier = Modifier.padding(start = 4.dp, top = 12.dp))
            }
            Row(Modifier.padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Pill(stringResource(if (s.setup.busy) R.string.connecting else R.string.connect), onClick = ::submit, primary = true, modifier = Modifier.focusRequester(connectButton))
                if (canCancel) Pill(stringResource(R.string.cancel), onClick = onDone)
                if (existing != null) Pill(stringResource(R.string.torrents_forget), onClick = { vm.disconnect(); onDone() })
                if (s.setup.busy) Spinner(Modifier.size(24.dp))
            }
        }
    }
}

@Composable
private fun Label(text: String) {
    Text(text, style = Type.callout, color = C.label2, modifier = Modifier.padding(start = 4.dp, top = 10.dp, bottom = 6.dp))
}

// ---------------------------------------------------------------------------
// Transfer list.

@Composable
private fun TorrentList(vm: TorrentsViewModel, s: TorrentsState, top: Dp, onScrolled: (Boolean) -> Unit, onSettings: () -> Unit) {
    val list = rememberLazyListState()
    // The header stays put under the tab bar and only the rows scroll, so nothing ever
    // slides under the bar: keep it visible.
    LaunchedEffect(Unit) { onScrolled(false) }
    var menuFor by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }
    val memory = rememberFocusMemory()
    // Up from the first row: the selected filter (plain geometric search escapes to the tab bar).
    val filterFocus = remember { FocusRequester() }
    // Newest first: a torrent just added lands above the first row; show it if the list was at the top.
    LaunchedEffect(s.torrents.firstOrNull()?.hash) {
        if (list.firstVisibleItemIndex <= 1) list.animateScrollToItem(0)
    }

    Column(Modifier.fillMaxSize().padding(top = top)) {
        Header(vm, s, memory, filterFocus, onAdd = { adding = true }, onSettings = onSettings, modifier = Modifier.padding(horizontal = 48.dp))
        LazyColumn(
            state = list,
            modifier = Modifier.fillMaxWidth().weight(1f),
            contentPadding = PaddingValues(start = 48.dp, end = 48.dp, top = 12.dp, bottom = 40.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            when {
                s.connection is QbitConnection.Offline && s.torrents.isEmpty() -> item(key = "offline") {
                    val c = s.connection as QbitConnection.Offline
                    EmptyState(stringResource(R.string.torrents_unreachable), c.message) {
                        Pill(stringResource(R.string.retry), onClick = vm::refresh, icon = Ic.Refresh)
                        Pill(stringResource(R.string.torrents_edit_connection), onClick = onSettings, icon = Ic.Gear)
                    }
                }
                s.connection == QbitConnection.Connecting -> item(key = "loading") {
                    Box(Modifier.fillMaxWidth().padding(top = 64.dp), contentAlignment = Alignment.Center) { Spinner() }
                }
                s.torrents.isEmpty() -> item(key = "empty") {
                    EmptyState(
                        stringResource(s.filter.emptyRes),
                        stringResource(R.string.torrents_empty_hint),
                    ) {}
                }
                else -> itemsIndexed(s.torrents, key = { _, t -> t.hash }) { i, t ->
                    // focusProperties(up) is not enough here: the lazy list's own search gives up at
                    // index 0 and the view system then lands on the first tab. Handle Up directly.
                    val m = if (i == 0) {
                        Modifier.onPreviewKeyEvent { e ->
                            if (e.key == Key.DirectionUp && e.type == KeyEventType.KeyDown) runCatching { filterFocus.requestFocus() }.isSuccess else false
                        }
                    } else {
                        Modifier
                    }
                    TorrentRow(t, pending = t.hash in s.pending, modifier = m.remembered(memory, "t/${t.hash}"), onClick = { menuFor = t.hash })
                }
            }
        }
    }

    val selected = menuFor?.let { h -> s.torrents.firstOrNull { it.hash == h } }
    if (menuFor != null && selected == null) menuFor = null
    if (selected != null) ActionsDialog(vm, s, selected, onDismiss = { menuFor = null })
    if (adding) AddDialog(vm, s, onDismiss = { adding = false })
}

@Composable
private fun Header(vm: TorrentsViewModel, s: TorrentsState, memory: FocusMemory, filterFocus: FocusRequester, onAdd: () -> Unit, onSettings: () -> Unit, modifier: Modifier) {
    val t = s.transfer
    val online = s.connection is QbitConnection.Online
    // The actions sit top-right, away from the filters: Up from a filter goes to them, not the tab bar.
    val add = remember { FocusRequester() }
    Column(modifier.fillMaxWidth().padding(top = 8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(TIc.Down, null, tint = C.label2, modifier = Modifier.size(20.dp))
                    Text(if (online) formatSpeed(t.dlSpeed) else "—", style = Type.mono.copy(fontSize = 22.sp, lineHeight = 28.sp), color = C.label)
                    Spacer(Modifier.width(14.dp))
                    Icon(TIc.Up, null, tint = C.label2, modifier = Modifier.size(20.dp))
                    Text(if (online) formatSpeed(t.upSpeed) else "—", style = Type.mono.copy(fontSize = 22.sp, lineHeight = 28.sp), color = C.label)
                }
                val line = when (val c = s.connection) {
                    is QbitConnection.Offline -> stringResource(R.string.torrents_offline_line, c.message)
                    is QbitConnection.Online -> listOfNotNull(
                        "qBittorrent ${c.version}",
                        t.freeSpace.takeIf { it >= 0 }?.let { stringResource(R.string.torrents_free_space, formatBytes(it)) },
                        stringResource(R.string.torrents_alt_speed_on).takeIf { t.altSpeed },
                    ).joinToString(" · ")
                    else -> stringResource(R.string.connecting)
                }
                Text(line, style = Type.footnote, color = if (s.connection is QbitConnection.Offline) C.red else C.label3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Pill(stringResource(R.string.torrents_add), onClick = onAdd, icon = TIc.Add, modifier = Modifier.focusRequester(add).remembered(memory, "add", default = true))
                Pill(
                    stringResource(if (t.altSpeed) R.string.torrents_alt_speed else R.string.torrents_full_speed), onClick = vm::toggleAltSpeed, icon = TIc.Speed,
                    selected = t.altSpeed, modifier = Modifier.remembered(memory, "alt"),
                )
                Pill(null, onClick = onSettings, icon = Ic.Gear, modifier = Modifier.remembered(memory, "settings"))
            }
        }
        Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TorrentFilter.entries.forEach { f ->
                val n = s.counts[f] ?: 0
                Pill(
                    if (f == TorrentFilter.All || n > 0) stringResource(R.string.torrents_filter_count, stringResource(f.labelRes), n) else stringResource(f.labelRes),
                    onClick = { vm.setFilter(f) },
                    selected = s.filter == f,
                    // fill4 alone is too faint at ten feet: a monochrome check marks the active filter.
                    icon = if (s.filter == f) Ic.Check else null,
                    modifier = Modifier
                        .then(if (s.filter == f) Modifier.focusRequester(filterFocus) else Modifier)
                        .focusProperties { up = add }
                        .remembered(memory, "filter/${f.name}"),
                )
            }
        }
    }
}

@Composable
private fun EmptyState(title: String, body: String, actions: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 64.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(title, style = Type.title3, color = C.label)
        Text(body, style = Type.footnote, color = C.label3, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 6.dp, bottom = 18.dp).widthIn(max = 520.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) { actions() }
    }
}

@Composable
private fun subtitle(t: Torrent): String {
    val parts = mutableListOf(stringResource(t.status.labelRes))
    if (t.isComplete || t.bytes <= 0) {
        if (t.bytes > 0) parts += formatBytes(t.bytes)
        if (t.isComplete) parts += stringResource(R.string.torrents_ratio, String.format(uiLocale(), "%.2f", t.ratio))
    } else {
        parts += stringResource(R.string.torrents_progress, formatBytes((t.bytes * t.progress).toLong()), formatBytes(t.bytes))
        if (!t.isPaused) formatEta(t.eta)?.let { parts += stringResource(R.string.torrents_eta, it) }
    }
    if (t.status == TorrentStatus.Downloading || t.status == TorrentStatus.Stalled) parts += pluralStringResource(R.plurals.torrents_seeds, t.seeds, t.seeds)
    if (t.category.isNotEmpty()) parts += t.category
    return parts.joinToString(" · ")
}

@Composable
private fun TorrentRow(t: Torrent, pending: Boolean, modifier: Modifier, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val accent = LocalAccent.current
    val bar = when {
        t.status == TorrentStatus.Error -> C.red
        t.isPaused && !t.isComplete -> C.label3
        else -> accent
    }
    Column(
        modifier
            .fillMaxWidth()
            .tvFocus(RoundedCornerShape(Radius.md), focusedScale = 1.02f, sheen = false, elevation = 10.dp, onFocusChange = { focused = it }, onClick = onClick)
            .background(if (focused) C.raised else C.elevated)
            .padding(horizontal = 20.dp, vertical = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(t.name, style = Type.headline, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(16.dp))
            if (pending) Spinner(Modifier.size(16.dp)) else Text(formatPercent(t.progress), style = Type.mono, color = if (focused) C.label else C.label2)
        }
        Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(subtitle(t), style = Type.footnote, color = C.label3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (t.dlSpeed > 0 || t.upSpeed > 0) {
                Spacer(Modifier.width(16.dp))
                SpeedPair(t.dlSpeed, t.upSpeed)
            }
        }
        Box(Modifier.padding(top = 10.dp).fillMaxWidth().height(4.dp).clip(CircleShape).background(C.fill3)) {
            Box(Modifier.fillMaxWidth(t.progress.coerceIn(0f, 1f)).fillMaxHeight().clip(CircleShape).background(bar))
        }
    }
}

@Composable
private fun SpeedPair(down: Long, up: Long) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (down > 0) {
            Icon(TIc.Down, null, tint = C.label3, modifier = Modifier.size(13.dp))
            Text(formatSpeed(down), style = Type.mono.copy(fontSize = 12.sp), color = C.label2)
        }
        if (up > 0) {
            if (down > 0) Spacer(Modifier.width(6.dp))
            Icon(TIc.Up, null, tint = C.label3, modifier = Modifier.size(13.dp))
            Text(formatSpeed(up), style = Type.mono.copy(fontSize = 12.sp), color = C.label2)
        }
    }
}

// ---------------------------------------------------------------------------
// Dialogs: OK menu on a torrent, and "add a magnet".

@Composable
// top = true for text entry: the sheet sits in the upper part, clear of the TV keyboard.
private fun Sheet(onDismiss: () -> Unit, width: Dp = 440.dp, top: Boolean = false, content: @Composable () -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        if (top) {
            val window = (LocalView.current.parent as? DialogWindowProvider)?.window
            SideEffect { window?.setGravity(Gravity.TOP or Gravity.CENTER_HORIZONTAL) }
        }
        Column(
            Modifier
                .padding(top = if (top) 40.dp else 0.dp)
                .width(width)
                .clip(RoundedCornerShape(Radius.xl))
                .background(C.elevated2)
                .padding(28.dp),
        ) { content() }
    }
}

private enum class MenuPage { Main, Category, Delete }

@Composable
private fun ActionsDialog(vm: TorrentsViewModel, s: TorrentsState, t: Torrent, onDismiss: () -> Unit) {
    var page by remember { mutableStateOf(MenuPage.Main) }
    val first = remember(page) { FocusRequester() }
    LaunchedEffect(page) {
        delay(50)
        runCatching { first.requestFocus() }
    }
    fun done(action: () -> Unit) {
        action()
        onDismiss()
    }
    Sheet(onDismiss = { if (page != MenuPage.Main) page = MenuPage.Main else onDismiss() }) {
        Text(t.name, style = Type.title3, color = C.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(subtitle(t), style = Type.footnote, color = C.label3, maxLines = 2, modifier = Modifier.padding(top = 4.dp, bottom = 20.dp))
        val full = Modifier.fillMaxWidth()
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            when (page) {
                MenuPage.Main -> {
                    Pill(
                        stringResource(if (t.isPaused) R.string.resume else R.string.torrents_pause),
                        onClick = { done { vm.togglePause(t) } },
                        icon = if (t.isPaused) Ic.Play else Ic.Pause,
                        modifier = full.focusRequester(first),
                    )
                    Pill(if (t.category.isEmpty()) stringResource(R.string.torrents_category) else stringResource(R.string.torrents_category_value, t.category), onClick = { page = MenuPage.Category }, icon = TIc.Folder, modifier = full)
                    Pill(stringResource(R.string.torrents_recheck), onClick = { done { vm.recheck(t.hash) } }, icon = Ic.Refresh, modifier = full)
                    Pill(stringResource(R.string.torrents_delete), onClick = { page = MenuPage.Delete }, icon = TIc.Delete, modifier = full)
                }
                MenuPage.Category -> {
                    val names = listOf("") + s.categories.map { it.name }
                    names.forEachIndexed { i, name ->
                        Pill(
                            name.ifEmpty { stringResource(R.string.torrents_category_none) },
                            onClick = { done { if (name != t.category) vm.setCategory(t.hash, name) } },
                            icon = if (name == t.category) Ic.Check else null,
                            selected = name == t.category,
                            modifier = if (i == 0) full.focusRequester(first) else full,
                        )
                    }
                }
                MenuPage.Delete -> {
                    Text(stringResource(R.string.torrents_delete_hint), style = Type.footnote, color = C.label2, modifier = Modifier.padding(bottom = 6.dp))
                    Pill(stringResource(R.string.cancel), onClick = { page = MenuPage.Main }, modifier = full.focusRequester(first))
                    Pill(stringResource(R.string.torrents_remove), onClick = { done { vm.remove(t.hash, deleteFiles = false) } }, icon = TIc.Delete, modifier = full)
                    Pill(stringResource(R.string.torrents_delete_files), onClick = { done { vm.remove(t.hash, deleteFiles = true) } }, icon = TIc.Delete, modifier = full)
                }
            }
        }
    }
}

@Composable
private fun AddDialog(vm: TorrentsViewModel, s: TorrentsState, onDismiss: () -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    var category by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val badLink = stringResource(R.string.torrents_bad_link)
    fun submit() {
        if (text.isBlank()) return
        if (vm.addLinks(text, AddOptions(category = category.ifEmpty { null }))) onDismiss() else error = badLink
    }
    Sheet(onDismiss = onDismiss, width = 620.dp, top = true) {
        Text(stringResource(R.string.torrents_add_title), style = Type.title3, color = C.label)
        Text(stringResource(R.string.torrents_add_hint), style = Type.footnote, color = C.label3, modifier = Modifier.padding(top = 4.dp, bottom = 18.dp))
        TvTextField(text, { text = it; error = null }, "magnet:?xt=urn:btih:…", Modifier.fillMaxWidth(), autoEdit = true, imeAction = ImeAction.Done, onSubmit = ::submit)
        if (error != null) Text(error!!, style = Type.footnote, color = C.red, modifier = Modifier.padding(start = 4.dp, top = 10.dp))
        if (s.categories.isNotEmpty()) {
            Text(stringResource(R.string.torrents_category), style = Type.callout, color = C.label2, modifier = Modifier.padding(start = 4.dp, top = 18.dp, bottom = 8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                (listOf("") + s.categories.map { it.name }).take(6).forEach { name ->
                    Pill(name.ifEmpty { stringResource(R.string.torrents_category_none) }, onClick = { category = name }, selected = category == name, icon = if (category == name) Ic.Check else null)
                }
            }
        }
        Row(Modifier.padding(top = 22.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Pill(stringResource(R.string.torrents_add), onClick = ::submit, primary = true, icon = TIc.Add)
            Pill(stringResource(R.string.cancel), onClick = onDismiss)
        }
    }
}

@Composable
private fun Notice(message: String?, onShown: () -> Unit, modifier: Modifier) {
    var shown by remember { mutableStateOf<String?>(null) }
    // Consuming the notice changes `message`, so the timer lives in its own effect keyed on `shown`.
    LaunchedEffect(message) {
        if (message != null) {
            shown = message
            onShown()
        }
    }
    LaunchedEffect(shown) {
        if (shown != null) {
            delay(3_000)
            shown = null
        }
    }
    AnimatedVisibility(shown != null, modifier = modifier, enter = fadeIn(), exit = fadeOut()) {
        Text(
            shown.orEmpty(),
            style = Type.callout.copy(fontWeight = FontWeight.Medium),
            color = C.label,
            modifier = Modifier.clip(RoundedCornerShape(50)).background(C.elevated2).padding(horizontal = 20.dp, vertical = 10.dp),
        )
    }
}
