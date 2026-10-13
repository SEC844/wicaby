package com.wika.wicaby.core.comics

import androidx.compose.runtime.mutableStateMapOf
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.Item
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// A message the reader shows as is (unsupported format, no pages, no permission).
class ComicException(message: String) : IOException(message)

// The comic backend shared by both apps: the CBZ is fetched once through /Items/{id}/File
// (Core.http, so the mesh transport and auth apply) into cacheDir/comics, read with ZipFile,
// and the page is written back to the server as UserData.
object Comics {
    // Least recently opened archives go once the cache passes this.
    const val CACHE_CAP = 1L shl 30

    private val ARCHIVES = setOf("cbz", "zip")
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

    // Opens the book: fetch (or reuse) the archive, then read its directory.
    suspend fun open(api: Api, item: Item, onProgress: (Float) -> Unit = {}): ComicArchive {
        val ext = extension(item)
        if (ext.isNotEmpty() && ext !in ARCHIVES) throw unsupported()
        val file = fetch(api, item.id, onProgress)
        return withContext(Dispatchers.IO) {
            val archive = try {
                ComicArchive(file)
            } catch (e: Exception) {
                // A cached copy that does not parse would fail forever; drop it so a later open refetches.
                file.delete()
                throw unsupported()
            }
            if (archive.pageCount == 0) {
                archive.close()
                throw ComicException(Core.str(R.string.reader_no_pages))
            }
            archive
        }
    }

    private fun dir() = File(Core.app.cacheDir, "comics")

    private suspend fun fetch(api: Api, id: String, onProgress: (Float) -> Unit): File = withContext(Dispatchers.IO) {
        val sid = api.server.id
        require(ID.matches(id) && ID.matches(sid)) { "bad id" }
        val dir = dir().apply { mkdirs() }
        val file = File(dir, "$sid-$id.cbz")
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
            val part = File(dir, "${file.name}.part")
            body.byteStream().use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    while (true) {
                        ensureActive()
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        if (total > 0) onProgress(done.toFloat() / total)
                    }
                }
            }
            if (!part.renameTo(file)) {
                part.delete()
                throw IOException("cache")
            }
        }
        prune(file)
        file
    }

    private fun call(api: Api, path: String): Response {
        val req = Request.Builder().url(api.url(path))
        api.authHeaders().forEach { (k, v) -> req.header(k, v) }
        return Core.http.newCall(req.build()).execute()
    }

    private fun prune(keep: File) {
        val files = dir().listFiles { f -> f.name.endsWith(".cbz") || f.name.endsWith(".part") }.orEmpty()
            .sortedByDescending { it.lastModified() }
        var total = 0L
        for (f in files) {
            total += f.length()
            if (total > CACHE_CAP && f != keep) f.delete()
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
