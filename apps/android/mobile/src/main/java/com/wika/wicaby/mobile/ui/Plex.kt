package com.wika.wicaby.mobile.ui

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.net.toUri
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.Session
import com.wika.wicaby.core.data.Snapshot
import com.wika.wicaby.core.plex.Plex
import com.wika.wicaby.core.plex.PlexAccount
import com.wika.wicaby.core.plex.PlexAccounts
import com.wika.wicaby.core.plex.PlexApi
import com.wika.wicaby.core.plex.PlexConnections
import com.wika.wicaby.core.plex.PlexHomeUser
import com.wika.wicaby.core.plex.PlexServer
import com.wika.wicaby.meshui.QrCode
import com.wika.wicaby.mobile.R
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Plex on phones and tablets (plex spec §5, PXA-mobile): the touch twin of the TV's link screen. Link with a code
// (plex.tv/link opened in the browser, the QR code as a fallback for another device), the Plex Home profiles with
// their PIN (a protected one is never picked without it), the D-3 question before a token goes to a plain-http LAN
// address, the connection choice, the hide toggle (D-10) and the Plex Pass explanations (never worked around).
// The flow itself is core's PlexAccounts; tokens stay sealed by the Android Keystore (PlexStore, Prefs).

// Bumped when a server is hidden or shown: WicabyRoot re-reads which plex servers join the merged views.
object PlexUi {
    var hidden by mutableIntStateOf(0)
}

// D-10: a hidden plex server stays stored and signed in, out of Home, Libraries and Search.
fun plexHidden(server: Server): Boolean = server.kind == "plex" && runCatching { Plex.accounts.store.server(server.id)?.hidden == true }.getOrDefault(false)

// Which of a Home user's servers becomes the primary session: the one already primary (or picked) keeps its place;
// with nothing signed in and not adding (the first link, a profile switch whose server this profile cannot reach),
// the account's own server first. Every other one is an extra account (TP-06).
internal fun plexPrimary(list: List<PlexAccounts.SignIn>, current: String?, signedIn: Boolean, add: Boolean): String? =
    list.firstOrNull { it.server.id == current }?.server?.id
        ?: if (add || signedIn) null else (list.firstOrNull { it.owned } ?: list.firstOrNull())?.server?.id

suspend fun savePlexSessions(list: List<PlexAccounts.SignIn>, add: Boolean) {
    val snap = Core.prefs.current()
    val primary = plexPrimary(list, snap.session?.server?.id ?: snap.server?.id, snap.session != null, add)
    // The extras first: the shell then opens with every server already there.
    list.filter { it.server.id != primary }.forEach { Core.prefs.addAccount(Session(it.server, it.userId, it.userName, it.token)) }
    list.firstOrNull { it.server.id == primary }?.let {
        Core.prefs.setServer(it.server)
        Core.prefs.setSession(it.userId, it.userName, it.token)
    }
    Cache.map.clear()
}

// "Lier un compte Plex": the row the server pickers show (first run, Ajouter un serveur, the wizard).
@Composable
fun PlexLinkRow(add: Boolean, onLinked: () -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    Group { GroupRow(stringResource(R.string.plex_link_row), { open = true }, subtitle = stringResource(R.string.plex_link_row_sub), icon = Ic.Server) }
    if (open) PlexLinkDialog(add, onDismiss = { open = false }, onLinked = { open = false; onLinked() })
}

@Composable
fun PlexLinkDialog(add: Boolean, onDismiss: () -> Unit, onLinked: () -> Unit) {
    Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(G.bg)) { PlexLinkScreen(onDismiss, onLinked) { savePlexSessions(it, add) } }
    }
}

