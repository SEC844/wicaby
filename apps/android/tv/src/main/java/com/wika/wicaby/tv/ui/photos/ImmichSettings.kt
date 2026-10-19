package com.wika.wicaby.tv.ui.photos

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.photos.Immich
import com.wika.wicaby.core.photos.ImmichClient
import com.wika.wicaby.core.photos.ImmichProbe
import com.wika.wicaby.core.photos.normalizeImmichUrl
import com.wika.wicaby.core.files.FileSource
import com.wika.wicaby.core.files.FileSources
import com.wika.wicaby.core.files.LocalFolders
import com.wika.wicaby.core.files.PhotoIndex
import com.wika.wicaby.core.files.text
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.ui.AddFileSourceSheet
import com.wika.wicaby.tv.ui.AlertAction
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.SignInSheet
import com.wika.wicaby.tv.ui.TvAlert
import com.wika.wicaby.tv.ui.Cache
import com.wika.wicaby.tv.ui.ConfirmRow
import com.wika.wicaby.tv.ui.Group
import com.wika.wicaby.tv.ui.LocalOverlay
import com.wika.wicaby.tv.ui.SettingRow
import com.wika.wicaby.tv.ui.SheetButton
import com.wika.wicaby.tv.ui.TvSheet
import com.wika.wicaby.tv.ui.TvTextField
import com.wika.wicaby.tv.ui.Type
import kotlinx.coroutines.launch

// Réglages > Sources > "Dossiers de photos" and "Immich" (photos spec PH-13): connect an Immich server with an API key,
// sealed by the Keystore; Test checks the version (2.0 or later) and which permissions the key lacks.
@Composable
internal fun ImmichGroup() {
    val overlay = LocalOverlay.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var source by remember { mutableStateOf(Immich.source) }
    val add = remember { FocusRequester() }
    Group(stringResource(CoreR.string.photos_folders_title)) {
        PhotoSourceRows()
    }
    Group(stringResource(CoreR.string.photos_immich_title), stringResource(CoreR.string.photos_sources_foot)) {
        source?.let { s ->
            val remove = stringResource(CoreR.string.photos_sources_remove)
            ConfirmRow(s.name, remove, value = remove) {
                scope.launch {
                    Immich.remove(context)
                    source = null
                    Cache.changed()
                }
            }
        }
        SettingRow(stringResource(CoreR.string.photos_immich_connect), modifier = Modifier.focusRequester(add), chevron = true, onClick = {
            overlay.show(add) {
                ImmichSheet { added ->
                    if (added) {
                        source = Immich.source
                        Cache.changed()
                    }
                    overlay.close()
                }
            }
        })
    }
}

// The photo sources (a folder or a share used as a photo library): each with its scan status (OK: Rescan, Remove),
// then Add, through the file sources' own sheet (address, credentials, Test, Find on this network).
@Composable
private fun PhotoSourceRows() {
    val overlay = LocalOverlay.current
    val context = LocalContext.current
    val sources by FileSources.photos.collectAsState()
    sources.forEach { s ->
        key(s.id) {
            val me = remember { FocusRequester() }
            val index = remember(s.id) { FileSources.api(s.id)?.photos }
            val status by (index?.status ?: kotlinx.coroutines.flow.MutableStateFlow(PhotoIndex.Status())).collectAsState()
            LaunchedEffect(index) { index?.peek() }
            val sub = if (FileSources.needsSignIn(s)) stringResource(CoreR.string.files_sign_in_again) else status.text()
            SettingRow(s.name, sub, Modifier.focusRequester(me), chevron = true, onClick = {
                overlay.show(me) {
                    val actions = buildList {
                        add(AlertAction(stringResource(CoreR.string.photos_sources_rescan)) { overlay.close(); index?.rescan(); Cache.changed() })
                        if (!s.isLocal) add(AlertAction(stringResource(CoreR.string.files_sign_in_again)) { overlay.show(me) { SignInSheet(s, overlay::close) } })
                        add(AlertAction(stringResource(CoreR.string.photos_sources_remove), destructive = true) { overlay.close(); FileSources.remove(s.id); Cache.changed() })
                        add(AlertAction(stringResource(R.string.cancel)) { overlay.close() })
                    }
                    TvAlert(s.name, s.label.ifEmpty { null }, actions, focusIndex = actions.lastIndex, onDismiss = overlay::close)
                }
            })
        }
    }
    // A folder of this device: the system picker at once (the sheet's other fields do not apply to it).
    val pick = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) runCatching { LocalFolders.add(context, uri, photos = true); Cache.changed() }
            .onFailure { android.widget.Toast.makeText(context, com.wika.wicaby.core.files.errorText(it), android.widget.Toast.LENGTH_LONG).show() }
    }
    val choices = listOfNotNull(
        (CoreR.string.files_add_local to FileSource.LOCAL).takeIf { LocalFolders.available(context) },
        CoreR.string.files_add_smb to FileSource.SMB,
        CoreR.string.files_add_webdav to FileSource.WEBDAV,
    )
    choices.forEach { (label, protocol) ->
        val me = remember { FocusRequester() }
        SettingRow(stringResource(CoreR.string.photos_sources_add_with, stringResource(label)), modifier = Modifier.focusRequester(me), chevron = true, onClick = {
            if (protocol == FileSource.LOCAL) runCatching { pick.launch(null) }
            else overlay.show(me) { AddFileSourceSheet(onDismiss = { overlay.close(); Cache.changed() }, photos = true, protocol = protocol) }
        })
    }
}

