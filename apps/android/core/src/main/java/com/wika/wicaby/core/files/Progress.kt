package com.wika.wicaby.core.files

import com.wika.wicaby.core.files.pure.ProgressDoc
import com.wika.wicaby.core.files.pure.ProgressRecord
import com.wika.wicaby.core.files.pure.ProgressRules
import java.io.File

// One source's local watch state (spec §4.4, D4): progress-<sourceId>.json, the desktop's shape ({v:1, records by
// relative path}), written whole and atomically, pruned to the 10,000 most recent. [writes] counts the writes
// (PlaybackFilesTest).
class FileProgress(private val file: File) {
    private var cache: MutableMap<String, ProgressRecord>? = null

    @Volatile
    var writes = 0
        private set

    @Synchronized
    private fun records(): MutableMap<String, ProgressRecord> = cache ?: LinkedHashMap(
        runCatching { filesJson.decodeFromString(ProgressDoc.serializer(), file.readText()).records }.getOrDefault(emptyMap()),
    ).also { cache = it }

    @Synchronized
    fun get(rel: String): ProgressRecord? = records()[rel]

    @Synchronized
    fun all(): Map<String, ProgressRecord> = records().toMap()

    // [fn] gets the stored record (or null) and returns the new one; null leaves it as it is.
    @Synchronized
    fun update(rel: String, fn: (ProgressRecord?) -> ProgressRecord?) {
        val next = fn(records()[rel]) ?: return
        val m = records()
        m[rel] = next
        val kept = ProgressRules.prune(m)
        if (kept.size != m.size) {
            m.clear()
            m.putAll(kept)
        }
        SourceStore.writeAtomic(file, filesJson.encodeToString(ProgressDoc.serializer(), ProgressDoc(1, m)))
        writes++
    }
}
