package com.wika.wicaby.tv.ui

import android.os.Build
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.mesh.MeshPeer
import com.wika.wicaby.core.mesh.MeshProvider
import com.wika.wicaby.core.mesh.MeshServers
import com.wika.wicaby.core.mesh.MeshState
import com.wika.wicaby.core.mesh.MeshStatus
import com.wika.wicaby.core.mesh.PeerServer
import com.wika.wicaby.core.mesh.fitQr
import com.wika.wicaby.core.mesh.meshReport
import com.wika.wicaby.meshui.QrCode
import com.wika.wicaby.meshui.R as MeshR
import com.wika.wicaby.tv.BuildConfig
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.LocalSnapshot
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.Route
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

// Réglages > Accès à distance (onboarding spec 3.3, OB-T2): status and its actions, this device, every peer
// (servers found on request), routed networks, the management server, and diagnostics as text and a QR code.
// Signed out or signing in, the usual panel (Join buttons, QR sign-in) sits under the status.

// The node's actions; RemoteSection maps them to Core.mesh, tests to fakes.
internal class MeshControls(
    val turnOff: () -> Unit,
    val signOut: () -> Unit,
    val retry: () -> Unit,
    val switchTo: (MeshProvider) -> Unit,
    val reconnect: (managementUrl: String?, key: String?) -> Unit,
)

@Composable
fun RemoteSection() {
    val mesh = Core.mesh
    val status by mesh.status.collectAsState()
    val nav = LocalNav.current
    val snap = LocalSnapshot.current
    val context = LocalContext.current
    val isMain = stringResource(R.string.server_is_main)
    val provider = status.provider ?: mesh.provider
    RemoteContent(
        status, provider, mesh.managementUrl,
        MeshControls(
            turnOff = mesh::disconnect,
            signOut = mesh::logout,
            retry = { mesh.login(provider, mesh.managementUrl) },
            // One button, the two existing calls: leave this network, join the other one.
            switchTo = { mesh.logout(); mesh.login(it) },
            reconnect = { url, key -> mesh.logout(); mesh.login(provider, url, key) },
        ),
        // TP-06: an extra account, signed in like any added server.
        onAdd = { s -> if (s.id == snap.server?.id) Toast.makeText(context, isMain, Toast.LENGTH_SHORT).show() else nav.push(Route.Login(s, add = true)) },
        panel = { RemoteAccessSection() },
    )
}

@Composable
internal fun meshStateLabel(state: MeshState): String = stringResource(
    when (state) {
        MeshState.Connected -> MeshR.string.mesh_state_connected
        MeshState.NeedsLogin -> MeshR.string.mesh_state_needs_login
        MeshState.Connecting -> MeshR.string.mesh_state_connecting
        MeshState.Error -> MeshR.string.mesh_state_error
        MeshState.Stopped, MeshState.Unsupported -> MeshR.string.mesh_state_off
    },
)

