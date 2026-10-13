package com.wika.wicaby.core.livetv

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.text.format.DateFormat
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.SafeNames
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.util.Date

// Live TV reminders (LT-19, spec §9.6, §21.3): stored on the device, armed with
// AlarmManager.setWindow(RTC_WAKEUP) (no exact-alarm permission), re-armed at boot and after an
// update, posted as a notification whose tap and "Regarder" open wicaby://live?channel=…&server=….
// The apps also collect [Reminders.fired] for the in-app banner (TV: in-app first, §21.3).

@Serializable
data class Reminder(
    val serverId: String,
    val userId: String,
    val programId: String,
    val channelId: String,
    /** Programme start, server clock (epoch ms). */
    val start: Long,
    val title: String,
    val channelName: String,
    /** 0, 1, 2 (default), 5, 10. */
    val leadMin: Int = 2,
    val autoTune: Boolean = false,
    /** When to fire, device clock: [fireAt]. */
    val at: Long,
) {
    val key: String get() = "$serverId:$userId:$programId"
}

/** Device-clock fire time; [skewMs] is LiveTvApi's clock skew (server − device). */
fun fireAt(start: Long, leadMin: Int, skewMs: Long = 0): Long = start - leadMin * 60_000L - skewMs

/**
 * Next alarm on the way to [at]. Android 12+ stretches any setWindow to min(10 min, 0.75 × futurity)
 * (`min_window`) and, with lazy batching, often delivers at the end of it. So a reminder is reached in
 * hops whose latest delivery is still before [at]; the last hop is ≤ 80 s away, which keeps its window
 * at the 60 s asked for. About 4 wakeups in the last 10 minutes.
 */
fun nextHop(at: Long, now: Long): Long {
    val left = at - now
    return if (left <= 80_000) at else now + maxOf(left - 600_000, (left / 1.75).toLong())
}

/** Drops the reminders missed by more than [Reminders.LATE_MS] (device off at the time). */
fun pruneReminders(list: List<Reminder>, now: Long): List<Reminder> = list.filter { now <= it.at + Reminders.LATE_MS }

/** Deep-link channel lookup (§3.1): id, then number, then name (case-insensitive). */
fun resolveChannel(query: String, channels: List<ChannelRow>): ChannelRow? =
    channels.firstOrNull { it.id == query }
        ?: channels.firstOrNull { it.number.isNotEmpty() && it.number == query }
        ?: channels.firstOrNull { it.name.equals(query, ignoreCase = true) }

