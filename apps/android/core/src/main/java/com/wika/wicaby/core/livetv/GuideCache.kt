package com.wika.wicaby.core.livetv

import android.content.ComponentCallbacks2
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.io.File
import java.io.IOException

// Live TV programme cache (spec §7.1, §2.2, §21.9). Memory: an LRU of (channel, slab) units capped in
// programmes, evicting whole units, never the visible ones. Disk: one JSON file per (slab, bucket)
// under <cacheDir>/livetv/<server>/<user>/<slab>/<bucket>.json, bucket = fnv1a32(channelId) mod 32,
// so a lens or sort change hits the same files. Writes are atomic (.tmp then rename), serialized,
// and run on Dispatchers.IO after 2 s without a new put, never on the scroll path. Startup purge of
// slabs that ended more than 6 h ago; the folder is capped at PlatformTuning.persistMb.

const val FRESH_AIRING_MS = 20 * 60_000L
const val FRESH_OTHER_MS = 6 * 3_600_000L
const val PURGE_ENDED_MS = 6 * 3_600_000L
const val CHANNELS_FRESH_MS = 10 * 60_000L
const val GUIDE_BUCKETS = 32
const val DISK_IDLE_MS = 2_000L

/** fnv1a32 of the UTF-8 bytes, unsigned, mod 32 (§7.1). */
fun bucketOf(channelId: String): Int {
    var h = 0x811C9DC5.toInt()
    for (b in channelId.toByteArray(Charsets.UTF_8)) {
        h = h xor (b.toInt() and 0xFF)
        h *= 0x01000193
    }
    return ((h.toLong() and 0xFFFFFFFFL) % GUIDE_BUCKETS).toInt()
}

/** <cacheDir>/livetv/<server>/<user>; ids are reduced to file-name-safe characters. */
fun guideDir(cacheDir: File, serverId: String, userId: String): File {
    fun safe(s: String) = s.replace(Regex("[^A-Za-z0-9_-]"), "_").ifEmpty { "_" }
    return File(cacheDir, "livetv/${safe(serverId)}/${safe(userId)}")
}

/** The programmes of one channel intersecting one slab. */
@Serializable
class GuideUnit(
    @SerialName("c") val channelId: String,
    @SerialName("s") val slab: Long,
    @SerialName("f") val fetchedAt: Long,
    @SerialName("p") val programs: List<ProgramLite>,
)

@Serializable
private class BucketFile(val units: List<GuideUnit>)

@Serializable
class ChannelsSnapshot(val fetchedAt: Long, val rows: List<ChannelRow>)

