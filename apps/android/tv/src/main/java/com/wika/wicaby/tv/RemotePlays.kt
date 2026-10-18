package com.wika.wicaby.tv

import android.app.Activity
import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.annotation.RequiresApi
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.player.RemoteControl
import com.wika.wicaby.core.player.RemotePlay
import com.wika.wicaby.tv.data.AppLanguage
import com.wika.wicaby.tv.player.PlayerActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

// "Play on Wicaby" from another app, as mobile's RemotePlayNotification: the socket outlives MainActivity, so the
// requests are collected for the whole process. An app in front (or Android 9 and below) opens the player; otherwise
// Android 10+ forbids an activity start from the background, so a 60 s notification offers it.
object RemotePlays {
    const val ACTION_PLAY = "com.wika.wicaby.tv.REMOTE_PLAY"
    const val CHANNEL = "remote"
    const val NOTIFICATION_ID = 0x5250
    const val TIMEOUT_MS = 60_000L

    // The request the notification plays: kept here, not in the PendingIntent (MainActivity is exported).
    @Volatile
    private var offer: Pair<RemotePlay, Long>? = null
    private var installed = false

    /** Once per process, from MainActivity. */
    fun install(context: Context) {
        if (installed) return
        installed = true
        val app = context.applicationContext
        Core.scope.launch(Dispatchers.Main) { RemoteControl.plays.collect { playRemote(app, it) } }
    }

    // FOREGROUND_SERVICE (125, MusicService playing) sits between these two and does not allow an activity start.
    fun canStart(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true
        val info = ActivityManager.RunningAppProcessInfo().also(ActivityManager::getMyMemoryState)
        return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND ||
            info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
    }

    fun start(context: Context, r: RemotePlay) = context.startActivity(
        Intent(context, PlayerActivity::class.java).putExtra(PlayerActivity.EXTRA_ID, r.itemId)
            .putStringArrayListExtra(PlayerActivity.EXTRA_QUEUE, ArrayList(r.queue))
            .apply { if (context !is Activity) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) },
    )

    /** false when notifications are refused: the request is dropped. */
    @RequiresApi(Build.VERSION_CODES.Q)
    fun notify(context: Context, r: RemotePlay, who: String, itemName: String?): Boolean {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (!nm.areNotificationsEnabled()) return false
        val res = AppLanguage.localized(context)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, res.getString(R.string.remote_channel_name), NotificationManager.IMPORTANCE_HIGH))
        offer = r to System.currentTimeMillis()
        val play = PendingIntent.getActivity(
            context, NOTIFICATION_ID, Intent(context, MainActivity::class.java).setAction(ACTION_PLAY),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = Notification.Builder(context, CHANNEL)
            .setSmallIcon(context.applicationInfo.icon)
            .setContentTitle(res.getString(R.string.remote_play_request_title, who))
            .apply { itemName?.let(::setContentText) }
            .setContentIntent(play)
            .setAutoCancel(true)
            .setTimeoutAfter(TIMEOUT_MS)
            .addAction(Notification.Action.Builder(null, res.getString(R.string.remote_play_action), play).build())
            .build()
        nm.notify(NOTIFICATION_ID, n)
        return true
    }

    /** The notification tapped: the offer, while under 60 s and with a session open, plays at the requested position. */
    fun accept(context: Context) {
        val (r, at) = offer ?: return
        offer = null
        context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
        if (System.currentTimeMillis() - at > TIMEOUT_MS || Core.api == null) return
        RemoteControl.arm(r)
        start(context, r)
    }
}
