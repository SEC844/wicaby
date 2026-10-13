package com.wika.wicaby.tv.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
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
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.LocalSnapshot
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.Route
import com.wika.wicaby.tv.Wicaby
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.AccessSchedules
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.Found
import com.wika.wicaby.core.data.Profile
import com.wika.wicaby.core.data.Profiles
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.Session
import com.wika.wicaby.core.data.SessionGate
import com.wika.wicaby.core.data.User
import com.wika.wicaby.core.data.discover
import com.wika.wicaby.core.net.LocalNetwork
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
internal fun AmbientGlow() {
    val accent = LocalAccent.current
    Box(
        Modifier.fillMaxSize().background(
            Brush.radialGradient(listOf(accent.copy(alpha = 0.16f), Color.Transparent), center = androidx.compose.ui.geometry.Offset(0f, 0f), radius = 1400f),
        ),
    )
}

@Composable
fun AppMark(size: androidx.compose.ui.unit.Dp = 64.dp) {
    // The launcher icon's layers (brand/scripts/make-brand.mjs): the adaptive foreground is drawn on a
    // 108 dp canvas of which the middle 72 dp show, so it is drawn 1.5x and clipped.
    Box(
        Modifier
            .size(size)
            .clip(RoundedCornerShape(size * 0.22f))
            .background(Brush.verticalGradient(listOf(Color(0xFF2E2E33), Color(0xFF121214)))),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painterResource(R.drawable.ic_launcher_foreground),
            contentDescription = null,
            modifier = Modifier.requiredSize(size * 1.5f),
        )
    }
}

