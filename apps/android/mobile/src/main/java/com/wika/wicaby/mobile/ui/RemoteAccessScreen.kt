package com.wika.wicaby.mobile.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.mesh.MeshPeer
import com.wika.wicaby.core.mesh.MeshProvider
import com.wika.wicaby.core.mesh.MeshServers
import com.wika.wicaby.core.mesh.MeshState
import com.wika.wicaby.core.mesh.MeshStatus
import com.wika.wicaby.core.mesh.PeerServer
import com.wika.wicaby.core.mesh.meshReport
import com.wika.wicaby.meshui.R as MeshR
import com.wika.wicaby.mobile.BuildConfig
import com.wika.wicaby.mobile.R
import kotlinx.coroutines.launch
import com.wika.wicaby.core.R as CoreR

// OB-M2: Réglages > Accès à distance (onboarding spec sections 3.1 and 3.4). Signed out or signing in,
// the shared mesh panel; connected: this device, every peer, routes, advanced and diagnostics.

// What the screen asks of the mesh; [RemoteAccessScreen] binds it to Core.mesh, tests to a fake.
class MeshControls(
    val turnOff: () -> Unit,
    val signOut: () -> Unit,
    val switchTo: (MeshProvider) -> Unit,
    val reconnect: (managementUrl: String?, key: String?) -> Unit,
    val find: suspend (List<MeshPeer>) -> List<PeerServer>,
)