// Link with a code, then who is watching. [save] stores the sign-ins (tests capture them).
@Composable
fun PlexLinkScreen(onClose: () -> Unit, onLinked: () -> Unit, accounts: PlexAccounts = remember { Plex.accounts }, save: suspend (List<PlexAccounts.SignIn>) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var link by remember { mutableStateOf<PlexAccounts.Link?>(null) }
    var expired by remember { mutableStateOf(false) }
    var linked by remember { mutableStateOf<PlexAccounts.Poll.Linked?>(null) }
    var qr by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val unreachable = stringResource(R.string.server_unreachable)

    fun start() = scope.launch {
        busy = true
        error = null
        expired = false
        try {
            link = accounts.link()
        } catch (e: Exception) {
            error = (e as? ApiException)?.message ?: unreachable
        } finally {
            busy = false
        }
    }

    // Every 2 s until plex.tv says the code was entered (PlexAccounts backs off on 429), or it expires.
    LaunchedEffect(link, expired) {
        if (link == null || expired) return@LaunchedEffect
        while (true) {
            delay(2_000)
            val p = try {
                accounts.poll()
            } catch (e: Exception) {
                error = (e as? ApiException)?.message ?: unreachable
                link = null
                return@LaunchedEffect
            }
            when (p) {
                PlexAccounts.Poll.Waiting -> continue
                PlexAccounts.Poll.Expired -> expired = true
                is PlexAccounts.Poll.Linked -> {
                    link = null
                    linked = p
                }
            }
            return@LaunchedEffect
        }
    }

    BackHandler { onClose() }
    Column(Modifier.fillMaxSize().imeAware().verticalScroll(rememberScrollState()).statusBarsPadding().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.fillMaxWidth()) { GlassIconButton(Ic.Close, stringResource(R.string.cancel), onClose, glass = 0f) }
        Column(Modifier.widthIn(max = 520.dp).fillMaxWidth()) {
            val l = linked
            val code = link
            when {
                l != null -> PlexUsersPanel(l.account, l.users, l.signedIn, accounts) { list ->
                    save(list)
                    onLinked()
                }
                code != null -> {
                    Text(stringResource(R.string.plex_link_title), style = Type.largeTitle, color = G.label)
                    Text(stringResource(R.string.plex_link_lead), style = Type.body, color = G.label2, modifier = Modifier.padding(top = 8.dp))
                    Text(
                        code.code, style = Type.largeTitle.copy(fontFamily = FontFamily.Monospace, fontSize = 44.sp, letterSpacing = 6.sp),
                        color = if (expired) G.label3 else G.label, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp).testTag("plex-code"),
                    )
                    if (expired) {
                        Text(stringResource(R.string.plex_link_expired), style = Type.callout, color = G.red)
                        Spacer(Modifier.height(14.dp))
                        PillButton(stringResource(R.string.plex_link_new_code), { start() }, primary = true, modifier = Modifier.fillMaxWidth())
                    } else {
                        // The browser on this phone: plex.tv/link with the code filled in.
                        PillButton(stringResource(R.string.plex_link_open), { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, code.url.toUri())) } }, icon = Ic.External, primary = true, modifier = Modifier.fillMaxWidth())
                        Spacer(Modifier.height(12.dp))
                        PillButton(stringResource(R.string.plex_link_show_qr), { qr = !qr }, selected = qr, modifier = Modifier.fillMaxWidth())
                        if (qr) {
                            Text(stringResource(R.string.plex_link_qr_lead), style = Type.footnote, color = G.label2, modifier = Modifier.padding(top = 14.dp))
                            val alt = stringResource(R.string.plex_link_qr_alt)
                            QrCode(code.url, Modifier.padding(top = 12.dp).size(200.dp).align(Alignment.CenterHorizontally).semantics { contentDescription = alt })
                        }
                        Row(Modifier.padding(top = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                            Spinner(Modifier.size(14.dp), G.label3)
                            Text(stringResource(R.string.plex_link_waiting), style = Type.footnote, color = G.label2, modifier = Modifier.padding(start = 10.dp))
                        }
                    }
                }
                else -> {
                    Spacer(Modifier.height(24.dp))
                    Text(stringResource(R.string.plex_link_title), style = Type.largeTitle, color = G.label)
                    Text(stringResource(R.string.plex_link_body), style = Type.body, color = G.label2, modifier = Modifier.padding(top = 8.dp, bottom = 24.dp))
                    Box(Modifier.fillMaxWidth()) {
                        PillButton(stringResource(R.string.plex_link_start), { if (!busy) start() }, primary = true, modifier = Modifier.fillMaxWidth())
                        if (busy) Spinner(Modifier.align(Alignment.CenterEnd).padding(end = 16.dp).size(20.dp), onAccent(LocalAccent.current))
                    }
                    Text(stringResource(R.string.plex_unofficial), style = Type.footnote, color = G.label3, modifier = Modifier.padding(top = 14.dp))
                }
            }
            error?.let { Text(it, style = Type.callout, color = G.red, modifier = Modifier.padding(top = 14.dp)) }
        }
    }
}