@Composable
fun ListRow(
    title: String,
    subtitle: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    trailing: String? = null,
) {
    var focused by remember { mutableStateOf(false) }
    val bg by animateColorAsState(if (focused) Color.White else C.fill2, label = "row-bg")
    val fg = if (focused) Color.Black else C.label
    val fg2 = if (focused) Color.Black.copy(alpha = 0.6f) else C.label2
    Row(
        modifier
            .fillMaxWidth()
            .tvFocus(RoundedCornerShape(Radius.lg), focusedScale = 1.03f, onFocusChange = { focused = it }, onClick = onClick)
            .background(bg)
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        if (icon != null) Icon(icon, null, tint = fg2, modifier = Modifier.size(24.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = Type.headline, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) Text(subtitle, style = Type.footnote, color = fg2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (trailing != null) Text(trailing, style = Type.caption, color = fg2)
    }
}

// The wizard (Welcome.kt) hosts it too: [section] "lan" or "public" keeps only that part, without the welcome
// header, and [onReady] gets the server (saved as the primary one unless [add]) instead of the sign-in page.
// [onPaired] replaces the phone pairing's jump to Main.
@Composable
fun ServerScreen(add: Boolean = false, section: String? = null, onReady: ((Server) -> Unit)? = null, onPaired: (() -> Unit)? = null) {
    val wizard = onReady != null
    val public = section == "public"
    val context = LocalContext.current
    val nav = LocalNav.current
    val snap = LocalSnapshot.current
    val scope = rememberCoroutineScope()
    var found by remember { mutableStateOf<List<Found>?>(null) }
    var scan by remember { mutableIntStateOf(0) }
    var address by rememberSaveable { mutableStateOf(if (public) "https://" else "") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val unreachable = stringResource(R.string.server_unreachable)
    val isMain = stringResource(R.string.server_is_main)
    val lanDenied = stringResource(com.wika.wicaby.core.R.string.local_network_denied)
    val memory = rememberFocusMemory()
    // Refused (or "Plus tard" on the rationale): discovery would only get EPERM, LAN addresses time out.
    val lan by rememberLocalNetworkGranted()

    LaunchedEffect(scan, lan) {
        found = null
        if (lan && !public) found = runCatching { discover(context) }.getOrDefault(emptyList())
    }

    fun connect(input: String) {
        if (input.isBlank() || busy) return
        scope.launch {
            busy = true
            error = null
            try {
                if (LocalNetwork.blocks(context, input)) {
                    error = lanDenied
                    return@launch
                }
                val server = Api.probe(input)
                // TP-06: an extra account; the primary server and session stay as they are.
                if (add) {
                    if (server.id == snap.server?.id) error = isMain else onReady?.invoke(server) ?: nav.push(Route.Login(server, add = true))
                    return@launch
                }
                Wicaby.app.prefs.setServer(server)
                onReady?.invoke(server) ?: nav.reset(Route.Login(server))
            } catch (e: Exception) {
                error = unreachable
            } finally {
                busy = false
            }
        }
    }

    Box(Modifier.fillMaxSize()) {
        // The wizard draws its own glow behind every step.
        if (!wizard) AmbientGlow()
        Row(Modifier.fillMaxSize().padding(horizontal = 64.dp, vertical = 56.dp), horizontalArrangement = Arrangement.spacedBy(56.dp)) {
            Column(Modifier.weight(0.9f).padding(top = 40.dp)) {
                if (wizard) {
                    Text(stringResource(if (public) com.wika.wicaby.core.R.string.onboarding_where_public else com.wika.wicaby.core.R.string.onboarding_where_lan), style = Type.largeTitle, color = C.label)
                    Spacer(Modifier.height(10.dp))
                    Text(stringResource(if (public) com.wika.wicaby.core.R.string.onboarding_where_public_sub else com.wika.wicaby.core.R.string.onboarding_where_lan_sub), style = Type.body, color = C.label2)
                } else {
                    AppMark(76.dp)
                    Spacer(Modifier.height(28.dp))
                    Text(stringResource(if (add) R.string.add_server else R.string.welcome), style = Type.largeTitle, color = C.label)
                    Spacer(Modifier.height(10.dp))
                    Text(stringResource(if (add) R.string.other_servers_hint else R.string.welcome_sub), style = Type.body, color = C.label2)
                }
                Spacer(Modifier.height(20.dp))
                if (!add && !public) PairWithPhoneButton(Modifier.remembered(memory, "pair"), onPaired)
            }
            Column(Modifier.weight(1.1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                val saved = snap.server.takeUnless { add }
                val list = found.orEmpty()
                // The address field first: with a TV keyboard up only the upper part of the screen shows.
                Text(stringResource(R.string.manual_address).uppercase(), style = Type.eyebrow, color = C.label3, modifier = Modifier.padding(start = 4.dp))
                TvTextField(
                    address, { address = it }, stringResource(if (public) R.string.public_address_hint else R.string.address_hint),
                    modifier = Modifier.fillMaxWidth().remembered(memory, "address", default = public || (saved == null && list.isEmpty())),
                    imeAction = androidx.compose.ui.text.input.ImeAction.Go,
                    onSubmit = { connect(address) },
                )
                if (public && insecure(address)) {
                    Text(stringResource(com.wika.wicaby.core.R.string.onboarding_insecure), style = Type.callout, color = C.label2, modifier = Modifier.padding(start = 4.dp))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
                    Pill(stringResource(R.string.connect), onClick = { connect(address) }, primary = true, modifier = Modifier.remembered(memory, "connect"))
                    if (!public) Pill(stringResource(R.string.search_again), onClick = { scan++ }, icon = Ic.Refresh, modifier = Modifier.remembered(memory, "rescan"))
                    if (busy) Spinner(Modifier.size(22.dp))
                }
                AnimatedVisibility(error != null, enter = fadeIn(), exit = fadeOut()) {
                    Text(error.orEmpty(), style = Type.callout, color = C.red, modifier = Modifier.padding(start = 4.dp, top = 4.dp))
                }
                if (public) return@Column
                // Next to the address: a server only on Tailscale / NetBird needs the mesh joined first (the wizard has a card for it).
                if (!wizard) RemoteAccessRow(Modifier.padding(top = 6.dp).remembered(memory, "remote"))
                Spacer(Modifier.height(10.dp))
                if (saved != null && list.none { it.id == saved.id }) {
                    Text(stringResource(R.string.saved_server).uppercase(), style = Type.eyebrow, color = C.label3, modifier = Modifier.padding(start = 4.dp, top = 4.dp))
                    ListRow(saved.name, saved.address, onClick = { connect(saved.address) }, icon = Ic.Server, trailing = saved.kind.replaceFirstChar { it.uppercase() },
                        modifier = Modifier.remembered(memory, "saved", default = true))
                }
                Row(Modifier.padding(start = 4.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(stringResource(R.string.searching_lan).trimEnd('…').uppercase(), style = Type.eyebrow, color = C.label3)
                    if (lan && found == null) Spinner(Modifier.size(14.dp), C.label3)
                }
                if (!lan) {
                    ListRow(
                        stringResource(com.wika.wicaby.core.R.string.local_network_denied), stringResource(com.wika.wicaby.core.R.string.local_network_open_settings),
                        onClick = { LocalNetwork.openSettings(context) }, icon = Ic.Gear, modifier = Modifier.remembered(memory, "lan-settings"),
                    )
                }
                list.forEachIndexed { i, s ->
                    ListRow(s.name, s.address, onClick = { connect(s.address) }, icon = Ic.Server,
                        modifier = Modifier.remembered(memory, "found-${s.id}", default = saved == null && i == 0))
                }
                if (lan && found != null && list.isEmpty()) {
                    Text(stringResource(R.string.no_server_found), style = Type.footnote, color = C.label2, modifier = Modifier.padding(start = 4.dp, bottom = 4.dp))
                }
            }
        }
    }
}

@Composable
private fun Avatar(user: User?, api: Api, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, selected: Boolean = false) {
    var focused by remember { mutableStateOf(false) }
    val accent = LocalAccent.current
    Column(modifier.width(120.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier
                .size(104.dp)
                .tvFocus(CircleShape, focusedScale = 1.12f, ring = if (selected) accent else null, onFocusChange = { focused = it }, onClick = onClick)
                .background(if (selected) accent.copy(alpha = 0.4f).compositeOver(C.bg) else if (focused) C.raised else C.elevated2),
            contentAlignment = Alignment.Center,
        ) {
            val url = user?.let { api.userImage(it, 240) }
            if (url != null) {
                AsyncImage(url, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            } else {
                Text(if (user != null) label.take(1).uppercase() else "+", style = Type.largeTitle, color = C.label)
            }
        }
        Text(label, style = Type.callout, color = if (focused || selected) C.label else C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 16.dp))
    }
}

// In the wizard, [onSignedIn] replaces the jump to Main, and [onAddAnother] (step 3 again) replaces Switch Server.
@Composable
fun LoginScreen(server: Server, add: Boolean = false, onSignedIn: (() -> Unit)? = null, onAddAnother: (() -> Unit)? = null) {
    val nav = LocalNav.current
    val snap = LocalSnapshot.current
    val scope = rememberCoroutineScope()
    val api = remember(server) { Api.of(server, snap.deviceId) }
    var reload by remember { mutableIntStateOf(0) }
    val users by rememberLoad("public-${server.id}-$reload") { api.publicUsers() }
    var picked by remember { mutableStateOf<User?>(null) }
    var manual by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val wrong = stringResource(R.string.wrong_credentials)
    val context = LocalContext.current
    val unreachable = stringResource(R.string.server_unreachable)
    val memory = rememberFocusMemory()
    // TP-10: this device's saved accounts on this server (none while adding an extra server).
    val saved = if (add) emptyList() else Profiles.saved(snap.profiles, snap.session, server)
    val overlay = LocalOverlay.current
    val expired = stringResource(R.string.profile_expired)

    BackHandler(enabled = picked != null || manual) {
        picked = null
        manual = false
        password = ""
        error = null
    }

    fun login(user: String, pw: String) {
        if (busy) return
        scope.launch {
            busy = true
            error = null
            try {
                val r = api.login(user, pw)
                AccessSchedules.save(server.id, r.user.id, r.user.policy)
                Cache.map.clear()
                if (add) Wicaby.app.prefs.addAccount(Session(server, r.user.id, r.user.name, r.accessToken))
                else {
                    // TP-10: the password opened it: this session may be used.
                    SessionGate.unlock(Session(server, r.user.id, r.user.name, r.accessToken))
                    Wicaby.app.prefs.setSession(r.user.id, r.user.name, r.accessToken, remember = true)
                }
                onSignedIn?.invoke() ?: nav.reset(Route.Main)
            } catch (e: ApiException) {
                // TP-11: refused outside the parental hours (kept from an earlier sign-in, else the server's wording).
                // Jellyfin lists the policy publicly and refuses with a bare 403 (see AccessSchedules.refused).
                val listed = users.value?.firstOrNull { it.name.equals(user, ignoreCase = true) }
                listed?.let { AccessSchedules.save(server.id, it.id, it.policy) }
                error = AccessSchedules.explain(context, server.id, listed?.id, e, signIn = listed != null && !server.isEmby)
                    ?: if (e.status == 401 || e.status == 403) wrong else e.message
            } catch (e: Exception) {
                error = unreachable
            } finally {
                busy = false
            }
        }
    }

    // A saved account: its PIN first when it has one, then its token (checked unless it is the current session).
    fun open(user: User, s: Profile) {
        if (busy) return
        val go = {
            scope.launch {
                busy = true
                error = null
                try {
                    val cur = snap.session
                    val current = cur != null && cur.server.id == s.session.server.id && cur.userId == s.session.userId
                    // TP-11: the token check both servers refuse outside the parental hours (AccessSchedules.verify).
                    // Offline, the current account still opens (as before); another one needs its server.
                    val a = Api.of(server, snap.deviceId, s.session.token, s.session.userId)
                    val ok = try {
                        AccessSchedules.verify(a, s.session.userId).id == s.session.userId
                    } catch (e: java.io.IOException) {
                        if (e is ApiException || !current) throw e
                        true
                    }
                    if (!ok) throw ApiException("not this account's token", 401)
                    SessionGate.unlock(s.session)
                    if (!current) {
                        Wicaby.app.prefs.setSession(s.session.userId, s.session.userName, s.session.token, s.session.shared, remember = true)
                        Cache.map.clear()
                    }
                    onSignedIn?.invoke() ?: nav.reset(Route.Main)
                } catch (e: ApiException) {
                    // TP-11: outside the parental hours the token is still good: say so, no password asked.
                    val refused = AccessSchedules.explain(context, server.id, s.session.userId, e)
                    // Signed out elsewhere since: the password once more (the next sign-in keeps the PIN).
                    if (refused != null) error = refused
                    else if (e.status == 401 || e.status == 403) {
                        picked = user
                        password = ""
                        error = expired
                    } else error = e.message
                } catch (e: Exception) {
                    error = unreachable
                } finally {
                    busy = false
                }
            }
        }
        if (!s.hasPin) go() else overlay.show {
            PinEntrySheet(s.session.userName, overlay::close, check = { Wicaby.app.prefs.checkPin(s.session, it) }, onOk = { overlay.close(); go() })
        }
    }

    val list = users.value
    // Offline, the saved accounts still open (the current one needs no server).
    val entries = list?.let { Profiles.entries(it, saved) } ?: Profiles.entries(emptyList(), saved).takeIf { users.error != null && saved.isNotEmpty() }
    val p = picked
    val form = p != null || manual
    @OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
    val ime = WindowInsets.isImeVisible
    Box(Modifier.fillMaxSize()) {
        if (onSignedIn == null) AmbientGlow()
        // One scrolling column, top-aligned like tvOS: with the keyboard up the window shrinks
        // (adjustResize + imePadding) and the focused field scrolls into the upper part.
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(top = if (ime) 20.dp else if (form) 56.dp else 70.dp, bottom = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (!form) {
                Text(if (onSignedIn != null) stringResource(com.wika.wicaby.core.R.string.onboarding_signin_title, server.name) else stringResource(R.string.who_is_watching), style = Type.largeTitle, color = C.label)
                // The wizard's title already names the server.
                if (onSignedIn == null) Text(server.name, style = Type.callout, color = C.label2, modifier = Modifier.padding(top = 6.dp))
                Spacer(Modifier.height(40.dp))
                when {
                    entries == null && users.error != null -> ErrorState { reload++ }
                    entries == null -> Spinner()
                    else -> Row(horizontalArrangement = Arrangement.spacedBy(28.dp)) {
                        // Focus lands on whoever is signed in, as the desktop lands on the last profile used.
                        val start = entries.indexOfFirst { it.user.id == snap.session?.userId }.coerceAtLeast(0)
                        entries.forEachIndexed { i, e ->
                            val u = e.user
                            Avatar(u, api, u.name, onClick = {
                                manual = false
                                error = null
                                val s = e.saved
                                when {
                                    s != null -> open(u, s)
                                    !u.hasPassword -> login(u.name, "")
                                    else -> { picked = u; password = "" }
                                }
                            }, modifier = Modifier.remembered(memory, "u-${u.id}", default = i == start))
                        }
                        Avatar(null, api, stringResource(R.string.other_user), onClick = {
                            picked = null; manual = true; error = null
                        }, modifier = Modifier.remembered(memory, "other", default = entries.isEmpty()))
                    }
                }
            } else {
                // Who is signing in, then the fields right below: the upper half of the screen. With the
                // keyboard up only ~190 dp remain, so the header steps aside (the field names the user).
                if (!ime) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        UserBadge(p, api, p?.name ?: stringResource(R.string.other_user))
                        Column {
                            Text(p?.name ?: stringResource(R.string.other_user), style = Type.title2, color = C.label)
                            Text(server.name, style = Type.callout, color = C.label2)
                        }
                    }
                    Spacer(Modifier.height(28.dp))
                }
                Column(Modifier.width(460.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (manual) {
                        TvTextField(
                            name, { name = it }, stringResource(R.string.username), Modifier.fillMaxWidth(), autoEdit = true,
                            imeAction = androidx.compose.ui.text.input.ImeAction.Next,
                        )
                    }
                    TvTextField(
                        password, { password = it },
                        if (p != null) stringResource(R.string.password_for, p.name) else stringResource(R.string.password),
                        Modifier.fillMaxWidth(), password = true, autoEdit = p != null,
                        imeAction = androidx.compose.ui.text.input.ImeAction.Go,
                        onSubmit = { login(p?.name ?: name, password) },
                    )
                    Row(
                        Modifier.padding(top = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Pill(stringResource(R.string.sign_in), onClick = { login(p?.name ?: name, password) }, primary = true)
                        if (busy) Spinner(Modifier.size(22.dp))
                    }
                }
            }
            AnimatedVisibility(error != null, enter = fadeIn(), exit = fadeOut()) {
                Text(error.orEmpty(), style = Type.callout, color = C.red, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 16.dp))
            }
            // Secondary action, always in the flow below the primary one (never overlapping it).
            Spacer(Modifier.height(if (form) 28.dp else 40.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (onAddAnother == null && !add) TextButton(stringResource(R.string.switch_server), icon = Ic.Server, onClick = { nav.reset(Route.Servers) })
                // A phone pairing replaces the primary account: not while adding one.
                if (!add) PairWithPhoneButton(onSignedIn = onSignedIn)
                if (onAddAnother != null) TextButton(stringResource(com.wika.wicaby.core.R.string.onboarding_add_another), icon = Ic.Plus, onClick = onAddAnother)
            }
        }
    }
}

// Sign-in from Wicaby mobile, which sends its server and session (PhonePair.kt).
@Composable
private fun PairWithPhoneButton(modifier: Modifier = Modifier, onSignedIn: (() -> Unit)? = null) {
    val nav = LocalNav.current
    val overlay = LocalOverlay.current
    TextButton(stringResource(R.string.pair_with_phone), icon = Ic.Phone, modifier = modifier, onClick = {
        overlay.show {
            PhonePairSheet(overlay::close) {
                overlay.close()
                onSignedIn?.invoke() ?: nav.reset(Route.Main)
            }
        }
    })
}

// A server reachable only over Tailscale / NetBird: join the mesh before connecting (Réglages
// only exists once connected). The Settings panel in a sheet; focus enters its first button.
@Composable
private fun RemoteAccessRow(modifier: Modifier = Modifier) {
    val overlay = LocalOverlay.current
    ListRow(stringResource(R.string.remote_access_setup), null, icon = Ic.External, modifier = modifier, onClick = {
        overlay.show {
            TvSheet(overlay::close, width = 640.dp, padding = androidx.compose.foundation.layout.PaddingValues(vertical = 24.dp)) {
                val first = remember { FocusRequester() }
                LaunchedEffect(Unit) {
                    delay(60)
                    runCatching { first.requestFocus() }
                }
                // With its advanced fields the panel can outgrow the screen: it scrolls inside the sheet.
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    RemoteAccessSection(Modifier.focusRequester(first).focusGroup())
                    SheetButton(stringResource(com.wika.wicaby.core.R.string.close), onClick = overlay::close, modifier = Modifier.padding(top = 18.dp))
                }
            }
        }
    })
}

// The user being signed in, small, next to their name.
@Composable
private fun UserBadge(user: User?, api: Api, label: String) {
    Box(Modifier.size(56.dp).clip(CircleShape).background(C.elevated2), contentAlignment = Alignment.Center) {
        val url = user?.let { api.userImage(it, 160) }
        if (url != null) {
            AsyncImage(url, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        } else {
            Text(if (user != null) label.take(1).uppercase() else "+", style = Type.title2, color = C.label)
        }
    }
}

// http:// to a host that is not on the LAN (nor loopback): readable on the way.
internal fun insecure(address: String): Boolean {
    val uri = address.trim().toUri()
    val host = uri.host ?: return false
    if (!uri.scheme.equals("http", ignoreCase = true)) return false
    return !(LocalNetwork.isLanAddress(host) || '.' !in host || host.endsWith(".local", ignoreCase = true) || host == "localhost" || host.startsWith("127."))
}

// A borderless secondary button: label only until focused, then the usual white lift.
@Composable
fun TextButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    var focused by remember { mutableStateOf(false) }
    val bg by animateColorAsState(if (focused) Color.White else Color.Transparent, label = "text-btn")
    val fg = if (focused) Color.Black else C.label2
    Row(
        modifier
            .tvFocus(RoundedCornerShape(50), focusedScale = 1.06f, sheen = false, elevation = 8.dp, onFocusChange = { focused = it }, onClick = onClick)
            .background(bg)
            .padding(horizontal = 18.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (icon != null) Icon(icon, null, tint = fg, modifier = Modifier.size(18.dp))
        Text(text, style = Type.callout, color = fg, maxLines = 1)
    }
}

// Android 17: whether LAN sockets are allowed, re-read on every return (the user may have
// changed it in the system settings meanwhile). Always true before Android 17.
@Composable
fun rememberLocalNetworkGranted(): MutableState<Boolean> {
    val context = LocalContext.current
    val granted = remember { mutableStateOf(LocalNetwork.granted(context)) }
    LifecycleResumeEffect(Unit) {
        granted.value = LocalNetwork.granted(context)
        onPauseOrDispose {}
    }
    return granted
}

// The rationale screen shown during setup (server discovery) and before the first call to a
// saved LAN server while ACCESS_LOCAL_NETWORK is missing. "Plus tard" goes on without it:
// remote servers keep working, the server list then says the access was refused.
@Composable
fun LocalNetworkGate(needed: Boolean, content: @Composable () -> Unit) {
    var granted by rememberLocalNetworkGranted()
    var refused by rememberSaveable { mutableStateOf(false) }
    var later by rememberSaveable { mutableStateOf(false) }
    val context = LocalContext.current
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        granted = it
        refused = !it
    }
    if (!needed || granted || later) {
        content()
        return
    }
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    Box(Modifier.fillMaxSize()) {
        AmbientGlow()
        Column(Modifier.fillMaxSize().padding(horizontal = 64.dp, vertical = 56.dp).widthIn(max = 760.dp), verticalArrangement = Arrangement.Center) {
            AppMark(76.dp)
            Spacer(Modifier.height(28.dp))
            Text(
                stringResource(if (refused) com.wika.wicaby.core.R.string.local_network_denied else com.wika.wicaby.core.R.string.local_network_title),
                style = Type.largeTitle, color = C.label,
            )
            Spacer(Modifier.height(10.dp))
            Text(stringResource(com.wika.wicaby.core.R.string.local_network_rationale), style = Type.body, color = C.label2)
            Spacer(Modifier.height(28.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Pill(
                    stringResource(if (refused) com.wika.wicaby.core.R.string.local_network_open_settings else com.wika.wicaby.core.R.string.local_network_allow),
                    onClick = { if (refused) LocalNetwork.openSettings(context) else ask.launch(LocalNetwork.PERMISSION) },
                    primary = true, modifier = Modifier.focusRequester(first),
                )
                Pill(stringResource(com.wika.wicaby.core.R.string.local_network_later), onClick = { later = true })
            }
        }
    }
}
