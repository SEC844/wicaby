package com.wika.wicaby.tv

import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.player.RemoteControl
import com.wika.wicaby.core.player.RemotePlay
import com.wika.wicaby.tv.player.PlayerActivity
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

// A remote Play while the TV app is in the background: a notification offers it, and its tap opens the player.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class RemotePlaysTest {
    private val app: Application = RuntimeEnvironment.getApplication()
    private val nm = app.getSystemService(NotificationManager::class.java)
    private val req = RemotePlay("123", 600_000, "ms1", 2, 3, queue = listOf("123", "124"))

    @After
    fun tearDown() {
        Core.api = null
    }

    @Test
    fun theNotificationOpensThePlayerAtTheRequestedPosition() {
        assertTrue(RemotePlays.notify(app, req, "Théo", "Le Film"))
        val n = shadowOf(nm).getNotification(RemotePlays.NOTIFICATION_ID)
        assertEquals("Le Film", n.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(60_000L, n.timeoutAfter)
        Core.api = Api(Server("s1", "Test", "http://127.0.0.1:1", "jellyfin"), "tv", "tok", "u1")
        RemotePlays.accept(app)
        val started = shadowOf(app).nextStartedActivity
        assertEquals(PlayerActivity::class.java.name, started.component?.className)
        assertEquals("123", started.getStringExtra(PlayerActivity.EXTRA_ID))
        assertEquals(listOf("123", "124"), started.getStringArrayListExtra(PlayerActivity.EXTRA_QUEUE))
        // The player takes the position and tracks, even past RemoteControl's own 30 s window.
        assertEquals(req, RemoteControl.take("123"))
        assertNull(shadowOf(nm).getNotification(RemotePlays.NOTIFICATION_ID))
        // Accepted once: a second tap (or an ACTION_PLAY from another app) starts nothing.
        RemotePlays.accept(app)
        assertNull(shadowOf(app).nextStartedActivity)
    }

    // TP-10: no player without a session open (the profile picker, a locked account).
    @Test
    fun noSessionNoPlayer() {
        RemotePlays.notify(app, req, "Théo", null)
        RemotePlays.accept(app)
        assertNull(shadowOf(app).nextStartedActivity)
    }
}
