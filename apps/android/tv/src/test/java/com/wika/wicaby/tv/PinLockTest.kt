package com.wika.wicaby.tv

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateListOf
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Profile
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.Session
import com.wika.wicaby.core.data.SessionGate
import com.wika.wicaby.core.data.Snapshot
import com.wika.wicaby.core.net.ServerTransport
import com.wika.wicaby.core.player.RemotePlay
import com.wika.wicaby.tv.player.PlayerActivity
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest

// TP-10: while "Who is watching?" is up nothing reaches a PIN-locked account: MainActivity keeps Core.api null until
// the picker opens a session (SessionGate), and every entry point checks it. A plain Application: Wicaby would start
// Core, the mesh and the updater.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class PinLockTest {
    private val home = Server("abc123", "Home", "https://nas.lan:8920", "emby")
    private val kid = Session(home, "kid", "Kid", "tok-kid")

    @After
    fun tearDown() {
        Core.api = null
        SessionGate.lock()
        OpenItem.id = null
    }

    private fun unlocked() {
        SessionGate.unlock(kid)
        Core.api = Api(home, "dev", kid.token, kid.userId)
    }

    private fun activity(link: String) =
        Robolectric.buildActivity(ComponentActivity::class.java, Intent(Intent.ACTION_VIEW, Uri.parse(link))).create().get()

    // Watch Next and the Next Up channel (wicaby://play), Recently Added (wicaby://open), a reminder (wicaby://live).
    @Test
    fun launcherAndReminderLinksWaitWhileLocked() {
        for (link in listOf("wicaby://play/abc123", "wicaby://open/abc123", "wicaby://live?channel=ch1&server=abc123")) {
            val a = activity(link)
            openDeepLink(a)
            assertNull(link, shadowOf(a).nextStartedActivity)
            assertNull(link, OpenItem.id)
            // Kept: it opens once a profile is picked (App() calls openDeepLink again).
            assertEquals(link, Uri.parse(link), a.intent.data)
        }
    }

    @Test
    fun launcherLinksOpenOnceThePickerOpenedTheSession() {
        unlocked()
        val play = activity("wicaby://play/abc123")
        openDeepLink(play)
        val started = shadowOf(play).nextStartedActivity
        assertEquals(PlayerActivity::class.java.name, started.component?.className)
        assertEquals("abc123", started.getStringExtra(PlayerActivity.EXTRA_ID))
        assertNull(play.intent.data)
        openDeepLink(activity("wicaby://open/abc123"))
        assertEquals("abc123", OpenItem.id)
    }

    // "Play" sent from the server socket (another app's remote control).
    @Test
    fun remotePlayNeedsAnOpenSession() {
        val app = Robolectric.buildActivity(ComponentActivity::class.java).create().get()
        val play = RemotePlay("abc123", 0, null, null, null)
        assertFalse(playRemote(app, play))
        assertNull(shadowOf(app).nextStartedActivity)
        // No session, no socket: nothing reaches the server either.
        assertFalse(Core.socketSend("KeepAlive"))
        unlocked()
        // playRemote looks the item up first (a music track goes to the music session): a local fake answers it, so no
        // request leaves the machine.
        val fake = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = MockResponse.Builder().code(200).body("""{"Id":"abc123","Name":"Film","Type":"Movie"}""").build()
            }
            start()
        }
        Core.transport = object : ServerTransport {
            override fun forward(origin: String) = fake.url("/").toString().trimEnd('/')
        }
        try {
            assertTrue(playRemote(app, play))
            val end = System.currentTimeMillis() + 5_000
            while (shadowOf(app).peekNextStartedActivity() == null && System.currentTimeMillis() < end) {
                Thread.sleep(20)
                ShadowLooper.idleMainLooper()
            }
            assertEquals(PlayerActivity::class.java.name, shadowOf(app).nextStartedActivity.component?.className)
            assertTrue(fake.requestCount > 0)
        } finally {
            Core.transport = ServerTransport.Direct
            fake.close()
        }
    }

    // The system screensaver: a locked account's library never shows.
    @Test
    fun screensaverShowsOnlyAnOpenSession() {
        val other = Session(home, "dad", "Dad", "tok-dad")
        val snap = Snapshot("dev", home, kid, 0, 0, 0, profiles = listOf(Profile(kid, hasPin = true), Profile(other)))
        assertNull(dreamApi(snap))
        SessionGate.unlock(kid)
        assertEquals("kid", dreamApi(snap)?.userId)
        SessionGate.lock()
        // The TV's lone account without a PIN skips the picker: nothing to protect.
        assertNotNull(dreamApi(snap.copy(profiles = listOf(Profile(kid)))))
        assertNull(dreamApi(snap.copy(profiles = listOf(Profile(kid)), skipPicker = false)))
    }

    // Switch User / Sign out: the picker locks the session and is left alone, so Back cannot return to the account.
    @Test
    fun thePickerLocksAndBackCannotReturn() {
        unlocked()
        val stack = mutableStateListOf<Route>(Route.Main, Route.Detail("abc123"))
        val nav = Nav(stack)
        nav.push(Route.Login(home))
        assertEquals(listOf<Route>(Route.Login(home)), stack.toList())
        assertNull(SessionGate.active(kid))
        nav.pop()
        assertEquals(listOf<Route>(Route.Login(home)), stack.toList())
        // Adding an extra server is no picker: the open session stays.
        SessionGate.unlock(kid)
        nav.reset(Route.Main)
        nav.push(Route.Login(home.copy(id = "other"), add = true))
        assertEquals(2, stack.size)
        assertEquals(kid, SessionGate.active(kid))
    }
}
