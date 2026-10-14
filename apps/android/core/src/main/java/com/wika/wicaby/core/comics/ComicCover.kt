package com.wika.wicaby.core.comics

import android.util.Log
import coil3.ImageLoader
import coil3.decode.DataSource
import coil3.decode.ImageSource
import coil3.fetch.FetchResult
import coil3.fetch.Fetcher
import coil3.fetch.SourceFetchResult
import coil3.key.Keyer
import coil3.request.Options
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okio.Buffer
import okio.FileSystem
import java.io.IOException
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.Inflater
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

// What Coil loads for a comic the server has no cover for: the archive's /File URL (Core.http's
// ServerAuthInterceptor signs it); [version] (Etag, else DateCreated) keys the caches.
data class ComicCover(val url: String, val version: String)

// The first page of a CBZ as its cover, read with HTTP Range requests: the end of the archive
// (end record and central directory), then that one entry. Mirrors desktop comic-service cover().
object ComicCovers {
    private const val EOCD = 0x06054b50
    private const val ZIP64_LOCATOR = 0x07064b50
    private const val ZIP64_EOCD = 0x06064b50
    private const val CENTRAL = 0x02014b50
    private const val LOCAL = 0x04034b50
    // The end record, ZIP64 records and, for any comic, the whole central directory.
    private const val TAIL = 22 + 0xffff
    private const val MAX_CD = 16 * 1024 * 1024
    // A first page bigger than this is not worth a thumbnail.
    const val MAX_ENTRY = 30L * 1024 * 1024

    // Same rule as desktop src/shared/comic-cover.ts: CBZ/ZIP books, or books whose list entry
    // does not name the format; null when the server has a cover (or the book is not a ZIP).
    fun of(api: Api, item: Item): ComicCover? {
        if (!Comics.isBook(item)) return null
        val ext = Comics.extension(item)
        val skip = if (item.imageTags["Primary"] != null) "server cover" else if (ext.isNotEmpty() && ext != "cbz" && ext != "zip") "not a ZIP" else null
        if (skip != null) {
            // Field log, once per reason and extension a session: the extension only, nothing that names the book.
            if (skipped.add("$skip.$ext")) Log.w(TAG, "skipped ($skip): extension \"$ext\"")
            return null
        }
        return ComicCover(api.url("/Items/${item.id}/File"), item.etag ?: item.dateCreated.orEmpty())
    }

    private val COVER = Regex("^(cover([^a-z].*)?|0+)$", RegexOption.IGNORE_CASE)

    // A page named "cover" ("Cover_01"…) or all zeros ("000") wins, else the first page in reading order.
    fun entry(names: List<String>): String? {
        val pages = ComicPages.order(names)
        return pages.firstOrNull { COVER.matches(it.substringAfterLast('/').substringAfterLast('\\').substringBeforeLast('.')) } ?: pages.firstOrNull()
    }

    class Entry(val name: String, val method: Int, val compressedSize: Long, val size: Long, val offset: Long)

    private class Ranged(val bytes: ByteArray, val start: Long, val total: Long)

    private class Refused(val code: Int) : IOException("HTTP $code: no Range answer")

    // A server answering 200 (the whole file) is refused at once: a cover never downloads the archive. [steps] gets each
    // answer's status, Content-Range numbers and bytes read (the field log).
    private suspend fun range(http: OkHttpClient, url: String, range: String, max: Int, steps: MutableList<String>): Ranged =
        http.newCall(Request.Builder().url(url).header("Range", range).build()).await().use { r ->
            val cr = r.header("Content-Range")
            val m = Regex("^bytes (\\d+)-(\\d+)/(\\d+)$").find(cr.orEmpty())
            steps += "${r.code} " + (m?.let { "${it.groupValues[1]}-${it.groupValues[2]}/${it.groupValues[3]}" } ?: if (cr == null) "no Content-Range" else "odd Content-Range")
            if (r.code != 206 || m == null) throw Refused(r.code)
            val src = r.body.source()
            val buf = Buffer()
            // Some servers (Emby) ignore the end of "bytes=a-b" and stream to the end of the file:
            // keep what was asked for and stop reading (closing the response cancels the rest).
            while (buf.size < max && src.read(buf, 64L * 1024) != -1L) Unit
            steps[steps.lastIndex] += " read ${buf.size}"
            Ranged(buf.readByteArray(minOf(buf.size, max.toLong())), m.groupValues[1].toLong(), m.groupValues[3].toLong())
        }

