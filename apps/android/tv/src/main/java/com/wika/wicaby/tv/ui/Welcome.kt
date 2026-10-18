package com.wika.wicaby.tv.ui

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.SessionGate
import com.wika.wicaby.core.mesh.MeshServers
import com.wika.wicaby.core.mesh.MeshState
import com.wika.wicaby.core.mesh.PeerServer
import com.wika.wicaby.core.net.LocalNetwork
import com.wika.wicaby.meshui.R as MeshR
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.LocalSnapshot
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.Route
import com.wika.wicaby.tv.Wicaby
import com.wika.wicaby.tv.data.AppLanguage
import com.wika.wicaby.tv.data.TvSettings
import com.wika.wicaby.tv.startRoute
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// First-run wizard (onboarding spec 2, OB-T1), D-pad first: Welcome → Look → Where is your server? → Sign in →
// Extras → Done. Each choice is written at once, so leaving halfway loses nothing. Only the step is kept
// (rememberSaveable): a language change recreates the activity and comes back to it.

internal const val STEPS = 6

@Composable
fun WelcomeScreen(rerun: Boolean) {
    val nav = LocalNav.current
    val snap = LocalSnapshot.current
    val activity = LocalActivity.current ?: return
    val prefs = Wicaby.app.prefs
    val scope = rememberCoroutineScope()
    // Step 3's server for step 4 (the primary one is also in the preferences; an added one only here).
    var target by remember { mutableStateOf<Server?>(null) }
    val session = snap.session
    val adding = session != null
    val isMain = stringResource(R.string.server_is_main)
    // Back out of the wizard (to Réglages, or out of the app) drops a theme only previewed too, as finish() does.
    DisposableEffect(Unit) { onDispose { C.theme = TvSettings.theme.value } }

    // Skip Setup and Start Watching: a rerun goes back to Réglages, a first run lands where the app would have.
    fun finish() {
        C.theme = TvSettings.theme.value // a theme only previewed (focused, never confirmed) is dropped
        scope.launch {
            prefs.setOnboarded(true)
            if (rerun) return@launch nav.pop()
            val s = snap.copy(onboarded = true)
            val route = if (s.session != null && SessionGate.active(s.session) != null) Route.Main else startRoute(s)
            if (route == Route.Main) s.session?.let(SessionGate::unlock)
            nav.reset(route)
        }
    }
    // Réglages > Remote Access; they only exist once signed in.
    val remote = if (session == null) null else { ->
        SettingsLink.remote = true
        finish()
    }

    Wizard(
        language = remember { AppLanguage.current(activity) },
        onLanguage = { AppLanguage.set(activity, it) },
        accent = snap.accent,
        onAccent = { scope.launch { prefs.setAccent(it) } },
        // A click or Continue, never a focus; keeping Graphite leaves the Home suggestion for later.
        onTheme = {
            TvSettings.theme.value = it
            if (it != "graphite") TvSettings.themeHintShown.value = true
        },
        onSkip = ::finish,
    ) { step, go ->
        when (step) {
            3 -> WhereStep(
                servers = signedIn(snap),
                onReady = { target = it; go(4) },
                // A server found on the mesh: as ServerScreen does with a typed address.
                onPeer = { s ->
                    if (adding && s.id == snap.server?.id) isMain
                    else {
                        scope.launch {
                            if (!adding) prefs.setServer(s)
                            target = s
                            go(4)
                        }
                        null
                    }
                },
                onPaired = { go(5) },
                onMore = remote,
                onContinue = { go(5) },
                onBack = { go(2) },
            )
            4 -> {
                val server = target ?: snap.server
                if (server == null) LaunchedEffect(Unit) { go(3) }
                // The primary server opens its own profiles; another one is an extra account (TP-06).
                else LoginScreen(server, add = session != null && session.server.id != server.id, onSignedIn = { go(5) }, onAddAnother = { go(3) })
            }
            5 -> ExtrasStep(onContinue = { go(6) }, onBack = { go(4) })
            else -> DoneStep(signedIn(snap), onStart = ::finish, onRemote = remote)
        }
    }
}

private fun signedIn(snap: com.wika.wicaby.core.data.Snapshot): List<Server> =
    (listOfNotNull(snap.session?.server) + snap.extras.map { it.server }).distinctBy { it.id }

