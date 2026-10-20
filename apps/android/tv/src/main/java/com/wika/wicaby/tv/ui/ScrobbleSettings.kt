package com.wika.wicaby.tv.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
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
import com.wika.wicaby.core.scrobble.ScrobbleFailure
import com.wika.wicaby.core.scrobble.ScrobbleService
import com.wika.wicaby.meshui.QrCode
import com.wika.wicaby.tv.R
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Réglages > Comptes > Scrobbling, as the desktop's ScrobbleSettings.svelte: ListenBrainz (a user token) and Last.fm
// (the user's own API account under Avancé, authorized on last.fm through a QR code). Off until connected.
@Composable
internal fun ScrobbleSection() {
    val svc = ScrobbleService.shared
    val st by svc.state.collectAsState()
    LaunchedEffect(Unit) { svc.reload() }
    if (st.lbUser != null) {
        Group(stringResource(CoreR.string.scrobble_title), stringResource(CoreR.string.scrobble_connected_desc)) {
            SettingRow(st.lbUser?.takeIf { it.isNotEmpty() }?.let { stringResource(CoreR.string.scrobble_lb_connected_as, it) } ?: stringResource(CoreR.string.scrobble_lb_connected))
            val disconnect = stringResource(CoreR.string.scrobble_disconnect)
            ConfirmRow(disconnect, disconnect) { Core.scope.launch { svc.disconnectListenBrainz() } }
        }
    } else {
        ListenBrainzForm()
    }
    if (st.fmUser != null) {
        Group(stringResource(CoreR.string.scrobble_fm_title), stringResource(CoreR.string.scrobble_connected_desc)) {
            SettingRow(st.fmUser?.takeIf { it.isNotEmpty() }?.let { stringResource(CoreR.string.scrobble_fm_connected_as, it) } ?: stringResource(CoreR.string.scrobble_fm_connected))
            val disconnect = stringResource(CoreR.string.scrobble_disconnect)
            ConfirmRow(disconnect, disconnect) { Core.scope.launch { svc.disconnectLastfm() } }
        }
    } else {
        LastfmForm(st.fmKey)
    }
    if (st.queued > 0) Text(stringResource(CoreR.string.scrobble_queued, st.queued), style = Type.callout, color = C.label2, modifier = Modifier.padding(start = 18.dp, bottom = 12.dp))
    st.error?.let { ErrorText(it, Modifier.padding(start = 18.dp, bottom = 12.dp)) }
    Text(
        stringResource(CoreR.string.scrobble_server_note) + " " + stringResource(CoreR.string.scrobble_foot),
        style = Type.footnote, color = C.label3, modifier = Modifier.padding(horizontal = 18.dp),
    )
}

@Composable
private fun ErrorText(e: ScrobbleFailure, modifier: Modifier) {
    Text(stringResource(e.res, e.detail), style = Type.callout, color = C.red, modifier = modifier)
}

@Composable
private fun ListenBrainzForm() {
    val scope = rememberCoroutineScope()
    var token by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var invalid by remember { mutableStateOf(false) }
    fun submit() {
        if (busy || token.isBlank()) return
        busy = true
        scope.launch {
            invalid = !ScrobbleService.shared.connectListenBrainz(token)
            busy = false
            token = ""
        }
    }
    Group(stringResource(CoreR.string.scrobble_title), stringResource(CoreR.string.scrobble_lb_hint)) {
        TvTextField(token, { token = it; invalid = false }, stringResource(CoreR.string.scrobble_lb_token), Modifier.fillMaxWidth(), password = true, onSubmit = ::submit)
        SettingRow(stringResource(if (busy) R.string.connecting else CoreR.string.scrobble_connect), chevron = true, onClick = ::submit)
        if (invalid) ErrorText(ScrobbleFailure(CoreR.string.scrobble_error_invalid_token), Modifier.padding(start = 18.dp, top = 6.dp))
    }
}

@Composable
private fun LastfmForm(storedKey: String) {
    val overlay = LocalOverlay.current
    val scope = rememberCoroutineScope()
    val connect = remember { FocusRequester() }
    var advanced by remember { mutableStateOf(false) }
    var key by remember(storedKey) { mutableStateOf(storedKey) }
    var secret by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var invalid by remember { mutableStateOf(false) }
    val keepSecret = storedKey.isNotEmpty() && storedKey == key.trim()
    fun submit() {
        if (busy || key.isBlank() || (secret.isBlank() && !keepSecret)) return
        busy = true
        scope.launch {
            val svc = ScrobbleService.shared
            invalid = !svc.connectLastfm(key, secret)
            busy = false
            secret = ""
            if (svc.state.value.authUrl != null) overlay.show(connect) { LastfmAuthSheet(overlay::close) }
        }
    }
    if (!advanced) {
        Group(stringResource(CoreR.string.scrobble_fm_title), stringResource(CoreR.string.scrobble_fm_hint)) {
            SettingRow(stringResource(CoreR.string.scrobble_advanced), chevron = true, onClick = { advanced = true })
        }
        return
    }
    Group(stringResource(CoreR.string.scrobble_fm_title), stringResource(CoreR.string.scrobble_fm_key_hint)) {
        TvTextField(key, { key = it; invalid = false }, stringResource(CoreR.string.scrobble_fm_key), Modifier.fillMaxWidth(), imeAction = ImeAction.Next)
        TvTextField(
            secret, { secret = it; invalid = false }, stringResource(if (keepSecret) CoreR.string.trakt_saved else CoreR.string.scrobble_fm_secret),
            Modifier.fillMaxWidth(), password = true, onSubmit = ::submit, label = stringResource(CoreR.string.scrobble_fm_secret),
        )
        SettingRow(stringResource(if (busy) R.string.connecting else CoreR.string.scrobble_connect), modifier = Modifier.focusRequester(connect), chevron = true, onClick = ::submit)
        if (invalid) ErrorText(ScrobbleFailure(CoreR.string.scrobble_error_invalid_key), Modifier.padding(start = 18.dp, top = 6.dp))
    }
}

// The Last.fm page as a QR code: the user allows Wicaby from a phone. Closes itself once Last.fm said yes;
// Back or "Annuler" stops waiting.
@Composable
private fun LastfmAuthSheet(onClose: () -> Unit) {
    val svc = ScrobbleService.shared
    val st by svc.state.collectAsState()
    LaunchedEffect(st.fmUser) { if (st.fmUser != null) onClose() }
    val cancel = { Core.scope.launch { svc.cancelLastfm() }; onClose() }
    TvSheet(cancel, width = 520.dp) {
        Text(stringResource(CoreR.string.scrobble_fm_waiting), style = Type.title2, color = C.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        val url = st.authUrl
        if (url != null) {
            QrCode(url, Modifier.padding(top = 14.dp).size(200.dp).align(Alignment.CenterHorizontally))
            Text(
                stringResource(CoreR.string.scrobble_fm_waiting_desc), style = Type.callout, color = C.label2, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = 14.dp),
            )
        }
        st.error?.let { ErrorText(it, Modifier.fillMaxWidth().padding(top = 12.dp)) }
        val first = remember { FocusRequester() }
        LaunchedEffect(Unit) {
            delay(60)
            runCatching { first.requestFocus() }
        }
        SheetButton(stringResource(if (url != null) R.string.cancel else CoreR.string.close), onClick = cancel, modifier = Modifier.padding(top = 18.dp).focusRequester(first))
    }
}
