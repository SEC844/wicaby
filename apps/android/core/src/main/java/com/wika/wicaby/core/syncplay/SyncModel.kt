package com.wika.wicaby.core.syncplay

import com.wika.wicaby.core.data.SafeNames
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.livetv.parseServerDate
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlin.math.abs

// Jellyfin SyncPlay, the pure part (unit-tested): clock offset, the server's commands and play queue.

// jellyfin-web TimeSyncCore: NTP-style samples against GET /GetUtcTime; of the last [keep], the one with the
// shortest round trip gives the offset (server clock − local clock) and the ping.
class TimeSync(private val keep: Int = 8) {
    private class Sample(val offset: Long, val delay: Long)

    private val samples = ArrayDeque<Sample>()

    @Volatile var offsetMs = 0L
        private set
    @Volatile var pingMs = 0L
        private set

    /** [sent] and [received] on the local clock, [serverIn] and [serverOut] on the server's (all epoch ms). */
    @Synchronized
    fun add(sent: Long, serverIn: Long, serverOut: Long, received: Long) {
        samples.addLast(Sample(((serverIn - sent) + (serverOut - received)) / 2, ((received - sent) - (serverOut - serverIn)).coerceAtLeast(0)))
        if (samples.size > keep) samples.removeFirst()
        val best = samples.minBy { it.delay }
        offsetMs = best.offset
        pingMs = best.delay
    }

    fun toLocal(serverMs: Long) = serverMs - offsetMs
    fun toServer(localMs: Long) = localMs + offsetMs
}

/** A SyncPlayCommand: Unpause, Pause, Seek or Stop at [whenMs] (server clock), the group at [positionMs]. */
data class SyncCommand(val command: String, val whenMs: Long, val positionMs: Long, val playlistItemId: String?) {
    companion object {
        fun parse(d: JsonElement?): SyncCommand? {
            val o = d as? JsonObject ?: return null
            return SyncCommand(
                o.str("Command") ?: return null,
                parseServerDate(o["When"]) ?: return null,
                ((o["PositionTicks"] as? JsonPrimitive)?.longOrNull ?: 0L) / TICKS_PER_MS,
                o.str("PlaylistItemId"),
            )
        }
    }
}

// When and where a command applies on this device.
object SyncPlan {
    /** Closer than this to the group, Pause and Unpause leave the position alone (a seek would rebuffer). */
    const val DRIFT_MS = 2_000L

    /** How long to wait on the local clock before [c] applies; 0 once its time has passed. */
    fun delayMs(c: SyncCommand, nowLocal: Long, sync: TimeSync): Long = (sync.toLocal(c.whenMs) - nowLocal).coerceAtLeast(0)

    /** The group's position at [nowLocal]: from When on, Unpause runs; Pause and Seek hold theirs. */
    fun groupPositionMs(c: SyncCommand, nowLocal: Long, sync: TimeSync): Long =
        if (c.command == "Unpause") c.positionMs + (nowLocal - sync.toLocal(c.whenMs)).coerceAtLeast(0) else c.positionMs

    /** Where to seek so [currentMs] matches the group: always for Seek, past [DRIFT_MS] otherwise; null = stay. */
    fun seekTo(c: SyncCommand, nowLocal: Long, sync: TimeSync, currentMs: Long): Long? {
        val target = groupPositionMs(c, nowLocal, sync)
        return target.takeIf { c.command == "Seek" || abs(currentMs - target) > DRIFT_MS }
    }
}

/** The group's play queue as a PlayQueue update gives it: the item playing, from [startMs]. */
data class SyncQueue(val itemId: String, val playlistItemId: String, val startMs: Long, val isPlaying: Boolean, val reason: String = "") {
    /** Whether the players reload and wait for the group: not for queue edits (RemoveItems, MoveItem, Queue, modes). */
    fun reloads(prev: SyncQueue?) = reason in RELOAD || prev?.playlistItemId != playlistItemId

    companion object {
        private val RELOAD = setOf("NewPlaylist", "SetCurrentItem", "NextItem", "PreviousItem")
        /** null for an empty queue, or an id that is not a server id (it goes into URLs). */
        fun parse(d: JsonElement?): SyncQueue? {
            val o = d as? JsonObject ?: return null
            val list = o["Playlist"] as? JsonArray ?: return null
            val entry = list.getOrNull((o["PlayingItemIndex"] as? JsonPrimitive)?.intOrNull ?: return null) as? JsonObject ?: return null
            val id = entry.str("ItemId")?.takeIf(SafeNames::isValidId) ?: return null
            return SyncQueue(
                id, entry.str("PlaylistItemId") ?: return null,
                ((o["StartPositionTicks"] as? JsonPrimitive)?.longOrNull ?: 0L) / TICKS_PER_MS,
                (o["IsPlaying"] as? JsonPrimitive)?.booleanOrNull == true,
                o.str("Reason").orEmpty(),
            )
        }
    }
}

/** A group as /SyncPlay/List and GroupJoined give it: participants are user names. */
data class SyncGroup(val id: String, val name: String, val participants: List<String>) {
    companion object {
        fun parse(d: JsonElement?): SyncGroup? {
            val o = d as? JsonObject ?: return null
            return SyncGroup(
                o.str("GroupId") ?: return null, o.str("GroupName").orEmpty(),
                (o["Participants"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }.orEmpty(),
            )
        }
    }
}

internal fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
