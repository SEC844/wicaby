package com.wika.wicaby.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.imeNestedScroll
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.ui.composed
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.IconButton
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import coil3.compose.AsyncImage
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.Found
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.Session
import com.wika.wicaby.core.data.Snapshot
import com.wika.wicaby.core.data.User
import com.wika.wicaby.core.data.discover
import com.wika.wicaby.core.net.LocalNetwork
import com.wika.wicaby.mobile.R
import kotlinx.coroutines.launch

@Composable
fun AppMark(size: Dp = 64.dp) {
    // The launcher icon's own layers, drawn for a 108 dp canvas around a 72 dp visible area.
    Box(Modifier.size(size).clip(RoundedCornerShape(size * 0.24f)), contentAlignment = Alignment.Center) {
        Image(painterResource(R.drawable.ic_launcher_background), null, modifier = Modifier.requiredSize(size * 1.5f))
        Image(painterResource(R.drawable.ic_launcher_foreground), null, modifier = Modifier.requiredSize(size * 1.5f))
    }
}

// Grouped rows on an elevated card, separated by hairlines (iOS-style lists, no icon tiles).
@Composable
fun Group(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.lg)).background(G.elevated)) { content() }
}

@Composable
fun GroupDivider() = HorizontalDivider(Modifier.padding(start = 52.dp), thickness = 0.5.dp, color = G.separator)

@Composable
fun GroupRow(
    title: String,
    onClick: (() -> Unit)?,
    subtitle: String? = null,
    icon: ImageVector? = null,
    trailing: String? = null,
    titleColor: Color = G.label,
    chevron: Boolean = onClick != null,
    end: (@Composable () -> Unit)? = null,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = G.label2, modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(14.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = Type.body, color = titleColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) Text(subtitle, style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (trailing != null) Text(trailing, style = Type.footnote, color = G.label2, modifier = Modifier.padding(start = 8.dp))
        end?.invoke()
        if (chevron) Icon(Ic.ChevronRight, null, tint = G.label3, modifier = Modifier.padding(start = 6.dp).size(18.dp))
    }
}

@Composable
fun Eyebrow(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(), style = Type.eyebrow, color = G.label3, modifier = modifier.padding(start = 16.dp, bottom = 8.dp, top = 22.dp))
}

// Scrolling screens with text fields: the viewport shrinks above the keyboard (so a focused field
// can be scrolled into the visible part), and while the keyboard is up a drag on the content pulls
// it down. Not while it is hidden: dragging past the end would open it with no field to type in.
@OptIn(ExperimentalLayoutApi::class)
fun Modifier.imeAware(): Modifier = composed {
    val nested = if (WindowInsets.isImeVisible) Modifier.imeNestedScroll() else Modifier
    imePadding().then(nested)
}

@Composable
fun WicabyField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    password: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Done,
    onSubmit: () -> Unit = {},
    leading: ImageVector? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    var revealed by rememberSaveable { mutableStateOf(false) }
    // Keeps the focused field above the keyboard while it slides in (and after rotation).
    val requester = remember { BringIntoViewRequester() }
    var focused by remember { mutableStateOf(false) }
    val ime = WindowInsets.ime
    val density = LocalDensity.current
    LaunchedEffect(focused) {
        if (focused) snapshotFlow { ime.getBottom(density) }.collect { if (it > 0) requester.bringIntoView() }
    }
    TextField(
        value, onChange,
        modifier = modifier.fillMaxWidth().bringIntoViewRequester(requester).onFocusChanged { focused = it.isFocused },
        placeholder = { Text(placeholder, style = Type.body, color = G.label3) },
        singleLine = true,
        textStyle = Type.body,
        shape = RoundedCornerShape(Radius.md),
        leadingIcon = leading?.let { { Icon(it, null, tint = G.label2, modifier = Modifier.size(20.dp)) } },
        trailingIcon = trailing ?: if (password) {
            {
                IconButton({ revealed = !revealed }) {
                    Icon(
                        if (revealed) Ic.EyeOff else Ic.Eye,
                        stringResource(if (revealed) R.string.hide_password else R.string.show_password),
                        tint = G.label2, modifier = Modifier.size(20.dp),
                    )
                }
            }
        } else null,
        visualTransformation = if (password && !revealed) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else keyboardType, imeAction = imeAction, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onAny = { onSubmit() }),
        colors = TextFieldDefaults.colors(
            focusedContainerColor = G.fill3, unfocusedContainerColor = G.fill2, disabledContainerColor = G.fill1,
            focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent,
            focusedTextColor = G.label, unfocusedTextColor = G.label, cursorColor = LocalAccent.current,
        ),
    )
}

