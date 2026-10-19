package com.wika.wicaby.mobile.ui.photos

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.photos.Immich
import com.wika.wicaby.core.photos.ImmichClient
import com.wika.wicaby.core.photos.ImmichProbe
import com.wika.wicaby.core.photos.normalizeImmichUrl
import com.wika.wicaby.core.files.FileSource
import com.wika.wicaby.core.files.FileSources
import com.wika.wicaby.core.files.LocalFolders
import com.wika.wicaby.core.files.PhotoIndex
import com.wika.wicaby.core.files.errorText
import com.wika.wicaby.core.files.text
import com.wika.wicaby.mobile.ui.AddFileSourceSheet
import com.wika.wicaby.mobile.ui.Cache
import com.wika.wicaby.mobile.ui.SignInSheet
import kotlinx.coroutines.flow.MutableStateFlow
import com.wika.wicaby.mobile.ui.Eyebrow
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Group
import com.wika.wicaby.mobile.ui.GroupDivider
import com.wika.wicaby.mobile.ui.GroupRow
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.WicabyField
import kotlinx.coroutines.launch

// Réglages > Sources > "Dossiers de photos" and "Immich" (photos spec PH-13): connect an Immich server with an API key. The key is sealed by
// the Keystore and never shown again; Test checks the version (2.0 or later) and which permissions the key lacks.
@Composable
fun ImmichSettings() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var source by remember { mutableStateOf(Immich.source) }
    var url by rememberSaveable { mutableStateOf("") }
    var key by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<ImmichProbe?>(null) }
    fun run(add: Boolean) {
        if (busy || url.isBlank() || key.isBlank()) return
        busy = true
        scope.launch {
            val base = normalizeImmichUrl(url)
            val r = if (base == null) ImmichProbe(false, "url") else ImmichClient(base, key.trim()).test()
            if (add && r.ok && base != null) {
                source = Immich.save(context, base, key.trim())
                url = ""
                key = ""
                Cache.map.clear()
            }
            result = r
            busy = false
        }
    }
    // The form shows while no Immich server is connected; then behind "Connecter un autre serveur Immich".
    var another by rememberSaveable { mutableStateOf(false) }
    Eyebrow(stringResource(CoreR.string.photos_folders_title))
    Group {
        PhotoSourceRows()
    }
    Eyebrow(stringResource(CoreR.string.photos_immich_title))
    Group {
        source?.let { s ->
            GroupRow(s.name, {
                scope.launch {
                    Immich.remove(context)
                    source = null
                    Cache.map.clear()
                }
            }, subtitle = s.url, icon = Ic.Server, chevron = false, end = {
                Icon(Ic.Trash, stringResource(CoreR.string.photos_sources_remove), tint = G.label2, modifier = Modifier.size(20.dp))
            })
            GroupDivider()
        }
        if (source != null && !another && result == null) {
            GroupRow(stringResource(CoreR.string.photos_immich_connect_other), { another = true }, icon = Ic.Plus)
            return@Group
        }
        Column(Modifier.padding(16.dp)) {
            Text(stringResource(CoreR.string.photos_sources_url), style = Type.body, color = G.label, modifier = Modifier.padding(bottom = 8.dp))
            WicabyField(url, { url = it }, "http://photos.local:2283", Modifier.testTag("immich-url"), keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next)
            Text(stringResource(CoreR.string.photos_sources_key), style = Type.body, color = G.label, modifier = Modifier.padding(top = 12.dp, bottom = 8.dp))
            WicabyField(key, { key = it }, "", Modifier.testTag("immich-key"), password = true, onSubmit = { run(false) })
            Text(stringResource(CoreR.string.photos_sources_key_hint), style = Type.footnote, color = G.label2, modifier = Modifier.padding(top = 6.dp))
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
                Text(msg, style = Type.footnote, color = if (r.ok) G.label else G.red, modifier = Modifier.padding(top = 10.dp).testTag("immich-result"))
                if (r.missing.isNotEmpty()) Text(stringResource(CoreR.string.photos_sources_scopes_missing, r.missing.joinToString(", ")), style = Type.footnote, color = G.label2)
            }
        }
        GroupDivider()
        GroupRow(stringResource(CoreR.string.photos_sources_test), { run(false) }, chevron = false)
        GroupDivider()
        GroupRow(stringResource(CoreR.string.photos_immich_connect), { run(true) }, icon = Ic.Plus, chevron = false)
    }
    Text(stringResource(CoreR.string.photos_sources_foot), style = Type.footnote, color = G.label2, modifier = Modifier.padding(start = 16.dp, top = 8.dp))
}

