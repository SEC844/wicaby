package com.wika.wicaby.mobile.ui

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
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
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Found
import com.wika.wicaby.core.data.Prefs
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.Snapshot
import com.wika.wicaby.core.data.discover
import com.wika.wicaby.core.mesh.MeshServers
import com.wika.wicaby.core.mesh.MeshState
import com.wika.wicaby.core.mesh.MeshStatus
import com.wika.wicaby.core.mesh.PeerServer
import com.wika.wicaby.mobile.Lang
import com.wika.wicaby.mobile.R
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import com.wika.wicaby.core.R as CoreR

// OB-M1: the first-run wizard (onboarding spec section 2). Six steps, every choice saved at once;
// steps 3 and 4 host the existing server picker, mesh panel and sign-in screen.

const val WIZARD_STEPS = 6

// What the wizard writes. Tests pass a fake: the DataStore file cannot be replaced twice on a Windows host.
interface WizardStore {
    suspend fun setAccent(i: Int)
    suspend fun setTheme(id: String)
    suspend fun setWifiOnlyDownloads(v: Boolean)
    suspend fun setServer(server: Server)
    suspend fun setOnboarded(v: Boolean)
}

private class PrefsStore(private val p: Prefs) : WizardStore {
    override suspend fun setAccent(i: Int) { p.setAccent(i) }
    override suspend fun setTheme(id: String) { p.setTheme(id) }
    override suspend fun setWifiOnlyDownloads(v: Boolean) { p.setWifiOnlyDownloads(v) }
    override suspend fun setServer(server: Server) { p.setServer(server) }
    override suspend fun setOnboarded(v: Boolean) { p.setOnboarded(v) }
}

private enum class Where { Lan, Vpn, Public }

