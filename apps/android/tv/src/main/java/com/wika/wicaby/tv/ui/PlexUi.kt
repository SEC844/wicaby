package com.wika.wicaby.tv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.PinCheck
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.Session
import com.wika.wicaby.core.data.SessionGate
import com.wika.wicaby.core.data.User
import com.wika.wicaby.core.plex.Plex
import com.wika.wicaby.core.plex.PlexAccounts
import com.wika.wicaby.core.plex.PlexServer
import com.wika.wicaby.meshui.QrCode
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.LocalSnapshot
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.Route
import com.wika.wicaby.tv.Wicaby
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Plex on TV (plex-spec §5, wave 3): link with a code (the code and a QR code to plex.tv/link, no password form), the
// server and connection choice (D-3: a plain-http LAN address gets the token only once confirmed; D-10: shared servers
// listed, with a hide toggle), and the Plex Home users in "Who is watching?" (LoginScreen) with their Plex PIN.

// A protected Plex Home user is never opened without their Plex PIN (plex-spec §5.5, #302, #485): the picker is not
// skipped for them. Unreadable Plex state counts as protected.
internal fun plexProtected(s: Session?): Boolean = s?.server?.kind == "plex" && runCatching {
    val store = Plex.accounts.store
    store.server(s.server.id)?.account?.let(store::account)?.home?.any { it.uuid == s.userId && it.protected }
}.getOrNull() != false

// What a Home user's sign-in leaves on this TV: [chosen] is the session; the account's other servers this user has a
// token for join as extra servers (TP-06) unless hidden (D-10) or still waiting for the D-3 confirmation; the account's
// extra servers this user has no token for leave, so no one browses with another Home user's token.
internal data class PlexPlan(val extras: List<PlexAccounts.SignIn>, val drop: List<String>)

internal fun plexPlan(chosen: PlexAccounts.SignIn, all: List<PlexAccounts.SignIn>, account: List<PlexServer>, extras: List<String>): PlexPlan {
    val hidden = account.filter { it.hidden }.mapTo(HashSet()) { it.id }
    val keep = all.filter { it.server.id != chosen.server.id && it.server.id !in hidden && it.confirm == null }
    val ids = account.mapTo(HashSet()) { it.id }
    val drop = extras.filter { it in ids && it != chosen.server.id && keep.none { k -> k.server.id == it } }
    return PlexPlan(keep, drop)
}

// Opens [chosen] as the TV's session, as a password sign-in does (TP-10: a saved profile), or as one more server ([add]).
internal suspend fun applyPlexSignIn(chosen: PlexAccounts.SignIn, all: List<PlexAccounts.SignIn>, add: Boolean, extras: List<Session>) {
    val prefs = Wicaby.app.prefs
    val session = Session(chosen.server, chosen.userId, chosen.userName, chosen.token)
    Cache.map.clear()
    if (add) {
        prefs.addAccount(session)
        return
    }
    prefs.setServer(chosen.server)
    SessionGate.unlock(session)
    prefs.setSession(chosen.userId, chosen.userName, chosen.token, remember = true)
    val account = Plex.accounts.store.server(chosen.server.id)?.account
    val plan = plexPlan(chosen, all, Plex.accounts.servers(account ?: return), extras.map { it.server.id })
    plan.extras.forEach { prefs.addAccount(Session(it.server, it.userId, it.userName, it.token)) }
    plan.drop.forEach { prefs.removeAccount(it) }
}

// D-3: "Use this local address?" before the token goes to a plain-http LAN address plex.tv listed.
@Composable
internal fun PlexConfirmAddress(address: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    TvAlert(
        stringResource(R.string.plex_tv_confirm_title), stringResource(R.string.plex_tv_confirm_body, address),
        listOf(AlertAction(stringResource(R.string.plex_tv_confirm), onClick = onConfirm), AlertAction(stringResource(R.string.cancel), onClick = onDismiss)),
        focusIndex = 1, onDismiss = onDismiss,
    )
}

