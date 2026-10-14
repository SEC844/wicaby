package com.wika.wicaby.core.files

import com.wika.wicaby.core.files.pure.ExifReader
import com.wika.wicaby.core.files.pure.Ids
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.Serializable
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

// One photo file (photo-index-<sourceId>.json, short keys: thousands of them). s/m: size and mtime (ms), the change
// test; v: a video clip; t/z: EXIF date and offset; w/h: stored pixels; o: EXIF orientation; la/lo/al: GPS (kept on
// this device only, never logged nor sent: the apps have no photo map); u: the backend's own address (a SAF document).
@Serializable
data class PhotoRecord(
    val s: Long, val m: Long, val v: Boolean = false, val t: String? = null, val z: String? = null, val w: Int? = null, val h: Int? = null,
    val o: Int? = null, val la: Double? = null, val lo: Double? = null, val al: Double? = null, val mk: String? = null, val md: String? = null,
    val ln: String? = null, val ex: Double? = null, val fn: Double? = null, val fl: Double? = null, val iso: Double? = null, val u: String? = null,
)

// A photo source's index (photo file sources): the tree scanned once, then incrementally (a file whose size and mtime
// did not change keeps its record; only new or changed files get their first 64 KB read), favourites kept locally.
class PhotoIndex(
    private val backend: FileBackend,
    private val file: File,
    private val now: () -> Long = System::currentTimeMillis,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    @Serializable
    private data class Doc(val v: Int = 1, val scannedAt: Long = 0, val records: Map<String, PhotoRecord> = emptyMap(), val favorites: Set<String> = emptySet())

    // What Réglages > Sources de photos shows: "Indexing N photos…", the count and the last scan.
    data class Status(val scanning: Boolean = false, val count: Int = 0, val scannedAt: Long = 0, val error: Throwable? = null)

    @Volatile
    private var doc: Doc? = null
    private val mutex = Mutex()
    private var refreshed = false
    private var job: Job? = null
    private val _status = MutableStateFlow(Status())
    val status: StateFlow<Status> = _status

    @Synchronized
    private fun loaded(): Doc = doc ?: (runCatching { filesJson.decodeFromString(Doc.serializer(), file.readText()) }.getOrDefault(Doc())).also {
        doc = it
        _status.value = _status.value.copy(count = it.records.size, scannedAt = it.scannedAt)
    }

    // The status of a source not opened yet (Réglages reads it without starting a scan).
    fun peek(): Status = loaded().let { _status.value }

    // Every record by path: the first open awaits the first scan; later ones answer from the cache at once and refresh
    // it in the background, once per session.
    suspend fun records(): Map<String, PhotoRecord> {
        val first = loaded().scannedAt == 0L
        val scan = synchronized(this) { if (first || !refreshed) rescan().also { refreshed = true } else null }
        if (first) scan?.join()
        return loaded().records
    }

    // The cache as it is (images and the cover of an album are asked for once a query answered).
    fun cached(rel: String): PhotoRecord? = doc?.records?.get(rel)

    fun cachedAll(): Map<String, PhotoRecord> = doc?.records.orEmpty()

    fun favorites(): Set<String> = loaded().favorites

    @Synchronized
    fun setFavorite(rel: String, on: Boolean) {
        val d = loaded()
        doc = d.copy(favorites = if (on) d.favorites + rel else d.favorites - rel)
        save()
    }

    // Réglages' Rescan (and the background refresh): one scan at a time.
    fun rescan(): Job = synchronized(this) { job?.takeIf { it.isActive } ?: scope.launch { scan() }.also { job = it } }

    fun close() = scope.cancel()

    @Synchronized
    private fun save() = doc?.let { SourceStore.writeAtomic(file, filesJson.encodeToString(Doc.serializer(), it)) }

    suspend fun scan() = mutex.withLock {
        val old = loaded().records
        _status.value = _status.value.copy(scanning = true, count = 0, error = null)
        try {
            val found = HashMap<String, PhotoRecord>()
            val todo = ArrayList<Pair<String, FileEntry>>()
            val queue = ArrayDeque(listOf(""))
            var dirs = 0
            while (queue.isNotEmpty() && dirs++ < MAX_DIRS) {
                val rel = queue.removeFirst()
                val entries = try {
                    backend.list(rel)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // The root failing fails the scan (the old index stays); a sub-folder that cannot be listed keeps its records.
                    if (rel.isEmpty()) throw e
                    old.filterKeys { it.startsWith("$rel/") }.let(found::putAll)
                    continue
                }
                for (e in entries) {
                    if (FilesApi.hidden(e.name)) continue
                    val child = Ids.child(rel, e.name) ?: continue
                    if (e.dir) queue += child
                    else if (kind(e.name) != null) {
                        val prev = old[child]
                        if (prev != null && prev.s == e.size && prev.m == e.mtimeMs) found[child] = prev else todo += child to e
                    }
                }
            }
            val done = AtomicInteger(found.size)
            _status.value = _status.value.copy(count = done.get())
            val gate = Semaphore(READS)
            coroutineScope {
                todo.map { (rel, e) ->
                    async {
                        gate.withPermit { rel to record(rel, e) }.also { _status.value = _status.value.copy(count = done.incrementAndGet()) }
                    }
                }.awaitAll()
            }.toMap(found)
            synchronized(this) {
                val favs = loaded().favorites.filterTo(HashSet()) { it in found }
                doc = Doc(scannedAt = now(), records = found, favorites = favs)
                save()
            }
            _status.value = Status(count = found.size, scannedAt = now())
        } catch (e: CancellationException) {
            _status.value = _status.value.copy(scanning = false)
            throw e
        } catch (e: Exception) {
            _status.value = Status(count = old.size, scannedAt = loaded().scannedAt, error = e)
        }
    }

    private suspend fun record(rel: String, e: FileEntry): PhotoRecord {
        val base = PhotoRecord(e.size, e.mtimeMs, v = kind(e.name) == VIDEO, u = e.uri)
        if (base.v) return base
        val head = runCatching { backend.read(rel, e, ExifReader.HEAD_BYTES) }.getOrNull() ?: return base
        val h = ExifReader.read(head)
        h.more?.let { m ->
            // shortcut: the Exif item past the head is read as a prefix up to its end (no offset reads in FileBackend), capped
            // at MORE_CAP; add a ranged read to the backends if HEIC files put it further.
            if (m.at + m.length <= MORE_CAP) runCatching {
                val all = backend.read(rel, e, (m.at + m.length).toInt())
                if (all.size >= m.at + m.length) {
                    val item = ExifReader.heicExifItem(all.copyOfRange(m.at.toInt(), (m.at + m.length).toInt()))
                    h.takenAt = item.takenAt; h.offset = item.offset; h.orientation = item.orientation; h.lat = item.lat; h.lon = item.lon; h.alt = item.alt
                    h.make = item.make; h.model = item.model; h.lens = item.lens; h.exposureS = item.exposureS; h.fNumber = item.fNumber
                    h.focalMm = item.focalMm; h.iso = item.iso
                    if (h.width == null) { h.width = item.width; h.height = item.height }
                }
            }
        }
        return base.copy(
            t = h.takenAt, z = h.offset, w = h.width, h = h.height, o = h.orientation, la = h.lat, lo = h.lon, al = h.alt,
            mk = h.make, md = h.model, ln = h.lens, ex = h.exposureS, fn = h.fNumber, fl = h.focalMm, iso = h.iso,
        )
    }

    companion object {
        const val PHOTO = "photo"
        const val VIDEO = "video"
        private const val READS = 4
        private const val MAX_DIRS = 20_000
        private const val MORE_CAP = 4L * 1024 * 1024
        private val PHOTOS = setOf("jpg", "jpeg", "png", "webp", "heic", "heif")
        private val VIDEOS = setOf("mp4", "mov", "m4v")

        fun kind(name: String): String? = name.substringAfterLast('.', "").lowercase().let { if (it in PHOTOS) PHOTO else if (it in VIDEOS) VIDEO else null }
    }
}
