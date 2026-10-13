package com.wika.wicaby.tv.ui

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ItemsResult
import com.wika.wicaby.core.files.FileError
import com.wika.wicaby.core.files.FileSource
import com.wika.wicaby.core.files.FileSourceDraft
import com.wika.wicaby.core.files.FileSources
import com.wika.wicaby.core.files.FilesApi
import com.wika.wicaby.core.files.FoundShare
import com.wika.wicaby.core.files.LocalFolders
import com.wika.wicaby.core.files.Nsd
import com.wika.wicaby.core.files.SignInDraft
import com.wika.wicaby.core.files.TlsPin
import com.wika.wicaby.core.files.errorText
import com.wika.wicaby.core.files.lines
import com.wika.wicaby.core.files.pure.Ids
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.Route
import com.wika.wicaby.tv.play
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// File sources on the TV (file-sources spec §9.2): the Files tab (source tiles, their Continue row, Add), the folder
// grid (D-pad first: breadcrumbs, Back up one folder, Menu for sort and a file's actions, focus kept on return) and the
// Add sheet. Folder mode only: no scan, the file names and their sidecars.

private fun kindLabel(s: FileSource) = when (s.protocol) {
    FileSource.LOCAL -> CoreR.string.files_kind_local
    FileSource.SMB -> CoreR.string.files_kind_smb
    else -> CoreR.string.files_kind_webdav
}

@Composable
fun FilesTab(onScrolled: (Boolean) -> Unit) {
    val nav = LocalNav.current
    val overlay = LocalOverlay.current
    val memory = rememberFocusMemory()
    val sources by FileSources.list.collectAsState()
    val addReq = remember { FocusRequester() }
    // Continue Watching of every source (always here; on Home only with the setting on).
    val cont = rememberLoad("files-continue-${sources.map { it.id }}") {
        FileSources.all().flatMap { a -> runCatching { a.resume() }.getOrDefault(emptyList()) }
            .sortedByDescending { it.userData?.lastPlayedDate.orEmpty() }
    }.value.value.orEmpty()
    val list = rememberLazyListState()
    LaunchedEffect(list) { snapshotFlow { list.firstVisibleItemIndex > 0 || list.firstVisibleItemScrollOffset > 60 }.collect(onScrolled) }
    LazyColumn(state = list, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 104.dp, bottom = 64.dp)) {
        item("title") { Text(stringResource(CoreR.string.files_title), style = Type.largeTitle, color = C.label, modifier = Modifier.padding(start = 48.dp, bottom = 8.dp)) }
        item("sources") {
            LazyRow(
                modifier = Modifier.fillMaxWidth().dpadEdges(),
                contentPadding = PaddingValues(horizontal = 48.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                items(sources, key = { it.id }) { s ->
                    SourceTile(s, Modifier.remembered(memory, "src-${s.id}", default = s == sources.first())) { nav.push(Route.Files(s.id, Ids.ROOT, s.name)) }
                }
                item("add") {
                    Box(Modifier.padding(top = 30.dp)) {
                        Pill(
                            stringResource(CoreR.string.files_add), icon = Ic.Plus,
                            modifier = Modifier.focusRequester(addReq).remembered(memory, "add", default = sources.isEmpty()),
                            onClick = { overlay.show(addReq) { AddFileSourceSheet(onDismiss = overlay::close) } },
                        )
                    }
                }
            }
        }
        if (sources.isEmpty()) item("none") {
            Text(stringResource(CoreR.string.files_none), style = Type.body, color = C.label2, modifier = Modifier.padding(start = 48.dp, end = 48.dp, top = 12.dp))
        }
        if (cont.isNotEmpty()) item("continue") {
            val context = LocalContext.current
            MediaRow(
                stringResource(CoreR.string.files_continue), cont, FileSources.all().first(), memory, "files-continue", wide = true,
                onFocusItem = {}, onClick = { play(context, it) },
            )
        }
    }
}