// Who is watching (§5.5): the Home profiles, a protected one with its PIN; [ready] (a lone account) skips the pick.
// Then the D-3 question for each server only reachable at a plain-http LAN address: refused, that server is left out.
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ColumnScope.PlexUsersPanel(
    account: String,
    users: List<PlexHomeUser>?,
    ready: List<PlexAccounts.SignIn> = emptyList(),
    accounts: PlexAccounts = remember { Plex.accounts },
    onSignedIn: suspend (List<PlexAccounts.SignIn>) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val list by produceState(users, account) { if (value == null) value = runCatching { accounts.users(account) }.getOrDefault(emptyList()) }
    var picked by remember { mutableStateOf<PlexHomeUser?>(null) }
    var pin by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Sign-ins waiting for the D-3 answer, the first one asked.
    var asking by remember { mutableStateOf<List<PlexAccounts.SignIn>?>(null) }
    val unreachable = stringResource(R.string.server_unreachable)
    val noAccess = stringResource(CoreR.string.plex_error_no_access)

    fun done(all: List<PlexAccounts.SignIn>) = scope.launch {
        busy = true
        try {
            if (all.isEmpty()) error = noAccess else onSignedIn(all)
        } catch (e: Exception) {
            error = e.message ?: unreachable
        } finally {
            busy = false
        }
    }

    fun next(all: List<PlexAccounts.SignIn>) {
        if (all.any { it.confirm != null }) asking = all else {
            asking = null
            done(all)
        }
    }

    fun signIn(u: PlexHomeUser, code: String?) {
        if (busy) return
        scope.launch {
            busy = true
            error = null
            try {
                next(accounts.signIn(account, u.uuid, code))
            } catch (e: ApiException) {
                error = e.message
            } catch (e: Exception) {
                error = unreachable
            } finally {
                busy = false
            }
        }
    }

    // Alone in the Home: signed in already, or (no server answered with a token) no access.
    LaunchedEffect(ready) { if (ready.isNotEmpty()) next(ready) else if (users?.isEmpty() == true) error = noAccess }

    Text(stringResource(R.string.who_is_watching), style = Type.largeTitle, color = G.label, modifier = Modifier.padding(top = 24.dp))
    Text(stringResource(R.string.plex_users_lead), style = Type.body, color = G.label2, modifier = Modifier.padding(top = 8.dp, bottom = 24.dp))
    val shown = list
    if (shown == null || ready.isNotEmpty()) Spinner(Modifier.size(24.dp).align(Alignment.CenterHorizontally))
    else FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        shown.forEach { u ->
            PlexAvatar(u, picked?.uuid == u.uuid) {
                error = null
                // Never without the PIN for a protected profile (#302, #485).
                if (u.protected) {
                    picked = u
                    pin = ""
                } else {
                    picked = null
                    signIn(u, null)
                }
            }
        }
    }
    val p = picked
    if (p != null) {
        Spacer(Modifier.height(24.dp))
        WicabyField(
            pin, { v -> pin = v.filter(Char::isDigit).take(8) }, stringResource(R.string.plex_pin_for, p.title),
            password = true, keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Go, onSubmit = { signIn(p, pin) }, leading = Ic.Lock,
        )
        Spacer(Modifier.height(12.dp))
        PillButton(stringResource(R.string.sign_in), { signIn(p, pin) }, primary = true, modifier = Modifier.fillMaxWidth())
    }
    if (busy) Spinner(Modifier.padding(top = 16.dp).size(20.dp).align(Alignment.CenterHorizontally))
    error?.let { Text(it, style = Type.callout, color = G.red, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) }

    asking?.firstOrNull { it.confirm != null }?.let { s ->
        fun answer(ok: Boolean) {
            if (ok) accounts.confirm(s.server.id, s.confirm!!)
            next(asking.orEmpty().mapNotNull { if (it !== s) it else if (ok) it.copy(confirm = null) else null })
        }
        PlexConfirmDialog(s.server.name, s.confirm!!, onAnswer = ::answer)
    }
}

