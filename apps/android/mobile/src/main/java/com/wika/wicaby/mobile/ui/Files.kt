package com.wika.wicaby.mobile.ui

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
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
import com.wika.wicaby.mobile.R
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

// File sources on phones and tablets (file-sources spec §9.3): a Files section in Libraries (the sources, their
// Continue row, Add), one screen per folder with breadcrumbs, sort and pull-to-refresh, and the Add sheet with the
// system folder picker.

@Serializable
data class FilesRoute(val sourceId: String, val id: String, val title: String)

private fun kindLabel(s: FileSource) = when (s.protocol) {
    FileSource.LOCAL -> CoreR.string.files_kind_local
    FileSource.SMB -> CoreR.string.files_kind_smb
    else -> CoreR.string.files_kind_webdav
}

// Libraries > Files: under the server libraries.
@Composable
fun FilesSection(nav: NavController) {
    val sources by FileSources.list.collectAsState()
    var adding by remember { mutableStateOf(false) }
    var signIn by remember { mutableStateOf<FileSource?>(null) }
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth()) {
        Eyebrow(stringResource(CoreR.string.files_title))
        Group {
            sources.forEach { s ->
                GroupRow(
                    // A credential that no longer opens is asked for again (§7.1); the source and its progress stay.
                    s.name, { if (FileSources.needsSignIn(s)) signIn = s else nav.navigate(FilesRoute(s.id, Ids.ROOT, s.name)) },
                    subtitle = if (FileSources.needsSignIn(s)) stringResource(CoreR.string.files_sign_in_again) else listOf(stringResource(kindLabel(s)), s.label).filter { it.isNotEmpty() }.joinToString(" · "),
                    icon = Ic.Server,
                )
                GroupDivider()
            }
            GroupRow(stringResource(CoreR.string.files_add), { adding = true }, icon = Ic.Plus, chevron = false)
        }
        val cont = rememberLoad("files-continue-${sources.map { it.id }}") {
            FileSources.all().flatMap { a -> runCatching { a.resume() }.getOrDefault(emptyList()) }.sortedByDescending { it.userData?.lastPlayedDate.orEmpty() }
        }.value.orEmpty()
        if (cont.isNotEmpty()) MediaRow(stringResource(CoreR.string.files_continue), cont, FileSources.all().first(), wide = true, onClick = { play(context, it) })
    }
    if (adding) AddFileSourceSheet(onDismiss = { adding = false })
    signIn?.let { s -> SignInSheet(s) { signIn = null } }
}