@Composable
private fun SourceTile(s: FileSource, focusModifier: Modifier, onClick: () -> Unit) {
    val overlay = LocalOverlay.current
    var focused by remember { mutableStateOf(false) }
    val me = remember { FocusRequester() }
    Column(Modifier.width(232.dp)) {
        Box(
            Modifier.fillMaxWidth().height(120.dp).focusRequester(me).then(focusModifier)
                .onPreviewKeyEvent { e ->
                    // Menu: sign in again or remove the source (its progress goes too, after a confirmation).
                    if (e.key != Key.Menu || e.type != KeyEventType.KeyUp) return@onPreviewKeyEvent false
                    showSourceActions(overlay, me, s)
                    true
                }
                // A source whose credential no longer opens asks for it again instead of failing (§7.1).
                .tvFocus(RoundedCornerShape(Radius.md), focusedScale = 1.07f, onFocusChange = { focused = it }, onClick = {
                    if (FileSources.needsSignIn(s)) overlay.show(me) { SignInSheet(s, overlay::close) } else onClick()
                })
                .background(C.elevated2),
            contentAlignment = Alignment.Center,
        ) {
            Icon(if (s.isLocal) Ic.Phone else Ic.Server, null, tint = C.label2, modifier = Modifier.size(40.dp))
            if (FileSources.needsSignIn(s)) Text(stringResource(CoreR.string.files_sign_in_again), style = Type.footnote, color = C.label, modifier = Modifier.align(Alignment.BottomCenter).padding(8.dp))
        }
        Text(s.name, style = Type.callout, color = if (focused) C.label else C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 12.dp, start = 2.dp))
        Text(listOf(stringResource(kindLabel(s)), s.label).filter { it.isNotEmpty() }.joinToString(" · "), style = Type.footnote, color = C.label3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp, start = 2.dp))
    }
}

// A source's actions (its tile's Menu key, Réglages > Fichiers): sign in again for a network source (§7.1: a lost
// Keystore key or a changed password; the source and its progress are kept), or remove it (its progress goes too).
// Cancel is the default.
fun showSourceActions(overlay: OverlayHost, back: FocusRequester, s: FileSource) = overlay.show(back) {
    val remove = stringResource(CoreR.string.files_remove)
    val actions = buildList {
        if (!s.isLocal) add(AlertAction(stringResource(CoreR.string.files_sign_in_again)) { overlay.show(back) { SignInSheet(s, overlay::close) } })
        add(AlertAction(remove, destructive = true) { overlay.close(); FileSources.remove(s.id) })
        add(AlertAction(stringResource(R.string.cancel)) { overlay.close() })
    }
    val message = if (FileSources.needsSignIn(s)) stringResource(CoreR.string.files_sign_in_body, s.name) else stringResource(CoreR.string.files_remove_confirm, s.name)
    TvAlert(s.name, message, actions, focusIndex = actions.lastIndex, onDismiss = overlay::close)
}

// §7.1 "sign in again": new credentials, tested before they replace the stored ones; the source keeps its progress.
@Composable
fun SignInSheet(s: FileSource, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    val draft = remember(s.id) { SignInDraft(s) }
    TvSheet(onDone, width = 560.dp) {
        Text(stringResource(CoreR.string.files_sign_in_again), style = Type.title2, color = C.label)
        Text(stringResource(CoreR.string.files_sign_in_body, s.name), style = Type.callout, color = C.label2, modifier = Modifier.padding(top = 8.dp, bottom = 14.dp))
        val first = remember { FocusRequester() }
        LaunchedEffect(Unit) { delay(60); runCatching { first.requestFocus() } }
        TvTextField(draft.user, { draft.user = it }, stringResource(CoreR.string.files_add_user), Modifier.fillMaxWidth().focusRequester(first), imeAction = ImeAction.Next)
        Spacer(Modifier.height(10.dp))
        TvTextField(draft.pass, { draft.pass = it }, stringResource(CoreR.string.files_add_password), Modifier.fillMaxWidth(), password = true, imeAction = ImeAction.Next)
        if (s.isSmb) {
            Spacer(Modifier.height(10.dp))
            TvTextField(draft.domain, { draft.domain = it }, stringResource(CoreR.string.files_add_domain), Modifier.fillMaxWidth(), imeAction = ImeAction.Next)
        }
        draft.status?.let { Text(it, style = Type.callout, color = C.label2, modifier = Modifier.padding(top = 12.dp)) }
        Spacer(Modifier.height(16.dp))
        Pill(stringResource(CoreR.string.files_add_save), primary = true, onClick = { if (!draft.busy) scope.launch { if (draft.save()) onDone() } })
    }
}