// D-3: the token goes to a plain-http LAN address only once the user agreed, for that address.
@Composable
fun PlexConfirmDialog(server: String, address: String, onAnswer: (Boolean) -> Unit) {
    AlertDialog(
        onDismissRequest = { onAnswer(false) },
        containerColor = G.elevated,
        title = { Text(stringResource(R.string.plex_confirm_title), color = G.label) },
        text = { Text(stringResource(R.string.plex_confirm_body, server, address), color = G.label2) },
        confirmButton = { TextButton({ onAnswer(true) }) { Text(stringResource(R.string.plex_confirm), color = LocalAccent.current) } },
        dismissButton = { TextButton({ onAnswer(false) }) { Text(stringResource(R.string.cancel), color = G.label2) } },
    )
}

@Composable
private fun PlexAvatar(u: PlexHomeUser, selected: Boolean, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    Column(Modifier.width(92.dp).pressScale(source).clickable(source, null, role = Role.Button, onClick = onClick), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(80.dp).clip(CircleShape).background(if (selected) G.fill4 else G.elevated2), contentAlignment = Alignment.Center) {
            // Initials only: no avatar is fetched from plex.tv.
            Text(u.title.take(1).uppercase(), style = Type.title1, color = G.label)
            if (u.protected) Icon(Ic.Lock, null, tint = G.label2, modifier = Modifier.align(Alignment.BottomEnd).padding(10.dp).size(16.dp))
        }
        Text(u.title, style = Type.callout, color = if (selected) G.label else G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 10.dp))
    }
}