@Composable
fun WelcomeFlow(
    snap: Snapshot,
    rerun: Boolean = false,
    store: WizardStore = remember { PrefsStore(Core.prefs) },
    mesh: StateFlow<MeshStatus> = Core.mesh.status,
    find: suspend (Context) -> List<Found> = { discover(it) },
) {
    val scope = rememberCoroutineScope()
    // Kept across the recreation a language change causes.
    var step by rememberSaveable { mutableIntStateOf(1) }
    // TP-06: "Ajouter un autre serveur" signs in to an extra account; [pending] is the server picked for it.
    var add by rememberSaveable { mutableStateOf(false) }
    var pending by rememberSaveable(stateSaver = ServerSaver) { mutableStateOf<Server?>(null) }

    fun finish(remote: Boolean) = scope.launch {
        store.setOnboarded(true)
        if (rerun || remote) SetupRequest.returnTo = Tab.Settings
        SetupRequest.openRemote = remote
        SetupRequest.rerun = false
        SetupRequest.wizard = false
    }

    fun ready(server: Server) {
        if (add) {
            pending = server
            step = 4
        } else scope.launch {
            store.setServer(server)
            // With a server saved the wizard never returns by itself: mark it done now, in case the app dies before Done.
            store.setOnboarded(true)
            step = 4
        }
    }

    // Plex: the sessions are saved already; on to "Vos serveurs".
    fun plexLinked() {
        scope.launch { store.setOnboarded(true) }
        add = false
        step = 4
    }

    fun back() {
        when {
            step == 4 && pending != null -> { pending = null; step = 3 }
            step == 3 && add -> add = false
            step > 1 -> step--
            // Step 1 of a rerun: back to Réglages, nothing changed.
            else -> finish(remote = false)
        }
    }
    BackHandler(enabled = step > 1 || rerun) { back() }

    val signedIn = snap.session != null && !add
    Column(Modifier.fillMaxSize().background(G.bg).statusBarsPadding().navigationBarsPadding().imeAware()) {
        Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (step > 1) GlassIconButton(Ic.Back, stringResource(R.string.back), ::back, glass = 0f)
            Spacer(Modifier.weight(1f))
            if (step < WIZARD_STEPS) TextButton({ finish(remote = false) }) { Text(stringResource(CoreR.string.onboarding_skip), style = Type.callout, color = G.label2) }
        }
        AnimatedContent(step, Modifier.weight(1f).fillMaxWidth(), transitionSpec = { fadeIn(tween(220)) togetherWith fadeOut(tween(120)) }, label = "wizard") { s ->
            when (s) {
                1 -> Page { Intro() }
                2 -> Page { Look(snap, store) }
                3 -> Page { WhereStep(snap, signedIn, add, find, mesh, onReady = ::ready, onAddAnother = { add = true }, onPlex = ::plexLinked) }
                4 -> {
                    val p = pending
                    val server = snap.server
                    when {
                        // Signed in: step 4 stays, now "Vos serveurs" with "Ajouter un autre serveur" and Continue (as on the TV).
                        p != null -> LoginScreen(p, snap.deviceId, add = true, title = stringResource(CoreR.string.onboarding_signin_title, p.name), onSignedIn = {
                            pending = null
                            add = false
                        })
                        !signedIn && server != null -> LoginScreen(server, snap.deviceId, title = stringResource(CoreR.string.onboarding_signin_title, server.name), onSignedIn = {})
                        else -> Page { YourServers(snap, onAddAnother = { add = true; step = 3 }) }
                    }
                }
                5 -> Page { Extras(snap, store) }
                else -> Page { Done(snap, mesh, onRemote = { finish(remote = true) }) }
            }
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Dots(step)
            Spacer(Modifier.height(14.dp))
            Box(Modifier.widthIn(max = 520.dp).fillMaxWidth()) {
                when (step) {
                    1 -> PillButton(stringResource(CoreR.string.onboarding_start), { step = 2 }, Modifier.fillMaxWidth(), primary = true)
                    2, 5 -> Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        PillButton(stringResource(CoreR.string.onboarding_not_now), { step++ }, Modifier.weight(1f))
                        PillButton(stringResource(R.string.wizard_continue), { step++ }, Modifier.weight(1f), primary = true)
                    }
                    3, 4 -> if (signedIn && pending == null) PillButton(stringResource(R.string.wizard_continue), { step = 5 }, Modifier.fillMaxWidth(), primary = true)
                    else -> PillButton(stringResource(CoreR.string.onboarding_done_start), { finish(remote = false) }, Modifier.fillMaxWidth(), primary = true)
                }
            }
        }
    }
}

@Composable
private fun Page(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(Modifier.widthIn(max = 520.dp).fillMaxWidth().padding(bottom = 16.dp), content = content)
    }
}

// Six small dots, the current one a capsule; read out as "Étape 2 sur 6".
@Composable
private fun Dots(step: Int) {
    val label = stringResource(CoreR.string.onboarding_progress, step, WIZARD_STEPS)
    Row(Modifier.semantics { contentDescription = label }, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        repeat(WIZARD_STEPS) { i ->
            val current = i + 1 == step
            Box(Modifier.height(6.dp).width(if (current) 20.dp else 6.dp).clip(CircleShape).background(if (current) LocalAccent.current else G.fill4))
        }
    }
}

@Composable
private fun Title(title: String, body: String? = null) {
    Text(title, style = Type.largeTitle, color = G.label, modifier = Modifier.padding(top = 12.dp))
    if (body != null) Text(body, style = Type.body, color = G.label2, modifier = Modifier.padding(top = 8.dp))
}

// Step 1: the mark, the pitch and the language (Lang.set recreates the activity; the step survives).
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Intro() {
    val context = LocalContext.current
    Spacer(Modifier.height(32.dp))
    AppMark(80.dp)
    Spacer(Modifier.height(10.dp))
    Title(stringResource(CoreR.string.onboarding_welcome_title), stringResource(CoreR.string.onboarding_welcome_body))
    Eyebrow(stringResource(CoreR.string.onboarding_language))
    val language = remember { Lang.current(context) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // The endonyms stay untranslated.
        listOf("" to CoreR.string.onboarding_language_system, "fr" to R.string.language_fr, "en" to R.string.language_en).forEach { (tag, label) ->
            Chip(stringResource(label), selected = language == tag) { if (language != tag) Lang.set(context, tag) }
        }
    }
}