@Composable
fun ServerScreen(snap: Snapshot) {
    Column(
        Modifier.fillMaxSize().imeAware().verticalScroll(rememberScrollState()).statusBarsPadding().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(Modifier.widthIn(max = 520.dp)) {
            Spacer(Modifier.height(24.dp))
            AppMark(64.dp)
            Spacer(Modifier.height(22.dp))
            Text(stringResource(R.string.welcome), style = Type.largeTitle, color = G.label)
            Spacer(Modifier.height(8.dp))
            Text(stringResource(R.string.welcome_sub), style = Type.body, color = G.label2)
            val scope = rememberCoroutineScope()
            ServerPanel(snap, onPlexLinked = { SetupRequest.pickServer = false }) { server ->
                scope.launch {
                    Core.prefs.setServer(server)
                    SetupRequest.pickServer = false
                }
            }

            // A server reachable only over Tailscale / NetBird: join the mesh before connecting
            // (Settings only exists once connected). Open by default while the mesh is on.
            var remote by rememberSaveable { mutableStateOf(Core.mesh.enabled) }
            Spacer(Modifier.height(22.dp))
            Group {
                GroupRow(stringResource(R.string.remote_access_setup), { remote = !remote }, icon = Ic.Lock, chevron = false) {
                    Icon(if (remote) Ic.ChevronDown else Ic.ChevronRight, null, tint = G.label3, modifier = Modifier.padding(start = 6.dp).size(18.dp))
                }
            }
            if (remote) RemoteAccessSection()
        }
    }
}

// Which part of the server picker to show: everything (the classic screen), or one wizard card.
enum class ServerSection { All, Lan, Public }

// http:// toward a host that is neither on the LAN, nor loopback, nor on a mesh (100.64/10): the
// wizard warns, the connection is still allowed.
fun insecureAddress(address: String): Boolean {
    val a = address.trim()
    if (!a.startsWith("http://", ignoreCase = true)) return false
    val authority = a.substringAfter("://").substringBefore('/').substringBefore('?').substringAfterLast('@')
    val host = if (authority.startsWith("[")) authority.substringBefore(']').removePrefix("[") else authority.substringBefore(':')
    if (host.isEmpty() || LocalNetwork.isLanAddress(host) || host.equals("localhost", ignoreCase = true) || host.startsWith("127.") || host == "::1") return false
    if (':' !in host && ('.' !in host.trimEnd('.') || host.trimEnd('.').endsWith(".local", ignoreCase = true))) return false
    val o = host.split('.').mapNotNull { it.toIntOrNull() }
    return !(o.size == 4 && o[0] == 100 && o[1] in 64..127)
}

