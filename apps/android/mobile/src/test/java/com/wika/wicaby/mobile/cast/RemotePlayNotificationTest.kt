package com.wika.wicaby.mobile.cast

import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import com.wika.wicaby.core.player.RemoteControl
import com.wika.wicaby.core.player.RemotePlay
import com.wika.wicaby.mobile.cast.RemotePlayNotification.Route
import com.wika.wicaby.mobile.player.PlayerActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

// CA-05: a remote Play while the app is in the background (notification path, §3.7).
// A plain Application: WicabyApp would start Core, downloads and the updater.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "fr")
class RemotePlayNotificationTest {
    private val app: Application = RuntimeEnvironment.getApplication()
    private val nm = app.getSystemService(NotificationManager::class.java)
    private val req = RemotePlay("123", 600_000, "ms1", 2, 3, controller = "u1")

    @Test
    fun routes() {
        assertEquals(Route.InPlace, RemotePlayNotification.route(playing = true, foreground = false, sdk = 34))
        assertEquals(Route.Player, RemotePlayNotification.route(playing = false, foreground = true, sdk = 34))
        // Android 8–9 may start an activity from the background; 10+ may not.
        assertEquals(Route.Player, RemotePlayNotification.route(playing = false, foreground = false, sdk = 28))
        assertEquals(Route.Notify, RemotePlayNotification.route(playing = false, foreground = false, sdk = 29))
    }

    @Test
    fun notificationOffersPlayAndDismissForSixtySeconds() {
        assertTrue(RemotePlayNotification.notify(app, req, "Théo", "Le Film"))
        val n = shadowOf(nm).getNotification(RemotePlayNotification.NOTIFICATION_ID)
        assertEquals(RemotePlayNotification.CHANNEL, n.channelId)
        assertEquals("Lecture demandée par Théo", n.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals("Le Film", n.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(listOf("Lire", "Ignorer"), n.actions.map { it.title.toString() })
        assertEquals(60_000L, n.timeoutAfter)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, nm.getNotificationChannel(RemotePlayNotification.CHANNEL).importance)
    }

    @Test
    fun lireStartsThePlayerAtTheRequestedPosition() {
        RemotePlayNotification.notify(app, req, "Théo", null)
        RemotePlayNotification.accept(app)
        val started = shadowOf(app).nextStartedActivity
        assertEquals(PlayerActivity::class.java.name, started.component?.className)
        assertEquals("123", started.getStringExtra("id"))
        assertFalse(started.getBooleanExtra("fromStart", true))
        // The new Playback takes the position and tracks, even past RemoteControl's own 30 s window.
        assertEquals(req, RemoteControl.take("123"))
        assertNull(shadowOf(nm).getNotification(RemotePlayNotification.NOTIFICATION_ID))
        // Accepted once: a second ACTION_PLAY (or one from another app) starts nothing.
        RemotePlayNotification.accept(app)
        assertNull(shadowOf(app).nextStartedActivity)
    }

    @Test
    fun refusedNotificationsDropTheRequest() {
        shadowOf(nm).setNotificationsEnabled(false)
        assertFalse(RemotePlayNotification.notify(app, req, "Théo", null))
        assertEquals(0, shadowOf(nm).size())
    }
}
