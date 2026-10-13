package com.wika.wicaby.mobile.cast

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.player.RemoteControl
import com.wika.wicaby.core.player.RemotePlay
import com.wika.wicaby.mobile.Lang
import com.wika.wicaby.mobile.MainActivity
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.player.PlayerActivity
import com.wika.wicaby.mobile.player.PlayerHolder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

// "Play on Wicaby" from another app (CA-05, cast spec §3.7). A running player switches item in place
// (PlaybackService keeps it alive off screen); an app in front, or Android 9 and below, opens the
// player; otherwise Android 10+ forbids an activity start from the background, so a 60 s
// notification offers "Lire" / "Ignorer".
object RemotePlayNotification {
    enum class Route { InPlace, Player, Notify }

    const val ACTION_PLAY = "com.wika.wicaby.mobile.REMOTE_PLAY"
    private const val ACTION_DISMISS = "com.wika.wicaby.mobile.REMOTE_DISMISS"
    const val CHANNEL = "remote"
    const val NOTIFICATION_ID = 0x5250
    const val TIMEOUT_MS = 60_000L
    private const val TAG = "WicabyRemote"

    fun route(playing: Boolean, foreground: Boolean, sdk: Int): Route = when {
        playing -> Route.InPlace
        foreground || sdk < Build.VERSION_CODES.Q -> Route.Player
        else -> Route.Notify
    }

    // The request "Lire" plays. Kept here, not in the PendingIntent: MainActivity is exported, so an
    // ACTION_PLAY from another app can at most accept the offer already on screen.
    @Volatile
    private var offer: Pair<RemotePlay, Long>? = null
    private var installed = false

    /** Once per process, from MainActivity: the socket and this collector outlive the activity. */
    fun install(context: Context) {
        if (installed) return
        installed = true
        val app = context.applicationContext
        RemoteControl.playerOnly = true
        ContextCompat.registerReceiver(
            app, object : BroadcastReceiver() {
                override fun onReceive(c: Context, i: Intent) = dismiss(c)
            },
            IntentFilter(ACTION_DISMISS), ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        Core.scope.launch(Dispatchers.Main) { RemoteControl.plays.collect { onPlay(app, it) } }
    }

    private fun onPlay(app: Context, r: RemotePlay) {
        val api = Core.api ?: return
        when (route(PlayerHolder.playback != null, foreground(), Build.VERSION.SDK_INT)) {
            Route.InPlace -> PlayerHolder.start(app, api, r.itemId, fromStart = false)
            Route.Player -> PlayerActivity.start(app, r.itemId, fromStart = false)
            Route.Notify -> Core.scope.launch {
                // The sender's user when the server names it (ControllingUserId), else the server.
                val who = r.controller?.let { id -> runCatching { api.get<JsonObject>("/Users/$id")["Name"]?.jsonPrimitive?.contentOrNull }.getOrNull() }
                val title = runCatching { api.item(r.itemId).name }.getOrNull()
                withContext(Dispatchers.Main) { notify(app, r, who ?: api.server.name, title) }
            }
        }
    }

    // FOREGROUND_SERVICE (125) sits between these two and does not allow an activity start.
    private fun foreground(): Boolean {
        val info = ActivityManager.RunningAppProcessInfo().also(ActivityManager::getMyMemoryState)
        return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND ||
            info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
    }

    /** false when notifications are refused (Android 13+ without POST_NOTIFICATIONS): the request is dropped, the sender's confirmation times out. */
    fun notify(context: Context, r: RemotePlay, who: String, itemName: String?): Boolean {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (!nm.areNotificationsEnabled()) {
            Log.w(TAG, "remote Play dropped: notifications are off")
            return false
        }
        val res = Lang.wrap(context)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, res.getString(R.string.remote_channel_name), NotificationManager.IMPORTANCE_HIGH))
        offer = r to System.currentTimeMillis()
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val play = PendingIntent.getActivity(context, NOTIFICATION_ID, Intent(context, MainActivity::class.java).setAction(ACTION_PLAY), flags)
        val dismiss = PendingIntent.getBroadcast(context, NOTIFICATION_ID, Intent(ACTION_DISMISS).setPackage(context.packageName), flags)
        val n = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_wicaby)
            .setContentTitle(res.getString(R.string.remote_play_request_title, who))
            .apply { itemName?.let(::setContentText) }
            .setContentIntent(play)
            .setAutoCancel(true)
            .setTimeoutAfter(TIMEOUT_MS)
            .addAction(Notification.Action.Builder(null, res.getString(R.string.remote_play_action), play).build())
            .addAction(Notification.Action.Builder(null, res.getString(R.string.remote_play_dismiss), dismiss).build())
            .build()
        nm.notify(NOTIFICATION_ID, n)
        return true
    }

    /** "Lire": the offer, while under 60 s, goes to the player at the requested position and tracks. */
    fun accept(context: Context) {
        val (r, at) = offer ?: return
        dismiss(context)
        if (System.currentTimeMillis() - at > TIMEOUT_MS) return
        RemoteControl.arm(r)
        PlayerActivity.start(context, r.itemId, fromStart = false)
    }

    private fun dismiss(context: Context) {
        offer = null
        context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
    }
}