private val SORTS = listOf(CoreR.string.files_sort_name to "SortName", CoreR.string.files_sort_date to "DateModified", CoreR.string.files_sort_size to "Size")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilesScreen(route: FilesRoute, nav: NavController) {
    val api = FileSources.api(route.sourceId)
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var sort by rememberSaveable { mutableIntStateOf(0) }
    var descending by rememberSaveable { mutableStateOf(false) }
    var nonce by remember { mutableIntStateOf(0) }
    var menuFor by remember { mutableStateOf<Item?>(null) }
    var signIn by remember { mutableStateOf(false) }
    val rel = Ids.decode(route.id).orEmpty()
    val crumbs = Ids.crumbs(rel).map { (_, n) -> n.ifEmpty { api?.source?.name ?: route.title } }
    val load = rememberLoad("files-${route.sourceId}-${route.id}-$sort-$descending", nonce) {
        api ?: throw FileError(FileError.Kind.NOT_FOUND)
        api.get<ItemsResult>("/Items", "ParentId" to route.id, "SortBy" to SORTS[sort].second, "SortOrder" to if (descending) "Descending" else "Ascending")
    }
    Column(Modifier.fillMaxSize()) {
        TopBar(crumbs.last(), onBack = { nav.popBackStack() })
        if (crumbs.size > 1) Text(crumbs.dropLast(1).joinToString(" › "), style = Type.footnote, color = G.label3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 20.dp))
        Row(Modifier.padding(horizontal = 20.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            var open by remember { mutableStateOf(false) }
            Box {
                Chip(stringResource(SORTS[sort].first), selected = true, icon = Ic.Sort) { open = true }
                DropdownMenu(open, { open = false }, containerColor = G.elevated2, shape = RoundedCornerShape(Radius.md)) {
                    SORTS.forEachIndexed { i, (label, _) ->
                        DropdownMenuItem(
                            text = { Text(stringResource(label), style = Type.body, color = G.label) },
                            trailingIcon = { if (i == sort) Icon(Ic.Check, null, tint = LocalAccent.current, modifier = Modifier.size(18.dp)) },
                            onClick = {
                                // The current sort again reverses it.
                                if (i == sort) descending = !descending else { sort = i; descending = false }
                                open = false
                            },
                        )
                    }
                }
            }
        }
        // As Home: the indicator stays while a pulled reload runs.
        var pulled by remember { mutableStateOf(false) }
        LaunchedEffect(load.loading) { if (!load.loading) pulled = false }
        PullToRefreshBox(isRefreshing = pulled && load.loading, onRefresh = { pulled = true; api?.refresh(); nonce++ }, modifier = Modifier.fillMaxSize()) {
            val result = load.value
            when {
                result == null && load.error != null -> Centered {
                    val e = load.error as? FileError ?: load.error?.cause as? FileError
                    if (e?.kind == FileError.Kind.CERT_CHANGED && api != null) CertChanged(api, onCancel = { nav.popBackStack() }) { api.refresh(); nonce++ }
                    else Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(errorText(load.error), style = Type.body, color = G.label2, modifier = Modifier.padding(24.dp))
                        if (e?.kind == FileError.Kind.AUTH && api != null && !api.source.isLocal) PillButton(stringResource(CoreR.string.files_sign_in_again), onClick = { signIn = true })
                    }
                }
                result == null -> Centered { Spinner() }
                result.items.isEmpty() -> Centered { Text(stringResource(CoreR.string.files_list_empty), style = Type.body, color = G.label2) }
            }
            if (result != null && api != null) LazyVerticalGrid(
                columns = GridCells.Adaptive(108.dp),
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 24.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                item("count", span = { GridItemSpan(maxLineSpan) }) {
                    val count = pluralStringResource(R.plurals.items_count, result.totalRecordCount, formatNumber(result.totalRecordCount))
                    Text(if (api.truncated) count + " · " + stringResource(CoreR.string.files_list_truncated) else count, style = Type.footnote, color = G.label3)
                }
                items(result.items, key = { it.id }) { item ->
                    Box {
                        PosterCard(
                            item, api, width = null,
                            onClick = { if (item.isFolder) nav.navigate(FilesRoute(route.sourceId, item.id, item.name)) else play(context, item) },
                            onLongClick = if (item.isFolder) null else { { menuFor = item } },
                        )
                        DropdownMenu(menuFor == item, { menuFor = null }, containerColor = G.elevated2, shape = RoundedCornerShape(Radius.md)) {
                            DropdownMenuItem(text = { Text(stringResource(CoreR.string.files_play_from_start), style = Type.body, color = G.label) }, onClick = { menuFor = null; play(context, item, fromStart = true) })
                            val played = item.userData?.played == true
                            DropdownMenuItem(
                                text = { Text(stringResource(if (played) CoreR.string.files_mark_unplayed else CoreR.string.files_mark_played), style = Type.body, color = G.label) },
                                onClick = {
                                    menuFor = null
                                    scope.launch { runCatching { api.setPlayed(item.id, !played) }; nonce++ }
                                },
                            )
                        }
                    }
                }
            }
        }
    }
    if (signIn && api != null) SignInSheet(api.source) { signIn = false; api.refresh(); nonce++ }
}

// §7.3: the pinned certificate changed. Blocking: both fingerprints, "Trust the new one" (explicit) or Cancel.
@Composable
private fun CertChanged(api: FilesApi, onCancel: () -> Unit, onTrusted: () -> Unit) {
    val pinned = api.source.tls?.sha256.orEmpty()
    var now by remember { mutableStateOf<TlsPin.CertInfo?>(null) }
    LaunchedEffect(api.source) { now = FileSources.presented(api.source) }
    val current = now
    Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(stringResource(CoreR.string.files_tls_changed_title), style = Type.title3, color = G.label)
        Text(
            stringResource(CoreR.string.files_tls_changed_body, pinned.uppercase().chunked(2).joinToString(":"), current?.fingerprint ?: "…"),
            style = Type.footnote, color = G.label2, modifier = Modifier.padding(vertical = 14.dp),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PillButton(stringResource(R.string.cancel), primary = true, onClick = onCancel)
            if (current != null) PillButton(stringResource(CoreR.string.files_tls_trust_new), onClick = {
                FileSources.trustNew(api.source, current)
                onTrusted()
            })
        }
    }
}