private val SORTS = listOf(CoreR.string.files_sort_name to "SortName", CoreR.string.files_sort_date to "DateModified", CoreR.string.files_sort_size to "Size")

// One folder of a source. Each folder is its own route, so Back goes up one folder and, from the root, back to the tab,
// with the focus where it was.
@Composable
fun FilesFolderScreen(sourceId: String, id: String, name: String) {
    val api = FileSources.api(sourceId)
    val nav = LocalNav.current
    val overlay = LocalOverlay.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val memory = rememberFocusMemory()
    var sort by rememberSaveable { mutableIntStateOf(0) }
    var descending by rememberSaveable { mutableStateOf(false) }
    var nonce by remember { mutableIntStateOf(0) }
    val rel = Ids.decode(id).orEmpty()
    val load = rememberLoad("files-$sourceId-$id-$sort-$descending-$nonce") {
        api ?: throw FileError(FileError.Kind.NOT_FOUND)
        api.get<ItemsResult>("/Items", "ParentId" to id, "SortBy" to SORTS[sort].second, "SortOrder" to if (descending) "Descending" else "Ascending")
    }.value
    // A reload (refresh, mark played, sort) keeps the cards until it lands, so the focused one is not removed under
    // the D-pad; an error still replaces them.
    var last by remember { mutableStateOf<ItemsResult?>(null) }
    LaunchedEffect(load.value) { load.value?.let { last = it } }
    var focused by remember { mutableStateOf<Item?>(null) }
    val gridReq = remember { FocusRequester() }
    val crumbs = Ids.crumbs(rel).map { (_, n) -> n.ifEmpty { api?.source?.name ?: name } }

    fun refresh() {
        api?.refresh()
        nonce++
    }

    fun menu() {
        val item = focused
        overlay.show { // focus goes back to the focused card (LastFocus), not the grid's first one
            TvSheet(overlay::close, width = 420.dp) {
                // The first button takes the focus, a file's or (on a folder) the first sort, so the D-pad never acts
                // on the grid behind the sheet.
                val first = remember { FocusRequester() }
                LaunchedEffect(Unit) { delay(60); runCatching { first.requestFocus() } }
                val file = item != null && !item.isFolder
                if (item != null && file) {
                    Text(item.name, style = Type.title3, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 14.dp))
                    SheetButton(stringResource(CoreR.string.files_play_from_start), icon = Ic.Restart, modifier = Modifier.focusRequester(first), onClick = { overlay.close(); play(context, item, fromStart = true) })
                    Spacer(Modifier.height(8.dp))
                    val played = item.userData?.played == true
                    SheetButton(stringResource(if (played) CoreR.string.files_mark_unplayed else CoreR.string.files_mark_played), icon = Ic.Check, onClick = {
                        overlay.close()
                        scope.launch { runCatching { api?.setPlayed(item.id, !played) }; refresh() }
                    })
                    Spacer(Modifier.height(18.dp))
                }
                SORTS.forEachIndexed { i, (label, _) ->
                    SheetButton(stringResource(label), checked = i == sort, modifier = if (i == 0 && !file) Modifier.focusRequester(first) else Modifier, onClick = {
                        // The current sort again reverses it.
                        if (i == sort) descending = !descending else { sort = i; descending = false }
                        overlay.close()
                    })
                    Spacer(Modifier.height(8.dp))
                }
                SheetButton(stringResource(CoreR.string.files_refresh), icon = Ic.Refresh, onClick = { overlay.close(); refresh() })
            }
        }
    }

    Box(Modifier.fillMaxSize().background(C.bg)) {
        val result = load.value ?: last.takeIf { load.error == null }
        when {
            api == null || (result == null && load.error != null) -> Centered {
                val e = load.error
                if (e is FileError && e.kind == FileError.Kind.CERT_CHANGED && api != null) CertChanged(api, onCancel = nav::pop) { refresh() }
                else Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    ErrorState(errorText(e)) { refresh() }
                    // A refused password (changed, or lost with the Keystore key): sign in again here (§7.1).
                    val auth = ((e as? FileError) ?: (e?.cause as? FileError))?.kind == FileError.Kind.AUTH
                    if (auth && api != null && !api.source.isLocal) Pill(stringResource(CoreR.string.files_sign_in_again), onClick = {
                        overlay.show(gridReq) { SignInSheet(api.source) { overlay.close(); refresh() } }
                    })
                }
            }
            result == null -> Centered { Spinner() }
        }
        val items = result?.items.orEmpty()
        LazyVerticalGrid(
            columns = GridCells.Fixed(6),
            modifier = Modifier.fillMaxSize().focusRequester(gridReq).dpadEdges().onPreviewKeyEvent { e ->
                // Menu (or holding OK) on the grid: sort, refresh, and the focused file's actions.
                val hold = (e.key == Key.DirectionCenter || e.key == Key.Enter) && e.type == KeyEventType.KeyDown && e.nativeKeyEvent.repeatCount == 1
                if ((e.key == Key.Menu && e.type == KeyEventType.KeyUp) || hold) {
                    menu()
                    true
                } else false
            },
            contentPadding = PaddingValues(start = 48.dp, end = 48.dp, top = 40.dp, bottom = 56.dp),
            horizontalArrangement = Arrangement.spacedBy(20.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            item("header", span = { GridItemSpan(maxLineSpan) }) {
                Column(Modifier.padding(bottom = 4.dp)) {
                    Text(crumbs.dropLast(1).joinToString(" › "), style = Type.footnote, color = C.label3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(crumbs.last(), style = Type.largeTitle, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val sortLabel = stringResource(SORTS[sort].first)
                    if (result != null) Text(
                        pluralStringResource(R.plurals.items_count, result.totalRecordCount, result.totalRecordCount) + " · " + sortLabel +
                            (if (api?.truncated == true) " · " + stringResource(CoreR.string.files_list_truncated) else ""),
                        style = Type.footnote, color = C.label3,
                    )
                }
            }
            if (result != null && items.isEmpty()) item("empty", span = { GridItemSpan(maxLineSpan) }) {
                Text(stringResource(CoreR.string.files_list_empty), style = Type.title3, color = C.label2, modifier = Modifier.padding(top = 60.dp))
            }
            itemsIndexed(items, key = { _, it -> it.id }) { i, item ->
                PosterCard(
                    item, api!!, width = null,
                    onFocus = { focused = item },
                    onClick = { if (item.isFolder) nav.push(Route.Files(sourceId, item.id, item.name)) else play(context, item) },
                    // The first card takes focus on the first visit; Back restores the one that was focused.
                    focusModifier = Modifier.remembered(memory, item.id, default = i == 0),
                )
            }
        }
    }
}

// §7.3: the pinned certificate changed. Both fingerprints; Cancel is the default and leaves the folder, as on mobile.
@Composable
private fun CertChanged(api: FilesApi, onCancel: () -> Unit, onDone: () -> Unit) {
    val pinned = api.source.tls?.sha256.orEmpty()
    var now by remember { mutableStateOf<TlsPin.CertInfo?>(null) }
    LaunchedEffect(Unit) { now = FileSources.presented(api.source) }
    Column(Modifier.width(560.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(stringResource(CoreR.string.files_tls_changed_title), style = Type.title2, color = C.label)
        val current = now
        Text(
            stringResource(CoreR.string.files_tls_changed_body, pinned.uppercase().chunked(2).joinToString(":"), current?.fingerprint ?: "…"),
            style = Type.footnote, color = C.label2, modifier = Modifier.padding(vertical = 16.dp),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            val cancel = remember { FocusRequester() }
            LaunchedEffect(Unit) { delay(80); runCatching { cancel.requestFocus() } }
            if (current != null) Pill(stringResource(CoreR.string.files_tls_trust_new), onClick = {
                FileSources.trustNew(api.source, current)
                onDone()
            })
            Pill(stringResource(R.string.cancel), modifier = Modifier.focusRequester(cancel), onClick = onCancel)
        }
    }
}

// The Add sheet (§6.1, §9.2): Folder on this device (only where a documents UI exists), WebDAV, SMB share; the address,
// the credentials, Test, Save; an untrusted certificate is shown before anything is trusted.
@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
fun AddFileSourceSheet(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val draft = remember { FileSourceDraft() }
    val local = remember { LocalFolders.available(context) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) {
            runCatching { LocalFolders.add(context, uri) }.onFailure { Toast.makeText(context, errorText(it), Toast.LENGTH_LONG).show() }
            onDismiss()
        }
    }
    // The certificate prompt (below) is a layer over the sheet: it holds the focus while shown, and gives it back to
    // Test (Cancel) or Save (Trust) before it goes, so the focused node is never removed under the D-pad.
    var certClosing by remember { mutableStateOf(false) }
    val testReq = remember { FocusRequester() }
    val saveReq = remember { FocusRequester() }
    fun closeCert(to: FocusRequester) {
        certClosing = true
        runCatching { to.requestFocus() }
        certClosing = false
    }
    TvSheet(onDismiss, width = 620.dp, trap = draft.cert == null) {
        // Taller than the 540 dp canvas with every field: it scrolls with the focus.
        Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState())) {
        Text(stringResource(CoreR.string.files_add), style = Type.title2, color = C.label, modifier = Modifier.padding(bottom = 16.dp))
        val first = remember { FocusRequester() }
        LaunchedEffect(Unit) { delay(60); runCatching { first.requestFocus() } }
        Row(Modifier.focusGroup(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (local) Pill(stringResource(CoreR.string.files_add_local), onClick = { runCatching { pick.launch(null) } })
            Pill(stringResource(CoreR.string.files_add_webdav), primary = draft.protocol == FileSource.WEBDAV, modifier = Modifier.focusRequester(first), onClick = { draft.protocol = FileSource.WEBDAV })
            Pill(stringResource(CoreR.string.files_add_smb), primary = draft.protocol == FileSource.SMB, onClick = { draft.protocol = FileSource.SMB })
        }
        Spacer(Modifier.height(12.dp))
        FindOnNetwork(draft)
        Spacer(Modifier.height(16.dp))
        val smb = draft.protocol == FileSource.SMB
        TvTextField(draft.url, { draft.url = it; draft.tested = false }, if (smb) "\\\\STORAGE\\media" else "https://dav.example/media", Modifier.fillMaxWidth(), imeAction = ImeAction.Next, label = stringResource(CoreR.string.files_add_url))
        if (smb) Text(stringResource(CoreR.string.files_add_smb_help), style = Type.footnote, color = C.label3, modifier = Modifier.padding(top = 6.dp))
        Spacer(Modifier.height(10.dp))
        // One field per line: the password field brings its own Show button.
        TvTextField(draft.user, { draft.user = it; draft.tested = false }, stringResource(CoreR.string.files_add_user), Modifier.fillMaxWidth(), imeAction = ImeAction.Next)
        Spacer(Modifier.height(10.dp))
        TvTextField(draft.pass, { draft.pass = it; draft.tested = false }, stringResource(CoreR.string.files_add_password), Modifier.fillMaxWidth(), password = true, imeAction = ImeAction.Next)
        if (smb) {
            Spacer(Modifier.height(10.dp))
            TvTextField(draft.domain, { draft.domain = it }, stringResource(CoreR.string.files_add_domain), Modifier.fillMaxWidth(), imeAction = ImeAction.Next)
        }
        Spacer(Modifier.height(10.dp))
        TvTextField(draft.name, { draft.name = it }, stringResource(CoreR.string.files_add_name), Modifier.fillMaxWidth())
        if (draft.insecure) {
            Spacer(Modifier.height(10.dp))
            SheetButton(stringResource(CoreR.string.files_add_insecure), checked = draft.insecureAck, onClick = { draft.insecureAck = !draft.insecureAck })
        }
        draft.status?.let { Text(it, style = Type.callout, color = C.label2, modifier = Modifier.padding(top = 12.dp)) }
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Pill(stringResource(CoreR.string.files_add_test), modifier = Modifier.focusRequester(testReq), onClick = { if (!draft.busy && draft.valid) scope.launch { draft.test() } })
            Pill(stringResource(CoreR.string.files_add_save), primary = draft.tested, modifier = Modifier.focusRequester(saveReq), onClick = {
                if (!draft.busy && draft.valid) scope.launch { if (draft.save()) onDismiss() }
            })
        }
        }
    }
    val cert = draft.cert
    if (cert != null) {
        // Over the sheet: Cancel is the default (§7.3), and Back is Cancel (not the whole sheet).
        val cancelCert = { closeCert(testReq); draft.cert = null }
        BackHandler(onBack = cancelCert)
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.6f)), contentAlignment = Alignment.Center) {
            Column(
                Modifier.width(600.dp).background(C.elevated2, RoundedCornerShape(Radius.xl))
                    // A focus trap: the D-pad never reaches the sheet's fields behind the scrim.
                    .focusProperties {
                        @Suppress("DEPRECATION")
                        exit = { if (certClosing) FocusRequester.Default else FocusRequester.Cancel }
                    }
                    .focusGroup().padding(28.dp),
            ) {
                Text(stringResource(CoreR.string.files_tls_title), style = Type.title2, color = C.label)
                Text(stringResource(CoreR.string.files_tls_body), style = Type.callout, color = C.label2, modifier = Modifier.padding(vertical = 10.dp))
                Text(cert.lines(), style = Type.mono, color = C.label2)
                Spacer(Modifier.height(18.dp))
                val cancel = remember { FocusRequester() }
                LaunchedEffect(cert) { delay(60); runCatching { cancel.requestFocus() } }
                SheetButton(stringResource(R.string.cancel), modifier = Modifier.focusRequester(cancel), onClick = cancelCert)
                Spacer(Modifier.height(8.dp))
                SheetButton(stringResource(CoreR.string.files_tls_trust), onClick = { closeCert(saveReq); scope.launch { draft.trust() } })
            }
        }
    }
}

// §6.2 "Find on this network" (NsdManager, 2.5 s): a reply only fills the form; nothing connects before Test.
@Composable
private fun FindOnNetwork(draft: FileSourceDraft) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var searching by remember { mutableStateOf(false) }
    var found by remember { mutableStateOf<List<FoundShare>?>(null) }
    Pill(stringResource(if (searching) CoreR.string.files_mdns_searching else CoreR.string.files_mdns_find), icon = Ic.Search, onClick = {
        if (!searching) scope.launch {
            searching = true
            found = runCatching { Nsd.find(context) }.getOrDefault(emptyList())
            searching = false
        }
    })
    val list = found ?: return
    if (list.isEmpty()) Text(stringResource(CoreR.string.files_mdns_none), style = Type.footnote, color = C.label3, modifier = Modifier.padding(top = 8.dp))
    list.forEach { f ->
        Spacer(Modifier.height(8.dp))
        SheetButton(f.name + " · " + com.wika.wicaby.core.files.pure.Urls.display(f.url), onClick = {
            draft.protocol = f.protocol
            draft.url = f.url
            if (draft.user.isEmpty()) f.user?.let { draft.user = it }
            if (draft.name.isEmpty()) draft.name = f.name
            draft.tested = false
            found = null
        })
    }
}