    // The cover page's bytes (decompressed). /File first, as the reader; /Download when it is refused.
    suspend fun firstPage(http: OkHttpClient, fileUrl: String, steps: MutableList<String> = mutableListOf()): ByteArray = withContext(Dispatchers.IO) {
        var url = fileUrl
        val tail = try {
            range(http, url, "bytes=-$TAIL", TAIL, steps)
        } catch (e: Refused) {
            if (e.code != 401 && e.code != 403 && e.code != 404) throw e
            val u = fileUrl.toHttpUrl()
            url = u.newBuilder().setPathSegment(u.pathSize - 1, "Download").build().toString()
            range(http, url, "bytes=-$TAIL", TAIL, steps)
        }
        val read: suspend (Long, Int) -> ByteArray = { pos, len ->
            val at = pos - tail.start
            if (at >= 0 && at + len <= tail.bytes.size) tail.bytes.copyOfRange(at.toInt(), at.toInt() + len)
            else range(http, url, "bytes=$pos-${pos + len - 1}", len, steps).bytes
        }
        val entries = entries(tail.bytes, tail.total, read)
        val name = entry(entries.map { it.name }) ?: throw IOException("no page")
        val e = entries.first { it.name == name }
        if (e.size > MAX_ENTRY || e.compressedSize > MAX_ENTRY + (1 shl 20)) throw IOException("page too large")
        val head = read(e.offset, 30)
        if (head.size < 30 || le32(head, 0) != LOCAL) throw IOException("bad entry")
        // The local header's name/extra lengths can differ from the central copy.
        val data = read(e.offset + 30 + le16(head, 26) + le16(head, 28), e.compressedSize.toInt())
        when (e.method) {
            0 -> data
            8 -> inflate(data, e.size.toInt())
            else -> throw IOException("ZIP method ${e.method}")
        }
    }

    // The central directory, as desktop zip.ts listEntriesFrom reads it (ZIP64 included).
    private suspend fun entries(tail: ByteArray, total: Long, read: suspend (Long, Int) -> ByteArray): List<Entry> {
        val e = (tail.size - 22 downTo 0).firstOrNull { le32(tail, it) == EOCD } ?: throw IOException("not a ZIP archive")
        var count = le16(tail, e + 10).toLong()
        var cdSize = le32(tail, e + 12).toLong() and 0xffffffffL
        var cdOffset = le32(tail, e + 16).toLong() and 0xffffffffL
        if (count == 0xffffL || cdSize == 0xffffffffL || cdOffset == 0xffffffffL) {
            val loc = e - 20
            if (loc >= 0 && le32(tail, loc) == ZIP64_LOCATOR) {
                val z = read(le64(tail, loc + 8), 56)
                if (z.size < 56 || le32(z, 0) != ZIP64_EOCD) throw IOException("bad ZIP64 record")
                count = le64(z, 32)
                cdSize = le64(z, 40)
                cdOffset = le64(z, 48)
            }
        }
        if (cdSize > MAX_CD || cdOffset < 0 || cdOffset + cdSize > total) throw IOException("bad central directory")
        val cd = read(cdOffset, cdSize.toInt())
        val out = mutableListOf<Entry>()
        var p = 0
        var n = 0L
        while (n++ < count && p + 46 <= cd.size) {
            if (le32(cd, p) != CENTRAL) throw IOException("bad central directory")
            val nameLen = le16(cd, p + 28)
            val extraLen = le16(cd, p + 30)
            val commentLen = le16(cd, p + 32)
            if (p + 46 + nameLen + extraLen > cd.size) break
            // Bit 11 marks UTF-8; older tools write CP437, which only matters for sorting odd names.
            val name = String(cd, p + 46, nameLen, if (le16(cd, p + 8) and 0x800 != 0) Charsets.UTF_8 else Charsets.ISO_8859_1)
            var size = le32(cd, p + 24).toLong() and 0xffffffffL
            var csize = le32(cd, p + 20).toLong() and 0xffffffffL
            var offset = le32(cd, p + 42).toLong() and 0xffffffffL
            // ZIP64 extra field: only the values saturated in the fixed header, in this order.
            var x = p + 46 + nameLen
            val xEnd = x + extraLen
            while (x + 4 <= xEnd) {
                val len = le16(cd, x + 2)
                if (le16(cd, x) == 0x0001) {
                    var q = x + 4
                    val end = minOf(x + 4 + len, xEnd)
                    fun next(v: Long): Long = if (q + 8 > end) v else le64(cd, q).also { q += 8 }
                    if (size == 0xffffffffL) size = next(size)
                    if (csize == 0xffffffffL) csize = next(csize)
                    if (offset == 0xffffffffL) offset = next(offset)
                }
                x += 4 + len
            }
            out += Entry(name, le16(cd, p + 10), csize, size, offset)
            p = xEnd + commentLen
        }
        return out
    }

    // The central directory's size is the cap: a stream inflating past it is lying.
    private fun inflate(data: ByteArray, size: Int): ByteArray {
        val inf = Inflater(true)
        try {
            // nowrap streams want one extra byte past the data.
            inf.setInput(data.copyOf(data.size + 1))
            val out = ByteArray(size)
            var n = 0
            while (n < size && !inf.finished()) {
                val r = inf.inflate(out, n, size - n)
                if (r == 0 && (inf.needsInput() || inf.needsDictionary())) break
                n += r
            }
            return if (n == size) out else out.copyOf(n)
        } finally {
            inf.end()
        }
    }

