package com.wika.wicaby.core.data

import android.util.AtomicFile
import com.wika.wicaby.core.Core
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// A watch state the server has not heard about yet (played offline, or the report failed).
@Serializable
data class PendingProgress(
    val serverId: String,
    val userId: String,
    val itemId: String,
    val positionTicks: Long,
    val played: Boolean,
    val atMs: Long,
)

// One entry per item and user; the most recent watch wins.
fun mergePending(list: List<PendingProgress>, e: PendingProgress): List<PendingProgress> {
    val old = list.firstOrNull { it.serverId == e.serverId && it.userId == e.userId && it.itemId == e.itemId }
    if (old != null && old.atMs > e.atMs) return list
    return list.filterNot { it === old } + e
}

// [item] with the watch state played offline and not sent yet, when there is one: the offline
// home's progress bars and the resume point of a downloaded copy.
fun Item.withPending(list: List<PendingProgress>, serverId: String, userId: String?): Item {
    val p = list.lastOrNull { it.serverId == serverId && it.userId == userId.orEmpty() && it.itemId == id } ?: return this
    val ud = userData ?: UserData()
    return copy(userData = ud.copy(playbackPositionTicks = if (p.played) 0 else p.positionTicks, played = p.played))
}

fun isoUtc(ms: Long): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(ms))

// Persisted queue, flushed with flush() whenever the server is reachable again.
object OfflineProgress {
    private val lock = Mutex()
    // AtomicFile: a crash mid-write keeps the previous queue rather than a torn one.
    private val file get() = AtomicFile(File(Core.app.filesDir, "pending-progress.json"))

    private fun read(): List<PendingProgress> =
        runCatching { json.decodeFromString<List<PendingProgress>>(file.readFully().decodeToString()) }.getOrDefault(emptyList())

    private fun write(list: List<PendingProgress>) {
        val f = file
        if (list.isEmpty()) return f.delete()
        val out = f.startWrite()
        try {
            out.write(json.encodeToString(list).toByteArray())
            f.finishWrite(out)
        } catch (e: IOException) {
            f.failWrite(out)
            throw e
        }
    }

    suspend fun add(e: PendingProgress) = lock.withLock { write(mergePending(read(), e)) }

    suspend fun pending(): List<PendingProgress> = lock.withLock { read() }

    // Sends what belongs to this server and user without holding the lock (network calls), then
    // drops only what went through: an entry added or updated meanwhile stays. Returns what is left.
    suspend fun flush(api: Api): Int {
        val sent = pending().filter { e ->
            e.serverId == api.server.id && e.userId == api.userId && runCatching {
                api.updateUserData(e.itemId, if (e.played) 0 else e.positionTicks, e.played, isoUtc(e.atMs))
                if (e.played) api.setPlayed(e.itemId, true)
            }.isSuccess
        }.toSet()
        return lock.withLock {
            val left = read() - sent
            write(left)
            left.size
        }
    }
}
