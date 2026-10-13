package com.wika.wicaby.core.livetv

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import java.util.Calendar
import java.util.GregorianCalendar
import java.util.Locale
import java.util.TimeZone

// Live TV time navigation (spec §6.4, §21.4): local days (DST-safe), dayparts, jump targets and the
// live/manual anchor state machine. Mirrors D/shared/livetv/anchor.ts (golden vectors: anchor.json,
// Europe/Paris and America/New_York).
//
// minSdk 23 (§21.3): java.util.Calendar and an injected TimeZone, no java-time. Wall-clock fields
// are normalised on a proleptic Gregorian calendar in UTC (what JavaScript's Date constructor does
// with overflowing fields); local ↔ instant goes through TimeZone.getOffset with JavaScript's rules
// (a time in the repeated hour is its first occurrence, a time in the skipped hour is read with the
// offset before the change). GregorianCalendar's own resolution is not used for that step: the JDK
// and Android's libcore resolve the repeated hour differently.

const val MINUTE = 60_000L
const val HOUR = 3_600_000L

/** Local wall-clock fields of an instant. month0 is 0-based, as in JavaScript. */
data class LocalFields(val year: Int, val month0: Int, val day: Int, val hour: Int, val minute: Int, val second: Int, val ms: Int)

@Serializable
data class DayChip(
    /** 0 = Aujourd’hui, 1 = Demain, then a formatted date. */
    val index: Int,
    /** YYYY-MM-DD */
    val key: String,
    val start: Long,
    /** Next local midnight. */
    val end: Long,
)

/** Dayparts are data; only their labels are strings (livetv_guide_dayparts_*). */
enum class Daypart(val id: String, val hour: Int, val nextDay: Boolean) {
    MORNING("morning", 6, false),
    AFTERNOON("afternoon", 12, false),
    EVENING("evening", 18, false),
    TONIGHT("tonight", 21, false),
    NIGHT("night", 0, true),
    ;

    companion object {
        fun fromId(id: String?): Daypart? = entries.firstOrNull { it.id == id }
    }
}

/** "Maintenant": the now line at ⅓ of the lane. */
const val NOW_AT = 1.0 / 3

/** A daypart sits 30 min in from the left edge. */
const val DAYPART_INSET_MS = 30 * MINUTE

/** ‹ › and Shift+←/→ (TV rewind/forward: 2 h). */
const val PAGE_MS = 3 * HOUR
const val TV_PAGE_MS = 2 * HOUR

private val DAY_KEY_RE = Regex("(\\d{4})-(\\d{2})-(\\d{2})")
private val AT_RE = Regex("(\\d{2})(\\d{2})")

/** Local days, dayparts and jump targets in [zone] (TimeZone.getDefault() in the apps; injected by the tests). */
class GuideClock(val zone: TimeZone) {
    // Wall-clock arithmetic only: UTC, proleptic Gregorian, lenient (fields overflow like Date's).
    private val wall = GregorianCalendar(TimeZone.getTimeZone("UTC"), Locale.ROOT).apply {
        gregorianChange = java.util.Date(Long.MIN_VALUE)
        isLenient = true
    }

    /** Local wall-clock fields of t. */
    fun fields(t: Long): LocalFields = synchronized(wall) {
        wall.timeInMillis = t + zone.getOffset(t)
        val era = wall.get(Calendar.ERA)
        val y = wall.get(Calendar.YEAR)
        LocalFields(
            year = if (era == GregorianCalendar.BC) 1 - y else y,
            month0 = wall.get(Calendar.MONTH),
            day = wall.get(Calendar.DAY_OF_MONTH),
            hour = wall.get(Calendar.HOUR_OF_DAY),
            minute = wall.get(Calendar.MINUTE),
            second = wall.get(Calendar.SECOND),
            ms = wall.get(Calendar.MILLISECOND),
        )
    }