@Composable
internal fun RemoteContent(
    status: MeshStatus,
    provider: MeshProvider,
    managementUrl: String?,
    controls: MeshControls,
    onAdd: (Server) -> Unit,
    panel: @Composable () -> Unit,
    find: suspend (List<MeshPeer>) -> List<PeerServer> = { MeshServers.find(it) },
) {
    val overlay = LocalOverlay.current
    val scope = rememberCoroutineScope()
    var found by remember { mutableStateOf<List<PeerServer>?>(null) }
    var finding by remember { mutableStateOf(false) }
    if (status.state == MeshState.Unsupported) return panel()
    val live = status.state == MeshState.Connected || status.state == MeshState.Error

    Group(stringResource(MeshR.string.mesh_status_title), status.error?.takeIf { status.state == MeshState.Error }) {
        val me = remember { FocusRequester() }
        val other = MeshProvider.entries.first { it != provider }
        val switchLabel = stringResource(MeshR.string.mesh_switch, other.label)
        val switchBody = stringResource(MeshR.string.mesh_switch_body, provider.label)
        val turnOff = stringResource(MeshR.string.mesh_disconnect)
        val signOut = stringResource(MeshR.string.mesh_logout)
        val retry = stringResource(MeshR.string.mesh_retry)
        val cancel = stringResource(R.string.cancel)
        val title = stringResource(MeshR.string.mesh_built_in, provider.label)
        fun confirmSwitch() = overlay.show(me) {
            TvAlert(switchLabel, switchBody, listOf(AlertAction(switchLabel) { overlay.close(); controls.switchTo(other) }, AlertAction(cancel) { overlay.close() }), focusIndex = 1, onDismiss = overlay::close)
        }
        val actions = when (status.state) {
            MeshState.Connected -> listOf(AlertAction(turnOff) { overlay.close(); controls.turnOff() }, AlertAction(signOut, destructive = true) { overlay.close(); controls.signOut() }, AlertAction(switchLabel) { overlay.close(); confirmSwitch() })
            MeshState.Error -> listOf(AlertAction(retry) { overlay.close(); controls.retry() }, AlertAction(turnOff) { overlay.close(); controls.turnOff() }, AlertAction(signOut, destructive = true) { overlay.close(); controls.signOut() })
            MeshState.Connecting, MeshState.NeedsLogin -> listOf(AlertAction(turnOff) { overlay.close(); controls.turnOff() })
            else -> emptyList()
        }
        SettingRow(title, meshStateLabel(status.state), Modifier.focusRequester(me).testTag("mesh-status"), chevron = actions.isNotEmpty(), onClick = {
            if (actions.isNotEmpty()) overlay.show(me) { TvAlert(title, null, actions, focusIndex = 0, onDismiss = overlay::close) }
        })
    }
    // Off or signing in: the existing panel, so the QR sign-in is unchanged.
    if (!live) Column(Modifier.padding(start = 18.dp, bottom = 26.dp)) { panel() }

    if (live) {
        Group(stringResource(MeshR.string.mesh_device_title)) {
            SettingRow(stringResource(MeshR.string.mesh_device_name), status.selfDnsName ?: status.selfName ?: "—", mono = true)
            SettingRow(stringResource(MeshR.string.mesh_device_address), status.ips.joinToString(", ").ifEmpty { "—" }, mono = true)
        }
        Group(stringResource(MeshR.string.mesh_peers_title, status.peers.size), stringResource(MeshR.string.mesh_scope_note)) {
            SettingRow(stringResource(CoreR.string.onboarding_find_servers), if (finding) stringResource(R.string.loading) else null, Modifier.testTag("find"), onClick = {
                if (finding) return@SettingRow
                scope.launch {
                    finding = true
                    found = runCatching { find(status.peers) }.getOrDefault(emptyList())
                    finding = false
                }
            })
            val offline = stringResource(MeshR.string.mesh_peer_offline)
            val none = stringResource(CoreR.string.onboarding_peer_no_server)
            // Every peer, online first.
            status.peers.sortedByDescending { it.online }.forEach { p ->
                val server = found?.firstOrNull { it.peer == p }?.server
                val badge = when {
                    !p.online -> offline
                    server != null -> "${server.kind.replaceFirstChar { it.uppercase() }} · ${server.name}"
                    found != null -> none
                    else -> null
                }
                SettingRow(
                    p.name.ifEmpty { p.dnsName.orEmpty() }, listOfNotNull(p.ips.firstOrNull(), p.os?.takeIf { it.isNotBlank() }, badge).joinToString(" · "),
                    chevron = server != null, onClick = { server?.let(onAdd) },
                )
            }
        }
        if (status.routes.isNotEmpty()) Group(stringResource(MeshR.string.mesh_routes_title)) {
            status.routes.forEach { SettingRow(it) }
        }
        Group(stringResource(MeshR.string.mesh_advanced), stringResource(MeshR.string.mesh_advanced_note)) {
            val me = remember { FocusRequester() }
            SettingRow(stringResource(MeshR.string.mesh_management), managementUrl ?: stringResource(MeshR.string.mesh_hosted), Modifier.focusRequester(me), chevron = true, onClick = {
                overlay.show(me) { ManagementSheet(managementUrl, onSave = { url, key -> overlay.close(); controls.reconnect(url, key) }, onDismiss = overlay::close) }
            })
        }
    }

    val last = status.lastError
    val lastText = last?.let {
        stringResource(MeshR.string.mesh_diag_last_error, it.message) + " · " + DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT, uiLocale()).format(Date(it.at))
    } ?: stringResource(MeshR.string.mesh_diag_none)
    Group(stringResource(MeshR.string.mesh_diag_title), lastText) {
        val me = remember { FocusRequester() }
        SettingRow(stringResource(MeshR.string.mesh_diag_show), modifier = Modifier.focusRequester(me).testTag("diag"), chevron = true, onClick = {
            val app = "Wicaby ${BuildConfig.VERSION_NAME} (tv, Android ${Build.VERSION.RELEASE})"
            val text = meshReport(status, provider, managementUrl, app, servers = found?.size)
            overlay.show(me) { DiagnosticsSheet(text, overlay::close) }
        })
    }
}

// The redacted text, and the same text as a QR code: a phone camera copies it from across the room.
@Composable
private fun DiagnosticsSheet(text: String, onDismiss: () -> Unit) {
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        delay(60)
        runCatching { first.requestFocus() }
    }
    TvSheet(onDismiss, width = 920.dp) {
        Text(stringResource(MeshR.string.mesh_diag_title), style = Type.title2, color = C.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(bottom = 18.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.Top) {
            Text(text, style = Type.mono, color = C.label2, modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()).testTag("diag-text"))
            QrCode(fitQr(text), Modifier.size(280.dp))
        }
        Text(stringResource(MeshR.string.mesh_diag_scan), style = Type.footnote, color = C.label3, modifier = Modifier.padding(top = 14.dp))
        SheetButton(stringResource(CoreR.string.close), onClick = onDismiss, modifier = Modifier.padding(top = 18.dp).focusRequester(first))
    }
}

// A new management server (Headscale, self-hosted NetBird) signs this device in afresh: logout, then login.
@Composable
private fun ManagementSheet(current: String?, onSave: (String?, String?) -> Unit, onDismiss: () -> Unit) {
    var url by remember { mutableStateOf(current.orEmpty()) }
    var key by remember { mutableStateOf("") }
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    TvSheet(onDismiss, width = 560.dp) {
        Text(stringResource(MeshR.string.mesh_management), style = Type.title3, color = C.label, modifier = Modifier.padding(bottom = 18.dp))
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            TvTextField(url, { url = it }, stringResource(MeshR.string.mesh_server_hint), Modifier.fillMaxWidth().focusRequester(first), imeAction = androidx.compose.ui.text.input.ImeAction.Next)
            TvTextField(key, { key = it }, stringResource(MeshR.string.mesh_key_hint), Modifier.fillMaxWidth(), password = true)
            Text(stringResource(MeshR.string.mesh_advanced_note), style = Type.footnote, color = C.label3, modifier = Modifier.padding(start = 4.dp))
            SheetButton(stringResource(MeshR.string.mesh_save), onClick = { onSave(url.trim().ifEmpty { null }, key.trim().ifEmpty { null }) }, modifier = Modifier.padding(top = 8.dp))
        }
    }
}
