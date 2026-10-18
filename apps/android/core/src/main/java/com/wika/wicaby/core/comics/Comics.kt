package com.wika.wicaby.core.comics

import androidx.compose.runtime.mutableStateMapOf
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.Item
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// A message the reader shows as is (unsupported format, no pages, no permission).
class ComicException(message: String) : IOException(message)

// The comic backend shared by both apps: the book is fetched once through /Items/{id}/File
// (Core.http, so the mesh transport and auth apply) into cacheDir/comics, read by format
// (ComicArchive, ComicFolder, ComicPdf), and the page is written back to the server as UserData.
object Comics {
    // Least recently opened archives go once the cache passes this.
    const val CACHE_CAP = 1L shl 30

    // Item and server ids name cache files: only the shapes Emby (digits) and Jellyfin (hex) use.
    private val ID = Regex("^[A-Za-z0-9-]{1,64}$")

    data class Saved(val page: Int, val played: Boolean)

    // Progress saved this session, so detail pages show it before the server is read again.
    val saved = mutableStateMapOf<String, Saved>()

    fun isBook(item: Item) = item.type == "Book" || item.mediaType == "Book"

    // The 0-based page to resume from, or null when the book is unread or finished.
    fun resumePage(item: Item): Int? {
        saved[item.id]?.let { return if (it.played || it.page <= 0) null else it.page }
        val ud = item.userData ?: return null
        if (ud.played) return null
        return ComicProgress.pageFromTicks(ud.playbackPositionTicks).takeIf { it > 0 }
    }

    fun extension(item: Item): String {
        val path = item.path ?: item.mediaSources.firstOrNull()?.path
        val ext = path?.substringAfterLast('/')?.substringAfterLast('\\')?.substringAfterLast('.', "")?.lowercase().orEmpty()
        return ext.ifEmpty { (item.container ?: item.mediaSources.firstOrNull()?.container).orEmpty().substringBefore(',').lowercase() }
    }

    private fun unsupported() = ComicException(Core.str(R.string.reader_unsupported))

    // The item with the fields the reader needs (Path and Container are not in the list views).
    suspend fun item(api: Api, id: String): Item = api.get("/Users/${api.userId}/Items/$id", "Fields" to "Path,MediaSources")

    private fun refused(e: ComicRefused) = ComicException(
        Core.str(
            when (e.reason) {
                ComicRefused.Reason.ENCRYPTED -> R.string.reader_encrypted
                ComicRefused.Reason.TEXT_BOOK -> R.string.reader_text_book
                ComicRefused.Reason.TOO_LARGE -> R.string.reader_too_large
            },
        ),
    )

    // Opens the book: fetch (or reuse) the file, then read it by what its first bytes say. RAR, 7z and tar are
    // extracted once into <sid>-<id>.d (their natural order; solid archives allow nothing else) and the archive
    // is dropped; later opens read that folder and need no network.
    suspend fun open(api: Api, item: Item, onProgress: (Float) -> Unit = {}): ComicBook {
        val ext = extension(item)
        if (ext.isNotEmpty() && ComicFormats.ofExt(ext) == null) throw unsupported()
        val folder = local(api.server.id, item.id, ".d")
        if (folder.isDirectory) {
            folder.setLastModified(System.currentTimeMillis())
            return withContext(Dispatchers.IO) { checked(ComicFolder(folder)) }
        }
        val file = fetch(api, item.id, onProgress)
        // withContext drops a finished result when the caller was cancelled meanwhile: that book must still close.
        var built: ComicBook? = null
        return try {
            openFile(file, folder) { built = it }
        } catch (e: CancellationException) {
            built?.close()
            throw e
        }
    }