// The pager, Back and the progress; steps 1 and 2 here, the rest from [later]. Tests drive it on its own.
@Composable
internal fun Wizard(
    language: String,
    onLanguage: (String) -> Unit,
    accent: Int,
    onAccent: (Int) -> Unit,
    onTheme: (String) -> Unit,
    onSkip: () -> Unit,
    later: @Composable (step: Int, go: (Int) -> Unit) -> Unit,
) {
    var step by rememberSaveable { mutableIntStateOf(1) }
    // Step 1: Back leaves the app (or a rerun), as on the server screen.
    BackHandler(enabled = step > 1) { step-- }
    val go: (Int) -> Unit = { step = it }
    // A keyboard left up by step 3 or 4 (address, password) would keep the D-pad on the next step.
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    LaunchedEffect(step) { keyboard?.hide() }
    Box(Modifier.fillMaxSize().background(C.bg)) {
        AmbientGlow()
        AnimatedContent(step, transitionSpec = { fadeIn(tween(240, 60)) togetherWith fadeOut(tween(140)) }, label = "wizard") { s ->
            when (s) {
                1 -> IntroStep(language, onLanguage, onStart = { go(2) }, onSkip = onSkip)
                2 -> LookStep(accent, onAccent, onTheme, onContinue = { go(3) }, onBack = { go(1) })
                else -> later(s, go)
            }
        }
        Row(
            Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(start = 64.dp, end = 52.dp, bottom = 24.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Dots(step, Modifier.weight(1f))
            if (step in 2..5) TextButton(stringResource(CoreR.string.onboarding_skip), onClick = onSkip, modifier = Modifier.testTag("skip"))
        }
    }
}

// Six dots, the current one a capsule; read out as "Step 2 of 6".
@Composable
private fun Dots(step: Int, modifier: Modifier = Modifier) {
    val label = stringResource(CoreR.string.onboarding_progress, step, STEPS)
    val accent = LocalAccent.current
    Row(modifier.clearAndSetSemantics { contentDescription = label }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        repeat(STEPS) { i ->
            Box(Modifier.size(width = if (i + 1 == step) 22.dp else 8.dp, height = 8.dp).clip(CircleShape).background(if (i + 1 == step) accent else C.fill4))
        }
    }
}

// Two columns, as the server screen: what the step is about on the left, its controls on the right.
@Composable
private fun StepColumns(title: String, body: String?, right: @Composable () -> Unit) {
    Row(Modifier.fillMaxSize().padding(start = 64.dp, end = 64.dp, top = 56.dp, bottom = 72.dp), horizontalArrangement = Arrangement.spacedBy(56.dp)) {
        Column(Modifier.weight(0.85f).padding(top = 40.dp)) {
            Text(title, style = Type.largeTitle, color = C.label)
            if (body != null) Text(body, style = Type.body, color = C.label2, modifier = Modifier.padding(top = 10.dp))
        }
        // Room inside the scroll for the focus lift and the cards' outline.
        Column(Modifier.weight(1.15f).verticalScroll(rememberScrollState()).padding(top = 40.dp, start = 8.dp, end = 8.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) { right() }
    }
}

// Step 1. Focus starts on Get Started; Up reaches the language chips, centred above it.
@Composable
internal fun IntroStep(language: String, onLanguage: (String) -> Unit, onStart: () -> Unit, onSkip: () -> Unit) {
    val memory = rememberFocusMemory()
    Row(Modifier.fillMaxSize().padding(horizontal = 64.dp, vertical = 56.dp), horizontalArrangement = Arrangement.spacedBy(56.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            AppMark(76.dp)
            Spacer(Modifier.height(28.dp))
            Text(stringResource(CoreR.string.onboarding_welcome_title), style = Type.largeTitle, color = C.label)
            Text(stringResource(CoreR.string.onboarding_welcome_body), style = Type.body, color = C.label2, modifier = Modifier.padding(top = 10.dp))
        }
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(CoreR.string.onboarding_language).uppercase(), style = Type.eyebrow, color = C.label3, modifier = Modifier.padding(bottom = 12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                // The language names stay in their own language, so either reader finds theirs.
                val labels = listOf(stringResource(CoreR.string.onboarding_language_system), stringResource(R.string.language_fr), stringResource(R.string.language_en))
                AppLanguage.TAGS.forEachIndexed { i, tag ->
                    Pill(labels[i], onClick = { onLanguage(tag) }, selected = tag == language, icon = Ic.Check.takeIf { tag == language }, modifier = Modifier.testTag("lang-$tag").remembered(memory, "lang-$tag"))
                }
            }
            Spacer(Modifier.height(32.dp))
            Pill(stringResource(CoreR.string.onboarding_start), onClick = onStart, primary = true, modifier = Modifier.testTag("start").remembered(memory, "start", default = true))
            Spacer(Modifier.height(12.dp))
            TextButton(stringResource(CoreR.string.onboarding_skip), onClick = onSkip, modifier = Modifier.testTag("skip").remembered(memory, "skip"))
        }
    }
}

// Step 2. Focusing a theme card or a colour applies it at once: the whole wizard is the preview. The theme is
// saved by a click on its card or by Continue, so passing through and skipping saves nothing.
@Composable
internal fun LookStep(accent: Int, onAccent: (Int) -> Unit, onTheme: (String) -> Unit, onContinue: () -> Unit, onBack: () -> Unit) {
    val memory = rememberFocusMemory()
    val next = remember { FocusRequester() }
    fun theme(id: String) {
        C.theme = id
        onTheme(id)
    }
    StepColumns(stringResource(CoreR.string.onboarding_look_title), stringResource(CoreR.string.onboarding_look_body)) {
        val current = C.palette.id
        ThemeCardRow(
            current, onPick = { theme(it); runCatching { next.requestFocus() } }, onFocus = { C.theme = it },
            cardModifier = { id -> Modifier.remembered(memory, "theme-$id", default = current == id) },
        )
        Text(stringResource(R.string.settings_accent).uppercase(), style = Type.eyebrow, color = C.label3, modifier = Modifier.padding(start = 4.dp, top = 8.dp))
        AccentRow(accent, onPick = { onAccent(it); runCatching { next.requestFocus() } }, onFocus = onAccent, modifier = Modifier.padding(start = 6.dp, top = 4.dp, bottom = 8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Pill(stringResource(R.string.welcome_continue), onClick = { onTheme(C.palette.id); onContinue() }, primary = true, modifier = Modifier.focusRequester(next).testTag("continue"))
            TextButton(stringResource(R.string.welcome_back), onClick = onBack)
        }
    }
}

// Step 3: three cards, then the chosen one's screen (Back returns to the cards, focus where it was).
@Composable
private fun WhereStep(
    servers: List<Server>,
    onReady: (Server) -> Unit,
    onPeer: (Server) -> String?,
    onPaired: () -> Unit,
    onMore: (() -> Unit)?,
    onContinue: () -> Unit,
    onBack: () -> Unit,
) {
    var where by rememberSaveable { mutableStateOf<String?>(null) }
    val memory = rememberFocusMemory()
    BackHandler(enabled = where != null) {
        memory.restored = false
        where = null
    }
    val adding = servers.isNotEmpty()
    when (where) {
        "lan" -> LocalNetworkGate(true) { ServerScreen(add = adding, section = "lan", onReady = onReady, onPaired = onPaired) }
        "public" -> ServerScreen(add = adding, section = "public", onReady = onReady)
        "vpn" -> VpnChooser(onPeer, onMore)
        else -> Column(Modifier.fillMaxSize().padding(start = 64.dp, end = 64.dp, top = 96.dp, bottom = 72.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text(stringResource(CoreR.string.onboarding_where_title), style = Type.largeTitle, color = C.label)
            // A rerun, or Add Another Server: the servers already signed in.
            if (adding) {
                Text(
                    stringResource(R.string.welcome_your_servers).uppercase() + "  ·  " + servers.joinToString(" · ") { it.name },
                    style = Type.eyebrow, color = C.label3, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp), modifier = Modifier.padding(top = 8.dp)) {
                WhereCard(Ic.Wifi, stringResource(CoreR.string.onboarding_where_lan), stringResource(CoreR.string.onboarding_where_lan_sub), onClick = { where = "lan" },
                    modifier = Modifier.weight(1f).remembered(memory, "lan", default = true))
                val mesh = Core.mesh.supported
                WhereCard(Ic.Lan, stringResource(CoreR.string.onboarding_where_vpn),
                    stringResource(if (mesh) CoreR.string.onboarding_where_vpn_sub else MeshR.string.mesh_unsupported), enabled = mesh, onClick = { where = "vpn" },
                    modifier = Modifier.weight(1f).remembered(memory, "vpn"))
                WhereCard(Ic.Globe, stringResource(CoreR.string.onboarding_where_public), stringResource(CoreR.string.onboarding_where_public_sub), onClick = { where = "public" },
                    modifier = Modifier.weight(1f).remembered(memory, "public"))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 8.dp)) {
                if (adding) Pill(stringResource(R.string.welcome_continue), onClick = onContinue, primary = true, modifier = Modifier.remembered(memory, "continue"))
                TextButton(stringResource(R.string.welcome_back), onClick = onBack)
            }
        }
    }
}

@Composable
private fun WhereCard(icon: ImageVector, title: String, sub: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    var focused by remember { mutableStateOf(false) }
    val bg = if (focused) TvFocus.bg else C.fill2
    val fg = if (focused) TvFocus.fg else C.label
    val fg2 = if (focused) TvFocus.fg.copy(alpha = 0.6f) else C.label2
    Column(
        modifier
            .height(180.dp)
            .alpha(if (enabled) 1f else 0.45f)
            // Disabled (mesh unsupported): shown with the reason, never focused.
            .then(if (enabled) Modifier.tvFocus(RoundedCornerShape(Radius.lg), focusedScale = 1.05f, onFocusChange = { focused = it }, onClick = onClick) else Modifier.clip(RoundedCornerShape(Radius.lg)))
            .background(bg)
            .padding(24.dp),
    ) {
        Icon(icon, null, tint = fg2, modifier = Modifier.size(32.dp))
        Spacer(Modifier.weight(1f))
        Text(title, style = Type.title3, color = fg, maxLines = 2)
        Text(sub, style = Type.footnote, color = fg2, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
    }
}

// Step 3, VPN: the usual sign-in panel (QR code), then, once connected, the peers that host a server. Probing
// costs a few seconds on a large network, so it only runs on "Find Servers".
@Composable
private fun VpnChooser(onPeer: (Server) -> String?, onMore: (() -> Unit)?) {
    val status by Core.mesh.status.collectAsState()
    val scope = rememberCoroutineScope()
    var found by remember { mutableStateOf<List<PeerServer>?>(null) }
    var finding by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        delay(60)
        runCatching { first.requestFocus() }
    }
    StepColumns(stringResource(CoreR.string.onboarding_where_vpn), stringResource(CoreR.string.onboarding_where_vpn_sub)) {
        RemoteAccessSection(Modifier.focusRequester(first).focusGroup())
        if (status.state == MeshState.Connected) {
            Text(stringResource(CoreR.string.onboarding_choose_device).uppercase(), style = Type.eyebrow, color = C.label3, modifier = Modifier.padding(start = 4.dp, top = 10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Pill(stringResource(CoreR.string.onboarding_find_servers), icon = Ic.Search, onClick = {
                    if (finding) return@Pill
                    scope.launch {
                        finding = true
                        found = runCatching { MeshServers.find(status.peers) }.getOrDefault(emptyList())
                        finding = false
                    }
                })
                if (finding) Spinner(Modifier.size(22.dp))
            }
            found?.let { list ->
                status.peers.filter { it.online }.forEach { peer ->
                    val s = list.firstOrNull { it.peer == peer }?.server
                    if (s != null) {
                        ListRow(s.name, "${peer.name} · ${s.kind.replaceFirstChar { it.uppercase() }}", icon = Ic.Server, onClick = { error = onPeer(s) })
                    } else {
                        // Nothing to pick there: dimmed, and not focusable.
                        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp).alpha(0.5f), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            Text(peer.name.ifEmpty { peer.dnsName.orEmpty() }, style = Type.headline, color = C.label2, modifier = Modifier.weight(1f))
                            Text(stringResource(CoreR.string.onboarding_peer_no_server), style = Type.footnote, color = C.label3)
                        }
                    }
                }
            }
            error?.let { Text(it, style = Type.callout, color = C.red, modifier = Modifier.padding(start = 4.dp)) }
        }
        // The full Remote Access page: devices, routes, management URL, diagnostics.
        if (onMore != null) TextButton(stringResource(CoreR.string.onboarding_more_options), onClick = onMore)
    }
}

// Step 5: optional. Every row writes at once; Not Now and Continue both move on.
@Composable
private fun ExtrasStep(onContinue: () -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        delay(60)
        runCatching { first.requestFocus() }
    }
    // Many TVs hide the system screensaver settings: the row only when they exist.
    val dream = remember { Intent(android.provider.Settings.ACTION_DREAM_SETTINGS).takeIf { it.resolveActivity(context.packageManager) != null } }
    StepColumns(stringResource(CoreR.string.onboarding_extras_title), null) {
        Column(Modifier.focusRequester(first).focusGroup()) {
            Group(null) { HomeChannelsRow() }
            Group(stringResource(R.string.group_screensaver)) {
                ScreensaverRow()
                if (dream != null) SettingRow(stringResource(CoreR.string.onboarding_system_screensaver), chevron = true, onClick = { runCatching { context.startActivity(dream) } })
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Pill(stringResource(R.string.welcome_continue), onClick = onContinue, primary = true)
            Pill(stringResource(CoreR.string.onboarding_not_now), onClick = onContinue)
            TextButton(stringResource(R.string.welcome_back), onClick = onBack)
        }
    }
}

// Step 6: what is set up, from the preferences and the mesh status.
@Composable
private fun DoneStep(servers: List<Server>, onStart: () -> Unit, onRemote: (() -> Unit)?) {
    val status by Core.mesh.status.collectAsState()
    // Each server's route: through the VPN, on the local network, or remote (blank until known).
    val routes by produceState(emptyMap<String, Int>(), servers, status.state) {
        value = servers.associate { s ->
            s.id to when {
                withContext(Dispatchers.IO) { s.origin?.let(Core.transport::forward) } != null -> CoreR.string.onboarding_route_vpn
                LocalNetwork.isLanServer(s.address) -> CoreR.string.onboarding_route_local
                else -> CoreR.string.onboarding_route_remote
            }
        }
    }
    val accent = LocalAccent.current
    val memory = rememberFocusMemory()
    Row(Modifier.fillMaxSize().padding(start = 64.dp, end = 64.dp, top = 56.dp, bottom = 72.dp), horizontalArrangement = Arrangement.spacedBy(56.dp)) {
        Column(Modifier.weight(0.85f).padding(top = 40.dp)) {
            Box(Modifier.size(64.dp).clip(CircleShape).background(accent), contentAlignment = Alignment.Center) {
                Icon(Ic.Check, null, tint = onAccent(accent), modifier = Modifier.size(36.dp))
            }
            Text(stringResource(CoreR.string.onboarding_done_title), style = Type.largeTitle, color = C.label, modifier = Modifier.padding(top = 24.dp))
        }
        Column(Modifier.weight(1.15f).verticalScroll(rememberScrollState()).padding(top = 40.dp, start = 8.dp, end = 8.dp, bottom = 8.dp)) {
            Group(stringResource(R.string.welcome_media_servers)) {
                if (servers.isEmpty()) InfoRow(stringResource(CoreR.string.onboarding_done_none), null)
                servers.forEach { s ->
                    val route = routes[s.id]?.let { stringResource(it) }
                    InfoRow(s.name, listOfNotNull(s.kind.replaceFirstChar { it.uppercase() }, route, s.address).joinToString(" · "))
                }
            }
            if (status.state != MeshState.Stopped && status.state != MeshState.Unsupported) {
                val provider = (status.provider ?: Core.mesh.provider).label
                Group(stringResource(MeshR.string.mesh_title)) {
                    InfoRow("$provider · ${meshStateLabel(status.state)}", listOfNotNull(status.selfDnsName ?: status.selfName, status.ips.firstOrNull()).joinToString(" · ").ifEmpty { null })
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Pill(stringResource(CoreR.string.onboarding_done_start), onClick = onStart, primary = true, modifier = Modifier.remembered(memory, "start", default = true))
                if (onRemote != null) TextButton(stringResource(CoreR.string.onboarding_done_remote), onClick = onRemote)
            }
        }
    }
}

// A read-only row, in the settings rows' shape.
@Composable
private fun InfoRow(label: String, value: String?) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.md)).background(C.fill1).padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(label, style = Type.headline, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (value != null) Text(value, style = Type.callout, color = C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