@Composable
private fun ImmichSheet(onDone: (added: Boolean) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf("") }
    var key by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<ImmichProbe?>(null) }
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    fun run(add: Boolean) {
        if (busy || url.isBlank() || key.isBlank()) return
        busy = true
        scope.launch {
            val base = normalizeImmichUrl(url)
            val r = if (base == null) ImmichProbe(false, "url") else ImmichClient(base, key.trim()).test()
            result = r
            busy = false
            if (add && r.ok && base != null) {
                Immich.save(context, base, key.trim())
                onDone(true)
            }
        }
    }
    TvSheet({ onDone(false) }, width = 640.dp) {
        Text(stringResource(CoreR.string.photos_sources_title), style = Type.title3, color = C.label, modifier = Modifier.padding(bottom = 18.dp))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val urlLabel = stringResource(CoreR.string.photos_sources_url)
            val keyLabel = stringResource(CoreR.string.photos_sources_key)
            Text(urlLabel, style = Type.footnote, color = C.label3, modifier = Modifier.padding(start = 4.dp))
            TvTextField(url, { url = it }, "http://photos.local:2283", Modifier.fillMaxWidth().focusRequester(first), imeAction = ImeAction.Next, label = urlLabel)
            Text(keyLabel, style = Type.footnote, color = C.label3, modifier = Modifier.padding(start = 4.dp, top = 6.dp))
            TvTextField(key, { key = it }, keyLabel, Modifier.fillMaxWidth(), password = true, onSubmit = { run(false) }, label = keyLabel)
            Text(stringResource(CoreR.string.photos_sources_key_hint), style = Type.footnote, color = C.label3, modifier = Modifier.padding(start = 4.dp))
            result?.let { r ->
                val msg = when {
                    r.ok -> stringResource(CoreR.string.photos_sources_ok, r.version.orEmpty())
                    r.error == "version" -> stringResource(CoreR.string.photos_sources_version_too_old, r.version.orEmpty())
                    r.error == "url" -> stringResource(CoreR.string.photos_sources_error_url)
                    r.error == "network" -> stringResource(CoreR.string.photos_sources_error_network)
                    r.error == "auth" -> stringResource(CoreR.string.photos_sources_error_auth)
                    r.error == "scope" -> stringResource(CoreR.string.photos_sources_error_scope)
                    else -> stringResource(CoreR.string.photos_sources_error_server)
                }
                Text(msg, style = Type.callout, color = if (r.ok) C.label else C.red, modifier = Modifier.padding(start = 4.dp, top = 4.dp).testTag("immich-result"))
                if (r.missing.isNotEmpty()) Text(stringResource(CoreR.string.photos_sources_scopes_missing, r.missing.joinToString(", ")), style = Type.footnote, color = C.label2, modifier = Modifier.padding(start = 4.dp))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 10.dp)) {
                SheetButton(stringResource(CoreR.string.photos_sources_test), onClick = { run(false) }, modifier = Modifier.weight(1f))
                SheetButton(stringResource(CoreR.string.photos_sources_add), onClick = { run(true) }, modifier = Modifier.weight(1f))
            }
        }
    }
}