@Composable
fun RemoteAccessScreen(onBack: () -> Unit) {
    val mesh = Core.mesh
    val status by mesh.status.collectAsState()
    val snap = LocalSnapshot.current
    val controls = remember {
        MeshControls(
            turnOff = mesh::disconnect,
            signOut = mesh::logout,
            // One button, two existing calls: leave this network, join the other one.
            switchTo = { p -> mesh.logout(); mesh.login(p) },
            reconnect = { url, key -> mesh.logout(); mesh.login(mesh.provider, url, key) },
            find = { MeshServers.find(it) },
        )
    }
    val saved = (listOfNotNull(snap.server) + snap.extras.map { it.server }).map { it.id }.toSet()
    RemoteAccessContent(status, mesh.provider, mesh.managementUrl, saved, controls, onBack, signIn = { RemoteAccessSection() }) { server ->
        SetupRequest.addTarget = server
        SetupRequest.addServer = true
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RemoteAccessContent(
    status: MeshStatus,
    provider: MeshProvider,
    managementUrl: String?,
    saved: Set<String>,
    controls: MeshControls,
    onBack: () -> Unit,
    signIn: @Composable () -> Unit,
    onAdd: (Server) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var found by remember { mutableStateOf<List<PeerServer>?>(null) }
    var finding by remember { mutableStateOf(false) }
    var switching by remember { mutableStateOf<MeshProvider?>(null) }
    var advanced by remember { mutableStateOf(false) }
    val connected = status.state == MeshState.Connected
    // Redacted by core (onboarding spec 3.5), the same text the TV shows as a QR code.
    fun report() = meshReport(status, provider, managementUrl, "Wicaby ${BuildConfig.VERSION_NAME} (mobile, Android ${Build.VERSION.RELEASE})", servers = found?.size)
    Column(Modifier.fillMaxSize().background(G.bg).imeAware()) {
        TopBar(stringResource(MeshR.string.mesh_title), onBack)
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(horizontal = 20.dp).padding(bottom = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Column(Modifier.widthIn(max = 640.dp).fillMaxWidth()) {
                Eyebrow(stringResource(MeshR.string.mesh_status_title))
                Group {
                    val via = managementUrl?.let { runCatching { it.toUri().host }.getOrNull() ?: it } ?: stringResource(MeshR.string.mesh_hosted)
                    GroupRow(status.provider?.let { stringResource(MeshR.string.mesh_built_in, it.label) } ?: stringResource(MeshR.string.mesh_title), null, subtitle = via.takeIf { status.provider != null }, trailing = meshStateLabel(status.state), chevron = false) {
                        StateDot(status.state)
                    }
                    if (connected) {
                        GroupDivider()
                        FlowRow(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            PillButton(stringResource(MeshR.string.mesh_disconnect), controls.turnOff, compact = true)
                            PillButton(stringResource(MeshR.string.mesh_logout), controls.signOut, compact = true)
                            val other = MeshProvider.entries.first { it != status.provider }
                            PillButton(stringResource(MeshR.string.mesh_switch, other.label), { switching = other }, compact = true)
                        }
                    }
                }
                if (!connected) signIn()
                else {
                    Eyebrow(stringResource(MeshR.string.mesh_device_title))
                    Group {
                        GroupRow(stringResource(MeshR.string.mesh_device_name), null, trailing = status.selfDnsName ?: status.selfName ?: "–")
                        GroupDivider()
                        GroupRow(stringResource(MeshR.string.mesh_device_address), null, trailing = status.ips.joinToString(", ").ifEmpty { "–" })
                    }

                    val peers = status.peers.sortedByDescending { it.online }
                    Eyebrow(stringResource(MeshR.string.mesh_peers_title, peers.size))
                    Group {
                        GroupRow(stringResource(CoreR.string.onboarding_find_servers), {
                            if (!finding) scope.launch {
                                finding = true
                                found = runCatching { controls.find(status.peers) }.getOrDefault(emptyList())
                                finding = false
                            }
                        }, icon = Ic.Search, chevron = false) { if (finding) Spinner(Modifier.size(16.dp), G.label3) }
                        peers.forEach { peer ->
                            GroupDivider()
                            val hit = found?.firstOrNull { it.peer == peer }
                            val line = listOfNotNull(peer.ips.firstOrNull(), peer.os?.replaceFirstChar { it.uppercase() }, stringResource(MeshR.string.mesh_peer_offline).takeIf { !peer.online })
                            GroupRow(
                                peer.name, null, subtitle = line.joinToString(" · "), icon = Ic.Server,
                                titleColor = if (peer.online) G.label else G.label3,
                                trailing = hit?.let { "${it.server.kind.replaceFirstChar { c -> c.uppercase() }} · ${it.server.name}" },
                            ) {
                                if (hit != null && hit.server.id !in saved) PillButton(stringResource(MeshR.string.mesh_add_server), { onAdd(hit.server) }, Modifier.padding(start = 8.dp), compact = true)
                            }
                        }
                    }

                    if (status.routes.isNotEmpty()) {
                        Eyebrow(stringResource(MeshR.string.mesh_routes_title))
                        Group {
                            status.routes.forEachIndexed { i, r ->
                                if (i > 0) GroupDivider()
                                GroupRow(r, null)
                            }
                        }
                    }

                    // The panel shows these fields while signed out; here they reconnect a running node.
                    Eyebrow(stringResource(MeshR.string.mesh_advanced))
                    Group {
                        GroupRow(stringResource(MeshR.string.mesh_management), { advanced = !advanced }, subtitle = managementUrl ?: stringResource(MeshR.string.mesh_hosted), chevron = false, trailing = stringResource(MeshR.string.mesh_change))
                        if (advanced) {
                            var url by remember { mutableStateOf(managementUrl.orEmpty()) }
                            var key by remember { mutableStateOf("") }
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                WicabyField(url, { url = it }, stringResource(MeshR.string.mesh_server_hint), keyboardType = androidx.compose.ui.text.input.KeyboardType.Uri)
                                WicabyField(key, { key = it }, stringResource(MeshR.string.mesh_key_hint), password = true)
                                Text(stringResource(MeshR.string.mesh_advanced_note), style = Type.footnote, color = G.label2)
                                PillButton(stringResource(MeshR.string.mesh_save), {
                                    advanced = false
                                    controls.reconnect(url.trim().ifEmpty { null }, key.trim().ifEmpty { null })
                                }, primary = true, compact = true)
                            }
                        }
                    }
                }

                Eyebrow(stringResource(MeshR.string.mesh_diag_title))
                Group {
                    val last = status.lastError
                    GroupRow(
                        if (last != null) stringResource(MeshR.string.mesh_diag_last_error, last.message) else stringResource(MeshR.string.mesh_diag_none), null,
                        subtitle = last?.let { java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT).format(java.util.Date(it.at)) },
                    )
                    GroupDivider()
                    GroupRow(stringResource(MeshR.string.mesh_diag_copy), { copyDiagnostics(context, report()) }, chevron = false)
                    GroupDivider()
                    GroupRow(stringResource(MeshR.string.mesh_diag_share), { shareDiagnostics(context, report()) }, icon = Ic.External, chevron = false)
                }
            }
        }
    }
    switching?.let { p ->
        AlertDialog(
            onDismissRequest = { switching = null },
            title = { Text(stringResource(MeshR.string.mesh_switch, p.label)) },
            text = { Text(stringResource(MeshR.string.mesh_switch_body, status.provider?.label.orEmpty())) },
            confirmButton = { TextButton({ switching = null; controls.switchTo(p) }) { Text(stringResource(R.string.wizard_continue)) } },
            dismissButton = { TextButton({ switching = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

fun copyDiagnostics(context: Context, text: String) {
    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Wicaby", text))
    Toast.makeText(context, MeshR.string.mesh_diag_copied, Toast.LENGTH_SHORT).show()
}

private fun shareDiagnostics(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
    runCatching { context.startActivity(Intent.createChooser(send, null)) }
}
