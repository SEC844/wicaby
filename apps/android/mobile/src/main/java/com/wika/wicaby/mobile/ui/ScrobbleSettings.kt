package com.wika.wicaby.mobile.ui

import android.content.Intent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.scrobble.ScrobbleFailure
import com.wika.wicaby.core.scrobble.ScrobbleService
import com.wika.wicaby.mobile.R
import kotlinx.coroutines.launch

// Réglages > Musique > Scrobbling, as the desktop's ScrobbleSettings.svelte: ListenBrainz (a user token) and Last.fm
// (the user's own API account under Avancé, authorized on last.fm in the browser). Off until connected.
@Composable
internal fun ScrobbleSettings() {
    val svc = ScrobbleService.shared
    val st by svc.state.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { svc.reload() }
    var token by remember { mutableStateOf("") }
    var key by remember(st.fmKey) { mutableStateOf(st.fmKey) }
    var secret by remember { mutableStateOf("") }
    var advanced by remember { mutableStateOf(false) }
    var invalid by remember { mutableStateOf<Int?>(null) }
    var busy by remember { mutableStateOf(false) }
    val open = { url: String -> runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri())) }; Unit }
    fun run(block: suspend ScrobbleService.() -> Unit) {
        if (busy) return
        busy = true
        invalid = null
        scope.launch {
            svc.block()
            busy = false
        }
    }
    fun connectLb() = run {
        if (!connectListenBrainz(token)) invalid = CoreR.string.scrobble_error_invalid_token
        token = ""
    }
    val keepSecret = st.fmKey.isNotEmpty() && st.fmKey == key.trim()
    fun connectFm() = run {
        if (!connectLastfm(key, secret)) invalid = CoreR.string.scrobble_error_invalid_key
        secret = ""
        state.value.authUrl?.let(open)
    }

    Eyebrow(stringResource(CoreR.string.scrobble_title))
    Group {
        val lbUser = st.lbUser
        if (lbUser != null) {
            GroupRow(
                if (lbUser.isNotEmpty()) stringResource(CoreR.string.scrobble_lb_connected_as, lbUser) else stringResource(CoreR.string.scrobble_lb_connected),
                null, subtitle = stringResource(CoreR.string.scrobble_connected_desc),
            )
            GroupDivider()
            GroupRow(stringResource(CoreR.string.scrobble_disconnect), { Core.scope.launch { svc.disconnectListenBrainz() } }, titleColor = G.red, chevron = false)
        } else {
            Column(Modifier.padding(16.dp)) {
                WicabyField(token, { token = it }, stringResource(CoreR.string.scrobble_lb_token), password = true, onSubmit = { if (token.isNotBlank()) connectLb() })
                Text(stringResource(CoreR.string.scrobble_lb_hint), style = Type.footnote, color = G.label2, modifier = Modifier.padding(top = 6.dp))
            }
            GroupDivider()
            GroupRow(stringResource(CoreR.string.scrobble_connect), { if (token.isNotBlank()) connectLb() }, chevron = false)
        }
        GroupDivider()
        val fmUser = st.fmUser
        val authUrl = st.authUrl
        when {
            fmUser != null -> {
                GroupRow(
                    if (fmUser.isNotEmpty()) stringResource(CoreR.string.scrobble_fm_connected_as, fmUser) else stringResource(CoreR.string.scrobble_fm_connected),
                    null, subtitle = stringResource(CoreR.string.scrobble_connected_desc),
                )
                GroupDivider()
                GroupRow(stringResource(CoreR.string.scrobble_disconnect), { Core.scope.launch { svc.disconnectLastfm() } }, titleColor = G.red, chevron = false)
            }
            authUrl != null -> {
                GroupRow(stringResource(CoreR.string.scrobble_fm_waiting), { open(authUrl) }, subtitle = stringResource(CoreR.string.scrobble_fm_open))
                GroupDivider()
                GroupRow(stringResource(R.string.cancel), { Core.scope.launch { svc.cancelLastfm() } }, chevron = false)
            }
            !advanced -> GroupRow(stringResource(CoreR.string.scrobble_fm_title), { advanced = true }, subtitle = stringResource(CoreR.string.scrobble_advanced))
            else -> {
                Column(Modifier.padding(16.dp)) {
                    WicabyField(key, { key = it }, stringResource(CoreR.string.scrobble_fm_key), imeAction = ImeAction.Next)
                    WicabyField(
                        secret, { secret = it }, stringResource(if (keepSecret) CoreR.string.trakt_saved else CoreR.string.scrobble_fm_secret),
                        Modifier.padding(top = 8.dp), password = true, onSubmit = { if (key.isNotBlank() && (secret.isNotBlank() || keepSecret)) connectFm() },
                    )
                    Text(stringResource(CoreR.string.scrobble_fm_key_hint), style = Type.footnote, color = G.label2, modifier = Modifier.padding(top = 6.dp))
                }
                GroupDivider()
                GroupRow(stringResource(CoreR.string.scrobble_connect), { if (key.isNotBlank() && (secret.isNotBlank() || keepSecret)) connectFm() }, chevron = false)
            }
        }
    }
    val error: ScrobbleFailure? = invalid?.let { ScrobbleFailure(it) } ?: st.error
    error?.let { Text(stringResource(it.res, it.detail), style = Type.footnote, color = G.red, modifier = Modifier.padding(start = 16.dp, top = 8.dp)) }
    if (st.queued > 0) Text(stringResource(CoreR.string.scrobble_queued, st.queued), style = Type.footnote, color = G.label2, modifier = Modifier.padding(start = 16.dp, top = 8.dp))
    Text(
        stringResource(CoreR.string.scrobble_server_note) + " " + stringResource(CoreR.string.scrobble_foot),
        style = Type.footnote, color = G.label3, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp),
    )
}
