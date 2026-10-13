package com.wika.wicaby.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.data.Session
import com.wika.wicaby.core.data.Snapshot
import com.wika.wicaby.core.mesh.MeshState
import com.wika.wicaby.core.mesh.MeshStatus
import com.wika.wicaby.meshui.R as MeshR
import com.wika.wicaby.mobile.R
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

// TP-06 on mobile: several signed-in servers, merged in Accueil, Bibliothèques and Recherche through
// core's Servers, as on the TV (tv/ui/ServersUi.kt). Core.api stays the primary server.

// Every signed-in server's libraries, the primary's first.
suspend fun allViews(api: Api): List<Item> {
    val others = Servers.online.filter { it.server.id != api.server.id }
    return api.views() + Servers.fanOut(others) { it.views() }.flatMap { it.orEmpty() }
}

// Every signed-in account from the saved prefs, also before WicabyRoot has set Core.api and Servers.extra
// (network callback in the background, an activity recreated after process death).
suspend fun savedApis(): List<Api> {
    val s = Core.prefs.current()
    return (listOfNotNull(s.session) + s.extras).distinctBy { it.server.id }
        .map { a -> Servers.of(a.server.id)?.takeIf { it.userId == a.userId } ?: Api.of(a.server, s.deviceId, a.token, a.userId) }
}

suspend fun savedApi(serverId: String): Api? = savedApis().firstOrNull { it.server.id == serverId }

// Two servers with a "Films" library: each one names its server.
fun viewLabel(v: Item, views: List<Item>): String =
    if (views.any { it.name == v.name && it.serverId != v.serverId }) "${v.name} · ${Servers.of(v.serverId)?.server?.name ?: v.serverId}" else v.name

// Réglages > Autres serveurs: the extra accounts (a tap offers to remove one) and "Ajouter un serveur".
@Composable
fun OtherServers(snap: Snapshot) {
    val scope = rememberCoroutineScope()
    var removing by remember { mutableStateOf<Session?>(null) }
    Eyebrow(stringResource(R.string.other_servers))
    Group {
        snap.extras.filter { it.server.id != snap.session?.server?.id }.forEach { e ->
            GroupRow(e.server.name, { removing = e }, subtitle = "${e.userName} · ${e.server.address}", icon = Ic.Server, chevron = false)
            GroupDivider()
        }
        GroupRow(stringResource(R.string.add_server), { SetupRequest.addServer = true }, icon = Ic.Plus)
    }
    Text(stringResource(R.string.other_servers_hint), style = Type.footnote, color = G.label2, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp))
    removing?.let { e ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text(e.server.name) },
            text = { Text(e.server.address) },
            confirmButton = {
                TextButton({
                    removing = null
                    // Not revoked on the server: the token may serve elsewhere. The rows reload (WicabyRoot).
                    scope.launch { Core.prefs.removeAccount(e.server.id) }
                }) { Text(stringResource(R.string.remove_server), color = G.red) }
            },
            dismissButton = { TextButton({ removing = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

// The servers this device is signed in to (the wizard's "Vos serveurs" and its last step).
@Composable
fun ServersSummary(snap: Snapshot) {
    val all = listOfNotNull(snap.session) + snap.extras.filter { it.server.id != snap.session?.server?.id }
    if (all.isEmpty()) {
        Text(stringResource(com.wika.wicaby.core.R.string.onboarding_done_none), style = Type.body, color = G.label2, modifier = Modifier.padding(16.dp))
        return
    }
    Group {
        all.forEachIndexed { i, s ->
            if (i > 0) GroupDivider()
            GroupRow(s.server.name, null, subtitle = "${s.userName} · ${s.server.address}", icon = Ic.Server, trailing = s.server.kind.replaceFirstChar { it.uppercase() })
        }
    }
}

// Server is @Serializable: saved across a recreation as JSON.
val ServerSaver = Saver<Server?, String>(
    save = { it?.let { s -> Json.encodeToString(Server.serializer(), s) } },
    restore = { runCatching { Json.decodeFromString(Server.serializer(), it) }.getOrNull() },
)

// Réglages > Autres serveurs > Ajouter un serveur, or "Ajouter" on a mesh peer (SetupRequest.addTarget):
// pick a server, sign in, back to Réglages. The primary server and session stay as they are.
@Composable
fun AddServerFlow(snap: Snapshot) {
    var picked by rememberSaveable(stateSaver = ServerSaver) { mutableStateOf(SetupRequest.addTarget) }
    fun done() {
        SetupRequest.addServer = false
        SetupRequest.addTarget = null
        SetupRequest.returnTo = Tab.Settings
    }
    BackHandler { if (picked != null && SetupRequest.addTarget == null) picked = null else done() }
    val p = picked
    if (p != null) {
        LoginScreen(p, snap.deviceId, add = true, title = stringResource(com.wika.wicaby.core.R.string.onboarding_signin_title, p.name), onSignedIn = ::done)
        return
    }
    Column(Modifier.fillMaxSize().background(G.bg).imeAware()) {
        TopBar(stringResource(R.string.add_server), ::done)
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(horizontal = 20.dp).padding(bottom = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Column(Modifier.widthIn(max = 520.dp)) {
                Text(stringResource(R.string.other_servers_hint), style = Type.body, color = G.label2, modifier = Modifier.padding(top = 8.dp))
                ServerPanel(snap, add = true, onPlexLinked = ::done) { picked = it }
            }
        }
    }
}

// The eight accent swatches (Réglages and the wizard's second step).
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AccentPicker(selected: Int, onPick: (Int) -> Unit) {
    FlowRow(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Accents.forEachIndexed { i, c ->
            val name = stringResource(AccentNames[i])
            Box(
                Modifier.size(32.dp).clip(CircleShape).background(c)
                    .semantics { contentDescription = name }
                    .selectable(i == selected, role = Role.RadioButton) { onPick(i) },
                contentAlignment = Alignment.Center,
            ) {
                if (i == selected) Icon(Ic.Check, null, tint = onAccent(c), modifier = Modifier.size(18.dp))
            }
        }
    }
}

// Remote access state names (onboarding spec section 3.1).
@Composable
fun meshStateLabel(state: MeshState): String = stringResource(
    when (state) {
        MeshState.Connected -> MeshR.string.mesh_state_connected
        MeshState.NeedsLogin -> MeshR.string.mesh_state_needs_login
        MeshState.Connecting -> MeshR.string.mesh_state_connecting
        MeshState.Stopped -> MeshR.string.mesh_state_off
        MeshState.Error -> MeshR.string.mesh_state_error
        MeshState.Unsupported -> MeshR.string.mesh_unsupported
    },
)

// "NetBird · Connecté", or just the state while no provider runs.
@Composable
fun meshLine(s: MeshStatus): String = listOfNotNull(s.provider?.label, meshStateLabel(s.state)).joinToString(" · ")

@Composable
fun StateDot(state: MeshState, modifier: Modifier = Modifier) {
    val color = when (state) {
        MeshState.Connected -> androidx.compose.ui.graphics.Color(0xFF30D158)
        MeshState.NeedsLogin, MeshState.Connecting -> androidx.compose.ui.graphics.Color(0xFFFF9F0A)
        MeshState.Error -> G.red
        else -> G.label3
    }
    Box(modifier.padding(start = 8.dp).size(8.dp).clip(CircleShape).background(color))
}
