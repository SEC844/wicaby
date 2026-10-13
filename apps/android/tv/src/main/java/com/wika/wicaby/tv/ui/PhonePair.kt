package com.wika.wicaby.tv.ui

import android.content.Context
import android.net.ConnectivityManager
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.data.AccessSchedules
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.SafeNames
import com.wika.wicaby.core.data.Session
import com.wika.wicaby.core.data.SessionGate
import com.wika.wicaby.core.pair.PairRequest
import com.wika.wicaby.core.pair.PairServer
import com.wika.wicaby.core.pair.isLanAddress
import com.wika.wicaby.meshui.QrCode
import com.wika.wicaby.tv.LocalSnapshot
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.Wicaby
import kotlinx.coroutines.delay
import java.net.Inet4Address

// The TV's own IPv4 address on the home network, null off one (mobile data, VPN only).
private fun lanAddress(context: Context): Inet4Address? {
    val cm = context.getSystemService(ConnectivityManager::class.java) ?: return null
    val links = runCatching { cm.getLinkProperties(cm.activeNetwork) }.getOrNull() ?: return null
    return links.linkAddresses.map { it.address }.filterIsInstance<Inet4Address>().firstOrNull(::isLanAddress)
}

// What the phone sent must be a session that the server accepts for that user (see Api.user).
// [probed]: the server's id, for TP-11's message when the sign-in is refused afterwards.
private suspend fun signIn(req: PairRequest, deviceId: String, probed: (String) -> Unit): Boolean {
    if (!SafeNames.isValidId(req.userId)) return false
    val server = Api.probe(req.server)
    probed(server.id)
    val api = Api.of(server, deviceId, req.accessToken, req.userId)
    // TP-11: the token check both servers refuse outside the hours (and the hours, kept for the message).
    val user = AccessSchedules.verify(api, req.userId)
    if (user.id != req.userId) return false
    Cache.map.clear()
    Wicaby.app.prefs.setServer(server)
    // TP-10: signed in here and now, as with a password.
    SessionGate.unlock(Session(server, user.id, user.name, req.accessToken, shared = true))
    Wicaby.app.prefs.setSession(user.id, user.name, req.accessToken, shared = true, remember = true)
    return true
}

// "Se connecter avec le téléphone": a QR code for Wicaby mobile (Réglages > Connecter une TV).
// The LAN endpoint lives only while this sheet is open; each code is new, single use, 5 minutes.
@Composable
fun PhonePairSheet(onDismiss: () -> Unit, onSignedIn: () -> Unit) {
    val context = LocalContext.current
    val deviceId = LocalSnapshot.current.deviceId
    var url by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    val noLan = stringResource(R.string.pair_no_lan)
    val failed = stringResource(R.string.pair_failed)
    LaunchedEffect(Unit) {
        val ip = lanAddress(context)
        if (ip == null) {
            message = noLan
            return@LaunchedEffect
        }
        while (true) {
            var refused: String? = null
            // TP-11: outside the parental hours, say so.
            val server = runCatching {
                PairServer(ip) { req ->
                    var serverId = ""
                    runCatching { signIn(req, deviceId) { serverId = it } }
                        .getOrElse { e -> refused = AccessSchedules.explain(context, serverId, req.userId, e); false }
                        .also { if (!it && refused == null) refused = failed }
                }
            }.getOrNull()
            if (server == null) {
                message = noLan
                return@LaunchedEffect
            }
            url = server.url
            val ok = try { server.run() } finally { server.close() }
            if (ok) return@LaunchedEffect onSignedIn()
            // Expired or refused: a fresh code (the old one is spent either way).
            refused?.let { message = it }
        }
    }
    TvSheet(onDismiss, width = 460.dp) {
        Text(stringResource(R.string.pair_title), style = Type.title2, color = C.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        Text(
            stringResource(R.string.pair_body), style = Type.callout, color = C.label2, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 18.dp),
        )
        val u = url
        if (u != null) QrCode(u, Modifier.size(200.dp).align(Alignment.CenterHorizontally))
        else if (message == null) Spinner(Modifier.align(Alignment.CenterHorizontally))
        message?.let { Text(it, style = Type.callout, color = C.red, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) }
        val first = remember { FocusRequester() }
        LaunchedEffect(Unit) {
            delay(60)
            runCatching { first.requestFocus() }
        }
        SheetButton(stringResource(com.wika.wicaby.core.R.string.close), onClick = onDismiss, modifier = Modifier.padding(top = 18.dp).focusRequester(first))
    }
}