    /** new Date(y, m0, d, h, min, s, ms).getTime() in [zone]: fields may overflow. */
    fun local(year: Int, month0: Int, day: Int, hour: Int = 0, minute: Int = 0, second: Int = 0, ms: Int = 0): Long {
        val w = synchronized(wall) {
            wall.clear()
            val y = if (year in 0..99) 1900 + year else year
            if (y <= 0) {
                wall.set(Calendar.ERA, GregorianCalendar.BC)
                wall.set(Calendar.YEAR, 1 - y)
            } else {
                wall.set(Calendar.YEAR, y)
            }
            wall.set(Calendar.MONTH, month0)
            wall.set(Calendar.DAY_OF_MONTH, day)
            wall.set(Calendar.HOUR_OF_DAY, hour)
            wall.set(Calendar.MINUTE, minute)
            wall.set(Calendar.SECOND, second)
            wall.set(Calendar.MILLISECOND, ms)
            wall.timeInMillis
        }
        return instantOf(w)
    }

    /** Wall-clock ms (local fields read as UTC) → instant, with JavaScript's choice in the DST overlap and gap. */
    private fun instantOf(w: Long): Long {
        val before = zone.getOffset(w - Civil.DAY_MS)
        val after = zone.getOffset(w + Civil.DAY_MS)
        var best: Long? = null
        for (off in intArrayOf(before, after, zone.getOffset(w))) {
            val t = w - off
            if (zone.getOffset(t) == off && (best == null || t < best)) best = t // the earliest valid reading
        }
        return best ?: (w - before) // in the gap: the offset before the change (02:30 → 03:30)
    }

    /** Local midnight of the day containing t. */
    fun dayStart(t: Long): Long = fields(t).let { local(it.year, it.month0, it.day) }

    /** The local midnight n days after the day containing t (calendar days: 23 h or 25 h across DST). */
    fun addDays(t: Long, n: Int): Long = fields(t).let { local(it.year, it.month0, it.day + n) }

    /** Local wall-clock time hour:minute on the day containing t (shifted by [days]). */
    fun atLocal(t: Long, hour: Int, minute: Int = 0, days: Int = 0): Long = fields(t).let { local(it.year, it.month0, it.day + days, hour, minute) }

    /** 'YYYY-MM-DD' of the local day (URL `day=`). */
    fun dayKey(t: Long): String = fields(t).let { "${it.year}-${pad2(it.month0 + 1)}-${pad2(it.day)}" }

    fun parseDayKey(key: String?): Long? {
        val m = DAY_KEY_RE.matchEntire(key ?: "") ?: return null
        val (y, mo, d) = m.destructured
        val t = local(y.toInt(), mo.toInt() - 1, d.toInt())
        return if (fields(t).month0 == mo.toInt() - 1) t else null
    }

    /** URL `at=HHMM` (local wall clock) on a day. */
    fun parseAt(day: Long, at: String?): Long? {
        val m = AT_RE.matchEntire(at ?: "") ?: return null
        val h = m.groupValues[1].toInt()
        val min = m.groupValues[2].toInt()
        if (h > 23 || min > 59) return null
        return atLocal(day, h, min)
    }

    fun atParam(t: Long): String = fields(t).let { pad2(it.hour) + pad2(it.minute) }

    /** From today to the local date of GuideInfo.EndDate (fallback now + 7 d), inclusive. */
    fun dayChips(now: Long, guideEnd: Long? = null): List<DayChip> {
        val end = if (guideEnd != null && guideEnd > now) guideEnd else now + 7 * 24 * HOUR
        val last = dayStart(end - 1)
        val out = ArrayList<DayChip>()
        var s = dayStart(now)
        var i = 0
        while (s <= last && i < 60) {
            val e = addDays(s, 1)
            out.add(DayChip(i, dayKey(s), s, e))
            s = e
            i++
        }
        return out
    }

    /** The wall-clock time a daypart names on the selected day ("Nuit" = 00:00 of the next day). */
    fun daypartTime(day: Long, part: Daypart): Long = atLocal(day, part.hour, 0, if (part.nextDay) 1 else 0)

    // ---- Jumps: they return the time at the left edge of the lane ----