// Step 2: theme and accent, applied at once (the whole wizard is the preview).
@Composable
private fun Look(snap: Snapshot, store: WizardStore) {
    val scope = rememberCoroutineScope()
    Title(stringResource(CoreR.string.onboarding_look_title), stringResource(CoreR.string.onboarding_look_body))
    Eyebrow(stringResource(R.string.settings_theme))
    Group { ThemePicker(snap.theme, snap.accent) { id -> scope.launch { store.setTheme(id) } } }
    Eyebrow(stringResource(R.string.settings_accent))
    Group { AccentPicker(snap.accent) { i -> scope.launch { store.setAccent(i) } } }
    Eyebrow(stringResource(CoreR.string.onboarding_look_preview))
    Group {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(56.dp).height(84.dp).clip(RoundedCornerShape(Radius.sm)).background(G.elevated2))
            Column(Modifier.padding(start = 14.dp).weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Wicaby", style = Type.headline, color = G.label)
                ProgressLine(0.4f, track = G.fill4)
                PillButton(stringResource(R.string.play), {}, icon = Ic.Play, primary = true, compact = true)
            }
        }
    }
}

// Step 3: three cards, the chosen one's panel underneath. Signed in already (rerun, or back from
// step 4): the servers so far, Continue, and "Ajouter un autre serveur".
@Composable
private fun WhereStep(
    snap: Snapshot,
    signedIn: Boolean,
    add: Boolean,
    find: suspend (Context) -> List<Found>,
    mesh: StateFlow<MeshStatus>,
    onReady: (Server) -> Unit,
    onAddAnother: () -> Unit,
    onPlex: () -> Unit = {},
) {
    Title(stringResource(CoreR.string.onboarding_where_title))
    if (signedIn) return YourServers(snap, onAddAnother)
    var where by rememberSaveable { mutableStateOf<Where?>(null) }
    Spacer(Modifier.height(18.dp))
    Group {
        listOf(
            Triple(Where.Lan, CoreR.string.onboarding_where_lan to CoreR.string.onboarding_where_lan_sub, Ic.Search),
            Triple(Where.Vpn, CoreR.string.onboarding_where_vpn to CoreR.string.onboarding_where_vpn_sub, Ic.Lock),
            Triple(Where.Public, CoreR.string.onboarding_where_public to CoreR.string.onboarding_where_public_sub, Ic.External),
        ).forEachIndexed { i, (w, text, icon) ->
            if (i > 0) GroupDivider()
            val selected = where == w
            Box(Modifier.selectable(selected, role = Role.RadioButton) { where = w }) {
                GroupRow(stringResource(text.first), null, subtitle = stringResource(text.second), icon = icon) {
                    if (selected) Icon(Ic.Check, null, tint = LocalAccent.current, modifier = Modifier.padding(start = 6.dp).size(20.dp))
                }
            }
        }
    }
    when (where) {
        Where.Lan -> ServerPanel(snap, ServerSection.Lan, add, find, onPlex, onReady)
        Where.Public -> ServerPanel(snap, ServerSection.Public, add, find, onPlex, onReady)
        Where.Vpn -> {
            RemoteAccessSection()
            ChooseDevice(mesh, onReady, onByAddress = { where = Where.Public })
        }
        null -> {}
    }
}

