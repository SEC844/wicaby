package com.wika.wicaby.tv.ui

import android.app.Application
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.mesh.MeshError
import com.wika.wicaby.core.mesh.MeshPeer
import com.wika.wicaby.core.mesh.MeshProvider
import com.wika.wicaby.core.mesh.MeshState
import com.wika.wicaby.core.mesh.MeshStatus
import com.wika.wicaby.core.mesh.PeerServer
import com.wika.wicaby.core.mesh.fitQr
import com.wika.wicaby.core.mesh.meshReport
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// OB-T2: Réglages > Accès à distance against a fake status flow (documentation addresses and names only).
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "en-w960dp-h540dp-land-mdpi")
class RemoteSettingsTest {
    @get:Rule
    val rule = createComposeRule()

    private val nas = MeshPeer("nas", "nas.example.ts.net", listOf("192.0.2.4"), online = true, os = "linux")
    private val laptop = MeshPeer("laptop", null, listOf("192.0.2.9"), online = true, os = "windows")
    private val phone = MeshPeer("phone", null, listOf("192.0.2.12"), online = false, os = "android")
    private val connected = MeshStatus(
        MeshState.Connected, MeshProvider.NetBird, selfName = "wicaby-tv", selfDnsName = "wicaby-tv.example.netbird.cloud",
        ips = listOf("192.0.2.2"), peers = listOf(phone, laptop, nas), routes = listOf("198.51.100.0/24"),
    )
    private val controls = MeshControls({}, {}, {}, {}, { _, _ -> })
    private val flow = MutableStateFlow(MeshStatus())

    private fun show() = rule.setContent {
        val status by flow.collectAsState()
        // As in Réglages: one scrolling column.
        Column(Modifier.verticalScroll(rememberScrollState())) {
            RemoteContent(
                status, MeshProvider.NetBird, null, controls, onAdd = {}, panel = {},
                find = { peers -> peers.filter { it == nas }.map { PeerServer(it, Server("s1", "Living room", "http://192.0.2.4:8096", "emby")) } },
            )
        }
    }

    @Test
    fun eachStateShowsItsLabel() {
        show()
        for ((state, label) in listOf(
            MeshState.Connected to "Connected", MeshState.NeedsLogin to "Sign-In Required", MeshState.Connecting to "Connecting…",
            MeshState.Stopped to "Off", MeshState.Error to "Error",
        )) {
            flow.value = MeshStatus(state, MeshProvider.NetBird, error = "management: 401".takeIf { state == MeshState.Error })
            rule.waitForIdle()
            rule.onNodeWithText(label).assertExists()
        }
    }

    @Test
    fun everyPeerWithItsOsAndTheServerBadgeOnceSearched() {
        flow.value = connected
        show()
        rule.onNodeWithText("Devices on Your Network (3)").assertExists()
        rule.onNodeWithText("192.0.2.12 · android · Offline").assertExists()
        rule.onNodeWithText("192.0.2.9 · windows").assertExists()
        // Never probed on open: only after Find Servers.
        rule.onNodeWithText("192.0.2.4 · linux").assertExists()
        rule.onNodeWithTag("find").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("192.0.2.4 · linux · Emby · Living room").assertExists()
        rule.onNodeWithText("192.0.2.9 · windows · No server on ports 8096 and 8920").assertExists()
    }

    @Test
    fun routesShowWhenThereAreSome() {
        flow.value = connected
        show()
        rule.onNodeWithText("Routed Networks").assertExists()
        rule.onNodeWithText("198.51.100.0/24").assertExists()
        flow.value = connected.copy(routes = emptyList())
        rule.waitForIdle()
        rule.onNodeWithText("Routed Networks").assertDoesNotExist()
    }

    @Test
    fun diagnosticsCarryNoRawAddressNameOrKey() {
        val status = connected.copy(state = MeshState.Error, lastError = MeshError("dial 192.0.2.7:443 for tskey-abc123-XYZ: refused", 0))
        val text = meshReport(status, MeshProvider.NetBird, "https://netbird.example.com/api", "Wicaby 1.0 (tv, Android 14)", now = 0, servers = 1)
        for (raw in listOf("192.0.2.2", "192.0.2.4", "198.51.100.0", "192.0.2.7", "tskey-abc123", "wicaby-tv", "nas", "netbird.example.com")) {
            assertFalse("$raw in\n$text", raw in text)
        }
        assertTrue(text, "peers: 3 (2 online, 1 with a media server)" in text)
        assertTrue(text, "routes: 198.51.*.*/24" in text)
        assertTrue(text, "management: https://<host>/***" in text)
        // The QR code keeps whole lines within its budget.
        val long = (1..400).joinToString("\n") { "line $it" }
        assertTrue(fitQr(long).encodeToByteArray().size <= 1800)
        assertEquals(text, fitQr(text))
    }
}
