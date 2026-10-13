package com.wika.wicaby.core.files.pure

import kotlinx.serialization.Serializable

// One file's local watch state (file sources §4.4, D4), stored per source by relative path. size and mtimeSec say
// which file it describes: a replaced file (new size or modification second) starts again at 0.
@Serializable
data class ProgressRecord(
    val size: Long,
    // Whole seconds: WebDAV dates have second precision, SMB 100 ns.
    val mtimeSec: Long,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val played: Boolean = false,
    val hidden: Boolean = false,
    val lastPlayedAt: Long = 0,
    // Tags captured at first play (D5).
    val title: String? = null,
)

@Serializable
data class ProgressDoc(val v: Int = 1, val records: Map<String, ProgressRecord> = emptyMap())

// The same rules as the desktop's shared/files/progress.ts (vectors: tools/checks/fixtures/files/progress.json).
object ProgressRules {
    const val RESUME_MIN = 0.05
    const val PLAYED_MIN = 0.9
    const val CONTINUE_LIMIT = 24
    const val MAX_RECORDS = 10_000

    fun mtimeSec(mtimeMs: Long) = mtimeMs.floorDiv(1000L)

    fun key(rel: String, size: Long, mtimeMs: Long) = "$rel\u0000$size\u0000${mtimeSec(mtimeMs)}"

    // The record still describes this file (same size and modification second).
    fun sameFile(r: ProgressRecord?, size: Long, mtimeMs: Long) = r != null && r.size == size && r.mtimeSec == mtimeSec(mtimeMs)

    // A position report: under 5 % is no resume point, 90 % or more marks the file played and clears it; played stays
    // until it is unmarked, and playing a hidden file again brings it back.
    fun report(prev: ProgressRecord?, size: Long, mtimeMs: Long, positionMs: Long, durationMs: Long, now: Long): ProgressRecord {
        val same = sameFile(prev, size, mtimeMs)
        val duration = if (durationMs > 0) durationMs else if (same) prev!!.durationMs else 0
        val ratio = if (duration > 0) positionMs.toDouble() / duration else 0.0
        return ProgressRecord(
            size = size,
            mtimeSec = mtimeSec(mtimeMs),
            positionMs = if (ratio >= RESUME_MIN && ratio < PLAYED_MIN) positionMs else 0,
            durationMs = duration,
            played = ratio >= PLAYED_MIN || (same && prev!!.played),
            hidden = false,
            lastPlayedAt = now,
            title = if (same) prev!!.title else null,
        )
    }

    private val recent = compareByDescending<Map.Entry<String, ProgressRecord>> { it.value.lastPlayedAt }.thenBy { it.key }

    // The Continue row: paths with a position, not hidden, last played first.
    fun continueList(records: Map<String, ProgressRecord>, limit: Int = CONTINUE_LIMIT): List<String> =
        records.entries.filter { it.value.positionMs > 0 && !it.value.hidden }.sortedWith(recent).take(limit).map { it.key }

    // Keeps the [max] most recently played records.
    fun prune(records: Map<String, ProgressRecord>, max: Int = MAX_RECORDS): Map<String, ProgressRecord> =
        if (records.size <= max) records else records.entries.sortedWith(recent).take(max).associate { it.key to it.value }
}