    fun leftForDaypart(day: Long, part: Daypart): Long = daypartTime(day, part) - DAYPART_INSET_MS

    /**
     * Picking a day keeps the time of day at the left edge, or lands on Soirée (18:00) when the
     * guide was at "Maintenant" (anchor live).
     */
    fun leftForDay(day: Long, currentLeft: Long, live: Boolean): Long {
        if (live) return leftForDaypart(day, Daypart.EVENING)
        val f = fields(currentLeft)
        return atLocal(day, f.hour, f.minute)
    }

    /** Ctrl+←/→: the same wall-clock time on the previous or next day. */
    fun shiftDay(left: Long, days: Int): Long = fields(left).let { local(it.year, it.month0, it.day + days, it.hour, it.minute, it.second, it.ms) }

    private fun pad2(n: Int) = n.toString().padStart(2, '0')
}

fun leftForNow(now: Long, laneMs: Long): Long = now - Math.round(laneMs * NOW_AT)

// ---- Anchor state machine ----

const val IDLE_RECENTER_MS = 5 * MINUTE
const val HIDDEN_RECENTER_MS = 5 * MINUTE
const val BAND_LOW = 0.1
const val BAND_HIGH = 0.6

@Serializable
enum class AnchorMode {
    @SerialName("live") LIVE,
    @SerialName("manual") MANUAL,
}

data class AnchorState(val mode: AnchorMode, val lastInputAt: Long, val hiddenAt: Long?)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("type")
sealed interface AnchorEvent {
    val at: Long

    /** "Maintenant" / Home. */
    @Serializable @SerialName("now") data class Now(override val at: Long) : AnchorEvent

    /** A day, a daypart, a page or a day shift. */
    @Serializable @SerialName("pick") data class Pick(override val at: Long) : AnchorEvent

    /** A horizontal scroll by the user. */
    @Serializable @SerialName("scroll") data class Scroll(override val at: Long, val nowVisible: Boolean = false) : AnchorEvent

    /** Any other key or pointer input. */
    @Serializable @SerialName("input") data class Input(override val at: Long) : AnchorEvent

    /** nowFrac = now line position / lane width. */
    @Serializable @SerialName("tick") data class Tick(override val at: Long, val nowFrac: Double) : AnchorEvent
    @Serializable @SerialName("hidden") data class Hidden(override val at: Long) : AnchorEvent
    @Serializable @SerialName("visible") data class Visible(override val at: Long) : AnchorEvent
}

data class AnchorStep(val state: AnchorState, val recenter: Boolean)

fun anchorInit(at: Long): AnchorState = AnchorState(AnchorMode.LIVE, at, null)

/** recenter = put the now line back at ⅓ (leftForNow). A manual view is never pulled back. */
fun anchorReduce(s: AnchorState, ev: AnchorEvent): AnchorStep = when (ev) {
    is AnchorEvent.Now -> AnchorStep(s.copy(mode = AnchorMode.LIVE, lastInputAt = ev.at), true)
    is AnchorEvent.Pick -> AnchorStep(s.copy(mode = AnchorMode.MANUAL, lastInputAt = ev.at), false)
    is AnchorEvent.Scroll -> AnchorStep(s.copy(mode = if (ev.nowVisible) s.mode else AnchorMode.MANUAL, lastInputAt = ev.at), false)
    is AnchorEvent.Input -> AnchorStep(s.copy(lastInputAt = ev.at), false)
    is AnchorEvent.Tick -> {
        val drifted = ev.nowFrac < BAND_LOW || ev.nowFrac > BAND_HIGH
        AnchorStep(s, s.mode == AnchorMode.LIVE && drifted && ev.at - s.lastInputAt >= IDLE_RECENTER_MS)
    }
    is AnchorEvent.Hidden -> AnchorStep(s.copy(hiddenAt = ev.at), false)
    is AnchorEvent.Visible -> {
        val long = s.hiddenAt != null && ev.at - s.hiddenAt > HIDDEN_RECENTER_MS
        AnchorStep(s.copy(hiddenAt = null), long && s.mode == AnchorMode.LIVE)
    }
}