// The sign-in screen of a plex server (Changer d'utilisateur, a session gone): its account's Home profiles, or a new
// link when this device no longer holds the account.
@Composable
fun PlexLoginScreen(server: Server, add: Boolean, title: String?, onSignedIn: (() -> Unit)?) {
    val account = remember(server.id) { runCatching { Plex.accounts.store.server(server.id)?.account?.takeIf { Plex.accounts.store.accountToken(it) != null } }.getOrNull() }
    var relink by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxSize().imeAware().verticalScroll(rememberScrollState()).statusBarsPadding().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(Modifier.widthIn(max = 520.dp).fillMaxWidth()) {
            if (title != null) Text(title, style = Type.title2, color = G.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            Text(server.name, style = Type.callout, color = G.label2, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
            if (account != null) PlexUsersPanel(account, null) { list ->
                savePlexSessions(list, add)
                onSignedIn?.invoke()
            } else {
                Text(stringResource(CoreR.string.plex_error_relink), style = Type.body, color = G.label2, modifier = Modifier.padding(vertical = 24.dp))
                PillButton(stringResource(R.string.plex_link_start), { relink = true }, primary = true, modifier = Modifier.fillMaxWidth())
            }
            Spacer(Modifier.height(32.dp))
            if (onSignedIn == null) PillButton(stringResource(R.string.change_server), { SetupRequest.pickServer = true }, icon = Ic.Server, modifier = Modifier.align(Alignment.CenterHorizontally))
        }
    }
    if (relink) PlexLinkDialog(add, onDismiss = { relink = false }, onLinked = { relink = false; onSignedIn?.invoke() })
}

// Whether this item may be downloaded: a plex server says so per item (allowSync, plex spec §1.3); others always.
@Composable
fun rememberCanDownload(api: Api, id: String?): Boolean {
    val plex = api as? PlexApi ?: return true
    val allowed by produceState(false, id) { value = id != null && runCatching { plex.downloadPath(id) != null }.getOrDefault(false) }
    return allowed
}

// Réglages > Plex: the linked accounts, their servers (owner, connection, the D-10 toggle), the Home profile, the
// Plex Pass status and what its absence means, a new link.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PlexSettings(snap: Snapshot) {
    val accounts = remember { Plex.accounts }
    val scope = rememberCoroutineScope()
    val accent = LocalAccent.current
    var version by remember { mutableIntStateOf(0) }
    val linked = remember(version, snap) { runCatching { accounts.store.accounts() }.getOrDefault(emptyList()) }
    val servers = remember(version, snap) { runCatching { accounts.servers() }.getOrDefault(emptyList()) }
    val sessions = listOfNotNull(snap.session) + snap.extras
    var linking by rememberSaveable { mutableStateOf(false) }
    var switching by remember { mutableStateOf<PlexAccount?>(null) }
    var unlinking by remember { mutableStateOf<PlexAccount?>(null) }
    var connections by remember { mutableStateOf<PlexServer?>(null) }

    Eyebrow(stringResource(R.string.plex_title))
    Group {
        linked.forEach { a ->
            GroupRow(stringResource(R.string.plex_linked_as, a.name), null, subtitle = stringResource(if (a.pass) R.string.plex_pass_on else R.string.plex_pass_off_short), icon = Ic.User)
            servers.filter { it.account == a.id }.forEach { s ->
                GroupDivider()
                val at = sessions.firstOrNull { it.server.id == s.id }?.server?.address
                val owner = when {
                    s.owned -> stringResource(R.string.plex_owned)
                    s.source != null -> stringResource(R.string.plex_shared_by, s.source!!)
                    else -> stringResource(R.string.plex_shared)
                }
                val show = stringResource(R.string.plex_show, s.name)
                GroupRow(s.name, { connections = s }, subtitle = listOfNotNull(owner, at?.let { routeLabel(s, it) }).joinToString(" · "), icon = Ic.Server, chevron = false) {
                    // The primary server stays shown: it is what the app opens on.
                    Switch(
                        !s.hidden, { v ->
                            accounts.setHidden(s.id, !v)
                            Cache.map.clear()
                            PlexUi.hidden++
                            version++
                        },
                        enabled = s.id != snap.session?.server?.id,
                        modifier = Modifier.semantics { contentDescription = show },
                        colors = SwitchDefaults.colors(checkedTrackColor = accent, checkedThumbColor = onAccent(accent), uncheckedTrackColor = G.control, uncheckedThumbColor = G.controlKnob, uncheckedBorderColor = androidx.compose.ui.graphics.Color.Transparent),
                    )
                }
            }
            GroupDivider()
            GroupRow(stringResource(R.string.plex_switch_user), { switching = a }, icon = Ic.Users)
            GroupDivider()
            GroupRow(stringResource(R.string.plex_unlink), { unlinking = a }, icon = Ic.LogOut, titleColor = G.red, chevron = false)
            GroupDivider()
        }
        GroupRow(stringResource(R.string.plex_link_row), { linking = true }, subtitle = stringResource(R.string.plex_link_row_sub), icon = Ic.Plus)
    }
    // Plex Pass gates are explained, never worked around (plex spec §1.3).
    val notes = listOfNotNull(stringResource(R.string.plex_pass_off).takeIf { linked.any { !it.pass } }, stringResource(R.string.plex_unofficial))
    Text(notes.joinToString(" "), style = Type.footnote, color = G.label2, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp))

    if (linking) PlexLinkDialog(add = snap.session != null, onDismiss = { linking = false }, onLinked = { linking = false; version++ })
    switching?.let { a ->
        Dialog({ switching = null }, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
            Box(Modifier.fillMaxSize().background(G.bg)) {
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).statusBarsPadding().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 12.dp)) {
                    GlassIconButton(Ic.Close, stringResource(R.string.cancel), { switching = null }, glass = 0f)
                    PlexUsersPanel(a.id, null) { list ->
                        savePlexSessions(list, add = true)
                        switching = null
                        version++
                    }
                }
            }
        }
    }
    unlinking?.let { a ->
        AlertDialog(
            onDismissRequest = { unlinking = null },
            containerColor = G.elevated,
            title = { Text(stringResource(R.string.plex_unlink_title, a.name), color = G.label) },
            text = { Text(stringResource(R.string.plex_unlink_body), color = G.label2) },
            confirmButton = {
                TextButton({
                    unlinking = null
                    scope.launch {
                        // Its servers leave this device: the extra accounts, then the primary one (back to the picker).
                        val ids = accounts.servers(a.id).map { it.id }.toSet()
                        snap.extras.filter { it.server.id in ids }.forEach { Core.prefs.removeAccount(it.server.id) }
                        if (snap.session?.server?.id in ids) {
                            SetupRequest.pickServer = true
                            Core.prefs.signOut()
                        }
                        accounts.unlink(a.id)
                        Cache.map.clear()
                        version++
                    }
                }) { Text(stringResource(R.string.plex_unlink), color = G.red) }
            },
            dismissButton = { TextButton({ unlinking = null }) { Text(stringResource(R.string.cancel), color = G.label2) } },
        )
    }
    connections?.let { s -> PlexConnectionsSheet(s, sessions.firstOrNull { it.server.id == s.id }, accounts, onDismiss = { connections = null; version++ }) }
}

