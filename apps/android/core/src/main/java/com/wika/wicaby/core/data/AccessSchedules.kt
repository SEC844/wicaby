package com.wika.wicaby.core.data

import android.content.Context
import android.text.format.DateFormat
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import java.util.Calendar
import java.util.TimeZone
import kotlin.math.ceil
import kotlin.math.roundToInt

// TP-11: Policy.AccessSchedules, as the desktop admin edits them (UserEditor.svelte). The server enforces them;
// the apps only explain a refusal and count down the end of the allowed hours, nothing more. Hours are wall-clock
// hours (the server reads its own clock: a TV in another time zone would be off). Kept per server and user, since
// outside the hours the server refuses /Users/{id} too. minSdk 23: Calendar, no java-time.
@Serializable
data class AccessSchedule(val dayOfWeek: String = "Everyday", val startHour: Double = 0.0, val endHour: Double = 24.0)

object AccessSchedules {
    private val names = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")

    // Emby and Jellyfin DynamicDayOfWeek, as Calendar days (SUNDAY = 1).
    fun days(d: String): Set<Int> = when (d) {
        "Everyday" -> (1..7).toSet()
        "Weekday" -> (2..6).toSet()
        "Weekend" -> setOf(Calendar.SUNDAY, Calendar.SATURDAY)
        else -> names.indexOfFirst { it.equals(d, true) }.let { if (it < 0) emptySet() else setOf(it + 1) }
    }

    // A Calendar day's allowed spans in hours, sorted, overlapping or touching ones merged.
    fun windows(list: List<AccessSchedule>, day: Int): List<ClosedFloatingPointRange<Double>> {
        val out = mutableListOf<ClosedFloatingPointRange<Double>>()
        list.filter { day in days(it.dayOfWeek) }
            .map { it.startHour.coerceIn(0.0, 24.0)..it.endHour.coerceIn(0.0, 24.0) }
            .filter { it.endInclusive > it.start }
            .sortedBy { it.start }
            .forEach { s ->
                val last = out.lastOrNull()
                if (last != null && s.start <= last.endInclusive) out[out.lastIndex] = last.start..maxOf(last.endInclusive, s.endInclusive) else out += s
            }
        return out
    }

    private fun cal(ms: Long, tz: TimeZone) = Calendar.getInstance(tz).apply { timeInMillis = ms }
    private fun hour(c: Calendar) = c.get(Calendar.HOUR_OF_DAY) + c.get(Calendar.MINUTE) / 60.0 + c.get(Calendar.SECOND) / 3600.0
    private fun current(list: List<AccessSchedule>, c: Calendar) = hour(c).let { h -> windows(list, c.get(Calendar.DAY_OF_WEEK)).firstOrNull { h >= it.start && h < it.endInclusive } }

    // No schedule: no limit.
    fun allowed(list: List<AccessSchedule>, nowMs: Long, tz: TimeZone = TimeZone.getDefault()): Boolean =
        list.isEmpty() || current(list, cal(nowMs, tz)) != null