// "Who is watching?" on a plex server: the account's Home users (the last list when plex.tv is down), protected ones
// asking their Plex PIN. The TV's saved profiles join them in LoginScreen (Profiles.entries).
internal suspend fun plexUsers(server: Server): List<User> {
    val account = Plex.accounts.store.server(server.id)?.account ?: throw ApiException(Wicaby.app.getString(CoreR.string.plex_error_relink), 401)
    return Plex.accounts.users(account).map { User(it.uuid, it.title, hasPassword = it.protected) }
}

// Signs a Home user of [server]'s account in: their Plex PIN first when protected (never picked without it, §5.5),
// then D-3 when the address needs it, then the session ([onDone]). [onError]: what to say under the avatars.
@Composable
internal fun rememberPlexSignIn(server: Server, add: Boolean, onDone: () -> Unit, onError: (String) -> Unit): (User) -> Unit {
    val overlay = LocalOverlay.current
    val snap = LocalSnapshot.current
    val scope = rememberCoroutineScope()
    val res = LocalResources.current
    fun message(e: Throwable) = (e as? ApiException)?.message ?: res.getString(R.string.server_unreachable)
    fun finish(all: List<PlexAccounts.SignIn>) {
        val chosen = all.firstOrNull { it.server.id == server.id } ?: return onError(res.getString(CoreR.string.plex_error_no_access))
        val go = { scope.launch { applyPlexSignIn(chosen, all, add, snap.extras); onDone() } }
        val confirm = chosen.confirm
        if (confirm == null) go() else overlay.show {
            PlexConfirmAddress(confirm, overlay::close) {
                overlay.close()
                Plex.accounts.confirm(server.id, chosen.server.address)
                go()
            }
        }
    }
    return { u ->
        val account = Plex.accounts.store.server(server.id)?.account
        when {
            account == null -> onError(res.getString(CoreR.string.plex_error_relink))
            !u.hasPassword -> scope.launch {
                runCatching { Plex.accounts.signIn(account, u.id) }.onSuccess(::finish).onFailure { if (it is CancellationException) throw it; onError(message(it)) }
            }
            else -> {
                // Kept outside the sheet's composition: check and onOk run one after the other.
                var signedIn: List<PlexAccounts.SignIn>? = null
                overlay.show {
                    PinEntrySheet(u.name, overlay::close, check = { pin ->
                        try {
                            signedIn = Plex.accounts.signIn(account, u.id, pin)
                            PinCheck(true)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            // A wrong PIN says so in the sheet; anything else closes it and says why.
                            if ((e as? ApiException)?.status != 401) {
                                overlay.close()
                                onError(message(e))
                            }
                            PinCheck(false)
                        }
                    }, onOk = {
                        overlay.close()
                        signedIn?.let(::finish)
                    })
                }
            }
        }
    }
}

// The row on the server screen that starts the link.
@Composable
internal fun PlexLinkRow(add: Boolean, modifier: Modifier = Modifier) {
    val nav = LocalNav.current
    ListRow(stringResource(R.string.plex_tv_account), stringResource(R.string.plex_tv_link_start), onClick = { nav.push(Route.PlexLink(add)) }, icon = Ic.External, modifier = modifier)
}

// Whose server it is (D-10) and how it was reached last (Local, Remote, Relay).
@Composable
private fun plexSubtitle(s: PlexServer): String {
    val owner = when {
        s.owned -> stringResource(R.string.plex_tv_owned)
        s.source != null -> stringResource(R.string.plex_tv_shared_by, s.source!!)
        else -> stringResource(R.string.plex_tv_shared)
    }
    val c = s.connections.firstOrNull { it.uri == s.lastGood } ?: return owner
    val badge = stringResource(if (c.relay) R.string.plex_tv_relay else if (c.local) R.string.plex_tv_local else R.string.plex_tv_remote)
    return "$owner · $badge"
}