// The photo sources (a folder or a share used as a photo library): each with its scan status (tap: Rescan, Remove),
// then Add, through the file sources' own sheet (address, credentials, Test, Find on this network).
@Composable
private fun PhotoSourceRows() {
    val context = LocalContext.current
    val sources by FileSources.photos.collectAsState()
    var acting by remember { mutableStateOf<FileSource?>(null) }
    var adding by remember { mutableStateOf<String?>(null) }
    var signIn by remember { mutableStateOf<FileSource?>(null) }
    sources.forEach { s ->
        key(s.id) {
            val index = remember(s.id) { FileSources.api(s.id)?.photos }
            val status by (index?.status ?: MutableStateFlow(PhotoIndex.Status())).collectAsState()
            LaunchedEffect(index) { index?.peek() }
            val sub = if (FileSources.needsSignIn(s)) stringResource(CoreR.string.files_sign_in_again) else status.text()
            GroupRow(s.name, { acting = s }, subtitle = sub, icon = Ic.Server, chevron = false, end = {
                Icon(Ic.Refresh, stringResource(CoreR.string.photos_sources_rescan), tint = G.label2, modifier = Modifier.size(20.dp))
            })
            GroupDivider()
        }
    }
    // A folder of this device: the system picker at once (the sheet's other fields do not apply to it).
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) runCatching { LocalFolders.add(context, uri, photos = true); Cache.map.clear() }
            .onFailure { Toast.makeText(context, errorText(it), Toast.LENGTH_LONG).show() }
    }
    listOfNotNull(
        (CoreR.string.files_add_local to FileSource.LOCAL).takeIf { LocalFolders.available(context) },
        CoreR.string.files_add_smb to FileSource.SMB,
        CoreR.string.files_add_webdav to FileSource.WEBDAV,
    ).let { choices ->
        choices.forEachIndexed { i, (label, protocol) ->
            if (i > 0) GroupDivider()
            GroupRow(stringResource(CoreR.string.photos_sources_add_with, stringResource(label)), {
                if (protocol == FileSource.LOCAL) runCatching { pick.launch(null) } else adding = protocol
            }, icon = Ic.Plus, chevron = false)
        }
    }
    adding?.let { p -> AddFileSourceSheet(onDismiss = { adding = null; Cache.map.clear() }, photos = true, protocol = p) }
    signIn?.let { s -> SignInSheet(s) { signIn = null } }
    acting?.let { s ->
        val index = remember(s.id) { FileSources.api(s.id)?.photos }
        AlertDialog(
            onDismissRequest = { acting = null },
            title = { Text(s.name) },
            text = { Text(s.label.ifEmpty { stringResource(CoreR.string.files_add_local) }) },
            dismissButton = {
                Row {
                    if (!s.isLocal) TextButton({ acting = null; signIn = s }) { Text(stringResource(CoreR.string.files_sign_in_again)) }
                    TextButton({ acting = null; FileSources.remove(s.id); Cache.map.clear() }) { Text(stringResource(CoreR.string.photos_sources_remove), color = G.red) }
                }
            },
            confirmButton = { TextButton({ acting = null; index?.rescan(); Cache.map.clear() }) { Text(stringResource(CoreR.string.photos_sources_rescan)) } },
        )
    }
}
