package com.wika.wicaby.mobile.ui

import android.app.Application
import android.content.ClipboardManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.mesh.MeshError
import com.wika.wicaby.core.mesh.MeshPeer
import com.wika.wicaby.core.mesh.MeshProvider
import com.wika.wicaby.core.mesh.MeshState
import com.wika.wicaby.core.mesh.MeshStatus
import com.wika.wicaby.core.mesh.PeerServer
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.meshui.R as MeshR

// OB-M2 acceptance: the state matrix, every peer with its OS and server badge, routes, redacted diagnostics.
// Run in fr and en (subclasses below).
abstract class RemoteAccessScreenTest {
    @get:Rule val rule = createComposeRule()
    private val app: Application get() = RuntimeEnvironment.getApplication()
    private fun text(id: Int, vararg args: Any) = app.getString(id, *args)

    // Mesh addresses (100.64/10) and documentation ranges only.
    private val peers = (1..10).map { MeshPeer("peer$it", "peer$it.example.ts.net", listOf("100.64.0.${it + 1}"), online = it % 3 != 0, os = "linux") }
    private val connected = MeshStatus(
        state = MeshState.Connected, provider = MeshProvider.NetBird, selfName = "phone", selfDnsName = "phone.example.ts.net",
        ips = listOf("100.64.0.1"), peers = peers, routes = listOf("192.0.2.0/24"),
        lastError = MeshError("management 192.0.2.7: 401 Unauthorized", 0),
    )
    private val nas = Server("srv", "NAS", "http://100.64.0.2:8096", "emby")
    private val controls = MeshControls({}, {}, {}, { _, _ -> }, find = { list -> listOf(PeerServer(list.first(), nas)) })

    private fun show(status: () -> MeshStatus) = rule.setContent {
        WicabyTheme(Accents[0]) {
            RemoteAccessContent(status(), MeshProvider.NetBird, null, emptySet(), controls, onBack = {}, signIn = {}, onAdd = {})
        }
    }

    @Test
    fun everyStateRendersItsLabel() {
        var status by mutableStateOf(MeshStatus())
        show { status }
        val labels = mapOf(
            MeshState.Connected to MeshR.string.mesh_state_connected,
            MeshState.NeedsLogin to MeshR.string.mesh_state_needs_login,
            MeshState.Connecting to MeshR.string.mesh_state_connecting,
            MeshState.Stopped to MeshR.string.mesh_state_off,
            MeshState.Error to MeshR.string.mesh_state_error,
            MeshState.Unsupported to MeshR.string.mesh_unsupported,
        )
        for ((state, label) in labels) {
            status = if (state == MeshState.Connected) connected else MeshStatus(state = state, provider = MeshProvider.Tailscale.takeIf { state != MeshState.Stopped })
            rule.waitForIdle()
            rule.onNodeWithText(text(label)).assertExists()
        }
    }

    @Test
    fun listsEveryPeerWithOsRoutesAndServerBadge() {
        show { connected }
        rule.onNodeWithText(text(MeshR.string.mesh_peers_title, 10).uppercase()).assertExists()
        peers.forEach { rule.onNodeWithText(it.name).assertExists() }
        rule.onNodeWithText("100.64.0.4 · Linux · ${text(MeshR.string.mesh_peer_offline)}").assertExists()
        rule.onNodeWithText("192.0.2.0/24").assertExists()
        rule.onNodeWithText(text(CoreR.string.onboarding_find_servers)).performScrollTo().performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Emby · NAS").assertExists()
        rule.onNodeWithText(text(MeshR.string.mesh_add_server)).assertExists()
    }

    @Test
    fun copyDiagnosticsPutsRedactedTextOnTheClipboard() {
        show { connected }
        rule.onNodeWithText(text(MeshR.string.mesh_diag_copy)).performScrollTo().performClick()
        rule.waitForIdle()
        val clip = app.getSystemService(ClipboardManager::class.java).primaryClip!!.getItemAt(0).text.toString()
        assertTrue(clip, clip.contains("state: connected"))
        assertTrue(clip, clip.contains("100.*.*.*"))
        assertFalse(clip, Regex("""\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b""").containsMatchIn(clip))
        assertFalse(clip, clip.contains("peer2") || clip.contains("phone") || clip.contains("ts.net"))
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "fr")
class RemoteAccessScreenFrTest : RemoteAccessScreenTest()

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "en")
class RemoteAccessScreenEnTest : RemoteAccessScreenTest()