/** F3, cold start: retries while the servers connect (5 × 2 s); [channels] null = not ready yet. */
suspend fun resolveChannelWithRetry(
    query: String,
    attempts: Int = 5,
    delayMs: Long = 2_000,
    channels: suspend () -> List<ChannelRow>?,
): ChannelRow? {
    repeat(attempts) { i ->
        val list = try {
            channels()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        if (!list.isNullOrEmpty()) resolveChannel(query, list)?.let { return it }
        if (i < attempts - 1) delay(delayMs)
    }
    return null
}

/** wicaby://live?channel=<id or number>&server=<id> → (channel, server?). The activity is exported and BROWSABLE: only plain ids get through. */
fun liveLinkQuery(data: Uri): Pair<String, String?>? {
    if (data.scheme != "wicaby" || data.host != "live") return null
    val channel = data.getQueryParameter("channel")?.takeIf(SafeNames::isValidId) ?: return null
    val server = data.getQueryParameter("server")
    if (server != null && !SafeNames.isValidId(server)) return null
    return channel to server
}

/** F3: [repo] is null while no one is signed in (or on another server); retried with the channels 5 × 2 s on a cold start. */
suspend fun resolveLiveLink(channel: String, repo: () -> LiveTvRepository?): Pair<LiveTvRepository, ChannelRow>? {
    var found: LiveTvRepository? = null
    val row = resolveChannelWithRetry(channel) { repo()?.also { found = it; it.loadChannels() }?.channels?.value }
    return row?.let { found!! to it }
}

object Reminders {
    const val WINDOW_MS = 60_000L

    /** Missed by more than this (device off at the time), a reminder is dropped instead of shown. */
    const val LATE_MS = 10 * 60_000L
    const val ACTION_FIRE = "com.wika.wicaby.livetv.REMINDER"
    private const val CHANNEL = "livetv_reminders"
    private val KEY = stringPreferencesKey("live.reminders")
    private val codec = ListSerializer(Reminder.serializer())

    private val _fired = MutableSharedFlow<Reminder>(extraBufferCapacity = 8)
    private val _askPermission = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /** The first reminder was set on Android 13+ without POST_NOTIFICATIONS: MainActivity asks (§21.4); refused → in-app only. */
    val askPermission: SharedFlow<Unit> = _askPermission.asSharedFlow()

    /** Each reminder as it fires, for the in-app banner or toast (and the auto-tune countdown, live only). */
    val fired: SharedFlow<Reminder> = _fired.asSharedFlow()

    private fun decode(text: String?): List<Reminder> =
        text?.let { runCatching { LiveJson.decodeFromString(codec, it) }.getOrNull() }.orEmpty()

    /** Every stored reminder, all servers and users (filter by serverId/userId for the bell marks). */
    fun all(context: Context): Flow<List<Reminder>> = context.applicationContext.liveTvStore.data.map { decode(it[KEY]) }

    private suspend fun edit(context: Context, change: (List<Reminder>) -> List<Reminder>): List<Reminder> {
        var out = emptyList<Reminder>()
        context.applicationContext.liveTvStore.edit { p ->
            out = change(decode(p[KEY]))
            p[KEY] = LiveJson.encodeToString(codec, out)
        }
        return out
    }

    /** Adds (or replaces) a reminder and arms it; the first one emits [askPermission] when [needsPermission]. */
    suspend fun add(context: Context, r: Reminder) {
        var first = false
        edit(context) { list -> first = list.isEmpty(); list.filterNot { it.key == r.key } + r }
        arm(context, r)
        if (first && needsPermission(context)) _askPermission.tryEmit(Unit)
    }

    suspend fun cancel(context: Context, serverId: String, userId: String, programId: String) {
        val key = "$serverId:$userId:$programId"
        edit(context) { list -> list.filterNot { it.key == key } }
        alarms(context).cancel(alarmIntent(context, key))
    }

    /** At boot, after an update or a clock change: prune what was missed, arm the rest. */
    suspend fun rearm(context: Context) {
        edit(context) { pruneReminders(it, System.currentTimeMillis()) }.forEach { arm(context, it) }
    }

    /** Android 13+ without POST_NOTIFICATIONS: the UI asks when the first reminder is set; refused → in-app only. */
    fun needsPermission(context: Context): Boolean =
        Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

    /** wicaby://live?channel=<id>&server=<id>, handled by MainActivity. */
    fun liveLink(context: Context, channelId: String, serverId: String): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse("wicaby://live?channel=${Uri.encode(channelId)}&server=${Uri.encode(serverId)}"))
            .setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    private fun alarms(context: Context) = context.getSystemService(AlarmManager::class.java)

    // The key rides in the data URI so each reminder gets its own PendingIntent.
    private fun alarmIntent(context: Context, key: String): PendingIntent = PendingIntent.getBroadcast(
        context, 0,
        Intent(ACTION_FIRE, Uri.fromParts("reminder", key, null), context, ReminderReceiver::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun arm(context: Context, r: Reminder) {
        val at = if (Build.VERSION.SDK_INT >= 31) nextHop(r.at, System.currentTimeMillis()) else r.at
        alarms(context).setWindow(AlarmManager.RTC_WAKEUP, at, WINDOW_MS, alarmIntent(context, r.key))
    }

    internal suspend fun fire(context: Context, key: String) {
        // An intermediate hop: arm the next one.
        val stored = decode(context.applicationContext.liveTvStore.data.first()[KEY]).firstOrNull { it.key == key } ?: return
        if (System.currentTimeMillis() < stored.at) return arm(context, stored)
        var hit: Reminder? = null
        edit(context) { list -> list.filterNot { (it.key == key).also { m -> if (m) hit = it } } }
        val r = hit ?: return
        if (pruneReminders(listOf(r), System.currentTimeMillis()).isEmpty()) return
        _fired.tryEmit(r)
        notify(context, r)
    }

    private fun notify(context: Context, r: Reminder) {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 24 && !nm.areNotificationsEnabled()) return
        val res = Core.localized
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, res.getString(R.string.livetv_reminder_channel), NotificationManager.IMPORTANCE_DEFAULT))
        }
        val open = PendingIntent.getActivity(
            context, r.key.hashCode(), liveLink(context, r.channelId, r.serverId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(context)
        // The apps' monochrome status icon when there is one (mobile), else the launcher icon (TV).
        @Suppress("DiscouragedApi")
        val icon = context.resources.getIdentifier("ic_stat_wicaby", "drawable", context.packageName).takeIf { it != 0 }
            ?: context.applicationInfo.icon
        val time = DateFormat.getTimeFormat(res).format(Date(r.start))
        val n = builder
            .setSmallIcon(icon)
            .setContentTitle(res.getString(R.string.livetv_reminder_title, r.title))
            .setContentText(res.getString(R.string.livetv_reminder_body, r.channelName, time))
            .setCategory(Notification.CATEGORY_REMINDER)
            .setContentIntent(open)
            .setAutoCancel(true)
            .addAction(Notification.Action.Builder(null, res.getString(R.string.livetv_reminder_watch), open).build())
            .build()
        nm.notify(r.key.hashCode(), n)
    }
}

/** Alarm, boot, update and clock or time-zone change (§21.4); declared in both apps' manifests. */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext
        val pending = goAsync()
        Core.scope.launch {
            try {
                when (intent.action) {
                    Reminders.ACTION_FIRE -> intent.data?.schemeSpecificPart?.let { Reminders.fire(app, it) }
                    Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED,
                    Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED -> Reminders.rearm(app)
                }
            } finally {
                pending.finish()
            }
        }
    }
}