// Once the mesh is up: the peers that answer as a media server, probed only on request ("Trouver les serveurs").
@Composable
private fun ChooseDevice(mesh: StateFlow<MeshStatus>, onReady: (Server) -> Unit, onByAddress: () -> Unit) {
    val status by mesh.collectAsState()
    if (status.state != MeshState.Connected) return
    val scope = rememberCoroutineScope()
    var found by remember { mutableStateOf<List<PeerServer>?>(null) }
    var busy by remember { mutableStateOf(false) }
    Eyebrow(stringResource(CoreR.string.onboarding_choose_device))
    Group {
        GroupRow(stringResource(CoreR.string.onboarding_find_servers), {
            if (!busy) scope.launch {
                busy = true
                found = runCatching { MeshServers.find(status.peers) }.getOrDefault(emptyList())
                busy = false
            }
        }, icon = Ic.Search, chevron = false) { if (busy) Spinner(Modifier.size(16.dp), G.label3) }
        found?.let { list ->
            status.peers.filter { it.online }.forEach { peer ->
                GroupDivider()
                val hit = list.firstOrNull { it.peer == peer }
                if (hit != null) GroupRow(peer.name, { onReady(hit.server) }, subtitle = "${hit.server.kind.replaceFirstChar { it.uppercase() }} · ${hit.server.name}", icon = Ic.Server)
                else GroupRow(peer.name, null, subtitle = stringResource(CoreR.string.onboarding_peer_no_server), titleColor = G.label3)
            }
        }
        GroupDivider()
        GroupRow(stringResource(CoreR.string.onboarding_by_address), onByAddress, icon = Ic.External)
    }
}

@Composable
private fun YourServers(snap: Snapshot, onAddAnother: () -> Unit) {
    Spacer(Modifier.height(18.dp))
    ServersSummary(snap)
    Spacer(Modifier.height(12.dp))
    Group { GroupRow(stringResource(CoreR.string.onboarding_add_another), onAddAnother, icon = Ic.Plus) }
}

// Step 5: downloads over Wi-Fi only.
@Composable
private fun Extras(snap: Snapshot, store: WizardStore) {
    val scope = rememberCoroutineScope()
    val accent = LocalAccent.current
    Title(stringResource(CoreR.string.onboarding_extras_title))
    Spacer(Modifier.height(18.dp))
    Group {
        GroupRow(stringResource(R.string.wifi_only), { scope.launch { store.setWifiOnlyDownloads(!snap.wifiOnlyDownloads) } }, subtitle = stringResource(R.string.wifi_only_sub), chevron = false) {
            Switch(
                snap.wifiOnlyDownloads, { v -> scope.launch { store.setWifiOnlyDownloads(v) } },
                colors = SwitchDefaults.colors(checkedTrackColor = accent, checkedThumbColor = onAccent(accent), uncheckedTrackColor = G.fill3, uncheckedThumbColor = G.label2, uncheckedBorderColor = Color.Transparent),
            )
        }
    }
}

// Step 6: what is set up (servers, the mesh), then Start Watching.
@Composable
private fun ColumnScope.Done(snap: Snapshot, mesh: StateFlow<MeshStatus>, onRemote: () -> Unit) {
    val status by mesh.collectAsState()
    Spacer(Modifier.height(28.dp))
    Icon(Ic.CircleCheck, null, tint = LocalAccent.current, modifier = Modifier.size(56.dp).align(Alignment.CenterHorizontally))
    Text(stringResource(CoreR.string.onboarding_done_title), style = Type.largeTitle, color = G.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 18.dp))
    ServersSummary(snap)
    if (status.state != MeshState.Stopped && status.state != MeshState.Unsupported) {
        Spacer(Modifier.height(12.dp))
        Group {
            GroupRow(status.provider?.label ?: stringResource(com.wika.wicaby.meshui.R.string.mesh_title), null, subtitle = listOfNotNull(meshStateLabel(status.state), status.ips.firstOrNull()).joinToString(" · ")) {
                StateDot(status.state)
            }
        }
    }
    Spacer(Modifier.height(12.dp))
    Group { GroupRow(stringResource(CoreR.string.onboarding_done_remote), onRemote, icon = Ic.Lock) }
}