// The server picker: nearby servers and a manual address. [onReady] gets the probed server; the
// caller saves it (classic screen), signs in to it as an extra account (TP-06), or moves the
// wizard on. [find] is the LAN discovery (tests pass their own: no broadcast from a unit test).
@Composable
fun ServerPanel(
    snap: Snapshot,
    section: ServerSection = ServerSection.All,
    add: Boolean = false,
    find: suspend (android.content.Context) -> List<Found> = { discover(it) },
    // Plex (PXA-mobile): the account was linked and its sessions saved (no LoginScreen after it).
    onPlexLinked: () -> Unit = {},
    onReady: (Server) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var found by remember { mutableStateOf<List<Found>?>(null) }
    var scan by remember { mutableIntStateOf(0) }
    var address by rememberSaveable(section) { mutableStateOf(if (section == ServerSection.Public) "https://" else "") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val unreachable = stringResource(R.string.server_unreachable)
    val isMain = stringResource(R.string.server_is_main)
    val lanDenied = stringResource(com.wika.wicaby.core.R.string.local_network_denied)
    // Refused (or "Plus tard" on the rationale): discovery would only get EPERM, LAN addresses time out.
    val lan by rememberLocalNetworkGranted()

    LaunchedEffect(scan, lan, section) {
        found = null
        if (lan && section != ServerSection.Public) found = runCatching { find(context) }.getOrDefault(emptyList())
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
                // TP-06: an extra account never replaces the primary server.
                if (add && server.id == snap.server?.id) error = isMain else onReady(server)
            } catch (e: Exception) {
                error = unreachable
            } finally {
                busy = false
            }
        }
    }

    Column {
        // Plex servers come from the account, not from an address: link it with a code.
        Eyebrow(stringResource(R.string.plex_title))
        PlexLinkRow(add || snap.session != null, onPlexLinked)
        if (section != ServerSection.Public) {
            val saved = snap.server.takeIf { section == ServerSection.All && !add }
            val list = found.orEmpty()
            if (saved != null && list.none { it.id == saved.id }) {
                Eyebrow(stringResource(R.string.saved_server))
                Group { GroupRow(saved.name, { if (saved.kind == "plex") onReady(saved) else connect(saved.address) }, subtitle = saved.address, icon = Ic.Server, trailing = saved.kind.replaceFirstChar { it.uppercase() }) }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Eyebrow(stringResource(R.string.on_network))
                if (found == null && lan) Spinner(Modifier.padding(top = 14.dp).size(12.dp), G.label3)
            }
            Group {
                if (!lan) {
                    GroupRow(
                        stringResource(com.wika.wicaby.core.R.string.local_network_denied), { LocalNetwork.openSettings(context) },
                        subtitle = stringResource(com.wika.wicaby.core.R.string.local_network_open_settings), icon = Ic.WifiOff,
                    )
                    GroupDivider()
                }
                list.forEachIndexed { i, s ->
                    if (i > 0) GroupDivider()
                    GroupRow(s.name, { connect(s.address) }, subtitle = s.address, icon = Ic.Server)
                }
                if (lan && found != null && list.isEmpty()) GroupRow(stringResource(R.string.no_server_found), null, icon = Ic.WifiOff, titleColor = G.label2)
                if (lan && found == null && list.isEmpty()) GroupRow(stringResource(R.string.searching_lan), null, icon = Ic.Search, titleColor = G.label2)
                GroupDivider()
                GroupRow(stringResource(R.string.search_again), { scan++ }, icon = Ic.Refresh, chevron = false)
            }
            Eyebrow(stringResource(R.string.manual_address))
        } else Spacer(Modifier.height(16.dp))
        WicabyField(
            address, { address = it; error = null },
            stringResource(if (section == ServerSection.Public) R.string.public_address_hint else R.string.address_hint),
            keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, onSubmit = { connect(address) }, leading = Ic.Server,
        )
        if (section == ServerSection.Public && insecureAddress(address)) {
            Text(stringResource(com.wika.wicaby.core.R.string.onboarding_insecure), style = Type.footnote, color = G.label2, modifier = Modifier.padding(top = 8.dp, start = 4.dp))
        }
        Spacer(Modifier.height(14.dp))
        Box(Modifier.fillMaxWidth()) {
            PillButton(stringResource(R.string.connect), { connect(address) }, primary = true, modifier = Modifier.fillMaxWidth())
            if (busy) Spinner(Modifier.align(Alignment.CenterEnd).padding(end = 16.dp).size(20.dp), onAccent(LocalAccent.current))
        }
        AnimatedVisibility(error != null, enter = fadeIn(), exit = fadeOut()) {
            Text(error.orEmpty(), style = Type.callout, color = G.red, modifier = Modifier.padding(top = 12.dp, start = 4.dp))
        }
    }
}

