package com.wika.wicaby.core.iptv

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.BufferedInputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.io.InputStreamReader
import java.util.zip.GZIPInputStream

// Downloads at the trust boundary: http(s) only, size caps (playlist 32 MB; guide 200 MB compressed, 1 GB once
// gunzipped), streamed (a guide never sits in memory, a playlist is read line by line). Playlist and guide URLs may
// carry credentials (Xtream get.php?username=&password=): only the host ever goes into a message or a log.

const val MAX_PLAYLIST_BYTES = 32L shl 20
const val MAX_GUIDE_GZ_BYTES = 200L shl 20
const val MAX_GUIDE_BYTES = 1L shl 30

class IptvTooLarge(what: String) : IOException("$what too large")

/** The host of a URL, for messages and logs (never the URL: it may hold a password). */
fun hostOf(url: String): String = url.toHttpUrlOrNull()?.host ?: "?"

/** Counts the bytes read through it and fails past [max] (changeable before the cap is reached). */
internal class Capped(input: InputStream, var max: Long, private val what: String) : FilterInputStream(input) {
    private var count = 0L

    private fun add(n: Long) {
        if (n > 0) count += n
        if (count > max) throw IptvTooLarge(what)
    }

    override fun read(): Int = super.read().also { if (it >= 0) add(1) }
    override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, len).also { add(it.toLong()) }
    override fun skip(n: Long): Long = super.skip(n).also { add(it) }
    override fun markSupported() = false
}

/** Feeds an XMLTV document (plain or gzip, told by the 1f 8b magic) to [parser] in chunks. The caller ends the parser. */
fun feedGuide(raw: InputStream, parser: XmltvParser, chunkChars: Int = 64 * 1024) {
    val counted = Capped(raw, MAX_GUIDE_BYTES, "guide")
    val buffered = BufferedInputStream(counted, 64 * 1024)
    buffered.mark(2)
    val gz = buffered.read() == 0x1f && buffered.read() == 0x8b
    buffered.reset()
    val text: InputStream = if (gz) {
        counted.max = MAX_GUIDE_GZ_BYTES
        Capped(GZIPInputStream(buffered, 64 * 1024), MAX_GUIDE_BYTES, "guide")
    } else buffered
    // shortcut: read as UTF-8 whatever the XML declaration says (Latin-1 guides get replacement characters); decode by
    // the declared encoding if one turns up.
    InputStreamReader(text, Charsets.UTF_8).use { r ->
        val buf = CharArray(chunkChars)
        while (true) {
            val n = r.read(buf)
            if (n < 0) break
            if (n > 0) parser.push(String(buf, 0, n))
        }
    }
}

/** Reads a playlist line by line through [M3uParser], at most [MAX_PLAYLIST_BYTES]. */
fun readPlaylist(raw: InputStream): Playlist {
    val p = M3uParser()
    InputStreamReader(Capped(raw, MAX_PLAYLIST_BYTES, "playlist"), Charsets.UTF_8).buffered().use { r ->
        while (true) p.line(r.readLine() ?: break)
    }
    return p.finish()
}

/** GET [url] (http or https only) and hand the body to [read]. Non-2xx: IOException with the status, never the URL. */
suspend fun <T> iptvGet(client: OkHttpClient, url: String, read: (InputStream) -> T): T = withContext(Dispatchers.IO) {
    val u = url.takeIf(::isWebUrl)?.toHttpUrlOrNull() ?: throw IOException("not an http(s) URL")
    client.newCall(Request.Builder().url(u).header("Accept", "*/*").build()).execute().use { res ->
        if (!res.isSuccessful) throw IOException("HTTP ${res.code} from ${u.host}")
        read(res.body.byteStream())
    }
}