@Composable
private fun routeLabel(s: PlexServer, address: String): String {
    val c = s.connections.firstOrNull { it.uri.equals(address.trimEnd('/'), true) }
    return stringResource(
        when {
            c?.relay == true -> R.string.plex_route_relay
            c?.local == true -> R.string.plex_route_local
            else -> R.string.plex_route_remote
        },
    )
}

// The connection choice (§5.3): Automatique races them again (local, then remote, then the bandwidth-capped relay);
// a picked one is used now and tried first next time (lastGood). The dropped ones say why. A network change re-races.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlexConnectionsSheet(s: PlexServer, session: Session?, accounts: PlexAccounts, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val ranked = remember(s) { PlexConnections.rankConnections(s.connections, s.httpsRequired, PlexConnections.localSubnets(), s.lastGood) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf<String?>(null) }
    val unreachable = stringResource(R.string.server_unreachable)
    val current = session?.server?.address?.trimEnd('/')

    fun use(uri: String) = scope.launch {
        accounts.store.updateServer(s.id) { it.copy(lastGood = uri) }
        if (session != null && !uri.equals(current, true)) Core.prefs.moveSession(s.id, uri)
        Cache.map.clear()
        onDismiss()
    }

    fun pick(uri: String) {
        if (accounts.needsConfirm(s, uri) != null) confirm = uri else use(uri)
    }

    fun auto() = scope.launch {
        busy = true
        error = null
        try {
            accounts.connect(s.id, interactive = true).address.let(::pick)
        } catch (e: Exception) {
            error = e.message ?: unreachable
        } finally {
            busy = false
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = G.elevated) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 24.dp).navigationBarsPadding()) {
            Text(s.name, style = Type.title2, color = G.label)
            Text(stringResource(R.string.plex_connection), style = Type.callout, color = G.label2, modifier = Modifier.padding(top = 4.dp, bottom = 14.dp))
            Group {
                GroupRow(stringResource(R.string.plex_connection_auto), { if (!busy) auto() }, subtitle = stringResource(R.string.plex_connection_auto_sub), icon = Ic.Refresh, chevron = false) {
                    if (busy) Spinner(Modifier.size(18.dp))
                }
                ranked.waves.flatten().forEach { uri ->
                    GroupDivider()
                    GroupRow(routeLabel(s, uri), { pick(uri) }, subtitle = uri, icon = Ic.Server, chevron = false) {
                        if (uri.equals(current, true)) Icon(Ic.Check, null, tint = LocalAccent.current, modifier = Modifier.size(20.dp))
                    }
                }
                ranked.dropped.forEach { d ->
                    GroupDivider()
                    val why = stringResource(if (d.why == "http-refused") R.string.plex_connection_http_refused else R.string.plex_connection_other_subnet)
                    GroupRow(routeLabel(s, d.uri), null, subtitle = "${d.uri} · $why", icon = Ic.WifiOff, titleColor = G.label3)
                }
            }
            if (s.connections.any { it.relay }) Text(stringResource(R.string.plex_connection_relay_note), style = Type.footnote, color = G.label2, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp))
            error?.let { Text(it, style = Type.callout, color = G.red, modifier = Modifier.padding(top = 12.dp)) }
        }
    }
    confirm?.let { uri ->
        PlexConfirmDialog(s.name, uri) { ok ->
            confirm = null
            if (ok) {
                accounts.confirm(s.id, uri)
                use(uri)
            }
        }
    }
}