    private suspend fun openFile(file: File, folder: File, built: (ComicBook) -> Unit): ComicBook = withContext(Dispatchers.IO) {
        try {
            when (val format = ComicFormats.sniff(file)) {
                ComicFormat.ZIP, ComicFormat.EPUB -> ComicArchive(file, epub = format == ComicFormat.EPUB)
                ComicFormat.PDF -> ComicPdf(file)
                ComicFormat.RAR, ComicFormat.SEVEN_Z, ComicFormat.TAR -> {
                    val ctx = coroutineContext
                    // A TV has little storage: a decompression bomb must not fill it (half the free space at most).
                    val limits = ComicFormats.Limits(maxTotal = minOf(ComicFormats.MAX_TOTAL, folder.parentFile!!.usableSpace / 2))
                    ComicLibarchive.entries(file, format) { ComicFormats.extract(it, folder, limits) { ctx.ensureActive() } }
                    file.delete()
                    ComicFolder(folder)
                }
                null -> throw unsupported()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            // A cached copy that does not open would fail forever; drop it so a later open refetches.
            // Throwable: a missing native library (LinkageError) is an unreadable book, not a crash.
            file.delete()
            folder.deleteRecursively()
            throw when (e) {
                is ComicRefused -> refused(e)
                is ComicException -> e
                else -> unsupported()
            }
        }.let(::checked).also(built)
    }

    private fun checked(book: ComicBook): ComicBook {
        if (book.pageCount == 0) {
            book.close()
            throw ComicException(Core.str(R.string.reader_no_pages))
        }
        return book
    }

    private fun dir() = File(Core.app.cacheDir, "comics")

    // The cache entry of a book: <sid>-<id>.book (the file as served) or <sid>-<id>.d (an extracted archive).
    internal fun local(sid: String, id: String, suffix: String): File {
        require(ID.matches(id) && ID.matches(sid)) { "bad id" }
        return File(dir(), "$sid-$id$suffix")
    }

    private suspend fun fetch(api: Api, id: String, onProgress: (Float) -> Unit): File = withContext(Dispatchers.IO) {
        val file = local(api.server.id, id, ".book")
        val dir = dir().apply { mkdirs() }
        if (file.isFile && file.length() > 0) {
            // mtime is the LRU clock.
            file.setLastModified(System.currentTimeMillis())
            return@withContext file
        }
        // /File is what the servers' own readers use and needs no download right; /Download does.
        var res = call(api, "/Items/$id/File")
        if (res.code == 401 || res.code == 403 || res.code == 404) {
            res.close()
            res = call(api, "/Items/$id/Download")
        }
        res.use { r ->
            if (!r.isSuccessful) {
                if (r.code == 401 || r.code == 403) throw ComicException(Core.str(R.string.reader_forbidden))
                throw ApiException("HTTP ${r.code}", r.code)
            }
            val body = r.body
            val total = body.contentLength()
            // A TV has little storage: a huge or endless body must not fill it (half the free space).
            // Not CACHE_CAP: that only evicts other books, and a 1.3 GB omnibus still opens.
            val limit = dir.usableSpace / 2
            if (total > limit) throw refused(ComicRefused(ComicRefused.Reason.TOO_LARGE))
            val part = File(dir, "${file.name}.part")
            try {
                body.byteStream().use { input ->
                    part.outputStream().use { out ->
                        copyCapped(input, out, limit, { ensureActive() }) { done -> if (total > 0) onProgress(done.toFloat() / total) }
                    }
                }
            } catch (e: Throwable) {
                // A failed or cancelled download must not stay on a full disk until the next book opens.
                part.delete()
                throw if (e is ComicRefused) refused(e) else e
            }
            if (!part.renameTo(file)) {
                part.delete()
                throw IOException("cache")
            }
        }
        prune(file)
        file
    }

    // Copies at most [limit] bytes; more is ComicRefused(TOO_LARGE), so a chunked body is capped too.
    internal fun copyCapped(input: InputStream, out: OutputStream, limit: Long, tick: () -> Unit = {}, onBytes: (Long) -> Unit = {}): Long {
        val buf = ByteArray(64 * 1024)
        var done = 0L
        while (true) {
            tick()
            val n = input.read(buf)
            if (n < 0) return done
            done += n
            if (done > limit) throw ComicRefused(ComicRefused.Reason.TOO_LARGE)
            out.write(buf, 0, n)
            onBytes(done)
        }
    }

    private fun call(api: Api, path: String): Response {
        val req = Request.Builder().url(api.url(path))
        api.authHeaders().forEach { (k, v) -> req.header(k, v) }
        return Core.http.newCall(req.build()).execute()
    }

    // Books (.book, legacy .cbz) and extracted folders (.d), least recently opened first out; leftovers of an
    // interrupted download or extraction (.part) always go.
    private fun prune(keep: File) {
        val all = dir().listFiles().orEmpty()
        all.filter { it.name.endsWith(".part") && it != keep }.forEach { it.deleteRecursively() }
        val books = all.filter { it.name.endsWith(".book") || it.name.endsWith(".cbz") || (it.isDirectory && it.name.endsWith(".d")) }
            .map { it to if (it.isDirectory) it.walk().sumOf { f -> f.length() } else it.length() }
            .sortedByDescending { it.first.lastModified() }
        var total = 0L
        for ((f, size) in books) {
            total += size
            if (total > CACHE_CAP && f != keep) f.deleteRecursively()
        }
    }

    private fun iso(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())

    // UserData only: see ComicProgress. Jellyfin 10.9+ has /UserItems; the per-user route is
    // what Emby and older Jellyfin serve.
    suspend fun saveProgress(api: Api, id: String, page: Int, pageCount: Int) {
        val u = ComicProgress.update(page, pageCount)
        saved[id] = Saved(page, u.played)
        val body = ComicProgress.json(page, pageCount, iso())
        val legacy = "/Users/${api.userId}/Items/$id/UserData"
        if (api.server.isEmby) api.raw("POST", legacy, body)
        else runCatching { api.raw("POST", "/UserItems/$id/UserData", body, "userId" to api.userId) }.getOrElse { api.raw("POST", legacy, body) }
    }
}
