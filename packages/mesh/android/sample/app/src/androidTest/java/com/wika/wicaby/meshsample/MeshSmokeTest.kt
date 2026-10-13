package com.wika.wicaby.meshsample

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.wika.wicaby.core.mesh.MeshProvider
import com.wika.wicaby.core.mesh.MeshState
import com.wika.wicaby.core.mesh.MeshStatus
import com.wika.wicaby.core.mesh.MeshTransport
import com.wika.wicaby.mesh.mobile.Mobile
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

// Brings the real node up as far as the sign-in step and stops there: no login is ever
// completed, no account is touched. Destinations are fake/local, nothing is fetched.
@RunWith(AndroidJUnit4::class)
class MeshSmokeTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext

    // Not mesh peers: the emulator host, a 100.x address nobody owns here, the internet.
    private val outsiders = listOf("http://10.0.2.2:8104", "http://100.100.100.100:80", "https://example.com:443")

    private fun awaitSignIn(mesh: MeshTransport): MeshStatus = runBlocking {
        withTimeout(120_000) { mesh.status.first { it.authUrl != null || it.state == MeshState.Error } }
    }

    private fun checkRefusals(mesh: MeshTransport) {
        for (o in outsiders) {
            val e = runCatching { Mobile.forward(o) }.exceptionOrNull()
            assertNotNull("forwarder opened for $o", e)
            assertTrue(e!!.message, e.message!!.contains("not a peer"))
            assertNull(mesh.forward(o))
        }
    }

    private fun stop(mesh: MeshTransport) = runBlocking {
        mesh.disconnect()
        withTimeout(30_000) { mesh.status.first { it.state == MeshState.Stopped } }
    }

    @Test
    fun tailscaleOffersSignInAndRefusesOutsiders() {
        File(ctx.filesDir, "mesh").deleteRecursively()
        val mesh = MeshTransport(ctx, "wicaby smoke test")
        assertNull(mesh.forward("http://100.100.100.100:80")) // not running: direct
        mesh.login(MeshProvider.Tailscale)
        val s = awaitSignIn(mesh)
        Log.i(TAG, "tailscale: state=${s.state} authUrl=${s.authUrl} error=${s.error}")
        assertEquals(MeshState.NeedsLogin, s.state)
        assertTrue(s.authUrl!!, s.authUrl!!.startsWith("https://login.tailscale.com/"))
        checkRefusals(mesh)
        stop(mesh)
        assertTrue(File(ctx.filesDir, "mesh/tailscale").isDirectory)
    }

    @Test
    fun netbirdOffersDeviceCode() {
        File(ctx.filesDir, "mesh").deleteRecursively()
        val mesh = MeshTransport(ctx, "wicaby smoke test")
        mesh.login(MeshProvider.NetBird)
        val s = awaitSignIn(mesh)
        Log.i(TAG, "netbird: state=${s.state} authUrl=${s.authUrl} userCode=${s.userCode} error=${s.error}")
        assertEquals(MeshState.NeedsLogin, s.state)
        assertNotNull(s.userCode)
        checkRefusals(mesh)
        stop(mesh)
    }

    @Test
    fun netbirdRejectsABadSetupKey() {
        File(ctx.filesDir, "mesh").deleteRecursively()
        val mesh = MeshTransport(ctx, "wicaby smoke test")
        // A well-formed key that cannot exist: management refuses it before any peer is created.
        mesh.login(MeshProvider.NetBird, authKey = "00000000-0000-0000-0000-000000000000")
        val s = runBlocking { withTimeout(120_000) { mesh.status.first { it.state == MeshState.Error || it.state == MeshState.Connected } } }
        Log.i(TAG, "netbird bad key: state=${s.state} error=${s.error}")
        assertEquals(MeshState.Error, s.state)
        stop(mesh)
    }

    private companion object {
        const val TAG = "MeshSmoke"
    }
}
