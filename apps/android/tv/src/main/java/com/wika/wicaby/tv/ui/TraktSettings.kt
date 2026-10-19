package com.wika.wicaby.tv.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.trakt.TraktFailure
import com.wika.wicaby.core.trakt.TraktService
import com.wika.wicaby.meshui.QrCode
import com.wika.wicaby.tv.R
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// TP-09: Réglages > Comptes > Trakt, as the desktop's TraktSettings.svelte: the user's own Trakt application
// (client id and secret), authorized with a device code shown with a QR code, then one switch per
// signed-in server.
@Composable
internal fun TraktSection() {
    val svc = TraktService.shared
    val st by svc.state.collectAsState()
    LaunchedEffect(Unit) { svc.reload() }
    // The Connect row, then the account row once authorized: where focus lands when the code sheet closes.
    val anchor = remember { FocusRequester() }
    if (st.user != null) {
        Group(stringResource(CoreR.string.trakt_title), stringResource(CoreR.string.trakt_connected_desc)) {
            SettingRow(st.user?.takeIf { it.isNotEmpty() }?.let { stringResource(CoreR.string.trakt_connected_as, it) } ?: stringResource(CoreR.string.trakt_connected), modifier = Modifier.focusRequester(anchor))
            val disconnect = stringResource(CoreR.string.trakt_disconnect)
            ConfirmRow(disconnect, disconnect) { Core.scope.launch { svc.disconnect() } }
        }
        Group(stringResource(CoreR.string.trakt_servers), stringResource(CoreR.string.trakt_servers_hint)) {
            val servers = Servers.all
            if (servers.isEmpty()) SettingRow(stringResource(CoreR.string.trakt_no_server))
            servers.forEach { api -> ServerRow(api, api.server.id !in st.offServers) }
        }
    } else {
        ConnectForm(st.clientId, anchor)
    }
    st.error?.let { ErrorText(it, Modifier.padding(start = 18.dp, bottom = 12.dp)) }
    Text(stringResource(CoreR.string.trakt_foot), style = Type.footnote, color = C.label3, modifier = Modifier.padding(horizontal = 18.dp))
}

@Composable
private fun ErrorText(e: TraktFailure, modifier: Modifier) {
    Text(stringResource(e.res, e.detail), style = Type.callout, color = C.red, modifier = modifier)
}

// A server whose own Trakt plugin scrobbles shows it instead of a switch.
@Composable
private fun ServerRow(api: Api, on: Boolean) {
    val plugin by produceState<Boolean?>(null, api) { value = TraktService.shared.plugin(api) }
    if (plugin == true) SettingRow(api.server.name, stringResource(CoreR.string.trakt_server_plugin))
    else ToggleRow(api.server.name, on) { v -> Core.scope.launch { TraktService.shared.setScrobble(api.server.id, v) } }
}

@Composable
private fun ConnectForm(storedId: String, connect: FocusRequester) {
    val overlay = LocalOverlay.current
    val scope = rememberCoroutineScope()
    var clientId by remember(storedId) { mutableStateOf(storedId) }
    var secret by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val canConnect = clientId.isNotBlank() && (secret.isNotBlank() || (storedId.isNotEmpty() && storedId == clientId.trim()))
    fun submit() {
        if (busy || !canConnect) return
        busy = true
        scope.launch {
            TraktService.shared.connect(clientId, secret)
            busy = false
            secret = ""
            if (TraktService.shared.state.value.pending != null) overlay.show(connect) { TraktCodeSheet(overlay::close) }
        }
    }
    Group(stringResource(CoreR.string.trakt_title), stringResource(CoreR.string.trakt_hint)) {
        TvTextField(clientId, { clientId = it }, stringResource(CoreR.string.trakt_client_id), Modifier.fillMaxWidth(), imeAction = ImeAction.Next)
        TvTextField(
            secret, { secret = it },
            stringResource(if (storedId.isNotEmpty() && storedId == clientId.trim()) CoreR.string.trakt_saved else CoreR.string.trakt_client_secret),
            Modifier.fillMaxWidth(), password = true, onSubmit = ::submit, label = stringResource(CoreR.string.trakt_client_secret),
        )
        SettingRow(stringResource(if (busy) R.string.connecting else CoreR.string.trakt_connect), modifier = Modifier.focusRequester(connect), chevron = true, onClick = ::submit)
    }
}

// The device code, big, and a QR code to the activation page. Closes itself once Trakt approved;
// Back or "Annuler" stops waiting.
@Composable
private fun TraktCodeSheet(onClose: () -> Unit) {
    val svc = TraktService.shared
    val st by svc.state.collectAsState()
    LaunchedEffect(st.user) { if (st.user != null) onClose() }
    val cancel = { Core.scope.launch { svc.cancel() }; onClose() }
    TvSheet(cancel, width = 520.dp) {
        Text(stringResource(CoreR.string.trakt_code_title), style = Type.title2, color = C.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        val p = st.pending
        if (p != null) {
            Text(p.userCode, style = Type.largeTitle, color = C.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 14.dp))
            QrCode(p.url, Modifier.size(180.dp).align(Alignment.CenterHorizontally))
            Text(
                stringResource(CoreR.string.trakt_code_body, p.url), style = Type.callout, color = C.label2, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = 14.dp),
            )
        }
        st.error?.let { ErrorText(it, Modifier.fillMaxWidth().padding(top = 12.dp)) }
        val first = remember { FocusRequester() }
        LaunchedEffect(Unit) {
            delay(60)
            runCatching { first.requestFocus() }
        }
        SheetButton(stringResource(if (p != null) R.string.cancel else CoreR.string.close), onClick = cancel, modifier = Modifier.padding(top = 18.dp).focusRequester(first))
    }
}