class GuideCache(
    /** null: memory only. */
    private val dir: File?,
    private val tuning: PlatformTuning,
    private val now: () -> Long,
    /** Where the deferred disk writes run. */
    private val scope: CoroutineScope,
    private val idleMs: Long = DISK_IDLE_MS,
) {
    private val mem = LinkedHashMap<String, GuideUnit>(256, 0.75f, true) // access order: eldest = least recently used
    private var memPrograms = 0
    private var staleBefore = Long.MIN_VALUE
    private val loadedBuckets = HashSet<String>() // "slab/bucket" files already read into memory
    private val pending = HashMap<String, HashMap<String, GuideUnit>>() // "slab/bucket" → channel → unit to write
    private val diskLock = Mutex()
    private var flushJob: Job? = null
    @Volatile private var lastPutNs = 0L

    /** Swaps a decoded channel id for the ChannelRow's own instance (§21.9). */
    @Volatile var canon: (String) -> String = { it }

    /** Coverage keys on screen: never evicted. */
    @Volatile var visible: Set<String> = emptySet()

    /** The memory cap in programmes (halved under memory pressure). */
    @Volatile var lruCap: Int = tuning.lruPrograms
        private set

    val diskCapBytes: Long = tuning.persistMb * 1024L * 1024L

    val programCount: Int get() = synchronized(this) { memPrograms }
    val unitKeys: Set<String> get() = synchronized(this) { mem.keys.toSet() }

    private fun bucketKey(channelId: String, slab: Long) = "$slab/${bucketOf(channelId)}"

    /** The unit in memory, else (with [disk]) from its bucket file: a blocking read, off the main thread. */
    fun unit(channelId: String, slab: Long, disk: Boolean = true): GuideUnit? {
        val key = coverageKey(channelId, slab)
        val bk = bucketKey(channelId, slab)
        synchronized(this) {
            mem[key]?.let { return it }
            if (!disk || dir == null || bk in loadedBuckets) return null
        }
        val units = readBucket(File(dir, "$bk.json"))
        synchronized(this) {
            loadedBuckets.add(bk)
            for (u in units) {
                val k = coverageKey(u.channelId, u.slab)
                if (k in mem) continue
                val c = canon(u.channelId)
                putLocked(k, GuideUnit(c, u.slab, u.fetchedAt, u.programs.map { if (it.channelId === c) it else it.copy(channelId = c) }))
            }
            evictLocked(lruCap)
            return mem[key]
        }
    }

    fun isFresh(u: GuideUnit, at: Long = now()): Boolean {
        if (u.fetchedAt < staleBefore) return false
        val age = at - u.fetchedAt
        return age < if (u.slab == slabOf(at)) FRESH_AIRING_MS else FRESH_OTHER_MS
    }

    /** A guide refresh (or a new guideEpoch): everything revalidates lazily, cached data still renders. */
    fun markAllStale() = synchronized(this) { staleBefore = now() }

    /** Stores one channel's clean programmes for [slabs] (each slab keeps what intersects it). */
    fun put(channelId: String, slabs: List<Long>, programs: List<ProgramLite>, fetchedAt: Long) {
        synchronized(this) {
            for (k in slabs) {
                val u = GuideUnit(channelId, k, fetchedAt, programsInWindow(programs, slabStart(k), slabEnd(k)))
                putLocked(coverageKey(channelId, k), u)
                if (dir != null) pending.getOrPut(bucketKey(channelId, k)) { HashMap() }[channelId] = u
            }
            evictLocked(lruCap)
        }
        scheduleFlush()
    }

    private fun putLocked(key: String, u: GuideUnit) {
        mem.put(key, u)?.let { memPrograms -= it.programs.size }
        memPrograms += u.programs.size
    }

    /** The cached programmes of a channel intersecting [from, to), across slabs (missing slabs are skipped). */
    fun programs(channelId: String, from: Long, to: Long, disk: Boolean = true): List<ProgramLite> {
        val out = ArrayList<ProgramLite>()
        for (k in slabRange(from, to)) {
            val u = unit(channelId, k, disk) ?: continue
            for (p in u.programs) {
                if (p.end <= from || p.start >= to) continue
                if (out.isNotEmpty() && out.last().id == p.id) continue // spans two slabs
                out.add(p)
            }
        }
        return out
    }

    // ---- Memory pressure (§21.9) ----

    private fun evictLocked(cap: Int) {
        if (memPrograms <= cap) return
        val keep = visible
        val it = mem.entries.iterator()
        while (memPrograms > cap && it.hasNext()) {
            val e = it.next()
            if (e.key in keep) continue
            memPrograms -= e.value.programs.size
            loadedBuckets.remove(bucketKey(e.value.channelId, e.value.slab)) // a later read may reload it
            it.remove()
        }
    }

    /** RUNNING_LOW halves the LRU; RUNNING_CRITICAL or the app in the background keeps only the visible set. */
    fun onTrimMemory(level: Int) = synchronized(this) {
        @Suppress("DEPRECATION")
        when {
            level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL || level >= ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN -> evictLocked(0)
            level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW -> {
                lruCap = tuning.lruPrograms / 2
                evictLocked(lruCap)
            }
        }
    }

    // ---- Disk ----

    private fun readBucket(f: File): List<GuideUnit> =
        runCatching { LiveJson.decodeFromString(BucketFile.serializer(), f.readText()).units }.getOrDefault(emptyList())

    private fun writeAtomic(f: File, text: String) {
        f.parentFile?.mkdirs()
        val tmp = File(f.path + ".tmp")
        tmp.writeText(text)
        // rename replaces atomically on Android (POSIX); a plain JVM on Windows refuses an existing target.
        if (!tmp.renameTo(f) && !(f.delete() && tmp.renameTo(f))) {
            tmp.delete()
            throw IOException("cannot replace $f")
        }
    }

    private fun scheduleFlush() {
        if (dir == null) return
        lastPutNs = System.nanoTime()
        synchronized(this) {
            if (flushJob != null) return
            flushJob = scope.launch {
                while (true) {
                    val wait = idleMs - (System.nanoTime() - lastPutNs) / 1_000_000
                    if (wait > 0) {
                        delay(wait)
                        continue
                    }
                    flush()
                    val done = synchronized(this@GuideCache) { pending.isEmpty().also { if (it) flushJob = null } }
                    if (done) break
                }
            }
        }
    }

    /** Writes every pending unit now (also what the 2 s idle timer calls). */
    suspend fun flush() {
        val d = dir ?: return
        withContext(Dispatchers.IO) {
            diskLock.withLock {
                val batch = synchronized(this@GuideCache) { HashMap(pending).also { pending.clear() } }
                for ((bk, units) in batch) {
                    val f = File(d, "$bk.json")
                    val merged = LinkedHashMap<String, GuideUnit>()
                    for (u in readBucket(f)) merged[u.channelId] = u
                    merged.putAll(units)
                    runCatching { writeAtomic(f, LiveJson.encodeToString(BucketFile.serializer(), BucketFile(merged.values.toList()))) }
                }
                enforceCap(d)
            }
        }
    }

    /** Deletes the least recently written bucket files until the folder fits [diskCapBytes]. */
    private fun enforceCap(d: File) {
        val files = d.listFiles()?.filter { it.isDirectory }?.flatMap { s -> s.listFiles()?.filter { it.isFile }.orEmpty() }.orEmpty()
        var total = files.sumOf { it.length() }
        if (total <= diskCapBytes) return
        for (f in files.sortedBy { it.lastModified() }) {
            if (total <= diskCapBytes) break
            total -= f.length()
            f.delete()
            synchronized(this) { loadedBuckets.remove("${f.parentFile?.name}/${f.name.substringBefore('.')}") }
        }
        d.listFiles()?.forEach { if (it.isDirectory && it.list()?.isEmpty() == true) it.delete() }
    }

    /** Startup: drops slabs that ended more than 6 h ago, leftover .tmp files, and enforces the cap. */
    suspend fun purge() {
        val d = dir ?: return
        withContext(Dispatchers.IO) {
            diskLock.withLock {
                val limit = now() - PURGE_ENDED_MS
                d.listFiles()?.forEach { s ->
                    val slab = s.name.toLongOrNull()
                    when {
                        slab != null && s.isDirectory && slabEnd(slab) <= limit -> s.deleteRecursively()
                        s.isDirectory -> s.listFiles()?.forEach { if (it.name.endsWith(".tmp")) it.delete() }
                    }
                }
                enforceCap(d)
            }
        }
    }

    fun readChannels(): ChannelsSnapshot? {
        val f = File(dir ?: return null, "channels.json")
        return runCatching { LiveJson.decodeFromString(ChannelsSnapshot.serializer(), f.readText()) }.getOrNull()
    }

    suspend fun writeChannels(s: ChannelsSnapshot) {
        val d = dir ?: return
        withContext(Dispatchers.IO) {
            diskLock.withLock { runCatching { writeAtomic(File(d, "channels.json"), LiveJson.encodeToString(ChannelsSnapshot.serializer(), s)) } }
        }
    }

    /** User switch or sign-out (§7.2): that user's memory and files go. */
    suspend fun clearAll() {
        synchronized(this) {
            mem.clear()
            memPrograms = 0
            pending.clear()
            loadedBuckets.clear()
        }
        val d = dir ?: return
        withContext(Dispatchers.IO) { diskLock.withLock { d.deleteRecursively() } }
    }
}