// §7.1 "sign in again": new credentials, tested before they replace the stored ones; the source keeps its progress.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SignInSheet(s: FileSource, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    val draft = remember(s.id) { SignInDraft(s) }
    ModalBottomSheet(onDismissRequest = onDone, containerColor = G.elevated) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imeAware().padding(horizontal = 20.dp).padding(bottom = 24.dp).navigationBarsPadding()) {
            Text(stringResource(CoreR.string.files_sign_in_again), style = Type.title2, color = G.label)
            Text(stringResource(CoreR.string.files_sign_in_body, s.name), style = Type.callout, color = G.label2, modifier = Modifier.padding(top = 6.dp, bottom = 14.dp))
            WicabyField(draft.user, { draft.user = it }, stringResource(CoreR.string.files_add_user), imeAction = ImeAction.Next)
            Spacer(Modifier.height(10.dp))
            WicabyField(draft.pass, { draft.pass = it }, stringResource(CoreR.string.files_add_password), password = true, imeAction = ImeAction.Next)
            if (s.isSmb) {
                Spacer(Modifier.height(10.dp))
                WicabyField(draft.domain, { draft.domain = it }, stringResource(CoreR.string.files_add_domain))
            }
            draft.status?.let { Text(it, style = Type.callout, color = G.label2, modifier = Modifier.padding(top = 12.dp)) }
            Spacer(Modifier.height(16.dp))
            PillButton(stringResource(CoreR.string.files_add_save), primary = true, onClick = { if (!draft.busy) scope.launch { if (draft.save()) onDone() } })
        }
    }
}

// §6.2 "Find on this network" (NsdManager, 2.5 s): a reply only fills the form; nothing connects before Test.
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun FindOnNetwork(draft: FileSourceDraft) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var searching by remember { mutableStateOf(false) }
    var found by remember { mutableStateOf<List<FoundShare>?>(null) }
    Chip(stringResource(if (searching) CoreR.string.files_mdns_searching else CoreR.string.files_mdns_find), selected = false, icon = Ic.Search) {
        if (!searching) scope.launch {
            searching = true
            found = runCatching { Nsd.find(context) }.getOrDefault(emptyList())
            searching = false
        }
    }
    val list = found ?: return
    if (list.isEmpty()) Text(stringResource(CoreR.string.files_mdns_none), style = Type.footnote, color = G.label3, modifier = Modifier.padding(top = 6.dp))
    else FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        list.forEach { f ->
            Chip(f.name + " · " + com.wika.wicaby.core.files.pure.Urls.display(f.url), selected = false) {
                draft.protocol = f.protocol
                draft.url = f.url
                if (draft.user.isEmpty()) f.user?.let { draft.user = it }
                if (draft.name.isEmpty()) draft.name = f.name
                draft.tested = false
                found = null
            }
        }
    }
}

// The Add sheet (§6.1): Folder on this device (the system picker), WebDAV or SMB; Test before Save; an untrusted
// certificate is shown, and trusted for this source only, before anything is sent.
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
// photos: a photo source (Réglages > Sources de photos), the same form; protocol: the one preselected.
fun AddFileSourceSheet(onDismiss: () -> Unit, photos: Boolean = false, protocol: String = FileSource.WEBDAV) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val draft = remember { FileSourceDraft(protocol, photos) }
    val accent = LocalAccent.current
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) {
            runCatching { LocalFolders.add(context, uri, photos) }.onFailure { Toast.makeText(context, errorText(it), Toast.LENGTH_LONG).show() }
            onDismiss()
        }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = G.elevated) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imeAware().padding(horizontal = 20.dp).padding(bottom = 24.dp).navigationBarsPadding()) {
            Text(stringResource(if (photos) CoreR.string.photos_sources_files_add else CoreR.string.files_add), style = Type.title2, color = G.label, modifier = Modifier.padding(bottom = 14.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (LocalFolders.available(context)) Chip(stringResource(CoreR.string.files_add_local), selected = false) { runCatching { pick.launch(null) } }
                Chip(stringResource(CoreR.string.files_add_webdav), selected = draft.protocol == FileSource.WEBDAV) { draft.protocol = FileSource.WEBDAV }
                Chip(stringResource(CoreR.string.files_add_smb), selected = draft.protocol == FileSource.SMB) { draft.protocol = FileSource.SMB }
            }
            Spacer(Modifier.height(10.dp))
            FindOnNetwork(draft)
            val smb = draft.protocol == FileSource.SMB
            Spacer(Modifier.height(14.dp))
            Text(stringResource(CoreR.string.files_add_url), style = Type.footnote, color = G.label2, modifier = Modifier.padding(bottom = 6.dp))
            WicabyField(draft.url, { draft.url = it; draft.tested = false }, if (smb) "\\\\STORAGE\\media" else "https://dav.example/media", keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next)
            if (smb) Text(stringResource(CoreR.string.files_add_smb_help), style = Type.footnote, color = G.label3, modifier = Modifier.padding(top = 6.dp))
            Spacer(Modifier.height(10.dp))
            WicabyField(draft.user, { draft.user = it; draft.tested = false }, stringResource(CoreR.string.files_add_user), imeAction = ImeAction.Next)
            Spacer(Modifier.height(10.dp))
            WicabyField(draft.pass, { draft.pass = it; draft.tested = false }, stringResource(CoreR.string.files_add_password), password = true, imeAction = ImeAction.Next)
            if (smb) {
                Spacer(Modifier.height(10.dp))
                WicabyField(draft.domain, { draft.domain = it }, stringResource(CoreR.string.files_add_domain), imeAction = ImeAction.Next)
            }
            Spacer(Modifier.height(10.dp))
            WicabyField(draft.name, { draft.name = it }, stringResource(CoreR.string.files_add_name))
            if (draft.insecure) {
                Spacer(Modifier.height(10.dp))
                Group {
                    GroupRow(stringResource(CoreR.string.files_add_insecure), { draft.insecureAck = !draft.insecureAck }, chevron = false) {
                        Switch(
                            draft.insecureAck, { draft.insecureAck = it },
                            colors = SwitchDefaults.colors(checkedTrackColor = accent, checkedThumbColor = onAccent(accent), uncheckedTrackColor = G.control, uncheckedThumbColor = G.controlKnob, uncheckedBorderColor = androidx.compose.ui.graphics.Color.Transparent),
                        )
                    }
                }
            }
            draft.status?.let { Text(it, style = Type.callout, color = G.label2, modifier = Modifier.padding(top = 12.dp)) }
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PillButton(stringResource(CoreR.string.files_add_test), onClick = { if (!draft.busy && draft.valid) scope.launch { draft.test() } })
                PillButton(stringResource(CoreR.string.files_add_save), primary = true, onClick = { if (!draft.busy && draft.valid) scope.launch { if (draft.save()) onDismiss() } })
            }
        }
    }
    val cert = draft.cert
    if (cert != null) AlertDialog(
        onDismissRequest = { draft.cert = null },
        title = { Text(stringResource(CoreR.string.files_tls_title)) },
        text = { Text(stringResource(CoreR.string.files_tls_body) + "\n\n" + cert.lines(), style = Type.footnote) },
        dismissButton = { TextButton({ draft.cert = null }) { Text(stringResource(R.string.cancel)) } },
        confirmButton = { TextButton({ scope.launch { draft.trust() } }) { Text(stringResource(CoreR.string.files_tls_trust)) } },
    )
}