// Link with a code, then pick the server. [add]: Réglages > Comptes > Ajouter un serveur (the primary one stays).
@Composable
fun PlexLinkScreen(add: Boolean) {
    val nav = LocalNav.current
    val snap = LocalSnapshot.current
    val overlay = LocalOverlay.current
    val scope = rememberCoroutineScope()
    val res = LocalResources.current
    var attempt by remember { mutableIntStateOf(0) }
    var link by remember { mutableStateOf<PlexAccounts.Link?>(null) }
    var expired by remember { mutableStateOf(false) }
    var linked by remember { mutableStateOf<PlexAccounts.Poll.Linked?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var nonce by remember { mutableIntStateOf(0) }
    val memory = rememberFocusMemory()

    LaunchedEffect(attempt) {
        link = null
        expired = false
        error = null
        try {
            link = Plex.accounts.link()
            // Every 2 s until the code is entered at plex.tv/link (PlexAccounts.poll backs off on 429).
            while (true) {
                delay(2_000)
                when (val p = Plex.accounts.poll()) {
                    PlexAccounts.Poll.Waiting -> Unit
                    PlexAccounts.Poll.Expired -> { expired = true; return@LaunchedEffect }
                    is PlexAccounts.Poll.Linked -> { linked = p; return@LaunchedEffect }
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = (e as? ApiException)?.message ?: res.getString(R.string.server_unreachable)
        }
    }

    // The server picked: its connections raced (§5.3), D-3 asked when the winner is plain-http LAN, then either the
    // session (the account alone in its Home) or "Who is watching?" with the Home users.
    fun choose(l: PlexAccounts.Poll.Linked, s: PlexServer) {
        if (busy) return
        scope.launch {
            busy = true
            error = null
            try {
                val route = Plex.accounts.connect(s.id, interactive = true)
                val server = Server(s.id, s.name, route.address, "plex")
                val go = {
                    scope.launch {
                        val mine = l.signedIn.firstOrNull { it.server.id == s.id }
                        when {
                            mine != null -> {
                                applyPlexSignIn(mine.copy(server = server, confirm = null), l.signedIn, add, snap.extras)
                                nav.reset(Route.Main)
                            }
                            add -> nav.push(Route.Login(server, add = true))
                            else -> {
                                Wicaby.app.prefs.setServer(server)
                                nav.reset(Route.Login(server))
                            }
                        }
                    }
                }
                val confirm = route.confirm
                if (confirm == null) go() else overlay.show {
                    PlexConfirmAddress(confirm, overlay::close) {
                        overlay.close()
                        Plex.accounts.confirm(s.id, route.address)
                        go()
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: res.getString(R.string.server_unreachable)
            } finally {
                busy = false
            }
        }
    }

    Box(Modifier.fillMaxSize()) {
        AmbientGlow()
        val l = linked
        Row(Modifier.fillMaxSize().padding(horizontal = 64.dp, vertical = 56.dp), horizontalArrangement = Arrangement.spacedBy(56.dp)) {
            Column(Modifier.weight(0.9f).padding(top = 40.dp)) {
                Text(stringResource(if (l == null) R.string.plex_tv_link_title else R.string.plex_tv_servers_title), style = Type.largeTitle, color = C.label)
                Spacer(Modifier.height(10.dp))
                Text(stringResource(if (l == null) R.string.plex_tv_link_lead else R.string.plex_tv_servers_hint), style = Type.body, color = C.label2)
                Spacer(Modifier.height(16.dp))
                Text(stringResource(R.string.plex_tv_not_affiliated), style = Type.footnote, color = C.label3)
                // Beside the text, not under the QR code: focus there would scroll the code out of view.
                if (l == null) TextButton(stringResource(CoreR.string.close), onClick = { nav.pop() }, modifier = Modifier.padding(top = 16.dp).remembered(memory, "close", default = true))
            }
            Column(Modifier.weight(1.1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                val code = link
                when {
                    l != null -> {
                        val servers = remember(l, nonce) { Plex.accounts.servers(l.account) }
                        // The code and its Close button are gone: focus goes to the first server.
                        val first = remember { FocusRequester() }
                        LaunchedEffect(l) {
                            delay(60)
                            runCatching { first.requestFocus() }
                        }
                        servers.forEachIndexed { i, s ->
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                ListRow(
                                    s.name, plexSubtitle(s), onClick = { choose(l, s) }, icon = Ic.Server,
                                    trailing = if (s.hidden) stringResource(R.string.plex_tv_hidden) else null,
                                    modifier = Modifier.weight(1f).then(if (i == 0) Modifier.focusRequester(first) else Modifier).remembered(memory, "s-${s.id}"),
                                )
                                TextButton(stringResource(if (s.hidden) R.string.plex_tv_show else R.string.plex_tv_hide), icon = if (s.hidden) Ic.Eye else Ic.EyeOff, onClick = {
                                    Plex.accounts.setHidden(s.id, !s.hidden)
                                    nonce++
                                })
                            }
                        }
                        if (busy) Spinner(Modifier.size(22.dp))
                    }
                    expired -> {
                        Text(stringResource(R.string.plex_tv_link_expired), style = Type.title3, color = C.label)
                        Pill(stringResource(R.string.plex_tv_link_new_code), onClick = { attempt++ }, primary = true, icon = Ic.Refresh, modifier = Modifier.remembered(memory, "new", default = true))
                    }
                    code != null -> {
                        // The code in large type, readable from the sofa, and the QR code a phone scans.
                        Text(code.code, style = Type.largeTitle.copy(fontSize = 56.sp, lineHeight = 64.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.18.em), color = C.label)
                        QrCode(code.url, Modifier.size(180.dp))
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Spinner(Modifier.size(16.dp), C.label3)
                            Text(stringResource(R.string.plex_tv_link_waiting), style = Type.callout, color = C.label2)
                        }
                    }
                    error == null -> Spinner()
                }
                error?.let {
                    Text(it, style = Type.callout, color = C.red)
                    if (l == null) Pill(stringResource(R.string.plex_tv_link_new_code), onClick = { attempt++ }, icon = Ic.Refresh, modifier = Modifier.remembered(memory, "retry", default = true))
                }
            }
        }
    }
}

// Réglages > Comptes on a plex server: the linked account and its Plex Pass (the gates are explained, never worked
// around), the account's other servers with the D-10 hide toggle, and unlinking.
@Composable
internal fun PlexAccountGroup(server: Server, onUnlinked: () -> Unit) {
    val overlay = LocalOverlay.current
    val snap = LocalSnapshot.current
    val prefs = Wicaby.app.prefs
    var nonce by remember { mutableIntStateOf(0) }
    val store = Plex.accounts.store
    val account = remember(server.id, nonce) { store.server(server.id)?.account?.let(store::account) } ?: return
    val others = remember(account.id, nonce) { Plex.accounts.servers(account.id).filter { it.id != server.id } }
    val me = remember { FocusRequester() }
    val unlink = stringResource(R.string.plex_tv_unlink)
    val cancel = stringResource(R.string.cancel)
    val body = stringResource(R.string.plex_tv_unlink_body)
    Group(stringResource(R.string.plex_tv_account), stringResource(if (account.pass) R.string.plex_tv_pass_on else R.string.plex_tv_pass_off)) {
        SettingRow(stringResource(R.string.plex_tv_linked_as, account.name))
        others.forEach { s ->
            ToggleRow(stringResource(R.string.plex_tv_show_server, s.name), !s.hidden) { on ->
                Plex.accounts.setHidden(s.id, !on)
                // Hidden: it leaves the merged rows now; shown again, it joins at the next sign-in (its token comes then).
                if (!on) Core.scope.launch { prefs.removeAccount(s.id) }
                nonce++
            }
        }
        SettingRow(unlink, modifier = Modifier.focusRequester(me), onClick = {
            overlay.show(me) {
                TvAlert(
                    unlink, body,
                    listOf(
                        AlertAction(unlink, destructive = true) {
                            overlay.close()
                            val ids = Plex.accounts.servers(account.id).mapTo(HashSet()) { it.id }
                            Plex.accounts.unlink(account.id)
                            // Its servers, extra ones and saved profiles, leave with it (their tokens too).
                            Core.scope.launch {
                                snap.extras.filter { it.server.id in ids }.forEach { prefs.removeAccount(it.server.id) }
                                snap.profiles.filter { it.session.server.id in ids }.forEach { prefs.removeProfile(it.session.server.id, it.session.userId) }
                            }
                            onUnlinked()
                        },
                        AlertAction(cancel) { overlay.close() },
                    ),
                    focusIndex = 1, onDismiss = overlay::close,
                )
            }
        })
    }
}