    private fun le16(b: ByteArray, p: Int) = (b[p].toInt() and 0xff) or ((b[p + 1].toInt() and 0xff) shl 8)
    private fun le32(b: ByteArray, p: Int) = le16(b, p) or (le16(b, p + 2) shl 16)
    private fun le64(b: ByteArray, p: Int) = (le32(b, p).toLong() and 0xffffffffL) or (le32(b, p + 4).toLong() shl 32)

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { c ->
        c.invokeOnCancellation { cancel() }
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = c.resumeWithException(e)
            override fun onResponse(call: Call, response: Response) {
                if (c.isActive) c.resume(response) else response.close()
            }
        })
    }

    // Books without a usable first page this session: not tried again on every scroll.
    internal val failed: MutableSet<String> = Collections.newSetFromMap(ConcurrentHashMap())
    private val skipped: MutableSet<String> = Collections.newSetFromMap(ConcurrentHashMap())
    const val TAG = "WicabyComicCover"

    // The release log line of a failed cover: the exception and each step (status, Content-Range numbers, bytes read).
    // Never the URL, host, item id or token, even when OkHttp puts them in its message.
    fun diagnostic(e: Throwable, steps: List<String>, url: String): String {
        var msg = e.message.orEmpty().replace(Regex("[a-zA-Z][a-zA-Z0-9+.-]*://\\S*"), "<url>")
        url.toHttpUrlOrNull()?.let { u ->
            val secrets = listOf(u.host) + u.pathSegments.filter { it.length > 1 && it !in setOf("emby", "Items", "File", "Download") } +
                (0 until u.querySize).mapNotNull { u.queryParameterValue(it) }
            for (v in secrets.filter { it.isNotEmpty() }.sortedByDescending { it.length }) msg = msg.replace(v, "<redacted>")
        }
        return "cover failed: ${e::class.java.simpleName}: $msg; steps: ${steps.joinToString(", ").ifEmpty { "none" }}"
    }
}

// Coil's memory and disk caches key the cover by server URL, item and version.
class ComicCoverKeyer : Keyer<ComicCover> {
    override fun key(data: ComicCover, options: Options): String = key(data)

    companion object {
        fun key(data: ComicCover) = "comic-cover:${data.url}#${data.version}"
    }
}

// Loads a ComicCover: Coil's disk cache first, else the first page through ComicCovers.firstPage,
// stored in that cache. Coil decodes and downsamples it to the card (inSampleSize), and cancels the
// load when the card leaves the screen; at most two covers are read at once, 20 s each.
class ComicCoverFetcher(private val data: ComicCover, private val loader: ImageLoader, private val http: () -> OkHttpClient) : Fetcher {
    override suspend fun fetch(): FetchResult {
        val key = ComicCoverKeyer.key(data)
        val cache = loader.diskCache
        cache?.openSnapshot(key)?.let { return SourceFetchResult(ImageSource(it.data, cache.fileSystem, key, it), null, DataSource.DISK) }
        if (key in ComicCovers.failed) throw IOException("no cover")
        val steps = mutableListOf<String>()
        val bytes = try {
            permits.withPermit { withTimeout(TIMEOUT_MS) { ComicCovers.firstPage(http(), data.url, steps) } }
        } catch (e: Exception) {
            // Field log (kept in release): every failure and timeout, not a card scrolled away.
            if (e !is CancellationException || e is TimeoutCancellationException) Log.w(ComicCovers.TAG, ComicCovers.diagnostic(e, steps, data.url))
            if (e is CancellationException) throw e // scrolled away or timed out: tried again next time
            ComicCovers.failed += key
            throw e
        }
        if (cache != null && bytes.size <= MAX_CACHED) {
            cache.openEditor(key)?.let { editor ->
                try {
                    cache.fileSystem.write(editor.data) { write(bytes) }
                    editor.commitAndOpenSnapshot()?.let { return SourceFetchResult(ImageSource(it.data, cache.fileSystem, key, it), null, DataSource.NETWORK) }
                } catch (e: Exception) {
                    editor.abort()
                }
            }
        }
        return SourceFetchResult(ImageSource(Buffer().write(bytes), FileSystem.SYSTEM), null, DataSource.NETWORK)
    }

    class Factory(private val http: () -> OkHttpClient = { Core.http }) : Fetcher.Factory<ComicCover> {
        override fun create(data: ComicCover, options: Options, imageLoader: ImageLoader): Fetcher = ComicCoverFetcher(data, imageLoader, http)
    }

    private companion object {
        val permits = Semaphore(2)
        const val TIMEOUT_MS = 20_000L
        // Pages above this are shown but not kept on disk.
        const val MAX_CACHED = 8 * 1024 * 1024
    }
}