// Réglages > Apparence > Accueil: the file sources on Home (off by default, spec D10).
@Composable
fun FilesOnHomeRow() {
    val showOnHome by FileSources.showOnHome.collectAsState()
    GroupRow(stringResource(CoreR.string.files_home_setting), { FileSources.setShowOnHome(!showOnHome); Cache.map.clear() }, chevron = false) {
        SettingSwitch(showOnHome, { FileSources.setShowOnHome(it); Cache.map.clear() })
    }
}

// Réglages > Sources: the sources of this device and Add.
@Composable
fun FilesSettings() {
    val sources by FileSources.list.collectAsState()
    var adding by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<FileSource?>(null) }
    var signIn by remember { mutableStateOf<FileSource?>(null) }
    Eyebrow(stringResource(CoreR.string.files_title))
    Group {
        sources.forEach { s ->
            val sub = if (FileSources.needsSignIn(s)) stringResource(CoreR.string.files_sign_in_again) else listOf(stringResource(kindLabel(s)), s.label).filter { it.isNotEmpty() }.joinToString(" · ")
            GroupRow(s.name, { if (FileSources.needsSignIn(s)) signIn = s else removing = s }, subtitle = sub, icon = Ic.Server, end = {
                Icon(Ic.Trash, stringResource(CoreR.string.files_remove), tint = G.label2, modifier = Modifier.size(20.dp))
            }, chevron = false)
            GroupDivider()
        }
        GroupRow(stringResource(CoreR.string.files_add), { adding = true }, icon = Ic.Plus, chevron = false)
    }
    if (adding) AddFileSourceSheet(onDismiss = { adding = false })
    removing?.let { s ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text(stringResource(CoreR.string.files_remove)) },
            text = { Text(stringResource(CoreR.string.files_remove_confirm, s.name)) },
            dismissButton = {
                Row {
                    // A network source can take new credentials instead (§7.1): its progress stays.
                    if (!s.isLocal) TextButton({ removing = null; signIn = s }) { Text(stringResource(CoreR.string.files_sign_in_again)) }
                    TextButton({ removing = null }) { Text(stringResource(R.string.cancel)) }
                }
            },
            confirmButton = { TextButton({ removing = null; FileSources.remove(s.id) }) { Text(stringResource(CoreR.string.files_remove), color = G.red) } },
        )
    }
    signIn?.let { s -> SignInSheet(s) { signIn = null } }
}