@Composable
private fun Avatar(user: User?, api: Api, label: String, selected: Boolean, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    Column(
        Modifier.width(92.dp).pressScale(source).clickable(source, null, role = Role.Button, onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.size(80.dp).clip(CircleShape).background(if (selected) G.fill4 else G.elevated2),
            contentAlignment = Alignment.Center,
        ) {
            val url = user?.let { remember(it.id) { api.userImage(it, 240) } }
            if (url != null) {
                AsyncImage(url, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            } else if (user != null) {
                Text(label.take(1).uppercase(), style = Type.title1, color = G.label)
            } else {
                Icon(Ic.User, null, tint = G.label2, modifier = Modifier.size(30.dp))
            }
        }
        Text(
            label, style = Type.callout, color = if (selected) G.label else G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center, modifier = Modifier.padding(top = 10.dp),
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
// [add]: TP-06, an extra account beside the primary one. [onSignedIn]: the wizard moves on instead of the
// root switching to the main shell; [title] then replaces "Qui regarde ?" and Change Server is left out.
fun LoginScreen(server: Server, deviceId: String, add: Boolean = false, title: String? = null, onSignedIn: (() -> Unit)? = null) {
    // Plex: no user list or password on the server, the account's Home profiles instead (plex spec §5.5).
    if (server.kind == "plex") return PlexLoginScreen(server, add, title, onSignedIn)
    val scope = rememberCoroutineScope()
    val api = remember(server) { Api.of(server, deviceId) }
    var reload by remember { mutableIntStateOf(0) }
    val users = rememberLoad("public-${server.id}", reload) { api.publicUsers() }
    var picked by remember { mutableStateOf<User?>(null) }
    var manual by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val wrong = stringResource(R.string.wrong_credentials)
    val unreachable = stringResource(R.string.server_unreachable)
    val passwordFocus = remember { FocusRequester() }

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
                Cache.map.clear()
                if (add) Core.prefs.addAccount(Session(server, r.user.id, r.user.name, r.accessToken))
                else Core.prefs.setSession(r.user.id, r.user.name, r.accessToken)
                onSignedIn?.invoke()
            } catch (e: ApiException) {
                error = if (e.status == 401 || e.status == 403) wrong else e.message
            } catch (e: Exception) {
                error = unreachable
            } finally {
                busy = false
            }
        }
    }

    Column(
        Modifier.fillMaxSize().imeAware().verticalScroll(rememberScrollState()).statusBarsPadding().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(40.dp))
        Text(title ?: stringResource(R.string.who_is_watching), style = Type.largeTitle, color = G.label, textAlign = TextAlign.Center)
        Text(server.name, style = Type.callout, color = G.label2, modifier = Modifier.padding(top = 6.dp))
        Spacer(Modifier.height(36.dp))
        val list = users.value
        when {
            list == null && users.error != null -> ErrorState({ reload++ })
            list == null -> Spinner()
            else -> FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(20.dp), modifier = Modifier.widthIn(max = 560.dp)) {
                list.forEach { u ->
                    Avatar(u, api, u.name, picked?.id == u.id) {
                        manual = false
                        error = null
                        if (!u.hasPassword) login(u.name, "") else {
                            picked = u
                            password = ""
                        }
                    }
                }
                Avatar(null, api, stringResource(R.string.other_user), manual) {
                    picked = null
                    manual = true
                    error = null
                }
            }
        }
        Spacer(Modifier.height(32.dp))
        Column(Modifier.widthIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val p = picked
            if (manual) WicabyField(name, { name = it }, stringResource(R.string.username), imeAction = ImeAction.Next, leading = Ic.User)
            if (p != null || manual) {
                LaunchedEffect(p?.id) { if (p != null) runCatching { passwordFocus.requestFocus() } }
                WicabyField(
                    password, { password = it },
                    if (p != null) stringResource(R.string.password_for, p.name) else stringResource(R.string.password),
                    modifier = Modifier.focusRequester(passwordFocus), password = true, imeAction = ImeAction.Go,
                    onSubmit = { login(p?.name ?: name, password) }, leading = Ic.Lock,
                )
                Box(Modifier.fillMaxWidth()) {
                    PillButton(stringResource(R.string.sign_in), { login(p?.name ?: name, password) }, primary = true, modifier = Modifier.fillMaxWidth())
                    if (busy) Spinner(Modifier.align(Alignment.CenterEnd).padding(end = 16.dp).size(20.dp), onAccent(LocalAccent.current))
                }
            }
            AnimatedVisibility(error != null, enter = fadeIn(), exit = fadeOut()) {
                Text(error.orEmpty(), style = Type.callout, color = G.red, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            }
        }
        Spacer(Modifier.height(40.dp))
        if (onSignedIn == null) PillButton(stringResource(R.string.change_server), { SetupRequest.pickServer = true }, icon = Ic.Server)
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

// The rationale screen shown before the first LAN connection (server discovery, or a saved
// server on the LAN) while ACCESS_LOCAL_NETWORK is missing. "Plus tard" goes on without it:
// remote servers and downloads keep working, LAN rows then say the access was refused.
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
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).statusBarsPadding().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(Modifier.widthIn(max = 520.dp)) {
            Spacer(Modifier.height(48.dp))
            Icon(Ic.WifiOff, null, tint = G.label2, modifier = Modifier.size(44.dp))
            Spacer(Modifier.height(22.dp))
            Text(
                stringResource(if (refused) com.wika.wicaby.core.R.string.local_network_denied else com.wika.wicaby.core.R.string.local_network_title),
                style = Type.largeTitle, color = G.label,
            )
            Spacer(Modifier.height(10.dp))
            Text(stringResource(com.wika.wicaby.core.R.string.local_network_rationale), style = Type.body, color = G.label2)
            Spacer(Modifier.height(28.dp))
            PillButton(
                stringResource(if (refused) com.wika.wicaby.core.R.string.local_network_open_settings else com.wika.wicaby.core.R.string.local_network_allow),
                { if (refused) LocalNetwork.openSettings(context) else ask.launch(LocalNetwork.PERMISSION) },
                primary = true, modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            PillButton(stringResource(com.wika.wicaby.core.R.string.local_network_later), { later = true }, modifier = Modifier.fillMaxWidth())
        }
    }
}