    // Minutes until the allowed hours end, rounded up; a span to 24:00 carries on into the next day's from 0:00.
    // null with no schedule, outside the hours, or allowed around the clock.
    fun minutesLeft(list: List<AccessSchedule>, nowMs: Long, tz: TimeZone = TimeZone.getDefault()): Long? {
        if (list.isEmpty()) return null
        val c = cal(nowMs, tz)
        var end = current(list, c)?.endInclusive ?: return null
        var d = 0
        while (end >= 24.0) {
            if (d >= 7) return null
            val next = (c.get(Calendar.DAY_OF_WEEK) + d) % 7 + 1
            end = windows(list, next).firstOrNull { it.start <= 0.0 }?.endInclusive ?: break
            d++
        }
        c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0)
        c.add(Calendar.DAY_OF_MONTH, d)
        c.add(Calendar.MINUTE, (end * 60).roundToInt())
        return ceil((c.timeInMillis - nowMs) / 60_000.0).toLong()
    }

    // A refusal of the hours: the servers' wording (Emby on every call, both at sign-in), or any 401/403 while the
    // kept schedule says it is outside the hours (Jellyfin answers other calls with a bare 403). The wording is
    // matched on any error: Live TV wraps the server's answer in a LiveError that keeps its message only.
    // signIn: Jellyfin's AuthenticateByName answers a bare 403 for a SecurityException only (account disabled, remote
    // access off, or outside the hours); for a user its /Users/Public lists (neither disabled nor remote-barred),
    // only the hours remain, whatever was kept.
    fun refused(e: Throwable?, list: List<AccessSchedule>, nowMs: Long, tz: TimeZone = TimeZone.getDefault(), signIn: Boolean = false): Boolean {
        if (e?.message?.contains("not allowed access at this time", ignoreCase = true) == true) return true
        val a = e as? ApiException ?: return false
        if (signIn && a.status == 403) return true
        return (a.status == 401 || a.status == 403) && !allowed(list, nowMs, tz)
    }

    fun parse(policy: JsonObject?): List<AccessSchedule> =
        (policy?.get("AccessSchedules") as? JsonArray)?.let { runCatching { json.decodeFromJsonElement<List<AccessSchedule>>(it) }.getOrNull() }.orEmpty()

    // ---- Kept per server and user (SharedPreferences; unit tests have no Application: nothing kept).

    private val sp by lazy { Core.app.getSharedPreferences("wicaby_access_schedules", Context.MODE_PRIVATE) }

    fun stored(serverId: String, userId: String?): List<AccessSchedule> = runCatching {
        sp.getString("$serverId|${userId ?: return emptyList()}", null)?.let { json.decodeFromString<List<AccessSchedule>>(it) }
    }.getOrNull().orEmpty()

    fun save(serverId: String, userId: String, policy: JsonObject?) {
        if (policy == null) return
        val list = parse(policy)
        runCatching { sp.edit().apply { if (list.isEmpty()) remove("$serverId|$userId") else putString("$serverId|$userId", json.encodeToString(list)) }.apply() }
    }

    // The current user's policy; a failure (after hours the server refuses this too) keeps what was saved.
    suspend fun refresh(api: Api) {
        val id = api.userId ?: return
        runCatching { save(api.server.id, id, api.get<JsonObject>("/Users/$id")["Policy"] as? JsonObject) }
    }

    // The check before reusing a saved token: Api.user (Emby /Users/{id}, Jellyfin /Users/Me), which both servers refuse
    // outside the hours (Emby with its wording, Jellyfin with a bare 403). Jellyfin's /Users/{id} ignores the hours
    // ([Authorize(IgnoreParentalControl)]), so after a refusal it still gives them; Emby's refuses too (kept ones stay).
    suspend fun verify(api: Api, userId: String): User {
        val user = try {
            api.user(userId)
        } catch (e: ApiException) {
            if (!api.server.isEmby) refresh(api)
            throw e
        }
        save(api.server.id, user.id, user.policy)
        return user
    }

    // "Accès refusé…" with today's allowed hours, when [e] is a refusal of the hours; else null. e == null: a
    // stream that broke off, judged on the kept hours alone.
    fun explain(context: Context, serverId: String, userId: String?, e: Throwable?, nowMs: Long = System.currentTimeMillis(), signIn: Boolean = false): String? {
        val list = stored(serverId, userId)
        val hit = if (e == null) !allowed(list, nowMs) else refused(e, list, nowMs, signIn = signIn)
        return if (hit) message(context, list, nowMs) else null
    }

    fun message(context: Context, list: List<AccessSchedule>, nowMs: Long): String {
        val today = windows(list, cal(nowMs, TimeZone.getDefault()).get(Calendar.DAY_OF_WEEK))
        val fmt = DateFormat.getTimeFormat(context)
        fun t(h: Double): String = if (h >= 24.0) context.getString(R.string.access_schedule_midnight) else fmt.format(
            Calendar.getInstance().apply { set(2000, 0, 1, h.toInt(), ((h % 1) * 60).roundToInt().coerceAtMost(59), 0) }.time,
        )
        val hours = when {
            list.isEmpty() -> null
            today.isEmpty() -> context.getString(R.string.access_schedule_none_today)
            today.size == 1 -> context.getString(R.string.access_schedule_hours, t(today[0].start), t(today[0].endInclusive))
            else -> context.getString(R.string.access_schedule_hours_list, today.joinToString(", ") { "${t(it.start)}–${t(it.endInclusive)}" })
        }
        return listOfNotNull(context.getString(R.string.access_schedule_refused), hours).joinToString("\n")
    }
}
